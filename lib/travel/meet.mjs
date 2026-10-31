/**
 * Enlaces de videollamada.
 *
 * - Con Google conectado: crea/actualiza el evento de Calendar con
 *   `conferenceData` (hangoutsMeet) y devuelve el `hangoutLink` real de Meet.
 * - Sin Google (o si falla): entrega una sala **Jitsi real** y pública
 *   (`https://meet.jit.si/AgendaP95-...`), marcada `provider:"jitsi"`.
 *   Nunca se inventa un enlace `meet.google.com`: esos enlaces solo existen
 *   si Google los creó. La respuesta explica que no es Google Meet.
 */

import crypto from 'node:crypto';
import { decryptJSON, encryptJSON } from '../store.mjs';
import { timezoneOf } from '../agenda/time.mjs';

let transport = (url, options) => fetch(url, options);

export function setMeetTransport(fn) {
  transport = typeof fn === 'function' ? fn : ((url, options) => fetch(url, options));
}

export function resetMeetTransport() {
  transport = (url, options) => fetch(url, options);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/**
 * Sala Jitsi real y determinista (meet.jit.si no requiere cuenta).
 * No imita un enlace de Google Meet.
 */
export function jitsiRoomCode(seed) {
  return sha256(seed || 'agenda-p95').toString('hex').slice(0, 12);
}

export function jitsiRoomLink(seed) {
  return `https://meet.jit.si/AgendaP95-${jitsiRoomCode(seed)}`;
}

function meetSeed(event) {
  return `${event?.id || 'sin-id'}|${event?.start || ''}|${event?.title || ''}`;
}

function parseLinkFromGoogle(json) {
  if (json?.hangoutLink) return json.hangoutLink;
  const points = json?.conferenceData?.entryPoints;
  if (Array.isArray(points)) {
    const video = points.find((point) => point?.entryPointType === 'video' && point?.uri);
    if (video?.uri) return video.uri;
  }
  return null;
}

function eventToGoogleBody(event, settings, requestId) {
  const tz = timezoneOf(settings);
  const body = {
    summary: event.title || 'Reunión',
    description: [event.result && `Resultado esperado: ${event.result}`, event.notes].filter(Boolean).join('\n'),
    location: event.location || '',
    start: { dateTime: event.start, timeZone: tz },
    end: { dateTime: event.end, timeZone: tz },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: Math.min(40320, Math.max(0, Number(event.reminderMin || 10))) }]
    },
    conferenceData: {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };
  if (Array.isArray(event.attendees) && event.attendees.length) {
    body.attendees = event.attendees.filter((email) => /@/.test(String(email))).map((email) => ({ email }));
  }
  return body;
}

function targetFor(data, settings) {
  const defaultTarget = settings?.defaultGoogle;
  let connection = defaultTarget
    ? (data.googleConnections || []).find((item) => item.id === defaultTarget.connectionId)
    : null;
  if (!connection) connection = (data.googleConnections || [])[0] || null;
  if (!connection) return null;
  const selected = settings?.selectedCalendars?.[connection.id];
  const calendars = Array.isArray(connection.calendars) ? connection.calendars : [];
  const calendarId = defaultTarget?.connectionId === connection.id && defaultTarget?.calendarId
    ? defaultTarget.calendarId
    : (Array.isArray(selected) && selected[0])
      || calendars.find((calendar) => calendar.primary)?.id
      || calendars[0]?.id
      || 'primary';
  return { connection, calendarId };
}

async function accessToken(data, connection) {
  let token = decryptJSON(connection.token);
  if (token.expires_at && token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error('La conexión Google necesita reconectarse');
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google OAuth no configurado');
  const response = await transport('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('No se pudo refrescar el token de Google');
  token = {
    ...token,
    ...json,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000
  };
  const stored = (data.googleConnections || []).find((item) => item.id === connection.id);
  if (stored) stored.token = encryptJSON(token);
  return token.access_token;
}

async function googleMeet({ data, settings, event }) {
  const target = targetFor(data, settings);
  if (!target) return null;
  const { connection, calendarId } = target;
  const access = await accessToken(data, connection);
  const requestId = `agenda-${event.id || 'nuevo'}-${Date.now()}`.slice(0, 120);
  const body = eventToGoogleBody(event, settings, requestId);
  const hasLink = event.google?.eventId && event.google?.connectionId === connection.id;
  const eventCalendarId = hasLink ? (event.google.calendarId || calendarId) : calendarId;
  const url = hasLink
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(eventCalendarId)}/events/${encodeURIComponent(event.google.eventId)}?conferenceDataVersion=1&sendUpdates=all`
    : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`;
  const response = await transport(url, {
    method: hasLink ? 'PATCH' : 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `Google Calendar ${response.status}`);
  }
  const link = parseLinkFromGoogle(json);
  if (!link) throw new Error('Google no devolvió hangoutLink');
  return {
    link,
    connectionId: connection.id,
    calendarId: eventCalendarId,
    eventId: json.id || event.google?.eventId || null,
    htmlLink: json.htmlLink || event.google?.htmlLink || null,
    created: !hasLink
  };
}

/**
 * Garantiza un enlace de reunión para el evento.
 * @returns {Promise<{meetLink:string, generated:boolean, provider:string, note:string, googleError?:string}>}
 */
export async function ensureMeetLink({ data, settings = data?.settings || {}, event } = {}) {
  if (!event) throw new Error('Evento requerido');
  const legacyFake = event.meet?.generated === true
    || (event.meet?.provider === 'local' && /^https:\/\/meet\.google\.com\//i.test(String(event.meetLink || '')));
  if (event.meetLink && !legacyFake) {
    return {
      meetLink: event.meetLink,
      generated: !!event.meet?.generated,
      provider: event.meet?.provider || (event.meet?.generated ? 'local' : 'google'),
      note: event.meet?.note || '',
      existing: true
    };
  }
  let googleError = null;
  try {
    const google = await googleMeet({ data, settings, event });
    if (google) {
      event.meetLink = google.link;
      event.meet = {
        link: google.link,
        provider: 'google',
        generated: false,
        eventId: google.eventId,
        createdAt: new Date().toISOString(),
        note: 'Enlace real de Google Calendar (conferenceData hangoutsMeet)'
      };
      if (google.created) {
        event.google = {
          connectionId: google.connectionId,
          calendarId: google.calendarId,
          eventId: google.eventId,
          htmlLink: google.htmlLink
        };
      }
      return {
        meetLink: google.link,
        generated: false,
        provider: 'google',
        note: event.meet.note,
        createdInGoogle: !!google.created
      };
    }
  } catch (error) {
    googleError = String(error.message || error).slice(0, 300);
  }

  const link = jitsiRoomLink(meetSeed(event));
  event.meetLink = link;
  event.meet = {
    link,
    provider: 'jitsi',
    generated: false,
    fallback: true,
    createdAt: new Date().toISOString(),
    note: 'Sala Jitsi real; Google Meet requiere conectar Google'
  };
  return {
    meetLink: link,
    generated: false,
    provider: 'jitsi',
    fallback: true,
    note: event.meet.note,
    googleError
  };
}

export function meetForEvent(event) {
  return {
    meetLink: event?.meetLink || null,
    meet: event?.meet || null,
    generated: !!event?.meet?.generated
  };
}


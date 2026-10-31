import crypto from 'node:crypto';
import { store, encryptJSON, decryptJSON, addActivity } from './store.mjs';
import { getSecret } from './security/vault.mjs';
import {
  dateKeyOfIso, isoAtLocal, isoLocalOf, minutesBetween, timezoneOf
} from './agenda/time.mjs';

/**
 * Integración Google (Calendar + Gmail) bidireccional.
 *
 * - OAuth con refresh token cifrado en el store.
 * - FreeBusy con errores VISIBLES (nunca se asume "libre" si Google falla).
 * - Eventos de día completo incluidos como bloqueo de jornada.
 * - PATCH/DELETE de la agenda sincronizan con Calendar.
 * - Reconciliación periódica (settings.syncIntervalMin), con syncToken
 *   incremental y manejo de 410 GONE (resync completo) y 429/5xx (backoff).
 * - Revocación del token al desconectar.
 *
 * Todas las llamadas HTTP pasan por `transport`, inyectable en pruebas
 * (`setGoogleTransport`) para poder usar un mock sin red.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 8000;

let transport = (url, options) => fetch(url, options);

/** Inyecta un transporte HTTP falso para pruebas (recibe url, options → Response). */
export function setGoogleTransport(fn) {
  transport = typeof fn === 'function' ? fn : ((url, options) => fetch(url, options));
}

export function resetGoogleTransport() {
  transport = (url, options) => fetch(url, options);
}

const clientId = () => getSecret('google.clientId') || process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => getSecret('google.clientSecret') || process.env.GOOGLE_CLIENT_SECRET || '';

export class GoogleApiError extends Error {
  constructor(status, message, { code, body, retryAfterMs, url } = {}) {
    super(message || `Google API ${status}`);
    this.name = 'GoogleApiError';
    this.status = status;
    this.code = code || `GOOGLE_${status}`;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.url = url;
  }
}

export class GoogleGoneError extends GoogleApiError {
  constructor(message = 'syncToken inválido o expirado (410)') {
    super(410, message, { code: 'GOOGLE_SYNC_TOKEN_GONE' });
    this.name = 'GoogleGoneError';
  }
}

export class GoogleNotFoundError extends GoogleApiError {
  constructor(message = 'Recurso de Google no encontrado (404)') {
    super(404, message, { code: 'GOOGLE_NOT_FOUND' });
    this.name = 'GoogleNotFoundError';
  }
}

export class GoogleRateLimitError extends GoogleApiError {
  constructor(message = 'Límite de Google alcanzado (429)', retryAfterMs) {
    super(429, message, { code: 'GOOGLE_RATE_LIMIT', retryAfterMs });
    this.name = 'GoogleRateLimitError';
  }
}

function assertConfigured() {
  if (!clientId() || !clientSecret()) throw new Error('Google OAuth no está configurado en .env');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(MAX_BACKOFF_MS, retryAfterMs);
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(MAX_BACKOFF_MS, exponential + jitter);
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(headerValue).getTime();
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function readJsonSafely(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function isRateLimitResponse(status, json) {
  if (status === 429) return true;
  if (status !== 403) return false;
  const reasons = []
    .concat(json?.error?.errors || [])
    .concat(json?.error?.details || []);
  return reasons.some((reason) => /rateLimitExceeded|quotaExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(
    `${reason?.reason || ''} ${reason?.code || ''} ${reason?.message || ''}`
  ));
}

/** Ejecuta una petición HTTP con backoff para 429 y 5xx. */
async function request(url, options = {}, { retries = MAX_RETRIES, allow404 = false, method } = {}) {
  let lastError;
  const httpMethod = method || options.method || 'GET';
  for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
    let response;
    try {
      response = await transport(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      lastError = new GoogleApiError(0, `No se pudo contactar Google: ${error.message}`, { code: 'GOOGLE_NETWORK', url });
      if (httpMethod !== 'GET' || attempt === retries - 1) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    const json = await readJsonSafely(response);
    if (response.ok) return json;

    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    if (isRateLimitResponse(response.status, json)) {
      lastError = new GoogleRateLimitError(json?.error?.message || 'Límite de Google alcanzado', retryAfterMs);
      if (attempt < retries - 1) {
        await sleep(backoffMs(attempt, retryAfterMs));
        continue;
      }
      break;
    }
    if (response.status === 410) throw new GoogleGoneError(json?.error?.message);
    if (response.status === 404) {
      if (allow404) return { __notFound: true, status: 404 };
      throw new GoogleNotFoundError(json?.error?.message);
    }
    if (response.status >= 500 && attempt < retries - 1) {
      lastError = new GoogleApiError(response.status, json?.error?.message || `Google API ${response.status}`, { ...json });
      await sleep(backoffMs(attempt, retryAfterMs));
      continue;
    }
    throw new GoogleApiError(response.status, json?.error?.message || json?.error_description || `Google API ${response.status}`, {
      code: json?.error?.status || json?.error?.code,
      body: json,
      retryAfterMs,
      url
    });
  }
  throw lastError || new GoogleApiError(0, 'Google no respondió', { code: 'GOOGLE_UNKNOWN' });
}

export function googleOAuthUrl({ redirectUri, state }) {
  assertConfigured();
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent select_account');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  u.searchParams.set('scope', [
    'openid', 'email',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.send'
  ].join(' '));
  return u.toString();
}

async function tokenRequest(params) {
  const response = await transport(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  const json = await readJsonSafely(response);
  if (!response.ok) throw new Error(`Google OAuth: ${json.error_description || json.error || response.status}`);
  return json;
}

export async function finishGoogleOAuth({ code, redirectUri, label = 'Google' }) {
  assertConfigured();
  const tok = await tokenRequest({
    code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri, grant_type: 'authorization_code'
  });
  const profileRes = await transport('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  const profile = await readJsonSafely(profileRes);
  if (!profileRes.ok) throw new Error('No se pudo leer el perfil de Google.');
  const calendars = await listCalendarsWithToken(tok.access_token);
  const connection = {
    id: crypto.randomUUID(),
    label,
    email: profile.email || label,
    createdAt: new Date().toISOString(),
    token: encryptJSON({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
      scope: tok.scope
    }),
    calendars: calendars.map((calendar) => ({
      id: calendar.id, summary: calendar.summary, primary: !!calendar.primary,
      accessRole: calendar.accessRole, timeZone: calendar.timeZone
    })),
    sync: { lastSyncAt: null, lastError: null, calendars: {} }
  };
  await store.mutate((data) => {
    const duplicate = data.googleConnections.findIndex((item) => item.email === connection.email);
    if (duplicate >= 0) data.googleConnections.splice(duplicate, 1, connection);
    else data.googleConnections.push(connection);
    data.settings.selectedCalendars[connection.id] = connection.calendars.filter((calendar) => calendar.primary).map((calendar) => calendar.id);
    if (!data.settings.defaultGoogle) {
      const primary = connection.calendars.find((calendar) => calendar.primary) || connection.calendars[0];
      if (primary) data.settings.defaultGoogle = { connectionId: connection.id, calendarId: primary.id };
    }
    if (!data.googleSync) data.googleSync = {};
    data.googleSync[connection.id] = { calendars: {} };
    addActivity('integration', `Google conectado: ${connection.email}`);
  });
  return publicConnection(connection);
}

function publicConnection({ token, ...connection }) {
  return {
    ...connection,
    sync: {
      lastSyncAt: connection.sync?.lastSyncAt || null,
      lastError: connection.sync?.lastError || null,
      calendars: connection.sync?.calendars || {}
    }
  };
}

async function getAccess(connection) {
  let token = decryptJSON(connection.token);
  if (token.expires_at && token.expires_at > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw new GoogleApiError(401, `La conexión ${connection.email} necesita reconectarse.`, { code: 'GOOGLE_RECONNECT' });
  let fresh;
  try {
    fresh = await tokenRequest({
      refresh_token: token.refresh_token, client_id: clientId(), client_secret: clientSecret(), grant_type: 'refresh_token'
    });
  } catch (error) {
    await store.mutate((data) => {
      const target = data.googleConnections.find((item) => item.id === connection.id);
      if (target) target.reconnectRequired = true;
    }).catch(() => {});
    throw new GoogleApiError(401, `Token de Google inválido para ${connection.email}. Reconecta la cuenta.`, { code: 'GOOGLE_RECONNECT' });
  }
  token = {
    ...token,
    ...fresh,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + (fresh.expires_in || 3600) * 1000
  };
  await store.mutate((data) => {
    const target = data.googleConnections.find((item) => item.id === connection.id);
    if (target) {
      target.token = encryptJSON(token);
      target.reconnectRequired = false;
    }
  });
  return token.access_token;
}

async function googleFetch(connection, url, options = {}) {
  const access = await getAccess(connection);
  const buildOptions = (token) => ({
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${token}` }
  });
  try {
    return await request(url, buildOptions(access), {
      allow404: options.allow404,
      retries: options.retries,
      method: options.method
    });
  } catch (error) {
    // Access token caducado o revocado: se refresca una vez y se reintenta.
    if (error instanceof GoogleApiError && error.status === 401) {
      const token = decryptJSON(connection.token);
      const forced = { ...connection, token: encryptJSON({ ...token, expires_at: 0 }) };
      const freshAccess = await getAccess(forced);
      return request(url, buildOptions(freshAccess), {
        allow404: options.allow404,
        retries: options.retries,
        method: options.method
      });
    }
    throw error;
  }
}

async function listCalendarsWithToken(access) {
  const response = await transport(`${CALENDAR_API}/users/me/calendarList?maxResults=250`, {
    headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  const json = await readJsonSafely(response);
  if (!response.ok) throw new Error(json?.error?.message || 'Error listando calendarios');
  return json.items || [];
}

export async function refreshCalendars(connectionId) {
  const data = store.get();
  const connection = data.googleConnections.find((item) => item.id === connectionId);
  if (!connection) throw new Error('Conexión Google no encontrada');
  const access = await getAccess(connection);
  const calendars = await listCalendarsWithToken(access);
  await store.mutate((current) => {
    const target = current.googleConnections.find((item) => item.id === connectionId);
    if (target) {
      target.calendars = calendars.map((calendar) => ({
        id: calendar.id, summary: calendar.summary, primary: !!calendar.primary,
        accessRole: calendar.accessRole, timeZone: calendar.timeZone
      }));
    }
  });
  return calendars;
}

export function publicConnections() {
  return store.get().googleConnections.map(publicConnection);
}

async function revokeToken(token) {
  if (!token) return { revoked: false, reason: 'sin token' };
  try {
    const response = await transport(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    return { revoked: response.ok, status: response.status };
  } catch (error) {
    return { revoked: false, reason: error.message };
  }
}

/**
 * Desconecta una cuenta Google. Revoca el refresh token (y el access si no hay
 * refresh) antes de borrar la conexión local.
 */
export async function disconnectGoogle(connectionId) {
  const connection = store.get().googleConnections.find((item) => item.id === connectionId);
  let revocation = { revoked: false, reason: 'conexión no encontrada' };
  if (connection) {
    try {
      const token = decryptJSON(connection.token);
      revocation = await revokeToken(token.refresh_token || token.access_token);
    } catch (error) {
      revocation = { revoked: false, reason: error.message };
    }
  }
  await store.mutate((data) => {
    data.googleConnections = data.googleConnections.filter((item) => item.id !== connectionId);
    delete data.settings.selectedCalendars[connectionId];
    if (data.settings.defaultGoogle?.connectionId === connectionId) data.settings.defaultGoogle = null;
    if (data.googleSync) delete data.googleSync[connectionId];
    addActivity('integration', `Google desconectado${connection ? `: ${connection.email}` : ''}${revocation.revoked ? ' (token revocado)' : ''}`);
  });
  return { ok: true, revoked: !!revocation.revoked, reason: revocation.reason || null };
}

function selectedCalendarsFor(data, connection) {
  const selected = data.settings.selectedCalendars?.[connection.id];
  if (Array.isArray(selected) && selected.length) return selected;
  return connection.calendars.filter((calendar) => calendar.primary).map((calendar) => calendar.id);
}

function mapGoogleEvent(connection, calendarId, item) {
  return {
    source: 'google',
    connectionId: connection.id,
    account: connection.email,
    calendarId,
    eventId: item.id,
    title: item.summary || '(Sin título)',
    start: item.start?.dateTime || item.start?.date,
    end: item.end?.dateTime || item.end?.date,
    allDay: !!item.start?.date,
    location: item.location || '',
    description: item.description || '',
    status: item.status || '',
    transparency: item.transparency || 'opaque',
    updated: item.updated || null,
    htmlLink: item.htmlLink || ''
  };
}

/**
 * Lista eventos de Google (todos los calendarios seleccionados) en un rango.
 * Los errores se devuelven como entradas `source:'error'` (no se silencian).
 */
export async function listGoogleEvents(timeMin, timeMax, { connectionId = null } = {}) {
  const data = store.get();
  const all = [];
    for (const connection of data.googleConnections) {
      if (connectionId && connection.id !== connectionId) continue;
      for (const calendarId of selectedCalendarsFor(data, connection)) {
        try {
          const result = await listCalendarEvents(connection, calendarId, { timeMin, timeMax });
          for (const item of result.items) all.push(mapGoogleEvent(connection, calendarId, item));
        } catch (error) {
          all.push({
            source: 'error', connectionId: connection.id, account: connection.email,
            calendarId, error: error.message, code: error.code || null
          });
        }
      }
    }
  return all;
}

async function listCalendarEvents(connection, calendarId, { timeMin, timeMax, syncToken, pageToken, showDeleted = false } = {}) {
  const items = [];
  let nextPageToken = pageToken || null;
  let nextSyncToken = null;
  for (let page = 0; page < 40; page++) {
    const u = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('maxResults', '2500');
    if (showDeleted) u.searchParams.set('showDeleted', 'true');
    if (syncToken) {
      u.searchParams.set('syncToken', syncToken);
    } else {
      u.searchParams.set('timeMin', timeMin);
      u.searchParams.set('timeMax', timeMax);
      u.searchParams.set('orderBy', 'startTime');
    }
    if (nextPageToken) u.searchParams.set('pageToken', nextPageToken);
    const json = await googleFetch(connection, u.toString());
    items.push(...(json.items || []));
    nextSyncToken = json.nextSyncToken || nextSyncToken;
    nextPageToken = json.nextPageToken || null;
    if (!nextPageToken) break;
  }
  return { items, nextSyncToken };
}

const allDayCache = new Map();
const ALL_DAY_CACHE_TTL_MS = 45_000;

/**
 * FreeBusy detallado + eventos de día completo.
 * @returns {{busy:Array, errors:Array, checkedCalendars:number, errorCount:number}}
 */
export async function googleBusyDetailed(timeMin, timeMax) {
  const data = store.get();
  const tz = timezoneOf(data.settings);
  const busy = [];
  const errors = [];
  let checkedCalendars = 0;

  for (const connection of data.googleConnections) {
    const ids = selectedCalendarsFor(data, connection);
    if (!ids.length) continue;
    try {
      const json = await googleFetch(connection, `${CALENDAR_API}/freeBusy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeMin, timeMax, timeZone: tz, items: ids.map((id) => ({ id })) })
      });
      for (const [calendarId, value] of Object.entries(json.calendars || {})) {
        checkedCalendars += 1;
        for (const error of value.errors || []) {
          errors.push({
            source: 'google-error', connectionId: connection.id, account: connection.email,
            calendarId, code: error.reason || 'FREEBUSY_ERROR', error: error.reason || 'FreeBusy falló', timeMin, timeMax
          });
        }
        for (const block of value.busy || []) {
          busy.push({ start: block.start, end: block.end, source: 'google', account: connection.email, calendarId, connectionId: connection.id });
        }
      }
    } catch (error) {
      errors.push({
        source: 'google-error', connectionId: connection.id, account: connection.email,
        calendarId: null, code: error.code || 'FREEBUSY_ERROR', error: error.message, timeMin, timeMax
      });
    }
  }

  // Los eventos de TODO EL DÍA no aparecen en freeBusy: se listan aparte.
  const cacheKey = `${timeMin}|${timeMax}|${data.googleConnections.map((c) => c.id).join(',')}`;
  const cached = allDayCache.get(cacheKey);
  let allDayItems = null;
  if (cached && Date.now() - cached.at < ALL_DAY_CACHE_TTL_MS) {
    allDayItems = cached.items;
  } else {
    allDayItems = [];
    for (const connection of data.googleConnections) {
      for (const calendarId of selectedCalendarsFor(data, connection)) {
        try {
          const result = await listCalendarEvents(connection, calendarId, { timeMin, timeMax });
          for (const item of result.items) {
            if (item.start?.date && item.status !== 'cancelled') {
              allDayItems.push(mapGoogleEvent(connection, calendarId, item));
            }
          }
        } catch (error) {
          errors.push({
            source: 'google-error', connectionId: connection.id, account: connection.email,
            calendarId, code: error.code || 'ALLDAY_ERROR', error: error.message, timeMin, timeMax
          });
        }
      }
    }
    allDayCache.set(cacheKey, { at: Date.now(), items: allDayItems });
  }

  for (const item of allDayItems) {
    if (item.transparency === 'transparent') continue;
    const startKey = item.start;
    const endKey = item.end;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endKey || '')) continue;
    busy.push({
      start: isoAtLocal(startKey, '00:00', tz),
      end: isoAtLocal(endKey, '00:00', tz),
      source: 'google-allday',
      account: item.account,
      calendarId: item.calendarId,
      connectionId: item.connectionId,
      title: item.title,
      allDay: true
    });
  }

  return { busy, errors, checkedCalendars, errorCount: errors.length };
}

/** Compatibilidad: devuelve solo los bloques ocupados. */
export async function googleBusy(timeMin, timeMax) {
  const result = await googleBusyDetailed(timeMin, timeMax);
  return result.busy;
}

function eventBody(event, settings) {
  const body = {
    summary: event.title,
    description: [event.result && `Resultado esperado: ${event.result}`, event.notes].filter(Boolean).join('\n'),
    location: event.context || '',
    start: { dateTime: event.start, timeZone: settings.timezone },
    end: { dateTime: event.end, timeZone: settings.timezone },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: Math.min(40320, Math.max(0, Number(event.reminderMin || 10))) }]
    }
  };
  if (Array.isArray(event.attendees) && event.attendees.length) {
    body.attendees = event.attendees.filter((email) => /@/.test(String(email))).map((email) => ({ email }));
  }
  return body;
}

export async function createGoogleEvent(event, target = store.get().settings.defaultGoogle) {
  if (!target) return null;
  const data = store.get();
  const connection = data.googleConnections.find((item) => item.id === target.connectionId);
  if (!connection) return null;
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(target.calendarId)}/events?sendUpdates=all`;
  const json = await googleFetch(connection, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(eventBody(event, data.settings))
  });
  return {
    connectionId: connection.id,
    calendarId: target.calendarId,
    eventId: json.id,
    htmlLink: json.htmlLink,
    createdAt: new Date().toISOString()
  };
}

export async function updateGoogleEvent(link, event) {
  if (!link?.connectionId || !link?.calendarId || !link?.eventId) return null;
  const data = store.get();
  const connection = data.googleConnections.find((item) => item.id === link.connectionId);
  if (!connection) return null;
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(link.calendarId)}/events/${encodeURIComponent(link.eventId)}?sendUpdates=all`;
  try {
    const json = await googleFetch(connection, url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(eventBody(event, data.settings))
    });
    return { ...link, updatedAt: json.updated || new Date().toISOString(), htmlLink: json.htmlLink || link.htmlLink };
  } catch (error) {
    if (error instanceof GoogleNotFoundError || error instanceof GoogleGoneError) {
      // El evento fue borrado en Google: lo reflejamos localmente.
      throw error;
    }
    throw error;
  }
}

export async function deleteGoogleEvent(link, { sendUpdates = 'all' } = {}) {
  if (!link?.connectionId || !link?.calendarId || !link?.eventId) return { deleted: false, reason: 'sin vínculo' };
  const data = store.get();
  const connection = data.googleConnections.find((item) => item.id === link.connectionId);
  if (!connection) return { deleted: false, reason: 'conexión ausente' };
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(link.calendarId)}/events/${encodeURIComponent(link.eventId)}?sendUpdates=${encodeURIComponent(sendUpdates)}`;
  try {
    await googleFetch(connection, url, { method: 'DELETE', allow404: true });
    return { deleted: true, alreadyDeleted: false };
  } catch (error) {
    if (error instanceof GoogleNotFoundError || error instanceof GoogleGoneError) {
      return { deleted: true, alreadyDeleted: true };
    }
    throw error;
  }
}

/** Resuelve un evento de Google por id (para reconciliación puntual). */
export async function getGoogleEvent(connectionId, calendarId, eventId) {
  const connection = store.get().googleConnections.find((item) => item.id === connectionId);
  if (!connection) return null;
  try {
    return await googleFetch(connection, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { allow404: true });
  } catch (error) {
    if (error instanceof GoogleNotFoundError) return { __notFound: true };
    throw error;
  }
}

function googleDateTimeToLocal(value, tz) {
  if (!value) return null;
  if (value.date) return isoAtLocal(value.date, '00:00', tz);
  if (value.dateTime) return value.dateTime;
  return null;
}

const SYNC_LOCKS = new Set();

/**
 * Sincroniza una conexión/calendario: pull incremental (syncToken) + push de
 * eventos locales sin vínculo.
 */
export async function syncCalendarConnection(connectionId, calendarId, { data = store.get() } = {}) {
  const lockKey = `${connectionId}:${calendarId}`;
  if (SYNC_LOCKS.has(lockKey)) return { skipped: true, reason: 'sync en curso' };
  SYNC_LOCKS.add(lockKey);
  const tz = timezoneOf(data.settings);
  const summary = { connectionId, calendarId, pushed: 0, pulled: 0, updated: 0, cancelled: 0, errors: [], fullResync: false, syncToken: null };
  try {
    const connection = data.googleConnections.find((item) => item.id === connectionId);
    if (!connection) throw new Error('Conexión Google no encontrada');
    if (!data.googleSync) data.googleSync = {};
    if (!data.googleSync[connectionId]) data.googleSync[connectionId] = { calendars: {} };
    if (!data.googleSync[connectionId].calendars) data.googleSync[connectionId].calendars = {};
    const state = data.googleSync[connectionId].calendars[calendarId] || {};

    let items = [];
    let nextSyncToken = null;
    const now = Date.now();
    try {
      const result = await listCalendarEvents(connection, calendarId, {
        syncToken: state.syncToken || undefined,
        timeMin: state.syncToken ? undefined : new Date(now - 30 * 86400000).toISOString(),
        timeMax: state.syncToken ? undefined : new Date(now + 120 * 86400000).toISOString(),
        showDeleted: true
      });
      items = result.items;
      nextSyncToken = result.nextSyncToken;
    } catch (error) {
      if (!(error instanceof GoogleGoneError)) throw error;
      // 410 GONE: el syncToken ya no sirve; resync completo.
      summary.fullResync = true;
      const result = await listCalendarEvents(connection, calendarId, {
        timeMin: new Date(now - 30 * 86400000).toISOString(),
        timeMax: new Date(now + 120 * 86400000).toISOString(),
        showDeleted: true
      });
      items = result.items;
      nextSyncToken = result.nextSyncToken;
    }

    for (const item of items) {
      const googleUpdated = item.updated ? new Date(item.updated).getTime() : 0;
      const local = data.agenda.find((event) => event.google?.eventId === item.id
        && event.google?.connectionId === connectionId && event.google?.calendarId === calendarId);
      if (!local) continue;
      summary.pulled += 1;
      if (item.status === 'cancelled') {
        if (local.status !== 'Cancelada') {
          local.status = 'Cancelada';
          local.cancelledAt = new Date().toISOString();
          local.externalChange = 'deleted';
          summary.cancelled += 1;
          addActivity('integration', `Google canceló ${local.id}: ${local.title}`);
        }
        continue;
      }
      const localUpdated = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
      const googleChanged = googleUpdated && googleUpdated > localUpdated + 1000;
      if (!googleChanged) continue;
      const start = googleDateTimeToLocal(item.start, tz);
      const end = googleDateTimeToLocal(item.end, tz);
      if (start && end && minutesBetween(start, end) > 0) {
        local.start = start;
        local.end = end;
        local.plannedMin = minutesBetween(start, end);
        local.due = dateKeyOfIso(start, tz) || local.due;
      }
      if (item.summary) local.title = item.summary;
      if (typeof item.description === 'string') local.notes = item.description;
      if (item.location) local.context = item.location;
      local.googleUpdatedAt = item.updated || new Date().toISOString();
      local.lastExternalSyncAt = new Date().toISOString();
      local.externalChange = 'updated';
      summary.updated += 1;
      addActivity('integration', `Google actualizó ${local.id}: ${local.title}`);
    }

    data.googleSync[connectionId].calendars[calendarId] = {
      ...state,
      syncToken: nextSyncToken || state.syncToken || null,
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      itemCount: items.length
    };
    connection.sync = {
      ...(connection.sync || {}),
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      calendars: {
        ...(connection.sync?.calendars || {}),
        [calendarId]: { lastSyncAt: new Date().toISOString(), itemCount: items.length, fullResync: summary.fullResync }
      }
    };
    summary.syncToken = data.googleSync[connectionId].calendars[calendarId].syncToken;
    await store.mutate(() => {}).catch(() => {});
    return summary;
  } catch (error) {
    summary.errors.push({ code: error.code || 'SYNC_ERROR', message: error.message });
    await store.mutate((current) => {
      const connection = current.googleConnections.find((item) => item.id === connectionId);
      if (connection) {
        connection.sync = { ...(connection.sync || {}), lastSyncAt: new Date().toISOString(), lastError: error.message };
      }
      if (current.googleSync?.[connectionId]?.calendars?.[calendarId]) {
        current.googleSync[connectionId].calendars[calendarId].lastError = error.message;
      }
    }).catch(() => {});
    return summary;
  } finally {
    SYNC_LOCKS.delete(lockKey);
  }
}

/** Empuja a Google eventos locales que aún no tienen vínculo. */
export async function pushUnsyncedEvents({ data = store.get(), limit = 40 } = {}) {
  const result = { pushed: 0, errors: [], skipped: 0 };
  if (!data.settings.autoSyncGoogle || !data.settings.defaultGoogle) return result;
  const now = Date.now();
  const candidates = data.agenda
    .filter((event) => event && event.calendar !== false && !event.google && event.status !== 'Cancelada'
      && event.start && new Date(event.start).getTime() >= now - 86400000
      && new Date(event.start).getTime() <= now + 120 * 86400000)
    .slice(0, limit);
  for (const event of candidates) {
    try {
      const link = await createGoogleEvent(event);
      if (link) {
        event.google = link;
        delete event.syncError;
        result.pushed += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      event.syncError = error.message;
      result.errors.push({ id: event.id, message: error.message, code: error.code || null });
    }
  }
  return result;
}

let reconcileRunning = false;

/**
 * Job de reconciliación: push de pendientes + pull incremental por calendario.
 * Es idempotente y seguro de llamar desde scheduler y desde el tick interno.
 */
export async function reconcileGoogle({ data = store.get(), force = false } = {}) {
  if (reconcileRunning && !force) return { skipped: true, reason: 'reconciliación en curso' };
  reconcileRunning = true;
  const startedAt = Date.now();
  const report = { startedAt: new Date(startedAt).toISOString(), pushed: 0, pulled: 0, updated: 0, cancelled: 0, errors: [], connections: 0, calendars: 0 };
  try {
    if (data.settings.googleSyncEnabled === false) return { ...report, disabled: true };
    report.pushed = (await pushUnsyncedEvents({ data })).pushed;
    for (const connection of data.googleConnections) {
      report.connections += 1;
      const calendars = selectedCalendarsFor(data, connection);
      for (const calendarId of calendars) {
        report.calendars += 1;
        const summary = await syncCalendarConnection(connection.id, calendarId, { data });
        report.pulled += summary.pulled || 0;
        report.updated += summary.updated || 0;
        report.cancelled += summary.cancelled || 0;
        for (const error of summary.errors || []) report.errors.push({ connectionId: connection.id, calendarId, ...error });
      }
    }
    report.ok = report.errors.length === 0;
    report.durationMs = Date.now() - startedAt;
    data.googleSyncStatus = {
      lastRunAt: new Date().toISOString(),
      durationMs: report.durationMs,
      pushed: report.pushed,
      pulled: report.pulled,
      updated: report.updated,
      cancelled: report.cancelled,
      errors: report.errors,
      ok: report.ok
    };
    await store.mutate(() => {}).catch(() => {});
    return report;
  } finally {
    reconcileRunning = false;
  }
}

let reconcilerTimer = null;
let lastReconcileAt = 0;

/**
 * Arranca el job horario de reconciliación Google (idempotente).
 * Respeta `settings.syncIntervalMin` (mínimo 5 minutos).
 * @returns {() => void} función para detenerlo
 */
export function startGoogleReconciler() {
  if (reconcilerTimer) return () => stopGoogleReconciler();
  reconcilerTimer = setInterval(() => {
    const data = store.get();
    if (data.settings.googleSyncEnabled === false) return;
    if (!data.googleConnections?.length) return;
    const intervalMin = Math.max(5, Number(data.settings.syncIntervalMin || 60));
    if (Date.now() - lastReconcileAt < intervalMin * 60000) return;
    lastReconcileAt = Date.now();
    reconcileGoogle().catch((error) => console.error('google-reconcile', error.message));
  }, 60_000);
  if (typeof reconcilerTimer.unref === 'function') reconcilerTimer.unref();
  return () => stopGoogleReconciler();
}

export function stopGoogleReconciler() {
  if (reconcilerTimer) clearInterval(reconcilerTimer);
  reconcilerTimer = null;
}

export function ensureGoogleReconciler() {
  return startGoogleReconciler();
}

export function googleSyncStatus() {
  const data = store.get();
  return {
    enabled: data.settings.googleSyncEnabled !== false,
    intervalMin: Math.max(5, Number(data.settings.syncIntervalMin || 60)),
    lastRunAt: data.googleSyncStatus?.lastRunAt || null,
    ok: data.googleSyncStatus?.ok ?? null,
    errors: data.googleSyncStatus?.errors || [],
    connections: data.googleConnections.length
  };
}

function encodeRFC2047(value) {
  return /[^\x00-\x7F]/.test(value) ? `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=` : value;
}

export async function sendGmail({ to, subject, body, connectionId }) {
  const data = store.get();
  const connection = data.googleConnections.find((item) => item.id === (connectionId || data.settings.defaultGoogle?.connectionId)) || data.googleConnections[0];
  if (!connection) throw new Error('Conecta una cuenta Google para enviar correo.');
  if (!/@/.test(String(to || ''))) throw new Error('Destinatario de correo inválido.');
  const raw = [
    `To: ${to}`,
    `Subject: ${encodeRFC2047(String(subject || ''))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(body || '')
  ].join('\r\n');
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  const json = await googleFetch(connection, `${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw: encoded })
  });
  addActivity('email', `Correo enviado a ${to}: ${subject}`);
  return json;
}

/** Borra la caché de eventos de día completo (tests). */
export function clearGoogleCaches() {
  allDayCache.clear();
}

export { CALENDAR_API, GMAIL_API, TOKEN_URL };


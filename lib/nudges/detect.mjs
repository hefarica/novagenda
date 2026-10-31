/**
 * Detectores de avisos inteligentes (t16).
 *
 * Cada detector devuelve candidatos con hechos verificados y factores para
 * priorizar (días vencidos, minutos hasta la cita, esfuerzo estimado…). No
 * envía nada ni escribe en el store: eso lo decide `engine.mjs`.
 *
 * Todos los detectores son tolerantes a datos corruptos: una cita con fecha
 * inválida se ignora, nunca lanza.
 */
import {
  dateKeyOfIso, isValidDateKey, isValidIso, minutesBetween, timeKeyOf, timezoneOf
} from '../agenda/time.mjs';
import { findSlotsDetailed } from '../agenda/conflicts.mjs';

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function safeMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function localMinutes(time) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function daysBetween(fromKey, toKey) {
  const a = Date.parse(`${fromKey}T12:00:00Z`);
  const b = Date.parse(`${toKey}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function eventMinutes(event) {
  try {
    if (!isValidIso(event.start) || !isValidIso(event.end)) return 0;
    return Math.max(0, minutesBetween(event.start, event.end));
  } catch {
    return 0;
  }
}

/** ¿La cita ya tiene lugar, sala o enlace de videollamada? */
export function hasPlace(event) {
  const candidates = [
    event.location, event.place, event.room, event.context, event.meet, event.meetLink,
    event.meetingUrl, event.conference, event.videoCall, event.google?.hangoutLink,
    event.google?.location
  ];
  const text = candidates.filter((value) => typeof value === 'string' && value.trim()).join(' ');
  if (!text) return false;
  return /(https?:\/\/|meet\.google|zoom|teams|webex|whereby|jitsi|presencial|oficina|sala|direcci[oó]n|domicilio|lugar)/i.test(text);
}

function isMeetingEvent(event) {
  const type = String(event.type || '');
  if (/reuni|meet|llamada|video|1:1|daily|weekly|comit[eé]/i.test(type)) return true;
  return Array.isArray(event.attendees) && event.attendees.length > 0;
}

function isOpen(event) {
  return event.status !== 'Hecho' && event.status !== 'Cancelada';
}

/* ------------------------------------------------------------------ */
/* Detectores                                                          */
/* ------------------------------------------------------------------ */

function detectOverdue(data, { dateKey }) {
  const items = [];
  const events = safeArray(data.agenda);
  for (const event of events) {
    if (!event.id || !isOpen(event)) continue;
    if (!isValidDateKey(event.due)) continue;
    if (event.due >= dateKey) continue;
    items.push({
      type: 'overdue',
      id: event.id,
      eventId: event.id,
      title: String(event.title || 'Cita').slice(0, 120),
      due: event.due,
      daysOverdue: daysBetween(event.due, dateKey),
      priority: event.priority || null,
      effortMin: Number(event.plannedMin) || 30
    });
    if (items.length >= 8) break;
  }
  return items.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

function detectImapNew(data) {
  const accounts = safeArray(data.imapAccounts);
  const items = [];
  for (const account of accounts) {
    const count = Number(account?.newCount) || 0;
    if (count <= 0) continue;
    items.push({
      type: 'imap_new',
      id: `imap-new-${account.id}`,
      title: `${count} correo${count === 1 ? '' : 's'} nuevo${count === 1 ? '' : 's'} en ${account.label || account.email || 'bandeja'}`,
      accountId: account.id,
      email: account.email || null,
      count,
      effortMin: 10
    });
  }
  return items.slice(0, 3);
}
function detectTasks(data, { dateKey }) {
  const tasks = safeArray(data.tasks).filter((task) => task && task.status === 'open' && task.due);
  const items = [];
  for (const task of tasks) {
    if (!isValidDateKey(task.due)) continue;
    const base = {
      taskId: task.id,
      due: task.due,
      owner: task.owner || null,
      effortMin: 15
    };
    if (task.due < dateKey) {
      items.push({
        ...base,
        type: 'task_overdue',
        id: `task-overdue-${task.id}`,
        title: `Tarea vencida: ${task.title}`,
        daysOverdue: daysBetween(task.due, dateKey)
      });
    } else if (task.due === dateKey) {
      items.push({
        ...base,
        type: 'task_due',
        id: `task-due-${task.id}`,
        title: `Tarea para hoy: ${task.title}`
      });
    }
  }
  return items.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0) || a.title.localeCompare(b.title)).slice(0, 5);
}
function detectUndated(data) {
  const items = [];
  for (const entry of safeArray(data.inbox)) {
    if (entry.processed === true || entry.actionable === false) continue;
    if (isValidDateKey(entry.due)) continue;
    items.push({
      type: 'undated',
      id: entry.id || entry.input || String(items.length),
      title: String(entry.title || entry.input || 'Captura del inbox').slice(0, 120),
      priority: entry.priority || null,
      effortMin: Number(entry.estimatedMin) || 20,
      count: 1
    });
    if (items.length >= 6) break;
  }
  return items;
}

async function detectFreeGap(data, settings, now, config) {
  try {
    const result = await findSlotsDetailed({
      durationMin: config.freeGapMin,
      fromIso: now.toISOString(),
      days: 1,
      count: 1,
      data,
      settings,
      includeGoogle: false
    });
    const slot = result.slots?.[0];
    if (!slot) return [];
    const startMs = safeMs(slot.start);
    if (startMs === null || startMs < now.getTime() - 5 * 60_000) return [];
    return [{
      type: 'free_gap',
      id: `gap-${slot.start}`,
      title: `hueco de ${config.freeGapMin} min`,
      start: slot.start,
      end: slot.end,
      minutes: config.freeGapMin,
      effortMin: 0
    }];
  } catch {
    return [];
  }
}

function detectFocus(data, settings, now, config, { dateKey }) {
  const target = Number(config.focusTargetMin) || Number(settings?.p95?.deepFocusDailyMin) || 120;
  let focusMin = 0;
  for (const event of safeArray(data.agenda)) {
    if (!event.deepFocus || event.status === 'Cancelada') continue;
    if (!isValidIso(event.start)) continue;
    if (dateKeyOfIso(event.start, timezoneOf(settings || {})) !== dateKey) continue;
    focusMin += Math.max(0, Number(event.actualMin) || 0);
  }
  const minutesNow = localMinutes(timeKeyOf(now, timezoneOf(settings || {})));
  const hour = minutesNow === null ? now.getHours() : Math.floor(minutesNow / 60);
  const behind = focusMin < target;
  const relevant = (hour >= 14 && behind) || (hour >= 12 && focusMin < target * 0.4);
  if (!relevant) return [];
  return [{
    type: 'focus_unmet',
    id: `focus-${dateKey}`,
    title: `foco ${focusMin}/${target} min`,
    focusMin,
    target,
    remaining: Math.max(0, target - focusMin),
    effortMin: 0,
    count: 1
  }];
}

function detectMeetingsWithoutPlace(data, now, config, { dateKey, tz }) {
  const lookaheadMs = Math.max(15, Number(config.meetingLookaheadMin) || 180) * 60_000;
  const nowMs = now.getTime();
  const items = [];
  for (const event of safeArray(data.agenda)) {
    if (!event.id || !isOpen(event) || !isValidIso(event.start)) continue;
    if (dateKeyOfIso(event.start, tz) !== dateKey) continue;
    const startMs = safeMs(event.start);
    if (startMs === null || startMs < nowMs - 5 * 60_000 || startMs > nowMs + lookaheadMs) continue;
    if (!isMeetingEvent(event)) continue;
    if (hasPlace(event)) continue;
    items.push({
      type: 'meeting_no_place',
      id: event.id,
      eventId: event.id,
      title: String(event.title || 'Reunión').slice(0, 120),
      start: event.start,
      minutesToStart: Math.max(0, Math.round((startMs - nowMs) / 60_000)),
      effortMin: 5
    });
    if (items.length >= 5) break;
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Aprobaciones de la oficina (si `data.office` ya existe)             */
/* ------------------------------------------------------------------ */

/**
 * Lee propuestas sin decidir desde el estado persistido de `lib/office`.
 * No importa ni inicializa el módulo (evita mutar en dry-run): si la oficina
 * aún no ha creado propuestas, simplemente no hay aviso.
 */
function detectApprovals(data, now) {
  const proposals = Array.isArray(data.office?.proposals) ? data.office.proposals : [];
  const nowMs = now.getTime();
  const rows = proposals
    .filter((proposal) => {
      if (!proposal || typeof proposal !== 'object') return false;
      const status = String(proposal.status || '').toLowerCase();
      if (status !== 'pending' && status !== 'held') return false;
      const expires = Date.parse(proposal.expiresAt || '');
      if (Number.isFinite(expires) && expires < nowMs) return false;
      return true;
    })
    .map((proposal) => {
      const created = safeMs(proposal.createdAt);
      return {
        proposal,
        ageHours: created === null ? 0 : Math.max(0, (nowMs - created) / 3_600_000)
      };
    })
    .sort((a, b) => b.ageHours - a.ageHours);
  if (!rows.length) return [];
  const oldest = rows[0];
  return [{
    type: 'approvals',
    id: 'approvals-pending',
    fingerprint: 'approvals:' + rows.length + ':' + (oldest.proposal.id || 'none'),
    title: String(oldest.proposal.subject || oldest.proposal.kind || 'Propuesta pendiente').slice(0, 120),
    count: rows.length,
    ageHours: Math.round(oldest.ageHours * 10) / 10,
    daysOverdue: Math.floor(oldest.ageHours / 24),
    oldestId: oldest.proposal.id || null,
    proposals: rows.slice(0, 3).map(({ proposal }) => ({
      id: proposal.id || null,
      subject: String(proposal.subject || proposal.kind || '').slice(0, 120),
      level: proposal.level || null
    })),
    effortMin: Math.min(30, 5 * rows.length)
  }];
}

/* ------------------------------------------------------------------ */
/* Mensajes entrantes sin responder                                    */
/* ------------------------------------------------------------------ */

function detectUnanswered(data, now, config) {
  const messages = safeArray(data.channelState?.messages);
  if (!messages.length) return [];
  const nowMs = now.getTime();
  const minAgeMs = Math.max(1, Number(config.unansweredMin) || 30) * 60_000;
  const maxAgeMs = 24 * 3_600_000;
  const outbound = messages.filter((message) => message.direction === 'outbound');
  const groups = new Map();

  for (const inbound of messages) {
    if (inbound.direction !== 'inbound' || inbound.status !== 'received') continue;
    const at = safeMs(inbound.timestamp);
    if (at === null || nowMs - at < minAgeMs || nowMs - at > maxAgeMs) continue;
    const answered = outbound.some((reply) => {
      if (reply.channel !== inbound.channel || reply.userId !== inbound.userId) return false;
      if (reply.replyTo && reply.replyTo === inbound.id) return true;
      const replyAt = safeMs(reply.timestamp);
      return replyAt !== null && replyAt > at && replyAt - at <= 5 * 60_000;
    });
    if (answered) continue;
    const key = `${inbound.channel}:${inbound.userId}`;
    const current = groups.get(key) || { channel: inbound.channel, userId: inbound.userId, count: 0, earliest: at };
    current.count += 1;
    current.earliest = Math.min(current.earliest, at);
    groups.set(key, current);
  }

  return [...groups.values()].slice(0, 4).map((group) => ({
    type: 'unanswered',
    id: `unanswered-${group.channel}-${group.userId}`,
    title: `${group.count} mensaje${group.count === 1 ? '' : 's'} sin responder`,
    channel: group.channel,
    count: group.count,
    since: new Date(group.earliest).toISOString(),
    effortMin: 5
  }));
}

function detectDailyClose(data, now, config, { dateKey, tz }) {
  const nowMinutes = localMinutes(timeKeyOf(now, tz));
  const checkMinutes = localMinutes(config.closeCheckAt);
  if (nowMinutes === null || checkMinutes === null || nowMinutes < checkMinutes) return [];
  const row = safeArray(data.metrics).find((metric) => metric.date === dateKey);
  if (row?.closeDaily === true) return [];
  return [{
    type: 'daily_close',
    id: `close-${dateKey}`,
    title: 'cierre diario pendiente',
    dateKey,
    effortMin: 10
  }];
}

/* ------------------------------------------------------------------ */
/* Entrada única                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reúne todos los candidatos con hechos verificados.
 * @param {{data:any, settings:object, now:Date, config:object}} options
 * @returns {Promise<{items:object[], tz:string, dateKey:string, time:string}>}
 */
export async function collectCandidates({ data, settings, now, config }) {
  const effectiveSettings = settings || data?.settings || {};
  const tz = timezoneOf(effectiveSettings);
  const dateKey = dateKeyOfIso(now.toISOString(), tz);
  const time = timeKeyOf(now, tz);
  const context = { dateKey, tz };
  const items = [];

  items.push(...detectOverdue(data || {}, context));
  items.push(...detectImapNew(data || {}));
  items.push(...detectTasks(data || {}, context));
  items.push(...detectUndated(data || {}));
  items.push(...await detectFreeGap(data || {}, effectiveSettings, now, config));
  items.push(...detectFocus(data || {}, effectiveSettings, now, config, context));
  items.push(...detectMeetingsWithoutPlace(data || {}, now, config, context));
  items.push(...detectApprovals(data || {}, now));
  items.push(...detectUnanswered(data || {}, now, config));
  items.push(...detectDailyClose(data || {}, now, config, context));

  return { items, tz, dateKey, time };
}





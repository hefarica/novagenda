import { addActivity, nextId } from '../store.mjs';
import {
  createGoogleEvent, updateGoogleEvent, deleteGoogleEvent, GoogleNotFoundError, GoogleGoneError
} from '../google.mjs';
import {
  dateKeyOfIso, isValidDateKey, isValidIso, isoAtLocal, minutesBetween, parseDateKey, parseHHMM, timezoneOf
} from './time.mjs';
import {
  clampRating, normalizePriority, priorityScore, withComputedScore
} from './score.mjs';
import { checkConflicts } from './conflicts.mjs';
import { computeEventTravel } from '../travel/plan.mjs';

/**
 * Servicio de eventos de agenda: creación, edición, cancelación y completado.
 *
 * - Valida fechas/rangos y campos (los errores devuelven 400 con code/field).
 * - Recalcula el score de prioridad al crear y al editar.
 * - Sincroniza con Google Calendar al crear/editar/cancelar, y deja
 *   `needsGoogleSync` cuando Google falla para que la reconciliación lo repare.
 * - Nunca asume libre: si FreeBusy falla, devuelve 409 FREEBUSY_UNAVAILABLE
 *   salvo `allowUnverified`.
 */

export class AgendaError extends Error {
  constructor(status, code, message, { field, details } = {}) {
    super(message);
    this.name = 'AgendaError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

export const EDITABLE_EVENT_FIELDS = [
  'title', 'start', 'end', 'type', 'result', 'priority', 'impact', 'urgency', 'energy',
  'status', 'owner', 'reminderMin', 'whatsapp', 'calendar', 'deepFocus', 'context', 'notes',
  'attendees', 'due', 'plannedMin', 'actualMin', 'objective', 'okrId', 'delegable', 'location',
  'placeId', 'travelMode', 'category'
];

const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const ENERGIES = ['Alta', 'Media', 'Baja'];
const STATUSES = ['Pendiente', 'En curso', 'Hecho', 'Cancelada', 'Reprogramada'];

function textField(value, { field, required = false, max = 500, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new AgendaError(400, 'VALIDATION', `${field} es requerido`, { field });
    return undefined;
  }
  if (typeof value !== 'string') throw new AgendaError(400, 'VALIDATION', `${field} debe ser texto`, { field });
  const trimmed = value.trim();
  if (required && !trimmed) throw new AgendaError(400, 'VALIDATION', `${field} no puede estar vacío`, { field });
  if (trimmed.length > max) throw new AgendaError(400, 'VALIDATION', `${field} excede ${max} caracteres`, { field });
  if (trimmed.length < min) throw new AgendaError(400, 'VALIDATION', `${field} debe tener al menos ${min} caracteres`, { field });
  return trimmed;
}

function parseBoolean(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value).trim().toUpperCase();
  if (['SI', 'SÍ', 'TRUE', '1', 'YES'].includes(raw)) return true;
  if (['NO', 'FALSE', '0', 'N'].includes(raw)) return false;
  throw new AgendaError(400, 'VALIDATION', `${field} debe ser booleano`, { field });
}

function parseRating(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    throw new AgendaError(400, 'VALIDATION', `${field} debe estar entre 1 y 5`, { field });
  }
  return Math.round(n);
}

/** Convierte fecha+hora en un payload de creación, si el cliente usa ese formato. */
export function expandDateFields(payload, settings) {
  const tz = timezoneOf(settings);
  if (payload?.start || !payload?.date) return payload;
  const date = String(payload.date);
  if (!isValidDateKey(date)) return payload;
  const time = parseHHMM(payload.time || payload.hora)?.hhmm || '09:00';
  const duration = Math.max(5, Math.round(Number(payload.durationMin || settings?.defaultDurationMin || 60)));
  return {
    ...payload,
    start: isoAtLocal(date, time, tz),
    end: isoAtLocal(date, addMinutesSafe(time, duration), tz)
  };
}

function addMinutesSafe(hhmm, duration) {
  const parsed = parseHHMM(hhmm) || { minutes: 540 };
  const total = (parsed.minutes + duration) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Valida y normaliza un payload de evento.
 * @param {object} payload
 * @param {{partial?:boolean, current?:object, settings?:object}} options
 * @returns {object} campos normalizados listos para aplicar
 */
export function validateEventPayload(payload, { partial = false, current = null, settings = {} } = {}) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const allowed = new Set([...EDITABLE_EVENT_FIELDS, 'date', 'time', 'hora', 'durationMin', 'score']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new AgendaError(400, 'UNKNOWN_FIELD', `Campo no editable: ${key}`, { field: key });
  }
  const out = {};
  if (input.title !== undefined) out.title = textField(input.title, { field: 'title', required: !partial, max: 200, min: 1 });
  for (const [field, max] of [['result', 500], ['type', 50], ['energy', 20], ['owner', 120], ['context', 200], ['notes', 2000], ['objective', 300], ['okrId', 80], ['category', 80], ['location', 300], ['placeId', 64]]) {
    if (input[field] !== undefined) out[field] = textField(input[field], { field, max });
  }
  if (input.travelMode !== undefined) {
    const mode = String(input.travelMode || 'auto').trim().toLowerCase();
    if (!['auto', 'urbano', 'mixto', 'carretera'].includes(mode)) {
      throw new AgendaError(400, 'VALIDATION', 'travelMode debe ser auto/urbano/mixto/carretera', { field: 'travelMode' });
    }
    out.travelMode = mode;
  }
  if (out.energy && !ENERGIES.includes(out.energy)) {
    throw new AgendaError(400, 'VALIDATION', `energy debe ser ${ENERGIES.join('/')}`, { field: 'energy' });
  }
  if (input.priority !== undefined) {
    const raw = String(input.priority ?? '').trim();
    if (raw.length > 20) throw new AgendaError(400, 'VALIDATION', 'priority excede 20 caracteres', { field: 'priority' });
    // P1/P2/P3 tienen puntos propios; cualquier otro valor (P4, "otro") vale 2.
    out.priority = normalizePriority(raw, raw || 'P2');
  }
  if (input.impact !== undefined) out.impact = parseRating(input.impact, 'impact', 3);
  if (input.urgency !== undefined) out.urgency = parseRating(input.urgency, 'urgency', 3);
  if (input.deepFocus !== undefined) out.deepFocus = parseBoolean(input.deepFocus, 'deepFocus', false);
  if (input.whatsapp !== undefined) out.whatsapp = parseBoolean(input.whatsapp, 'whatsapp', true);
  if (input.calendar !== undefined) out.calendar = parseBoolean(input.calendar, 'calendar', true);
  if (input.delegable !== undefined) out.delegable = parseBoolean(input.delegable, 'delegable', false);
  if (input.reminderMin !== undefined) {
    const n = Number(input.reminderMin);
    if (!Number.isFinite(n) || n < 0 || n > 40320) throw new AgendaError(400, 'VALIDATION', 'reminderMin debe estar entre 0 y 40320', { field: 'reminderMin' });
    out.reminderMin = Math.round(n);
  }
  if (input.actualMin !== undefined) {
    const n = Number(input.actualMin);
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw new AgendaError(400, 'VALIDATION', 'actualMin debe estar entre 0 y 1440', { field: 'actualMin' });
    out.actualMin = Math.round(n);
  }
  if (input.plannedMin !== undefined) {
    const n = Number(input.plannedMin);
    if (!Number.isFinite(n) || n < 1 || n > 44640) throw new AgendaError(400, 'VALIDATION', 'plannedMin debe estar entre 1 y 44640', { field: 'plannedMin' });
    out.plannedMin = Math.round(n);
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new AgendaError(400, 'VALIDATION', `status inválido. Valores: ${STATUSES.join(', ')}`, { field: 'status' });
    out.status = input.status;
  }
  if (input.due !== undefined && input.due !== null && input.due !== '') {
    if (!isValidDateKey(input.due)) throw new AgendaError(400, 'INVALID_DATE', 'due debe ser YYYY-MM-DD válido', { field: 'due' });
    out.due = input.due;
  }
  if (input.attendees !== undefined) {
    if (!Array.isArray(input.attendees)) throw new AgendaError(400, 'VALIDATION', 'attendees debe ser un array', { field: 'attendees' });
    out.attendees = input.attendees.map((email) => String(email).trim()).filter(Boolean);
    for (const email of out.attendees) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new AgendaError(400, 'VALIDATION', `Correo inválido: ${email}`, { field: 'attendees' });
      }
    }
  }

  // Fechas: ISO con offset/Z, naïve interpretada en la zona configurada,
  // o se expande date+time.
  const expanded = expandDateFields({ ...input, ...out }, settings);
  const normalizeIso = (value, field) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgendaError(400, 'INVALID_DATE', `${field} debe ser una fecha ISO válida`, { field });
    }
    const raw = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
      const dateKey = raw.slice(0, 10);
      const time = raw.slice(11, 16);
      if (!parseDateKey(dateKey) || !isValidIso(raw)) {
        throw new AgendaError(400, 'INVALID_DATE', `${field} no es una fecha real`, { field });
      }
      return isoAtLocal(dateKey, time, timezoneOf(settings));
    }
    if (!isValidIso(raw)) throw new AgendaError(400, 'INVALID_DATE', `${field} debe ser una fecha ISO válida`, { field });
    return raw;
  };
  if (expanded.start !== undefined) out.start = normalizeIso(expanded.start, 'start');
  if (expanded.end !== undefined) out.end = normalizeIso(expanded.end, 'end');

  if (partial) {
    // start/end se validan juntos contra el evento actual.
    const start = out.start ?? current?.start;
    const end = out.end ?? current?.end;
    if (out.start && !out.end && current?.end) {
      const duration = minutesBetween(current.start, current.end);
      if (Number.isFinite(duration) && duration > 0) {
        out.end = new Date(new Date(out.start).getTime() + duration * 60000).toISOString();
      }
    }
    if (!isValidIso(start) || !isValidIso(end)) throw new AgendaError(400, 'INVALID_DATE', 'start/end inválidos', { field: 'start' });
    if (minutesBetween(out.start ?? start, out.end ?? end) <= 0) {
      throw new AgendaError(400, 'INVALID_RANGE', 'end debe ser posterior a start', { field: 'end' });
    }
  } else {
    if (!out.title) throw new AgendaError(400, 'REQUIRED', 'title es requerido', { field: 'title' });
    if (!out.start) throw new AgendaError(400, 'REQUIRED', 'start es requerido', { field: 'start' });
    if (!out.end) throw new AgendaError(400, 'REQUIRED', 'end es requerido', { field: 'end' });
    const duration = minutesBetween(out.start, out.end);
    if (duration <= 0) throw new AgendaError(400, 'INVALID_RANGE', 'end debe ser posterior a start', { field: 'end' });
    if (duration > 31 * 1440) throw new AgendaError(400, 'INVALID_RANGE', 'La duración máxima es 31 días', { field: 'end' });
  }
  return out;
}

function baseEventFields(payload, settings, tz) {
  const type = payload.type || 'Compromiso';
  const deepFocus = payload.deepFocus ?? (String(type).toLowerCase() === 'foco');
  const start = payload.start;
  const end = payload.end;
  return {
    title: payload.title,
    start,
    end,
    type,
    result: payload.result || '',
    priority: payload.priority || 'P2',
    impact: payload.impact ?? 3,
    urgency: payload.urgency ?? 3,
    energy: payload.energy || 'Media',
    status: payload.status || 'Pendiente',
    owner: payload.owner || 'Yo',
    reminderMin: payload.reminderMin ?? settings.reminderMin ?? 10,
    whatsapp: payload.whatsapp !== false,
    calendar: payload.calendar !== false,
    due: payload.due || dateKeyOfIso(start, tz),
    plannedMin: minutesBetween(start, end),
    actualMin: payload.actualMin ?? 0,
    deepFocus: !!deepFocus,
    context: payload.context || (deepFocus ? 'Sin interrupciones' : ''),
    notes: payload.notes || '',
    location: payload.location || '',
    placeId: payload.placeId || '',
    travelMode: payload.travelMode || 'auto',
    objective: payload.objective || '',
    okrId: payload.okrId || '',
    category: payload.category || '',
    delegable: !!payload.delegable,
    attendees: Array.isArray(payload.attendees) ? payload.attendees : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function syncCreate(event, settings) {
  if (!settings.autoSyncGoogle || !settings.defaultGoogle || event.calendar === false) return;
  try {
    event.google = await createGoogleEvent(event);
    delete event.syncError;
  } catch (error) {
    event.syncError = error.message;
    event.needsGoogleSync = true;
  }
}

/** Sincroniza un evento recién creado (usado por materialización de rutinas). */
export async function syncNewEventToGoogle(event, settings) {
  return syncCreate(event, settings);
}

async function syncUpdate(event, settings) {
  if (event.calendar === false) return;
  try {
    if (event.google) {
      event.google = await updateGoogleEvent(event.google, event) || event.google;
      delete event.syncError;
      delete event.needsGoogleSync;
    } else if (settings.autoSyncGoogle && settings.defaultGoogle) {
      await syncCreate(event, settings);
    }
  } catch (error) {
    if (error instanceof GoogleNotFoundError || error instanceof GoogleGoneError) {
      // Borrado en Google: se recrea para no perder el compromiso.
      event.google = null;
      event.googleMissingAt = new Date().toISOString();
      await syncCreate(event, settings);
      return;
    }
    event.syncError = error.message;
    event.needsGoogleSync = true;
  }
}

/**
 * Adjunta `travel`/`travelWarning` a un evento con lugar. Nunca bloquea ni
 * tumba la creación: si el motor de viajes falla, se guarda el evento igual.
 */
async function applyTravelContext(event, data, settings) {
  if (!event?.location) {
    delete event.travel;
    delete event.travelWarning;
    return;
  }
  try {
    const travel = await computeEventTravel({ data, settings, event });
    if (travel) {
      event.travel = travel;
      if (travel.warning) event.travelWarning = travel.warning;
      else delete event.travelWarning;
    }
  } catch (error) {
    event.travel = { resolved: false, feasible: null, error: String(error.message || error).slice(0, 300) };
  }
}

/**
 * Crea una cita.
 * @returns {Promise<{ok:true,event:object}|{ok:false,status:number,code:string,error:string,field?:string,conflicts?:Array,errors?:Array}>}
 */
export async function createAgendaEvent({
  data, settings, payload, check = true, force = false, allowUnverified = false, syncGoogle = true
} = {}) {
  const effectiveSettings = settings || data.settings || {};
  const tz = timezoneOf(effectiveSettings);
  let fields;
  try {
    fields = validateEventPayload(payload, { partial: false, settings: effectiveSettings });
  } catch (error) {
    return errorResult(error);
  }
  const event = { ...baseEventFields(fields, effectiveSettings, tz) };
  event.score = priorityScore(event);
  await applyTravelContext(event, data, effectiveSettings);

  if (check) {
    const conflicts = await checkConflicts({ data, settings: effectiveSettings, start: event.start, end: event.end });
    if (conflicts.conflictCount > 0 && !force) {
      return { ok: false, status: 409, code: 'CONFLICT', error: 'Ese horario se cruza con otro compromiso', conflicts: conflicts.conflicts };
    }
    if (conflicts.errors.length > 0 && !allowUnverified && !force) {
      return { ok: false, status: 409, code: 'FREEBUSY_UNAVAILABLE', error: 'No se pudo verificar Google Calendar; confirma con allowUnverified=true', errors: conflicts.errors };
    }
  }

  event.id = nextId('AG', data.agenda);
  if (syncGoogle) await syncCreate(event, effectiveSettings);
  data.agenda.push(event);
  addActivity('calendar', `Cita creada: ${event.title}`, { agendaId: event.id });
  return { ok: true, event };
}

function errorResult(error) {
  if (error instanceof AgendaError) {
    return { ok: false, status: error.status, code: error.code, error: error.message, field: error.field, details: error.details };
  }
  throw error;
}

/**
 * Edita una cita existente. Recalcula score y sincroniza Google.
 */
export async function patchAgendaEvent({
  data, settings, id, patch, check = true, force = false, allowUnverified = false, syncGoogle = true
} = {}) {
  const effectiveSettings = settings || data.settings || {};
  const event = data.agenda.find((item) => item.id === id);
  if (!event) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré ${id}` };
  let fields;
  try {
    fields = validateEventPayload(patch, { partial: true, current: event, settings: effectiveSettings });
  } catch (error) {
    return errorResult(error);
  }

  const previous = { ...event };
  const timeChanged = (fields.start && fields.start !== event.start) || (fields.end && fields.end !== event.end);
  if (timeChanged && check) {
    const start = fields.start || event.start;
    const end = fields.end || event.end;
    const conflicts = await checkConflicts({ data, settings: effectiveSettings, start, end, ignoreIds: [event.id] });
    if (conflicts.conflictCount > 0 && !force) {
      return { ok: false, status: 409, code: 'CONFLICT', error: 'El nuevo horario se cruza con otro compromiso', conflicts: conflicts.conflicts };
    }
    if (conflicts.errors.length > 0 && !allowUnverified && !force) {
      return { ok: false, status: 409, code: 'FREEBUSY_UNAVAILABLE', error: 'No se pudo verificar Google Calendar; confirma con allowUnverified=true', errors: conflicts.errors };
    }
  }

  const cancelling = fields.status === 'Cancelada' && previous.status !== 'Cancelada';
  Object.assign(event, fields);
  if (fields.start || fields.end) {
    event.plannedMin = minutesBetween(event.start, event.end);
    if (!fields.due) event.due = dateKeyOfIso(event.start, timezoneOf(effectiveSettings));
  }
  if (fields.type && fields.deepFocus === undefined && String(fields.type).toLowerCase() === 'foco') event.deepFocus = true;
  if (fields.status === 'Hecho') {
    event.completedAt = event.completedAt || new Date().toISOString();
    if (fields.actualMin === undefined && !event.actualMin) event.actualMin = event.plannedMin;
  } else if (fields.status && previous.status === 'Hecho') {
    delete event.completedAt;
  }
  if (cancelling) {
    event.cancelledAt = new Date().toISOString();
  }
  event.score = priorityScore(event);
  event.updatedAt = new Date().toISOString();

  if (fields.location !== undefined || fields.placeId !== undefined || fields.travelMode !== undefined
    || fields.start !== undefined || fields.end !== undefined) {
    await applyTravelContext(event, data, effectiveSettings);
  }

  if (syncGoogle) {
    if (cancelling) {
      if (event.google) {
        try {
          await deleteGoogleEvent(event.google);
          event.lastGoogleEvent = event.google;
          event.google = null;
          delete event.syncError;
          delete event.pendingGoogleDelete;
        } catch (error) {
          event.syncError = error.message;
          event.pendingGoogleDelete = true;
        }
      }
    } else {
      await syncUpdate(event, effectiveSettings);
    }
  }
  addActivity('calendar', `Cita editada: ${event.title}`, { agendaId: event.id });
  return { ok: true, event, changed: Object.keys(fields), previous };
}

/**
 * Cancela una cita: estado local + borrado en Google Calendar.
 */
export async function cancelAgendaEvent({ data, settings, id, syncGoogle = true } = {}) {
  const effectiveSettings = settings || data.settings || {};
  const event = data.agenda.find((item) => item.id === id);
  if (!event) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré ${id}` };
  if (event.status !== 'Cancelada') {
    event.status = 'Cancelada';
    event.cancelledAt = new Date().toISOString();
    event.updatedAt = new Date().toISOString();
  }
  let google = { deleted: false, reason: 'sin vínculo' };
  if (syncGoogle && event.google) {
    try {
      google = await deleteGoogleEvent(event.google);
      event.lastGoogleEvent = event.google;
      event.google = null;
      delete event.syncError;
      delete event.pendingGoogleDelete;
    } catch (error) {
      event.syncError = error.message;
      event.pendingGoogleDelete = true;
      google = { deleted: false, error: error.message };
    }
  }
  addActivity('calendar', `Cita cancelada: ${event.title}`, { agendaId: event.id });
  return { ok: true, event, google };
}

/** Marca una cita como Hecho con minutos reales. */
export function completeAgendaEvent({ data, settings, id, actualMin, notes } = {}) {
  const event = data.agenda.find((item) => item.id === id);
  if (!event) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré ${id}` };
  if (actualMin !== undefined) {
    const n = Number(actualMin);
    if (!Number.isFinite(n) || n < 0 || n > 1440) return { ok: false, status: 400, code: 'VALIDATION', error: 'actualMin debe estar entre 0 y 1440', field: 'actualMin' };
    event.actualMin = Math.round(n);
  } else if (!event.actualMin) {
    event.actualMin = event.plannedMin || minutesBetween(event.start, event.end);
  }
  event.status = 'Hecho';
  event.completedAt = new Date().toISOString();
  event.updatedAt = event.completedAt;
  if (notes !== undefined) event.notes = String(notes).slice(0, 2000);
  event.score = priorityScore(event);
  addActivity('task', `${event.id} marcado como Hecho`, { agendaId: event.id });
  return { ok: true, event };
}

/** Borrado físico (la UI usa cancelar; se conserva para limpieza explícita). */
export function deleteAgendaEventHard({ data, id } = {}) {
  const index = data.agenda.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré ${id}` };
  const [event] = data.agenda.splice(index, 1);
  addActivity('calendar', `Cita eliminada: ${event.title}`, { agendaId: event.id });
  return { ok: true, event };
}

/** Vista de evento lista para API/UI (score recalculado). */
export function presentEvent(event) {
  if (!event) return event;
  return {
    ...withComputedScore(event),
    google: event.google || null,
    syncError: event.syncError || null,
    travel: event.travel || null,
    travelWarning: event.travelWarning || null,
    meetLink: event.meetLink || null,
    meet: event.meet || null
  };
}

/** Recalcula el score de toda la agenda. */
export function recalculateAllScores(data) {
  let changed = 0;
  for (const event of data.agenda) {
    const next = priorityScore(event);
    if (event.score !== next) {
      event.score = next;
      changed += 1;
    }
  }
  return changed;
}

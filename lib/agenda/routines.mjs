import { addActivity, nextId } from '../store.mjs';
import {
  addDaysKey, compareDateKeys, dateKeyOfIso, daysBetweenKeys, daysInMonth, isValidDateKey,
  parseDateKey, parseHHMM, timezoneOf, weekEndKey, weekStartKey
} from './time.mjs';
import {
  booleanOf, findMaterializedEvent, inferRoutineRole, isRoutineSkipped, nextRoutineOccurrences,
  normalizeExceptionDates, normalizeFrequency, normalizeRoutine, normalizeTimeValue, ruleMonthDay,
  ruleWeekdays, routineDueOn, routineOccurrencesBetween, routineToEventPayload, routinesFromData
} from './occurrences.mjs';
import { clampRating, normalizePriority, priorityScore } from './score.mjs';
import { syncNewEventToGoogle } from './events.mjs';

/**
 * Servicio de rutinas: CRUD unificado (`kind: 'recurrence' | 'meeting'`),
 * preview, excepciones por fecha, backfill y materialización idempotente.
 *
 * Persistencia: se mantienen las dos colecciones históricas del store
 * (`recurrences` y `meetings`) y la API las expone unificadas. Así no se rompe
 * `/api/bootstrap` ni los datos existentes.
 */

export class RoutineError extends Error {
  constructor(status, code, message, { field, details } = {}) {
    super(message);
    this.name = 'RoutineError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

const FREQUENCIES = ['DIARIA', 'LABORABLES', 'SEMANAL', 'MENSUAL', 'TRIMESTRAL'];
const ROUTINE_FIELDS = new Set([
  'id', 'kind', 'active', 'title', 'name', 'frequency', 'cadence', 'rule', 'time', 'hora',
  'durationMin', 'type', 'result', 'priority', 'impact', 'urgency', 'deepFocus', 'energy',
  'reminderMin', 'whatsapp', 'whatsappReminder', 'calendar', 'owner', 'start', 'startDate',
  'end', 'endDate', 'notes', 'skipHolidays', 'role', 'exceptions', 'skipDates',
  'purpose', 'requiredOutput', 'participants', 'effectiveness', 'preRead', 'agendaLink',
  'lastGenerated', 'createdAt', 'updatedAt', 'deleteGenerated'
]);

function requireText(value, field, { required = false, max = 300 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RoutineError(400, 'VALIDATION', `${field} es requerido`, { field });
    return undefined;
  }
  if (typeof value !== 'string') throw new RoutineError(400, 'VALIDATION', `${field} debe ser texto`, { field });
  const trimmed = value.trim();
  if (required && !trimmed) throw new RoutineError(400, 'VALIDATION', `${field} no puede estar vacío`, { field });
  if (trimmed.length > max) throw new RoutineError(400, 'VALIDATION', `${field} excede ${max} caracteres`, { field });
  return trimmed;
}

function parseBool(value, field, fallback) {
  try {
    return booleanOf(value, fallback);
  } catch {
    throw new RoutineError(400, 'VALIDATION', `${field} debe ser booleano`, { field });
  }
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && isValidDateKey(value.slice(0, 10))) return value.slice(0, 10);
  throw new RoutineError(400, 'INVALID_DATE', `${field} debe ser YYYY-MM-DD`, { field });
}

export function routineKindOf(input = {}) {
  const raw = String(input.kind ?? input.tipoRutina ?? '').trim().toLowerCase();
  if (raw === 'meeting' || raw === 'reunion' || raw === 'reunión' || raw === 'reuniones') return 'meeting';
  if (raw === 'recurrence' || raw === 'recurrencia' || raw === 'recurrente') return 'recurrence';
  if (input.cadence !== undefined || input.name !== undefined || input.purpose !== undefined) return 'meeting';
  return 'recurrence';
}

export function routineFromInput(input = {}, { partial = false, current = null, settings = {} } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  for (const key of Object.keys(source)) {
    if (!ROUTINE_FIELDS.has(key)) throw new RoutineError(400, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`, { field: key });
  }
  const kind = current?.kind || routineKindOf(source);
  const isMeeting = kind === 'meeting';
  const frequency = source.frequency !== undefined || source.cadence !== undefined
    ? normalizeFrequency(source.frequency ?? source.cadence, current?.frequency || 'DIARIA')
    : current?.frequency;
  if (!FREQUENCIES.includes(frequency)) {
    throw new RoutineError(400, 'VALIDATION', `frequency debe ser ${FREQUENCIES.join(', ')}`, { field: 'frequency' });
  }
  const title = source.title !== undefined || source.name !== undefined
    ? requireText(source.title ?? source.name, isMeeting ? 'name' : 'title', { required: !partial && !current, max: 160 })
    : current?.title;
  if (!partial && !title) throw new RoutineError(400, 'VALIDATION', 'title es requerido', { field: 'title' });

  const time = normalizeTimeValue(source.time ?? source.hora ?? current?.time, '09:00');
  if (!parseHHMM(time)) throw new RoutineError(400, 'VALIDATION', 'time debe ser HH:MM', { field: 'time' });
  const durationRaw = source.durationMin ?? current?.durationMin ?? 30;
  const durationMin = Number(durationRaw);
  if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 720) {
    throw new RoutineError(400, 'VALIDATION', 'durationMin debe estar entre 5 y 720', { field: 'durationMin' });
  }

  let rule = source.rule ?? current?.rule ?? '';
  rule = String(rule).trim().toUpperCase();
  if (frequency === 'SEMANAL' && !ruleWeekdays(rule).length) {
    const startKey = normalizeDate(source.startDate ?? source.start ?? current?.startDate ?? current?.start, 'start') || dateKeyOfIso(new Date().toISOString(), timezoneOf(settings));
    rule = rule || weekdayRuleFor(startKey);
  }
  if ((frequency === 'MENSUAL' || frequency === 'TRIMESTRAL') && !rule) rule = '1';
  if (frequency === 'MENSUAL' || frequency === 'TRIMESTRAL') {
    const day = ruleMonthDay(rule, 1);
    if (day < 1 || day > 31) throw new RoutineError(400, 'VALIDATION', 'El día mensual debe estar entre 1 y 31', { field: 'rule' });
  }
  if (frequency === 'SEMANAL' && !ruleWeekdays(rule).length) {
    throw new RoutineError(400, 'VALIDATION', 'La regla semanal debe incluir días (LUN, MAR, ...)', { field: 'rule' });
  }

  const startDate = source.startDate !== undefined || source.start !== undefined
    ? normalizeDate(source.startDate ?? source.start, 'startDate')
    : (current?.startDate || null);
  const endDate = source.endDate !== undefined || source.end !== undefined
    ? normalizeDate(source.endDate ?? source.end, 'endDate')
    : (current?.endDate || null);
  if (startDate && endDate && compareDateKeys(endDate, startDate) < 0) {
    throw new RoutineError(400, 'INVALID_RANGE', 'endDate debe ser posterior a startDate', { field: 'endDate' });
  }

  const exceptions = source.exceptions !== undefined || source.skipDates !== undefined
    ? normalizeExceptionDates({ exceptions: source.exceptions, skipDates: source.skipDates })
    : normalizeExceptionDates(current || {});
  for (const key of exceptions) {
    if (!isValidDateKey(key)) throw new RoutineError(400, 'INVALID_DATE', `Excepción inválida: ${key}`, { field: 'exceptions' });
  }

  const type = requireText(source.type ?? current?.type, 'type', { max: 50 }) || (isMeeting ? 'Reunión' : 'Recurrente');
  const deepFocus = source.deepFocus !== undefined ? booleanOf(source.deepFocus, false) : (current?.deepFocus ?? String(type).toLowerCase() === 'foco');
  const priority = normalizePriority(source.priority ?? current?.priority, 'P2');
  const impact = source.impact !== undefined ? clampRating(source.impact, 3) : (current?.impact ?? 3);
  const urgency = source.urgency !== undefined ? clampRating(source.urgency, 3) : (current?.urgency ?? 3);
  const reminderMin = source.reminderMin !== undefined ? Number(source.reminderMin) : (current?.reminderMin ?? settings.reminderMin ?? 10);
  if (!Number.isFinite(reminderMin) || reminderMin < 0 || reminderMin > 40320) {
    throw new RoutineError(400, 'VALIDATION', 'reminderMin debe estar entre 0 y 40320', { field: 'reminderMin' });
  }
  const effectivenessRaw = source.effectiveness !== undefined ? source.effectiveness : current?.effectiveness;
  const effectiveness = effectivenessRaw === null || effectivenessRaw === '' || effectivenessRaw === undefined
    ? null
    : clampRating(effectivenessRaw, null);

  return {
    kind,
    active: source.active !== undefined ? booleanOf(source.active, true) : (current?.active ?? true),
    title,
    frequency,
    rule,
    time,
    durationMin: Math.round(durationMin),
    type,
    result: requireText(source.result ?? current?.result ?? source.requiredOutput, 'result', { max: 500 }) || '',
    priority,
    impact,
    urgency,
    deepFocus: !!deepFocus,
    energy: requireText(source.energy ?? current?.energy, 'energy', { max: 20 }) || 'Media',
    reminderMin: Math.round(reminderMin),
    whatsapp: source.whatsapp !== undefined ? booleanOf(source.whatsapp, true) : (source.whatsappReminder !== undefined ? booleanOf(source.whatsappReminder, true) : (current?.whatsapp ?? true)),
    calendar: source.calendar !== undefined ? booleanOf(source.calendar, true) : (current?.calendar ?? true),
    owner: requireText(source.owner ?? current?.owner, 'owner', { max: 120 }) || 'Yo',
    startDate,
    endDate,
    notes: requireText(source.notes ?? current?.notes, 'notes', { max: 2000 }) || '',
    skipHolidays: source.skipHolidays !== undefined ? booleanOf(source.skipHolidays, true) : (current?.skipHolidays ?? true),
    role: requireText(source.role ?? current?.role, 'role', { max: 40 }) || null,
    exceptions,
    purpose: requireText(source.purpose ?? current?.purpose, 'purpose', { max: 500 }) || '',
    requiredOutput: requireText(source.requiredOutput ?? current?.requiredOutput, 'requiredOutput', { max: 500 }) || '',
    participants: requireText(source.participants ?? current?.participants, 'participants', { max: 300 }) || '',
    effectiveness,
    preRead: requireText(source.preRead ?? current?.preRead, 'preRead', { max: 300 }) || '',
    agendaLink: requireText(source.agendaLink ?? current?.agendaLink, 'agendaLink', { max: 500 }) || '',
    isMeeting
  };
}

function weekdayRuleFor(dateKey) {
  const codes = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
  const p = parseDateKey(dateKey);
  if (!p) return 'LUN';
  return codes[new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay()];
}

/** Convierte el objeto validado al formato que se guarda en el store. */
function toStoreShape(routine, existing = {}) {
  const base = {
    ...existing,
    id: existing.id,
    active: routine.active,
    time: routine.time,
    durationMin: routine.durationMin,
    priority: routine.priority,
    impact: routine.impact,
    urgency: routine.urgency,
    deepFocus: routine.deepFocus,
    energy: routine.energy,
    reminderMin: routine.reminderMin,
    calendar: routine.calendar,
    owner: routine.owner,
    start: routine.startDate,
    end: routine.endDate,
    notes: routine.notes,
    skipHolidays: routine.skipHolidays,
    role: routine.role || undefined,
    exceptions: routine.exceptions,
    updatedAt: new Date().toISOString()
  };
  if (routine.isMeeting) {
    return {
      ...base,
      name: routine.title,
      cadence: routine.frequency,
      rule: routine.rule,
      type: 'Reunión',
      purpose: routine.purpose,
      requiredOutput: routine.requiredOutput || routine.result,
      participants: routine.participants,
      effectiveness: routine.effectiveness,
      whatsappReminder: routine.whatsapp,
      preRead: routine.preRead,
      agendaLink: routine.agendaLink
    };
  }
  return {
    ...base,
    title: routine.title,
    frequency: routine.frequency,
    rule: routine.rule,
    type: routine.type,
    result: routine.result,
    whatsapp: routine.whatsapp
  };
}

function collectionFor(data, kind) {
  return kind === 'meeting' ? data.meetings : data.recurrences;
}

function findRawRoutine(data, id) {
  const recurrence = (data.recurrences || []).find((item) => item.id === id);
  if (recurrence) return { raw: recurrence, kind: 'recurrence', collection: data.recurrences };
  const meeting = (data.meetings || []).find((item) => item.id === id);
  if (meeting) return { raw: meeting, kind: 'meeting', collection: data.meetings };
  return null;
}

export function createRoutine(data, input, settings = {}) {
  const routine = routineFromInput(input, { partial: false, settings });
  const collection = collectionFor(data, routine.kind);
  const prefix = routine.kind === 'meeting' ? 'MT' : 'R';
  const id = nextId(prefix, collection);
  routine.id = id;
  const raw = toStoreShape(routine, { id, createdAt: new Date().toISOString() });
  collection.push(raw);
  addActivity('automation', `Rutina creada: ${routine.title} (${id})`);
  return { ok: true, routine: normalizeRoutine(raw, routine.kind, settings), raw };
}

export function updateRoutine(data, id, patch, settings = {}) {
  const found = findRawRoutine(data, id);
  if (!found) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré la rutina ${id}` };
  const current = normalizeRoutine(found.raw, found.kind, settings);
  let routine;
  try {
    routine = routineFromInput(patch, { partial: true, current, settings });
  } catch (error) {
    return routineErrorResult(error);
  }
  routine.id = id;
  const updated = toStoreShape(routine, found.raw);
  Object.assign(found.raw, updated);
  addActivity('automation', `Rutina editada: ${routine.title} (${id})`);
  return { ok: true, routine: normalizeRoutine(found.raw, found.kind, settings), raw: found.raw };
}

export function deleteRoutine(data, id, { keepGenerated = true } = {}) {
  const found = findRawRoutine(data, id);
  if (!found) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré la rutina ${id}` };
  const index = found.collection.indexOf(found.raw);
  found.collection.splice(index, 1);
  let removedGenerated = 0;
  if (!keepGenerated) {
    const now = Date.now();
    for (let i = data.agenda.length - 1; i >= 0; i--) {
      const event = data.agenda[i];
      const linked = [event.routineId, event.recurrentId, event.meetingId].filter(Boolean).includes(id);
      if (linked && event.status !== 'Hecho' && new Date(event.start).getTime() >= now) {
        data.agenda.splice(i, 1);
        removedGenerated += 1;
      }
    }
  }
  addActivity('automation', `Rutina eliminada: ${id}${removedGenerated ? ` (${removedGenerated} generadas)` : ''}`);
  return { ok: true, removed: id, removedGenerated };
}

export function setRoutineActive(data, id, active, settings = {}) {
  const found = findRawRoutine(data, id);
  if (!found) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré la rutina ${id}` };
  found.raw.active = booleanOf(active, true);
  found.raw.updatedAt = new Date().toISOString();
  addActivity('automation', `Rutina ${found.raw.active ? 'activada' : 'pausada'}: ${id}`);
  return { ok: true, routine: normalizeRoutine(found.raw, found.kind, settings) };
}

/** Agrega una excepción por fecha y cancela la instancia materializada. */
export function skipRoutineDate(data, id, dateKey, { reason = '' } = {}) {
  if (!isValidDateKey(dateKey)) return { ok: false, status: 400, code: 'INVALID_DATE', error: 'date debe ser YYYY-MM-DD', field: 'date' };
  const found = findRawRoutine(data, id);
  if (!found) return { ok: false, status: 404, code: 'NOT_FOUND', error: `No encontré la rutina ${id}` };
  const exceptions = new Set(normalizeExceptionDates(found.raw));
  exceptions.add(dateKey);
  found.raw.exceptions = [...exceptions].sort();
  found.raw.updatedAt = new Date().toISOString();
  let cancelled = 0;
  const tz = timezoneOf(data.settings || {});
  for (const event of data.agenda) {
    const linked = [event.routineId, event.recurrentId, event.meetingId].filter(Boolean).includes(id);
    if (linked && event.status !== 'Cancelada' && dateKeyOfIso(event.start, tz) === dateKey) {
      event.status = 'Cancelada';
      event.cancelledAt = new Date().toISOString();
      event.skipReason = reason || 'Excepción de rutina';
      cancelled += 1;
    }
  }
  addActivity('automation', `Rutina ${id}: se omite ${dateKey}${reason ? ` (${reason})` : ''}`);
  return { ok: true, routine: normalizeRoutine(found.raw, found.kind, data.settings), date: dateKey, cancelled };
}

export function previewRoutine(routine, { count = 30, fromKey, settings = {} } = {}) {
  const normalized = routine?.frequency ? routine : normalizeRoutine(routine, routine?.kind || 'recurrence', settings);
  const safeCount = Math.max(1, Math.min(365, Math.round(Number(count) || 30)));
  const from = fromKey || dateKeyOfIso(new Date().toISOString(), timezoneOf(settings));
  return nextRoutineOccurrences(normalized, { count: safeCount, fromKey: from, settings });
}

export function listRoutines(data, settings = {}, { kind, active, q, fromKey } = {}) {
  const routines = routinesFromData(data, settings)
    .filter((routine) => !kind || routine.kind === kind)
    .filter((routine) => active === undefined || routine.active === active)
    .filter((routine) => {
      if (!q) return true;
      const query = String(q).toLowerCase();
      return `${routine.title} ${routine.id} ${routine.notes} ${routine.purpose}`.toLowerCase().includes(query);
    });
  const today = fromKey || dateKeyOfIso(new Date().toISOString(), timezoneOf(settings));
  return routines.map((routine) => {
    const upcoming = previewRoutine(routine, { count: 1, fromKey: today, settings });
    return { ...routine, nextDate: upcoming[0]?.date || null, nextStart: upcoming[0]?.start || null };
  });
}

/**
 * Materializa las ocurrencias de un rango [fromKey, toKey].
 * Idempotente: no duplica eventos ya generados.
 */
export async function materializeRoutineRange(data, settings, { fromKey, toKey, maxOccurrences = 500 } = {}) {
  const tz = timezoneOf(settings);
  const from = fromKey || dateKeyOfIso(new Date().toISOString(), tz);
  const to = toKey || from;
  const summary = { from, to, created: [], skipped: 0, errors: [], generated: 0 };
  if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) {
    summary.errors.push({ code: 'INVALID_RANGE', message: 'Rango de materialización inválido' });
    return summary;
  }
  let budget = Math.max(1, Math.min(2000, Number(maxOccurrences) || 500));
  for (const routine of routinesFromData(data, settings)) {
    if (!routine.active) continue;
    if (routine.invalid?.time) {
      summary.errors.push({
        routineId: routine.id,
        code: 'INVALID_ROUTINE',
        message: `Rutina ${routine.id} omitida: hora inválida "${routine.invalid.time}"`
      });
      continue;
    }
    const occurrences = routineOccurrencesBetween(routine, from, to, settings);
    for (const occurrence of occurrences) {
      if (budget <= 0) break;
      if (occurrence.skipped) {
        summary.skipped += 1;
        continue;
      }
      if (findMaterializedEvent(data, routine, occurrence.date, tz)) {
        summary.skipped += 1;
        continue;
      }
      const payload = routineToEventPayload(routine, occurrence, settings);
      const event = {
        ...payload,
        id: nextId('AG', data.agenda),
        status: 'Pendiente',
        actualMin: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      event.score = priorityScore(event);
      budget -= 1;
      try {
        await syncNewEventToGoogle(event, settings);
      } catch (error) {
        event.syncError = error.message;
        event.needsGoogleSync = true;
      }
      data.agenda.push(event);
      const raw = collectionFor(data, routine.kind).find((item) => item.id === routine.id);
      if (raw) raw.lastGenerated = occurrence.date;
      summary.created.push({ id: event.id, routineId: routine.id, date: occurrence.date, title: event.title });
      summary.generated += 1;
      addActivity('automation', `Rutina generada: ${event.title} (${routine.id} · ${occurrence.date})`, { agendaId: event.id });
    }
  }
  return summary;
}

/**
 * Ejecución diaria con backfill de días perdidos.
 * - Primera ejecución: solo hoy (no inunda de eventos históricos).
 * - Si el servidor estuvo apagado: recupera hasta `backfillDays`.
 */
export async function runDailyMaterialization(data, settings, {
  todayKey, backfillDays, maxOccurrences = 500
} = {}) {
  const tz = timezoneOf(settings);
  const today = todayKey || dateKeyOfIso(new Date().toISOString(), tz);
  const lastRun = isValidDateKey(settings.routinesLastRun) ? settings.routinesLastRun : null;
  const configuredDays = backfillDays !== undefined ? backfillDays : settings.routineBackfillDays;
  const windowDays = Math.max(1, Math.min(60, Number(configuredDays) || settings.routineBackfillDays || 7));
  let from = today;
  let backfilled = false;
  if (lastRun) {
    const gap = daysBetweenKeys(lastRun, today);
    if (gap > 0) {
      from = gap > windowDays ? addDaysKey(today, -(windowDays - 1)) : addDaysKey(lastRun, 1);
      backfilled = true;
    }
  }
  const summary = await materializeRoutineRange(data, settings, { fromKey: from, toKey: today, maxOccurrences });
  summary.today = today;
  summary.lastRun = lastRun;
  summary.backfilled = backfilled;
  settings.routinesLastRun = today;
  return summary;
}

/** Materializa solo hoy (compatibilidad con el arranque actual). */
export async function materializeToday(data, settings, { todayKey } = {}) {
  const tz = timezoneOf(settings);
  const today = todayKey || dateKeyOfIso(new Date().toISOString(), tz);
  return materializeRoutineRange(data, settings, { fromKey: today, toKey: today });
}

/** Próximas 30 apariciones de una rutina del store. */
export function previewRoutineById(data, id, { count = 30, fromKey, settings = {} } = {}) {
  const routine = routinesFromData(data, settings).find((item) => item.id === id);
  if (!routine) return null;
  return previewRoutine(routine, { count, fromKey, settings });
}

function routineErrorResult(error) {
  if (error instanceof RoutineError) {
    return { ok: false, status: error.status, code: error.code, error: error.message, field: error.field };
  }
  throw error;
}

/** Verifica que la rutina esté vinculada a una porción del cálculo de métricas. */
export function routineRoleOf(routine, settings = {}) {
  return routine.role || inferRoutineRole(routine, settings);
}

export { routineDueOn, routineOccurrencesBetween, isRoutineSkipped };

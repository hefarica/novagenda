import {
  addDaysKey, daysBetweenKeys, daysInMonth, dateKeyOfIso, isoAtLocal, isoLocalOf, isValidDateKey,
  isHoliday, isWorkingDay, normalizeWeekday, normalizeWeekdays, parseDateKey, parseHHMM,
  safeDateKeyOfIso, weekdayCodeOfKey, timezoneOf
} from './time.mjs';
import { normalizePriority, clampRating, priorityScore, withComputedScore } from './score.mjs';

/**
 * Motor de ocurrencias de rutinas (recurrencias + reuniones recurrentes).
 *
 * Este módulo es PURO: no importa el store ni escribe nada. Lo usan:
 * - `routines.mjs` para CRUD/preview/materialización.
 * - `conflicts.mjs` para proyectar plantillas futuras y detectar choques.
 * - `metrics.mjs` para saber si una rutina de plan/cierre/revisión existe.
 *
 * Reglas del modelo Excel (`03_RECURRENCIAS`):
 * - DIARIA: todos los días.
 * - LABORABLES: lunes a viernes configurables, sin festivos.
 * - SEMANAL: regla con días (LUN-MAR-...).
 * - MENSUAL: día del mes; si el mes no tiene ese día se ajusta al último
 *   (clamp: 31 → 30/28/29), sin saltarse meses.
 * - TRIMESTRAL: día indicado en enero/abril/julio/octubre, con clamp.
 * - Excepciones por fecha (`exceptions`/`skipDates`) se omiten.
 */

const FREQUENCY_ALIASES = {
  DIARIA: 'DIARIA', DIARIO: 'DIARIA', DAILY: 'DIARIA', EVERYDAY: 'DIARIA', 'TODOS LOS DIAS': 'DIARIA',
  LABORABLES: 'LABORABLES', LABORAL: 'LABORABLES', WEEKDAYS: 'LABORABLES', 'DIAS HABILES': 'LABORABLES',
  SEMANAL: 'SEMANAL', SEMANA: 'SEMANAL', WEEKLY: 'SEMANAL',
  MENSUAL: 'MENSUAL', MENSUALMENTE: 'MENSUAL', MONTHLY: 'MENSUAL',
  TRIMESTRAL: 'TRIMESTRAL', QUARTERLY: 'TRIMESTRAL'
};

export function normalizeFrequency(value, fallback = 'DIARIA') {
  const raw = String(value ?? '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  return FREQUENCY_ALIASES[raw] || (FREQUENCY_ALIASES[raw.replace(/_/g, ' ')] || fallback);
}

export function normalizeTimeValue(value, fallback = '09:00') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Fracción de día estilo Excel (0.291666 = 07:00).
    const frac = value >= 0 && value < 1 ? value : (value % 1);
    const total = Math.round((frac || 0) * 1440);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  const parsed = parseHHMM(value);
  return parsed ? parsed.hhmm : fallback;
}

export function booleanOf(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value).trim().toUpperCase();
  if (['SI', 'SÍ', 'TRUE', '1', 'YES', 'Y', 'ACTIVA', 'ACTIVO'].includes(raw)) return true;
  if (['NO', 'FALSE', '0', 'N', 'INACTIVA', 'INACTIVO'].includes(raw)) return false;
  return fallback;
}

function normalizeDateKey(value) {
  if (!value) return null;
  if (typeof value === 'string' && isValidDateKey(value.slice(0, 10))) return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12)).toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Serial Excel (días desde 1899-12-30).
    const ms = Math.round(value) * 86400000 + Date.UTC(1899, 11, 30, 12);
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

export function normalizeExceptionDates(routine = {}) {
  const out = new Set();
  const add = (item) => {
    if (!item) return;
    const key = typeof item === 'object' ? normalizeDateKey(item.date || item.fecha || item.skipDate) : normalizeDateKey(item);
    if (key) out.add(key);
  };
  for (const key of ['exceptions', 'excepciones', 'skipDates', 'skippedDates', 'fechasExcluidas']) {
    const value = routine[key];
    if (Array.isArray(value)) value.forEach(add);
    else if (value) add(value);
  }
  return [...out].sort();
}

export function ruleWeekdays(rule) {
  const raw = String(rule ?? '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const found = [];
  // El modelo Excel usa el guion como SEPARADOR de días
  // ("LUN-MAR-MIE-JUE-VIE"), no como rango. Se admiten también comas y espacios.
  for (const token of raw.split(/[^A-Z0-9]+/)) {
    const code = normalizeWeekday(token);
    if (code && !found.includes(code)) found.push(code);
  }
  if (!found.length) {
    for (const chunk of raw.split(/[^A-Z]+/)) {
      const code = normalizeWeekday(chunk);
      if (code && !found.includes(code)) found.push(code);
    }
  }
  return found;
}

export function ruleMonthDay(rule, fallback = 1) {
  const match = String(rule ?? '').match(/\d{1,2}/);
  if (!match) return fallback;
  const day = Number(match[0]);
  return day >= 1 && day <= 31 ? day : fallback;
}

export function inferRoutineRole(routine = {}, settings = {}) {
  const explicit = String(routine.role || routine.rol || '').trim();
  if (explicit) return explicit;
  const title = String(routine.title || routine.name || routine.actividad || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const patterns = settings.metricRoles || settings.routineRoles || {};
  const checks = [
    ['weeklyReview', patterns.weeklyReview || 'revision semanal|weekly review|revision p95'],
    ['close', patterns.close || 'cierre diario|cierre del dia|^cierre\\b'],
    ['plan', patterns.plan || 'plan diario|top 3|planificacion diaria|inicio del dia']
  ];
  for (const [role, pattern] of checks) {
    try {
      if (new RegExp(pattern, 'i').test(title)) return role;
    } catch {
      // Patrón inválido configurado por el usuario: se ignora.
    }
  }
  return null;
}

/**
 * Normaliza una recurrencia o reunión del store a la forma canónica de rutina.
 * @param {object} raw
 * @param {'recurrence'|'meeting'} kind
 * @param {object} settings
 */
export function normalizeRoutine(raw = {}, kind = 'recurrence', settings = {}) {
  const isMeeting = kind === 'meeting' || raw.kind === 'meeting' || raw.cadence !== undefined;
  const frequency = normalizeFrequency(raw.frequency ?? raw.cadence ?? raw.frecuencia, 'DIARIA');
  const startDate = normalizeDateKey(raw.startDate ?? raw.start ?? raw.inicio ?? raw.startVigencia);
  const endDate = normalizeDateKey(raw.endDate ?? raw.end ?? raw.fin ?? raw.endVigencia);
  const title = String(raw.title ?? raw.name ?? raw.actividad ?? raw.nombre ?? '').trim();
  const type = String(raw.type ?? raw.tipo ?? (isMeeting ? 'Reunión' : 'Recurrente')).trim() || (isMeeting ? 'Reunión' : 'Recurrente');
  const deepFocus = booleanOf(raw.deepFocus ?? raw.focoProfundo, type.toLowerCase() === 'foco');
  const priority = normalizePriority(raw.priority ?? raw.prioridad, 'P2');
  const impact = clampRating(raw.impact ?? raw.impacto, 3);
  const urgency = clampRating(raw.urgency ?? raw.urgencia, 3);
  const durationMin = Math.min(720, Math.max(5, Math.round(Number(raw.durationMin ?? raw.duracionMin ?? raw.duration ?? 30) || 30)));
  const rawTime = raw.time ?? raw.hora;
  const rawTimeIsDate = rawTime instanceof Date && !Number.isNaN(rawTime.getTime());
  const rawTimeIsNumber = typeof rawTime === 'number' && Number.isFinite(rawTime);
  const timeInvalid = rawTime !== undefined && rawTime !== null && rawTime !== ''
    && !rawTimeIsDate && !rawTimeIsNumber && !parseHHMM(rawTime);
  const routine = {
    id: String(raw.id || '').trim(),
    kind: isMeeting ? 'meeting' : 'recurrence',
    active: booleanOf(raw.active ?? raw.activa ?? raw.activo, true),
    title,
    name: title,
    frequency,
    cadence: frequency,
    rule: String(raw.rule ?? raw.regla ?? '').trim(),
    time: normalizeTimeValue(raw.time ?? raw.hora, '09:00'),
    durationMin,
    type,
    result: String(raw.result ?? raw.resultado ?? raw.requiredOutput ?? raw.salida ?? '').trim(),
    priority,
    impact,
    urgency,
    deepFocus,
    energy: String(raw.energy ?? raw.energia ?? 'Media'),
    reminderMin: Math.max(0, Math.min(10080, Math.round(Number(raw.reminderMin ?? settings.reminderMin ?? 10) || 0))),
    whatsapp: booleanOf(raw.whatsapp ?? raw.whatsappReminder ?? raw.waReminder, true),
    calendar: booleanOf(raw.calendar ?? raw.calendario, true),
    owner: String(raw.owner ?? raw.responsable ?? 'Yo'),
    startDate,
    endDate,
    notes: String(raw.notes ?? raw.notas ?? ''),
    skipHolidays: booleanOf(raw.skipHolidays, true),
    role: String(raw.role ?? raw.rol ?? '').trim() || null,
    exceptions: normalizeExceptionDates(raw),
    lastGenerated: normalizeDateKey(raw.lastGenerated ?? raw.ultimaGeneracion),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    purpose: String(raw.purpose ?? raw.proposito ?? ''),
    requiredOutput: String(raw.requiredOutput ?? raw.salidaObligatoria ?? raw.result ?? ''),
    participants: String(raw.participants ?? raw.participantes ?? ''),
    effectiveness: (raw.effectiveness === null || raw.effectiveness === undefined || raw.effectiveness === '')
      ? null
      : (Number.isFinite(Number(raw.effectiveness)) ? Math.min(5, Math.max(1, Number(raw.effectiveness))) : null),
    preRead: String(raw.preRead ?? ''),
    agendaLink: String(raw.agendaLink ?? raw.link ?? ''),
    whatsappReminder: booleanOf(raw.whatsappReminder ?? raw.whatsapp, true),
    source: isMeeting ? 'meeting' : 'recurrence',
    raw
  };
  routine.role = routine.role || inferRoutineRole(routine, settings);
  routine.scorePreview = priorityScore(routine);
  // Datos heredados corruptos (p. ej. time:'99:99' editado a mano en el JSON):
  // se marcan para que la materialización los omita con un aviso, en vez de
  // moverlos silenciosamente a las 09:00.
  routine.invalid = timeInvalid ? { time: String(raw.time ?? raw.hora) } : null;
  return routine;
}

/** Devuelve todas las rutinas normalizadas del estado. */
export function routinesFromData(data = {}, settings = {}) {
  const sourceSettings = settings && Object.keys(settings).length ? settings : (data.settings || {});
  const recurrences = Array.isArray(data.recurrences) ? data.recurrences : [];
  const meetings = Array.isArray(data.meetings) ? data.meetings : [];
  return [
    ...recurrences.map((item) => normalizeRoutine(item, 'recurrence', sourceSettings)),
    ...meetings.map((item) => normalizeRoutine(item, 'meeting', sourceSettings))
  ];
}

export function findRoutine(data = {}, id, settings = {}) {
  if (!id) return null;
  return routinesFromData(data, settings).find((routine) => routine.id.toLowerCase() === String(id).toLowerCase()) || null;
}

export function routineExceptionSet(routine) {
  return new Set(normalizeExceptionDates(routine));
}

export function routineStartKey(routine) {
  return normalizeDateKey(routine?.startDate ?? routine?.start ?? null);
}

export function routineEndKey(routine) {
  return normalizeDateKey(routine?.endDate ?? routine?.end ?? null);
}

export function isRoutineActive(routine) {
  return booleanOf(routine?.active, true);
}

/**
 * ¿La rutina toca esta fecha? No considera excepciones (ver `routineOccurrenceOn`).
 */
export function routineDueOn(routine, dateKey, settings = {}) {
  const normalized = routine?.frequency ? routine : normalizeRoutine(routine, routine?.kind === 'meeting' ? 'meeting' : 'recurrence', settings);
  if (!normalized || !isRoutineActive(normalized)) return false;
  if (normalized.invalid?.time) return false;
  if (!isValidDateKey(dateKey)) return false;
  const start = routineStartKey(normalized);
  if (start && dateKey < start) return false;
  const end = routineEndKey(normalized);
  if (end && dateKey > end) return false;

  const dow = weekdayCodeOfKey(dateKey);
  const p = parseDateKey(dateKey);
  const frequency = normalizeFrequency(normalized.frequency, 'DIARIA');

  let due = false;
  if (frequency === 'DIARIA') due = true;
  else if (frequency === 'LABORABLES') due = isWorkingDay(dateKey, settings);
  else if (frequency === 'SEMANAL') {
    const days = ruleWeekdays(normalized.rule);
    if (days.length) due = days.includes(dow);
    else {
      const fallbackDow = start ? weekdayCodeOfKey(start) : dow;
      due = fallbackDow === dow;
    }
  } else if (frequency === 'MENSUAL') {
    const target = ruleMonthDay(normalized.rule, 1);
    due = p.day === Math.min(target, daysInMonth(p.year, p.month));
  } else if (frequency === 'TRIMESTRAL') {
    const target = ruleMonthDay(normalized.rule, 1);
    due = [1, 4, 7, 10].includes(p.month) && p.day === Math.min(target, daysInMonth(p.year, p.month));
  }

  if (!due) return false;
  if (frequency !== 'LABORABLES' && booleanOf(normalized.skipHolidays, true) && settings.ignoreHolidays !== true) {
    if (isHoliday(dateKey, settings)) return false;
  }
  return true;
}

export function isRoutineSkipped(routine, dateKey) {
  if (!routine || !isValidDateKey(dateKey)) return false;
  return routineExceptionSet(routine).has(dateKey);
}

/**
 * Ocurrencia concreta de una rutina en una fecha.
 * @returns {{date:string,start:string,end:string,skipped:boolean,due:boolean}|null}
 */
export function routineOccurrenceOn(routine, dateKey, settings = {}) {
  if (!routineDueOn(routine, dateKey, settings)) return null;
  const tz = timezoneOf(settings);
  const start = isoAtLocal(dateKey, routine.time || '09:00', tz);
  const durationMin = Math.max(5, Number(routine.durationMin || 30));
  const end = isoLocalOf(new Date(start).getTime() + durationMin * 60000, tz);
  return {
    date: dateKey,
    start,
    end,
    endLocal: end,
    skipped: isRoutineSkipped(routine, dateKey),
    due: true
  };
}

/**
 * Próximas `count` apariciones no omitidas.
 * @param {object} routine
 * @param {{count?:number,fromKey?:string,settings?:object,maxDays?:number}} options
 */
export function nextRoutineOccurrences(routine, { count = 30, fromKey, settings = {}, maxDays = 800 } = {}) {
  const startKey = fromKey || dateKeyOfIso(new Date().toISOString(), timezoneOf(settings));
  const occurrences = [];
  let cursor = startKey;
  for (let i = 0; i < maxDays && occurrences.length < count; i++) {
    const occurrence = routineOccurrenceOn(routine, cursor, settings);
    if (occurrence && !occurrence.skipped) occurrences.push(occurrence);
    cursor = addDaysKey(cursor, 1);
  }
  return occurrences;
}

/**
 * Apariciones (incluidas omitidas si se piden) en un rango de fechas inclusive.
 */
export function routineOccurrencesBetween(routine, fromKey, toKey, settings = {}, { includeSkipped = false } = {}) {
  if (!isValidDateKey(fromKey) || !isValidDateKey(toKey) || fromKey > toKey) return [];
  const out = [];
  let cursor = fromKey;
  const maxDays = Math.min(1000, daysBetweenKeys(fromKey, toKey) + 1);
  for (let i = 0; i < maxDays; i++) {
    const occurrence = routineOccurrenceOn(routine, cursor, settings);
    if (occurrence && (includeSkipped || !occurrence.skipped)) out.push(occurrence);
    if (cursor === toKey) break;
    cursor = addDaysKey(cursor, 1);
  }
  return out;
}

/**
 * ¿Existe ya un evento materializado para la rutina en esa fecha?
 * Idempotencia por `routineKey` y por id de rutina + fecha local.
 */
export function findMaterializedEvent(data, routineOrId, dateKey, tz) {
  const routine = typeof routineOrId === 'string' ? { id: routineOrId } : (routineOrId || {});
  const id = String(routine.id || '');
  const key = `${id}:${dateKey}`;
  const agenda = Array.isArray(data?.agenda) ? data.agenda : [];
  return agenda.find((event) => {
    if (!event) return false;
    if (event.routineKey === key) return true;
    const ids = [event.routineId, event.recurrentId, event.meetingId, event.sourceRoutineId].filter(Boolean).map(String);
    if (!id || !ids.some((value) => value.toLowerCase() === id.toLowerCase())) return false;
    return safeDateKeyOfIso(event.start, tz) === dateKey;
  }) || null;
}

/**
 * Payload de evento a partir de una ocurrencia. Mantiene los campos del
 * modelo Excel y calcula el score de prioridad.
 */
export function routineToEventPayload(routine, occurrence, settings = {}) {
  const isMeeting = routine.kind === 'meeting';
  const payload = {
    title: routine.title || (isMeeting ? 'Reunión' : 'Rutina'),
    start: occurrence.start,
    end: occurrence.end,
    type: routine.type || (isMeeting ? 'Reunión' : 'Recurrente'),
    result: routine.result || routine.requiredOutput || '',
    priority: routine.priority || 'P2',
    impact: routine.impact ?? 3,
    urgency: routine.urgency ?? 3,
    energy: routine.energy || 'Media',
    status: 'Pendiente',
    owner: routine.owner || 'Yo',
    reminderMin: routine.reminderMin ?? settings.reminderMin ?? 10,
    whatsapp: routine.whatsapp !== false,
    calendar: routine.calendar !== false,
    due: occurrence.date,
    plannedMin: routine.durationMin || 30,
    actualMin: 0,
    deepFocus: !!routine.deepFocus,
    context: routine.deepFocus ? 'Sin interrupciones' : (routine.context || ''),
    notes: routine.notes || (isMeeting && routine.purpose ? `Propósito: ${routine.purpose}` : ''),
    source: 'routine',
    routineId: routine.id,
    routineKind: routine.kind,
    routineKey: `${routine.id}:${occurrence.date}`,
    generatedAt: new Date().toISOString()
  };
  if (isMeeting) {
    payload.meetingId = routine.id;
    // `participants` del modelo es texto libre ("Equipo"); solo pasamos correos
    // reales a Google Calendar.
    payload.attendees = String(routine.participants || '').split(/[,;]+/).map((value) => value.trim()).filter((value) => /@/.test(value));
  } else {
    payload.recurrentId = routine.id;
  }
  payload.score = priorityScore(payload);
  return withComputedScore(payload);
}

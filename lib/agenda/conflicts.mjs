import { store } from '../store.mjs';
import { googleBusyDetailed } from '../google.mjs';
import {
  addDaysKey, compareDateKeys, dateKeyOfIso, formatShortDate, formatTime, isWorkingDay,
  isoAtLocal, localDayRange, minutesBetween, overlaps, parseHHMM, roundUpToMinutes, safeDateKeyOfIso,
  timezoneOf, isValidIso, weekdayCodeOfKey, WEEKDAY_NAMES
} from './time.mjs';
import {
  findMaterializedEvent, normalizeRoutine, routineOccurrencesBetween, routinesFromData
} from './occurrences.mjs';

/**
 * Motor de conflictos.
 *
 * Un choque existe si dos bloques se solapan. Se consideran:
 * - eventos locales no cancelados,
 * - PLANTILLAS de rutinas futuras aún no materializadas,
 * - eventos de Google vía FreeBusy y eventos de día completo,
 * - festivos y fines de semana configurables al proponer alternativas.
 *
 * Si FreeBusy falla, el error se propaga y NUNCA se asume libre:
 * `checkConflicts()` devuelve `unknown: true`.
 */

function normalizeSettings(data, settings) {
  if (settings && Object.keys(settings).length) return settings;
  return data?.settings || {};
}

function dateRangeForWindow(startIso, endIso, tz) {
  const fromKey = dateKeyOfIso(startIso, tz);
  const toKey = dateKeyOfIso(new Date(new Date(endIso).getTime() - 1000).toISOString(), tz) || fromKey;
  if (!fromKey || !toKey) return null;
  return { fromKey: addDaysKey(fromKey, -1), toKey: addDaysKey(toKey, 1) };
}

function localBusy(data, startIso, endIso, ignore) {
  const rows = Array.isArray(data?.agenda) ? data.agenda : [];
  return rows
    .filter((event) => event && event.id && !ignore.has(event.id) && event.status !== 'Cancelada')
    .filter((event) => isValidIso(event.start) && isValidIso(event.end) && overlaps(event.start, event.end, startIso, endIso))
    .map((event) => ({
      start: event.start,
      end: event.end,
      source: 'local',
      id: event.id,
      title: event.title,
      type: event.type,
      status: event.status
    }));
}

function routineBusy(data, settings, startIso, endIso, tz, ignore) {
  const range = dateRangeForWindow(startIso, endIso, tz);
  if (!range) return [];
  const out = [];
  for (const routine of routinesFromData(data, settings)) {
    if (!routine.active || ignore.has(routine.id)) continue;
    const occurrences = routineOccurrencesBetween(routine, range.fromKey, range.toKey, settings);
    for (const occurrence of occurrences) {
      if (ignore.has(`${routine.id}:${occurrence.date}`)) continue;
      if (!overlaps(occurrence.start, occurrence.end, startIso, endIso)) continue;
      // Si ya está materializada, el evento local ya cubre el bloqueo.
      if (findMaterializedEvent(data, routine, occurrence.date, tz)) continue;
      out.push({
        start: occurrence.start,
        end: occurrence.end,
        source: 'routine',
        routineId: routine.id,
        id: routine.id,
        title: routine.title,
        kind: routine.kind,
        type: routine.type,
        projected: true
      });
    }
  }
  return out;
}

/**
 * Reúne todos los bloqueos de un rango.
 * @returns {Promise<{busy:Array, errors:Array, unknown:boolean, checked:object}>}
 */
export async function collectBusyDetailed(startIso, endIso, {
  data = store.get(), settings, ignoreIds = [], includeRoutines = true, includeGoogle = true
} = {}) {
  const effectiveSettings = normalizeSettings(data, settings);
  const tz = timezoneOf(effectiveSettings);
  if (!isValidIso(startIso) || !isValidIso(endIso)) {
    throw Object.assign(new Error('Rango de fechas inválido'), { code: 'INVALID_RANGE', status: 400 });
  }
  if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
    throw Object.assign(new Error('El fin debe ser posterior al inicio'), { code: 'INVALID_RANGE', status: 400 });
  }
  const ignore = new Set((Array.isArray(ignoreIds) ? ignoreIds : [ignoreIds]).filter(Boolean).map(String));

  const busy = localBusy(data, startIso, endIso, ignore);
  if (includeRoutines) busy.push(...routineBusy(data, effectiveSettings, startIso, endIso, tz, ignore));

  const errors = [];
  let google = { checkedCalendars: 0, errorCount: 0 };
  if (includeGoogle && data?.googleConnections?.length) {
    const result = await googleBusyDetailed(startIso, endIso);
    busy.push(...result.busy.map((block) => ({ ...block, source: block.source === 'google' ? 'google' : block.source })));
    errors.push(...result.errors);
    google = { checkedCalendars: result.checkedCalendars, errorCount: result.errorCount };
  }

  return {
    busy: busy.sort((a, b) => new Date(a.start) - new Date(b.start)),
    errors,
    unknown: errors.length > 0,
    checked: {
      local: busy.filter((item) => item.source === 'local').length,
      routines: busy.filter((item) => item.source === 'routine').length,
      google: busy.filter((item) => item.source === 'google' || item.source === 'google-allday').length,
      calendars: google.checkedCalendars
    },
    start: startIso,
    end: endIso
  };
}

/**
 * Compatibilidad con el motor anterior: devuelve un array de choques.
 * Si FreeBusy falla, incluye marcadores `source:'google-error'` para que el
 * llamador no pueda interpretar la ausencia de datos como "libre".
 */
export async function collectBusy(startIso, endIso, ignoreId = null, options = {}) {
  const result = await collectBusyDetailed(startIso, endIso, {
    ...options,
    ignoreIds: ignoreId ? [ignoreId] : (options.ignoreIds || [])
  });
  return [
    ...result.busy,
    ...result.errors.map((error) => ({
      start: startIso,
      end: endIso,
      source: 'google-error',
      unknown: true,
      account: error.account,
      calendarId: error.calendarId,
      error: error.error,
      title: `Google sin verificar${error.account ? ` (${error.account})` : ''}`
    }))
  ];
}

/** Chequeo de conflictos con semántica explícita para rutas y asistente. */
export async function checkConflicts({ data = store.get(), settings, start, end, ignoreIds = [], includeGoogle = true } = {}) {
  const result = await collectBusyDetailed(start, end, { data, settings, ignoreIds, includeGoogle });
  const conflicts = result.busy.filter((item) => item.source !== 'google-error');
  return {
    ...result,
    conflicts,
    conflictCount: conflicts.length,
    canBook: conflicts.length === 0 && result.errors.length === 0,
    warnings: result.errors.map((error) => `No se pudo verificar Google${error.account ? ` (${error.account})` : ''}: ${error.error}`)
  };
}

/** Describe un choque en español para el asistente/UI. */
export function describeConflict(conflict) {
  if (!conflict) return '';
  const who = conflict.title || conflict.account || 'otro compromiso';
  const label = conflict.id ? `${conflict.id} ${who}` : who;
  const source = conflict.source === 'routine' ? 'rutina' : conflict.source === 'google' || conflict.source === 'google-allday' ? 'Google' : 'agenda';
  try {
    return `${label} (${source}) ${formatShortDate(conflict.start)} ${formatTime(conflict.start)}–${formatTime(conflict.end)}`;
  } catch {
    return `${label} (${source})`;
  }
}

/**
 * Busca alternativas dentro de la jornada, sin solapes, saltando festivos y
 * fines de semana configurables.
 * @param {object} options
 * @returns {Promise<{slots:Array, errors:Array, unknown:boolean, horizon:object}>}
 */
export async function findSlotsDetailed({
  durationMin = 60, fromIso = new Date().toISOString(), days = 5, count = 3,
  data = store.get(), settings, ignoreIds = [], includeGoogle = true, includeWeekend = false
} = {}) {
  const effectiveSettings = normalizeSettings(data, settings);
  const tz = timezoneOf(effectiveSettings);
  const duration = Math.max(5, Math.round(Number(durationMin) || 60));
  const horizonDays = Math.max(1, Math.min(60, Math.round(Number(days) || 5)));
  const desired = Math.max(1, Math.min(10, Math.round(Number(count) || 3)));
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) throw Object.assign(new Error('Fecha de inicio inválida'), { code: 'INVALID_DATE', status: 400 });
  const startKey = dateKeyOfIso(from.toISOString(), tz);
  const endKey = addDaysKey(startKey, horizonDays - 1);
  const workStart = parseHHMM(effectiveSettings.workdayStart || '07:00')?.hhmm || '07:00';
  const workEnd = parseHHMM(effectiveSettings.workdayEnd || '19:00')?.hhmm || '19:00';
  const stepMin = Math.min(120, Math.max(5, Math.round(Number(effectiveSettings.slotStepMin || 30))));
  const allowWeekend = includeWeekend || effectiveSettings.slotIncludeWeekend === true;

  const rangeStart = isoAtLocal(startKey, '00:00', tz);
  const rangeEnd = isoAtLocal(addDaysKey(endKey, 1), '00:00', tz);
  const busyResult = await collectBusyDetailed(rangeStart, rangeEnd, {
    data, settings: effectiveSettings, ignoreIds, includeGoogle, includeRoutines: true
  });

  const now = Date.now();
  const slots = [];
  for (let dayIndex = 0; dayIndex < horizonDays && slots.length < desired; dayIndex++) {
    const key = addDaysKey(startKey, dayIndex);
    const isWorking = isWorkingDay(key, effectiveSettings);
    if (!isWorking && !allowWeekend) continue;
    const dayStart = isoAtLocal(key, workStart, tz);
    const dayEnd = isoAtLocal(key, workEnd, tz);
    let cursor = new Date(Math.max(
      new Date(dayStart).getTime(),
      roundUpToMinutes(from, stepMin).getTime(),
      now
    ));
    const limit = new Date(dayEnd);
    for (; cursor.getTime() + duration * 60000 <= limit.getTime() && slots.length < desired; cursor = new Date(cursor.getTime() + stepMin * 60000)) {
      const candidateEnd = new Date(cursor.getTime() + duration * 60000);
      const collides = busyResult.busy.some((block) => overlaps(block.start, block.end, cursor.toISOString(), candidateEnd.toISOString()));
      if (collides) continue;
      slots.push({
        start: cursor.toISOString(),
        end: candidateEnd.toISOString(),
        date: key,
        weekday: WEEKDAY_NAMES[weekdayCodeOfKey(key)],
        unverified: busyResult.errors.length > 0,
        warnings: busyResult.errors.map((error) => error.error)
      });
    }
  }

  return {
    slots,
    errors: busyResult.errors,
    unknown: busyResult.errors.length > 0,
    horizon: { from: startKey, to: endKey, workday: [workStart, workEnd], stepMin, durationMin: duration }
  };
}

/** Compatibilidad: array de franjas {start,end}. */
export async function findSlots(durationMin, fromIso, days = 3, options = {}) {
  const result = await findSlotsDetailed({ ...options, durationMin, fromIso, days, count: options.count || 3 });
  return result.slots;
}

/**
 * Conflictos locales de hoy incluyendo plantillas de rutinas (síncrono).
 * Se usa en el dashboard; Google se consulta en `checkConflicts`.
 */
export function detectTodayConflicts({ data = store.get(), settings, dateKey } = {}) {
  const effectiveSettings = normalizeSettings(data, settings);
  const tz = timezoneOf(effectiveSettings);
  const today = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  const rows = (data.agenda || [])
    .filter((event) => event && event.id && event.status !== 'Cancelada' && safeDateKeyOfIso(event.start, tz) === today)
    .map((event) => ({ start: event.start, end: event.end, title: event.title, id: event.id, source: 'local' }));
  for (const routine of routinesFromData(data, effectiveSettings)) {
    if (!routine.active) continue;
    const occurrences = routineOccurrencesBetween(routine, today, today, effectiveSettings);
    for (const occurrence of occurrences) {
      if (findMaterializedEvent(data, routine, occurrence.date, tz)) continue;
      rows.push({ start: occurrence.start, end: occurrence.end, title: routine.title, id: routine.id, source: 'routine' });
    }
  }
  rows.sort((a, b) => new Date(a.start) - new Date(b.start));
  const conflicts = [];
  for (let i = 1; i < rows.length; i++) {
    for (let j = 0; j < i; j++) {
      if (overlaps(rows[j].start, rows[j].end, rows[i].start, rows[i].end)) {
        conflicts.push({ a: rows[j], b: rows[i] });
      }
    }
  }
  return { date: today, count: conflicts.length, conflicts };
}

/** Valida que un rango sea coherente (helper compartido por rutas). */
export function validateRange(start, end) {
  if (!isValidIso(start)) return { ok: false, code: 'INVALID_DATE', field: 'start', message: 'start debe ser una fecha ISO válida' };
  if (!isValidIso(end)) return { ok: false, code: 'INVALID_DATE', field: 'end', message: 'end debe ser una fecha ISO válida' };
  if (minutesBetween(start, end) <= 0) return { ok: false, code: 'INVALID_RANGE', field: 'end', message: 'end debe ser posterior a start' };
  return { ok: true };
}

export { localDayRange, compareDateKeys, normalizeRoutine };

/**
 * Cálculo de ventanas de ejecución, catch-up y zona horaria del scheduler.
 *
 * Reglas:
 * - Cada workflow declara su `trigger`; la zona es `settings.timezone` salvo que
 *   el trigger traiga `timezone` propio.
 * - Una ventana se identifica con `<workflowId>:<fecha local>` (daily/weekly) o
 *   `<workflowId>:<fecha>T<HH:MM>` (interval). Esa clave es la idempotencia.
 * - Si el servidor estaba caído, la PRÓXIMA ventana vencida dentro de
 *   `catchUpMaxMin` se ejecuta UNA sola vez con `reason: 'catch-up'`.
 */
import {
  timezoneOf, dateKeyOf, timeKeyOf, isoAtLocal, weekdayCodeOfKey, addDaysKey,
  isHoliday, isWeekend, isWorkingDay, parseHHMM
} from '../agenda/time.mjs';
import { normalizeWeekdayCodes } from './defaults.mjs';

export const DEFAULT_CATCHUP_MIN = Object.freeze({ daily: 720, weekly: 1440, interval: 1440, always: 0 });
const DAY_MS = 86_400_000;

/** Partes locales de un instante en una zona. */
export function localParts(date = new Date(), tz = timezoneOf({})) {
  const value = date instanceof Date ? date : new Date(date);
  const dateKey = dateKeyOf(value, tz);
  const hhmm = timeKeyOf(value, tz);
  return {
    dateKey,
    hhmm,
    minutes: hhmmToMinutes(hhmm),
    weekday: weekdayCodeOfKey(dateKey)
  };
}

export function hhmmToMinutes(value) {
  const parsed = parseHHMM(value);
  return parsed ? parsed.minutes : null;
}

export function minutesToHHMM(minutes) {
  const total = ((Math.round(Number(minutes) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Zona efectiva de un workflow (trigger.timezone > settings.timezone). */
export function workflowTimezone(workflow, settings = {}) {
  const candidate = workflow?.trigger?.timezone;
  if (candidate) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone || candidate;
    } catch { /* zona inválida: cae a settings */ }
  }
  return timezoneOf(settings);
}

/** Intervalo efectivo en minutos (settings.syncIntervalMin con mínimo 5). */
export function effectiveEveryMin(workflow, settings = {}) {
  const trigger = workflow?.trigger || {};
  const explicit = Number(trigger.everyMin);
  const base = trigger.useSettingsInterval
    ? Math.max(5, Number(settings.syncIntervalMin) || 60)
    : (Number.isFinite(explicit) && explicit > 0 ? Math.round(explicit) : 0);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.min(1440, Math.max(1, Math.round(base)));
}

export function catchUpMaxMs(workflow) {
  const trigger = workflow?.trigger || {};
  const raw = Number(trigger.catchUpMaxMin);
  const type = trigger.type || 'daily';
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : (DEFAULT_CATCHUP_MIN[type] ?? 720);
  return Math.max(0, minutes) * 60_000;
}

function withinMinutes(minutes, from, to) {
  const start = hhmmToMinutes(from);
  const end = hhmmToMinutes(to);
  if (start === null || end === null) return true;
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes <= end;
  // Ventana que cruza medianoche (p. ej. 22:00 → 02:00).
  return minutes >= start || minutes <= end;
}

/** ¿La hora local cae dentro de la ventana del trigger (si la define)? */
export function triggerWindowAllows(workflow, parts) {
  const trigger = workflow?.trigger || {};
  if (trigger.workHoursOnly) {
    const settings = workflow.__settings || {};
    const start = settings.workdayStart || '07:00';
    const end = settings.workdayEnd || '19:00';
    if (!withinMinutes(parts.minutes, start, end)) return false;
  }
  return true;
}

/** Condiciones declarativas del workflow sobre la fecha de la ocurrencia. */
export function conditionsAllow(workflow, dateKey, settings = {}) {
  const conditions = workflow?.conditions || {};
  if (conditions.skipWeekend && isWeekend(dateKey, settings)) return false;
  if (conditions.skipHolidays && isHoliday(dateKey, settings)) return false;
  if (workflow?.trigger?.workingDayOnly && !isWorkingDay(dateKey, settings)) return false;
  return true;
}

/**
 * Devuelve la ocurrencia vencida más reciente (si toca ejecutarla).
 * @param {any} workflow
 * @param {{now?:Date, settings?:object, reason?:string}} [options]
 * @returns {null|{workflowId:string, windowKey:string, occurrenceAt:string,
 *                 dateKey:string, reason:string, type:string}}
 */
export function workflowDue(workflow, options = {}) {
  if (!workflow || typeof workflow !== 'object' || workflow.active === false) return null;
  const trigger = workflow.trigger;
  if (!trigger || typeof trigger !== 'object') return null;
  const settings = options.settings || {};
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) return null;
  const tz = workflowTimezone(workflow, settings);
  const type = String(trigger.type || '').toLowerCase();
  const nowMs = now.getTime();

  if (type === 'manual') return null;

  if (type === 'always') {
    const parts = localParts(now, tz);
    const effective = { ...workflow, __settings: settings };
    if (!triggerWindowAllows(effective, parts)) return null;
    if (!conditionsAllow(workflow, parts.dateKey, settings)) return null;
    return {
      workflowId: workflow.id,
      windowKey: null,
      occurrenceAt: now.toISOString(),
      dateKey: parts.dateKey,
      reason: options.reason === 'startup' ? 'startup' : 'tick',
      type
    };
  }

  if (type === 'interval') {
    const everyMin = effectiveEveryMin(workflow, settings);
    if (!everyMin) return null;
    const parts = localParts(now, tz);
    if (!conditionsAllow(workflow, parts.dateKey, settings)) return null;
    if (trigger.workHoursOnly) {
      const start = settings.workdayStart || '07:00';
      const end = settings.workdayEnd || '19:00';
      if (!withinMinutes(parts.minutes, start, end)) return null;
    }
    const index = Math.floor(parts.minutes / everyMin);
    const startMinutes = index * everyMin;
    const windowHHMM = minutesToHHMM(startMinutes);
    const occurrenceAt = isoAtLocal(parts.dateKey, windowHHMM, tz);
    const occurrenceMs = Date.parse(occurrenceAt);
    if (!Number.isFinite(occurrenceMs) || occurrenceMs > nowMs) return null;
    const maxMs = catchUpMaxMs(workflow);
    if (maxMs > 0 && nowMs - occurrenceMs > Math.max(maxMs, everyMin * 60_000 * 2)) return null;
    return {
      workflowId: workflow.id,
      windowKey: `${workflow.id}:${parts.dateKey}T${windowHHMM}`,
      occurrenceAt,
      dateKey: parts.dateKey,
      reason: nowMs - occurrenceMs > 90_000 ? 'catch-up' : 'schedule',
      type
    };
  }

  if (type !== 'daily' && type !== 'weekly') return null;
  const at = String(trigger.at || '');
  if (hhmmToMinutes(at) === null) return null;
  // Los días se comparan contra LUN..DOM (weekdayCodeOfKey). Se normalizan
  // alias ingleses para tolerar datos antiguos o clientes que envíen "FRI".
  const weekdays = Array.isArray(trigger.weekdays)
    ? normalizeWeekdayCodes(trigger.weekdays)
    : (type === 'weekly' ? ['VIE'] : null);

  const maxMs = catchUpMaxMs(workflow);
  const todayKey = dateKeyOf(now, tz);
  const maxDaysBack = type === 'weekly' ? 8 : Math.min(3, Math.max(1, Math.ceil(maxMs / DAY_MS) + 1));
  for (let offset = 0; offset <= maxDaysBack; offset += 1) {
    const key = addDaysKey(todayKey, -offset);
    if (type === 'weekly' && weekdays && weekdays.length && !weekdays.includes(weekdayCodeOfKey(key))) continue;
    if (!conditionsAllow(workflow, key, settings)) continue;
    const occurrenceAt = isoAtLocal(key, at, tz);
    const occurrenceMs = Date.parse(occurrenceAt);
    if (!Number.isFinite(occurrenceMs)) continue;
    const age = nowMs - occurrenceMs;
    if (age < 0) continue;
    if (maxMs > 0 && age > maxMs) break;
    return {
      workflowId: workflow.id,
      windowKey: `${workflow.id}:${key}`,
      occurrenceAt,
      dateKey: key,
      reason: age > 90_000 ? 'catch-up' : 'schedule',
      type
    };
  }
  return null;
}

/** ¿Está permitida la señal ahora? Ventana `{from,to}` local. */
export function signalWindowAllows(window, date = new Date(), tz = timezoneOf({})) {
  if (!window || typeof window !== 'object') return true;
  const parts = localParts(date, tz);
  return withinMinutes(parts.minutes, window.from, window.to);
}

/** "Desde la última ejecución": ISO de corte para resúmenes de cambios. */
export function sinceForLastRun(lastRun, now, fallbackMin = 60) {
  const finished = lastRun && (lastRun.finishedAt || lastRun.startedAt);
  const parsed = finished ? Date.parse(finished) : NaN;
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(now.getTime() - Math.max(5, fallbackMin) * 60_000).toISOString();
}

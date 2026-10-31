/**
 * Validación estricta sin dependencias (Agenda Copilot P95).
 *
 * Todas las escrituras de la API pasan por aquí. Los errores son
 * `ValidationError` y se serializan como HTTP 400:
 *   { error, code, field, requestId }
 *
 * Códigos usados:
 *   REQUIRED, INVALID_TYPE, INVALID_NUMBER, INVALID_DATE, INVALID_RANGE,
 *   TOO_LONG, TOO_SHORT, INVALID_VALUE, INVALID_FORMAT, INVALID_CHARS,
 *   UNKNOWN_FIELD, FIELD_NOT_EDITABLE, EMPTY_PATCH, INVALID_BODY,
 *   INVALID_TIMEZONE, CONFIRMATION_REQUIRED, INVALID_BACKUP
 */
import { ValidationError } from './http/errors.mjs';

/* ------------------------------------------------------------------ */
/* Límites y enumeraciones                                             */
/* ------------------------------------------------------------------ */

export const LIMITS = Object.freeze({
  title: 200,
  result: 500,
  notes: 4000,
  context: 200,
  owner: 80,
  type: 60,
  attendees: 50,
  email: 254,
  username: 64,
  passwordMin: 8,
  passwordMax: 200,
  search: 200,
  rule: 120,
  label: 80,
  secretValue: 8192,
  input: 2000,
  assistantText: 4000,
  maxEventMinutes: 31 * 24 * 60,
  maxDayMinutes: 1440
});

export const PRIORITIES = Object.freeze(['P1', 'P2', 'P3']);
export const ENERGIES = Object.freeze(['Alta', 'Media', 'Baja']);
export const AGENDA_STATUSES = Object.freeze(['Pendiente', 'En curso', 'Hecho', 'Cancelada']);
export const RECURRENCE_FREQUENCIES = Object.freeze(['DIARIA', 'LABORABLES', 'SEMANAL', 'MENSUAL', 'TRIMESTRAL']);
export const WEEKDAYS = Object.freeze(['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM']);
export const THEMES = Object.freeze(['auto', 'claro', 'oscuro']);
export const P95_KEYS = Object.freeze(['agendaExecution', 'deepFocusDailyMin', 'overdueOpen', 'meetingEffectiveness', 'okrProgress', 'weeklyExecution', 'weeklyReview']);

/** Campos editables de una cita (POST /api/agenda). */
export const AGENDA_CREATE_FIELDS = Object.freeze([
  'title', 'start', 'end', 'type', 'result', 'priority', 'impact', 'urgency', 'energy', 'status',
  'owner', 'reminderMin', 'whatsapp', 'calendar', 'due', 'plannedMin', 'actualMin', 'score',
  'deepFocus', 'context', 'notes', 'attendees', 'force'
]);
/** Campos editables de una cita (PATCH /api/agenda/:id). `force` es una bandera de control. */
export const AGENDA_PATCH_FIELDS = Object.freeze([...AGENDA_CREATE_FIELDS]);
/** Nunca modificables desde el cliente. */
export const AGENDA_FORBIDDEN_FIELDS = Object.freeze(['id', 'google', 'createdAt', 'syncError', 'recurrentId', 'meetingId', 'completedAt']);

export const INBOX_CREATE_FIELDS = Object.freeze(['source', 'type', 'input', 'title', 'context', 'actionable', 'due', 'estimatedMin', 'priority', 'notes']);
export const INBOX_PATCH_FIELDS = Object.freeze(['source', 'type', 'input', 'title', 'context', 'actionable', 'due', 'estimatedMin', 'priority', 'notes', 'processed', 'agendaId']);
export const INBOX_FORBIDDEN_FIELDS = Object.freeze(['id', 'capturedAt']);

export const RECURRENCE_PATCH_FIELDS = Object.freeze(['active', 'frequency', 'rule', 'time', 'durationMin', 'type', 'title', 'result', 'priority', 'impact', 'urgency', 'energy', 'deepFocus', 'reminderMin', 'whatsapp', 'calendar', 'owner', 'start', 'end', 'notes', 'exceptions']);
export const MEETING_PATCH_FIELDS = Object.freeze(['active', 'name', 'cadence', 'rule', 'time', 'durationMin', 'purpose', 'requiredOutput', 'owner', 'participants', 'effectiveness', 'whatsappReminder', 'calendar', 'notes', 'agendaLink']);
export const OKR_PATCH_FIELDS = Object.freeze(['objective', 'keyResult', 'owner', 'period', 'baseline', 'target', 'current', 'unit', 'progress', 'confidence', 'due', 'priority', 'status', 'nextAction', 'notes']);
export const SETTINGS_FIELDS = Object.freeze([
  'timezone', 'workdayStart', 'workdayEnd', 'defaultDurationMin', 'reminderMin',
  'autoSyncGoogle', 'defaultGoogle', 'p95', 'selectedCalendars', 'locale', 'theme',
  'syncIntervalMin', 'googleSyncEnabled', 'holidays', 'holidayCalendar', 'workdays',
  'slotStepMin', 'slotIncludeWeekend', 'routineBackfillDays', 'metricRoles'
]);
export const AUTH_SETUP_FIELDS = Object.freeze(['username', 'password', 'setupToken']);
export const LOGIN_FIELDS = Object.freeze(['username', 'password']);
export const PASSWORD_CHANGE_FIELDS = Object.freeze(['currentPassword', 'newPassword']);
export const SECRET_PUT_FIELDS = Object.freeze(['value']);
export const ASSISTANT_FIELDS = Object.freeze(['text', 'channel', 'context']);

/* ------------------------------------------------------------------ */
/* Utilidades básicas                                                  */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function defaultTimeZone() {
  return process.env.TIMEZONE || 'America/Bogota';
}

/** @param {unknown} value */
export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {string} [field] */
export function assertObject(value, field = 'body') {
  if (!isPlainObject(value)) throw new ValidationError(field, 'INVALID_BODY', 'Se espera un objeto JSON.');
  return value;
}

/** @param {object} obj @param {string} key */
export function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Lista blanca estricta: rechaza cualquier campo no declarado.
 * @param {unknown} body
 * @param {readonly string[]} allowed
 * @param {{field?:string, allowEmpty?:boolean}} [options]
 */
export function pickFields(body, allowed, options = {}) {
  const container = assertObject(body, options.field || 'body');
  const allowedSet = new Set(allowed);
  const out = {};
  for (const key of Object.keys(container)) {
    if (!allowedSet.has(key)) {
      throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo no permitido: ${key}.`);
    }
    out[key] = container[key];
  }
  if (!options.allowEmpty && Object.keys(out).length === 0) {
    throw new ValidationError(options.field || 'body', 'EMPTY_PATCH', 'No se envió ningún campo editable.');
  }
  return out;
}

/**
 * Rechaza campos inmutables con un código específico.
 * @param {object} body
 * @param {readonly string[]} forbidden
 */
export function denyFields(body, forbidden) {
  for (const key of forbidden) {
    if (has(body, key)) throw new ValidationError(key, 'FIELD_NOT_EDITABLE', `El campo ${key} no se puede modificar.`);
  }
}

/* ------------------------------------------------------------------ */
/* Primitivas                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, min?:number, max?:number, trim?:boolean, allowEmpty?:boolean, enumValues?:readonly string[], pattern?:RegExp, patternMessage?:string, lowercase?:boolean, defaultValue?:string|null}} [options]
 * @returns {string|null}
 */
export function text(value, options = {}) {
  const field = options.field || 'valor';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  if (typeof value !== 'string') throw new ValidationError(field, 'INVALID_TYPE', `${field} debe ser texto.`);
  let out = options.trim === false ? value : value.trim();
  if (options.lowercase) out = out.toLowerCase();
  const max = options.max ?? LIMITS.title;
  const length = [...out].length;
  if (length > max) throw new ValidationError(field, 'TOO_LONG', `${field} supera el máximo de ${max} caracteres.`);
  if (options.min !== undefined && length < options.min) throw new ValidationError(field, 'TOO_SHORT', `${field} debe tener al menos ${options.min} caracteres.`);
  if (options.allowEmpty === false && length === 0) throw new ValidationError(field, 'REQUIRED', `${field} no puede estar vacío.`);
  if (options.enumValues && !options.enumValues.includes(out)) {
    throw new ValidationError(field, 'INVALID_VALUE', `${field} debe ser uno de: ${options.enumValues.join(', ')}.`);
  }
  if (options.pattern && !options.pattern.test(out)) {
    throw new ValidationError(field, 'INVALID_FORMAT', options.patternMessage || `${field} tiene un formato inválido.`);
  }
  if (CONTROL_CHARS_RE.test(out)) throw new ValidationError(field, 'INVALID_CHARS', `${field} contiene caracteres de control.`);
  return out;
}

/**
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, min?:number, max?:number, defaultValue?:number|null}} [options]
 * @returns {number|null}
 */
export function integer(value, options = {}) {
  const field = options.field || 'valor';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new ValidationError(field, 'INVALID_NUMBER', `${field} debe ser un número.`);
  if (!Number.isInteger(number)) throw new ValidationError(field, 'INVALID_NUMBER', `${field} debe ser un entero.`);
  if (options.min !== undefined && number < options.min) throw new ValidationError(field, 'OUT_OF_RANGE', `${field} debe ser ≥ ${options.min}.`);
  if (options.max !== undefined && number > options.max) throw new ValidationError(field, 'OUT_OF_RANGE', `${field} debe ser ≤ ${options.max}.`);
  return number;
}

/**
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, min?:number, max?:number, defaultValue?:number|null}} [options]
 * @returns {number|null}
 */
export function number(value, options = {}) {
  const field = options.field || 'valor';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new ValidationError(field, 'INVALID_NUMBER', `${field} debe ser un número.`);
  if (options.min !== undefined && parsed < options.min) throw new ValidationError(field, 'OUT_OF_RANGE', `${field} debe ser ≥ ${options.min}.`);
  if (options.max !== undefined && parsed > options.max) throw new ValidationError(field, 'OUT_OF_RANGE', `${field} debe ser ≤ ${options.max}.`);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, defaultValue?:boolean|null}} [options]
 * @returns {boolean|null}
 */
export function boolean(value, options = {}) {
  const field = options.field || 'valor';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 1 || value === 0)) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'si', 'sí', 'on', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  throw new ValidationError(field, 'INVALID_TYPE', `${field} debe ser booleano.`);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {{field?:string, required?:boolean, defaultValue?:string|null}} [options]
 */
export function enumValue(value, allowed, options = {}) {
  const field = options.field || 'valor';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  const out = typeof value === 'string' ? value.trim() : value;
  if (!allowed.includes(out)) throw new ValidationError(field, 'INVALID_VALUE', `${field} debe ser uno de: ${allowed.join(', ')}.`);
  return out;
}

/**
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, max?:number}} [options]
 * @returns {string|null}
 */
export function email(value, options = {}) {
  const field = options.field || 'email';
  const out = text(value, { field, required: options.required, max: options.max ?? LIMITS.email, lowercase: true, allowEmpty: options.required !== true });
  if (!out) return out;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out)) throw new ValidationError(field, 'INVALID_FORMAT', `${field} no es un correo válido.`);
  return out;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {{field?:string, required?:boolean, defaultValue?:string[]}} [options]
 */
export function arrayOf(value, itemValidator, options = {}) {
  const field = options.field || 'lista';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  if (!Array.isArray(value)) throw new ValidationError(field, 'INVALID_TYPE', `${field} debe ser una lista.`);
  const max = options.max ?? 200;
  if (value.length > max) throw new ValidationError(field, 'TOO_LONG', `${field} supera ${max} elementos.`);
  return value.map((item, index) => itemValidator(item, index));
}

/* ------------------------------------------------------------------ */
/* Fechas y horas                                                      */
/* ------------------------------------------------------------------ */

function partsToMap(parts) {
  return parts.reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
}

/** Valida una zona IANA y devuelve su forma canónica. */
export function timeZoneValue(value, options = {}) {
  const field = options.field || 'timezone';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  const candidate = text(value, { field, max: 64, required: true, allowEmpty: false });
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone || candidate;
  } catch {
    throw new ValidationError(field, 'INVALID_TIMEZONE', `${field} no es una zona horaria IANA válida.`);
  }
}

/**
 * Fecha de calendario real `YYYY-MM-DD` (rechaza 2026-02-31).
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, allowNull?:boolean}} [options]
 * @returns {string|null}
 */
export function dateKey(value, options = {}) {
  const field = options.field || 'fecha';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(field, 'INVALID_DATE', `${field} debe ser una fecha YYYY-MM-DD.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new ValidationError(field, 'INVALID_DATE', `${field} debe tener el formato YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertRealDate(year, month, day, field);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function assertRealDate(year, month, day, field) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new ValidationError(field, 'INVALID_DATE', `${field}: año fuera de rango.`);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new ValidationError(field, 'INVALID_DATE', `${field}: mes inválido.`);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new ValidationError(field, 'INVALID_DATE', `${field}: día inválido.`);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ValidationError(field, 'INVALID_DATE', `${field}: la fecha no existe en el calendario (${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}).`);
  }
}

/** Desfase (ms) de una zona respecto a UTC en un instante dado. */
function timeZoneOffsetMs(utcMs, timeZone) {
  const parts = partsToMap(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(utcMs)));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}

/**
 * Convierte una fecha/hora local en una zona IANA a ISO-8601 UTC.
 * @returns {string}
 */
export function zonedToIso(year, month, day, hour, minute, second, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = timeZoneOffsetMs(target, timeZone);
  let utcMs = target - firstOffset;
  const secondOffset = timeZoneOffsetMs(utcMs, timeZone);
  if (secondOffset !== firstOffset) utcMs = target - secondOffset;
  return new Date(utcMs).toISOString();
}

/** Clave de fecha local (YYYY-MM-DD) para un instante ISO en una zona. */
export function localDateKeyFor(iso, timeZone = defaultTimeZone()) {
  const parts = partsToMap(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(iso)));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const ISO_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Fecha-hora ISO-8601 estricta.
 *
 * Acepta:
 *   - `2026-11-01T10:00:00-05:00` (offset explícito)
 *   - `2026-11-01T15:00:00Z`
 *   - `2026-11-01T10:00` / `2026-11-01` (se interpreta en la zona configurada)
 *
 * Rechaza fechas imposibles (2026-02-31) y textos como `x` o `no-es-fecha`.
 * Devuelve siempre ISO UTC canónico (`...Z`).
 *
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, timeZone?:string, maxMinutes?:number}} [options]
 * @returns {string|null}
 */
export function isoDateTime(value, options = {}) {
  const field = options.field || 'fecha';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(field, 'INVALID_DATE', `${field} debe ser una fecha ISO-8601 en texto.`);
  const raw = value.trim();
  const match = ISO_DATE_TIME_RE.exec(raw);
  if (!match) throw new ValidationError(field, 'INVALID_DATE', `${field} no es una fecha ISO-8601 válida.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertRealDate(year, month, day, field);
  const hour = match[4] !== undefined ? Number(match[4]) : 0;
  const minute = match[5] !== undefined ? Number(match[5]) : 0;
  const second = match[6] !== undefined ? Number(match[6]) : 0;
  if (hour > 23) throw new ValidationError(field, 'INVALID_DATE', `${field}: hora inválida.`);
  if (minute > 59) throw new ValidationError(field, 'INVALID_DATE', `${field}: minuto inválido.`);
  if (second > 59) throw new ValidationError(field, 'INVALID_DATE', `${field}: segundo inválido.`);
  const offset = match[8];
  if (offset) {
    const normalizedOffset = /^[+-]\d{4}$/.test(offset) ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset.toUpperCase();
    const pad = (n) => String(n).padStart(2, '0');
    const ms = Date.parse(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.000${normalizedOffset}`);
    if (!Number.isFinite(ms)) throw new ValidationError(field, 'INVALID_DATE', `${field} no es una fecha válida.`);
    return new Date(ms).toISOString();
  }
  const timeZone = options.timeZone || defaultTimeZone();
  try {
    return zonedToIso(year, month, day, hour, minute, second, timeZone);
  } catch {
    throw new ValidationError(field, 'INVALID_TIMEZONE', `Zona horaria inválida: ${timeZone}.`);
  }
}

/**
 * Hora local `HH:MM` (acepta H:MM y HH:MM:SS, devuelve HH:MM).
 * @param {unknown} value
 * @param {{field?:string, required?:boolean, defaultValue?:string|null}} [options]
 */
export function timeHHMM(value, options = {}) {
  const field = options.field || 'hora';
  if (value === undefined || value === null) {
    if (options.required) throw new ValidationError(field, 'REQUIRED', `${field} es obligatorio.`);
    return options.defaultValue !== undefined ? options.defaultValue : null;
  }
  if (typeof value !== 'string') throw new ValidationError(field, 'INVALID_FORMAT', `${field} debe ser texto HH:MM.`);
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!match) throw new ValidationError(field, 'INVALID_FORMAT', `${field} debe tener el formato HH:MM (00:00–23:59).`);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/** @returns {{start:string, end:string, minutes:number}} */
export function validateRange(startIso, endIso, options = {}) {
  const fieldStart = options.fieldStart || 'start';
  const fieldEnd = options.fieldEnd || 'end';
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs)) throw new ValidationError(fieldStart, 'INVALID_DATE', 'start no es una fecha válida.');
  if (!Number.isFinite(endMs)) throw new ValidationError(fieldEnd, 'INVALID_DATE', 'end no es una fecha válida.');
  if (endMs <= startMs) throw new ValidationError(fieldEnd, 'INVALID_RANGE', 'end debe ser posterior a start.');
  const minutes = Math.round((endMs - startMs) / 60_000);
  const maxMinutes = options.maxMinutes ?? LIMITS.maxEventMinutes;
  if (minutes > maxMinutes) throw new ValidationError(fieldEnd, 'INVALID_RANGE', `El rango supera ${maxMinutes} minutos.`);
  return { start: startIso, end: endIso, minutes };
}

export function minutesBetween(startIso, endIso) {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
}

/* ------------------------------------------------------------------ */
/* Agenda                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {unknown} body
 * @param {{timeZone?:string, settings?:object}} [options]
 */
export function validateAgendaCreate(body, options = {}) {
  const timeZone = options.timeZone || defaultTimeZone();
  const settings = options.settings || {};
  const input = pickFields(body, AGENDA_CREATE_FIELDS);
  const start = isoDateTime(input.start, { field: 'start', required: true, timeZone });
  const end = isoDateTime(input.end, { field: 'end', required: true, timeZone });
  const range = validateRange(start, end);
  const title = text(input.title, { field: 'title', required: true, max: LIMITS.title, allowEmpty: false });
  const event = {
    title,
    start,
    end,
    type: text(input.type, { field: 'type', max: LIMITS.type, defaultValue: 'Compromiso' }),
    result: text(input.result, { field: 'result', max: LIMITS.result, defaultValue: '' }),
    priority: enumValue(input.priority, PRIORITIES, { field: 'priority', defaultValue: 'P2' }),
    impact: integer(input.impact, { field: 'impact', min: 1, max: 5, defaultValue: 3 }),
    urgency: integer(input.urgency, { field: 'urgency', min: 1, max: 5, defaultValue: 3 }),
    energy: enumValue(input.energy, ENERGIES, { field: 'energy', defaultValue: 'Media' }),
    status: enumValue(input.status, AGENDA_STATUSES, { field: 'status', defaultValue: 'Pendiente' }),
    owner: text(input.owner, { field: 'owner', max: LIMITS.owner, defaultValue: 'Yo' }),
    reminderMin: integer(input.reminderMin, { field: 'reminderMin', min: 0, max: LIMITS.maxDayMinutes, defaultValue: Number(settings.reminderMin ?? 10) }),
    whatsapp: boolean(input.whatsapp, { field: 'whatsapp', defaultValue: true }),
    calendar: boolean(input.calendar, { field: 'calendar', defaultValue: true }),
    due: has(input, 'due') ? dateKey(input.due, { field: 'due' }) : localDateKeyFor(start, timeZone),
    plannedMin: integer(input.plannedMin, { field: 'plannedMin', min: 0, max: 10080, defaultValue: range.minutes }),
    actualMin: integer(input.actualMin, { field: 'actualMin', min: 0, max: 10080, defaultValue: 0 }),
    score: integer(input.score, { field: 'score', min: 0, max: 100, defaultValue: 65 }),
    deepFocus: boolean(input.deepFocus, { field: 'deepFocus', defaultValue: false }),
    context: text(input.context, { field: 'context', max: LIMITS.context, defaultValue: '' }),
    notes: text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' }),
    attendees: arrayOf(input.attendees, (item, index) => email(item, { field: `attendees[${index}]` }), { field: 'attendees', max: LIMITS.attendees, defaultValue: [] })
  };
  if (event.status === 'Hecho') {
    event.actualMin = event.actualMin || event.plannedMin || range.minutes;
    event.completedAt = new Date().toISOString();
  }
  const force = boolean(input.force, { field: 'force', defaultValue: false });
  return { event, force };
}

/**
 * @param {unknown} body
 * @param {{current:object, timeZone?:string}} options
 */
export function validateAgendaPatch(body, options = {}) {
  const timeZone = options.timeZone || defaultTimeZone();
  const current = assertObject(options.current, 'current');
  const container = assertObject(body, 'body');
  denyFields(container, AGENDA_FORBIDDEN_FIELDS);
  const input = pickFields(container, AGENDA_PATCH_FIELDS);
  const patch = {};

  if (has(input, 'title')) patch.title = text(input.title, { field: 'title', required: true, max: LIMITS.title, allowEmpty: false });
  if (has(input, 'type')) patch.type = text(input.type, { field: 'type', required: true, max: LIMITS.type, allowEmpty: false });
  if (has(input, 'result')) patch.result = text(input.result, { field: 'result', max: LIMITS.result, defaultValue: '' });
  if (has(input, 'priority')) patch.priority = enumValue(input.priority, PRIORITIES, { field: 'priority', required: true });
  if (has(input, 'impact')) patch.impact = integer(input.impact, { field: 'impact', min: 1, max: 5, required: true });
  if (has(input, 'urgency')) patch.urgency = integer(input.urgency, { field: 'urgency', min: 1, max: 5, required: true });
  if (has(input, 'energy')) patch.energy = enumValue(input.energy, ENERGIES, { field: 'energy', required: true });
  if (has(input, 'owner')) patch.owner = text(input.owner, { field: 'owner', max: LIMITS.owner, defaultValue: 'Yo' });
  if (has(input, 'reminderMin')) patch.reminderMin = integer(input.reminderMin, { field: 'reminderMin', min: 0, max: LIMITS.maxDayMinutes, required: true });
  if (has(input, 'whatsapp')) patch.whatsapp = boolean(input.whatsapp, { field: 'whatsapp', required: true });
  if (has(input, 'calendar')) patch.calendar = boolean(input.calendar, { field: 'calendar', required: true });
  if (has(input, 'due')) patch.due = dateKey(input.due, { field: 'due' });
  if (has(input, 'plannedMin')) patch.plannedMin = integer(input.plannedMin, { field: 'plannedMin', min: 0, max: 10080, required: true });
  if (has(input, 'actualMin')) patch.actualMin = integer(input.actualMin, { field: 'actualMin', min: 0, max: 10080, required: true });
  if (has(input, 'score')) patch.score = integer(input.score, { field: 'score', min: 0, max: 100, required: true });
  if (has(input, 'deepFocus')) patch.deepFocus = boolean(input.deepFocus, { field: 'deepFocus', required: true });
  if (has(input, 'context')) patch.context = text(input.context, { field: 'context', max: LIMITS.context, defaultValue: '' });
  if (has(input, 'notes')) patch.notes = text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' });
  if (has(input, 'attendees')) {
    patch.attendees = arrayOf(input.attendees, (item, index) => email(item, { field: `attendees[${index}]` }), { field: 'attendees', max: LIMITS.attendees, defaultValue: [] });
  }

  const touchesRange = has(input, 'start') || has(input, 'end');
  if (touchesRange) {
    const start = has(input, 'start') ? isoDateTime(input.start, { field: 'start', required: true, timeZone }) : isoDateTime(current.start, { field: 'start', timeZone });
    const end = has(input, 'end') ? isoDateTime(input.end, { field: 'end', required: true, timeZone }) : isoDateTime(current.end, { field: 'end', timeZone });
    if (!start || !end) throw new ValidationError('start', 'INVALID_RANGE', 'start y end son obligatorios para reprogramar.');
    const range = validateRange(start, end);
    patch.start = start;
    patch.end = end;
    if (!has(input, 'plannedMin')) patch.plannedMin = range.minutes;
    if (!has(input, 'due')) patch.due = localDateKeyFor(start, timeZone);
  }

  if (has(input, 'status')) {
    patch.status = enumValue(input.status, AGENDA_STATUSES, { field: 'status', required: true });
    if (patch.status === 'Hecho') {
      patch.completedAt = new Date().toISOString();
      if (!has(input, 'actualMin')) {
        const fallback = Number(current.actualMin) || Number(current.plannedMin) || (current.start && current.end ? Math.max(0, minutesBetween(current.start, current.end)) : 0);
        patch.actualMin = fallback;
      }
    } else if (current.status === 'Hecho') {
      patch.completedAt = null;
    }
  }

  return { patch, touchesRange };
}

/* ------------------------------------------------------------------ */
/* Inbox                                                               */
/* ------------------------------------------------------------------ */

export function validateInboxCreate(body) {
  const input = pickFields(body, INBOX_CREATE_FIELDS, { allowEmpty: true });
  return {
    source: text(input.source, { field: 'source', max: LIMITS.type, defaultValue: 'App' }),
    type: text(input.type, { field: 'type', max: LIMITS.type, defaultValue: 'Tarea' }),
    title: text(input.title, { field: 'title', max: LIMITS.title, defaultValue: null }),
    input: text(input.input, { field: 'input', required: true, max: LIMITS.input, allowEmpty: false }),
    context: text(input.context, { field: 'context', max: LIMITS.context, defaultValue: 'Móvil' }),
    actionable: boolean(input.actionable, { field: 'actionable', defaultValue: true }),
    due: has(input, 'due') ? dateKey(input.due, { field: 'due' }) : null,
    estimatedMin: integer(input.estimatedMin, { field: 'estimatedMin', min: 0, max: LIMITS.maxDayMinutes, defaultValue: 30 }),
    priority: enumValue(input.priority, PRIORITIES, { field: 'priority', defaultValue: 'P2' }),
    notes: text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' })
  };
}

export function validateInboxPatch(body) {
  const container = assertObject(body, 'body');
  denyFields(container, INBOX_FORBIDDEN_FIELDS);
  const input = pickFields(container, INBOX_PATCH_FIELDS);
  const patch = {};
  if (has(input, 'source')) patch.source = text(input.source, { field: 'source', max: LIMITS.type, required: true });
  if (has(input, 'type')) patch.type = text(input.type, { field: 'type', max: LIMITS.type, required: true });
  if (has(input, 'title')) patch.title = text(input.title, { field: 'title', max: LIMITS.title, defaultValue: null });
  if (has(input, 'input')) patch.input = text(input.input, { field: 'input', required: true, max: LIMITS.input, allowEmpty: false });
  if (has(input, 'context')) patch.context = text(input.context, { field: 'context', max: LIMITS.context, defaultValue: '' });
  if (has(input, 'actionable')) patch.actionable = boolean(input.actionable, { field: 'actionable', required: true });
  if (has(input, 'due')) patch.due = dateKey(input.due, { field: 'due' });
  if (has(input, 'estimatedMin')) patch.estimatedMin = integer(input.estimatedMin, { field: 'estimatedMin', min: 0, max: LIMITS.maxDayMinutes, required: true });
  if (has(input, 'priority')) patch.priority = enumValue(input.priority, PRIORITIES, { field: 'priority', required: true });
  if (has(input, 'notes')) patch.notes = text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' });
  if (has(input, 'processed')) patch.processed = boolean(input.processed, { field: 'processed', required: true });
  if (has(input, 'agendaId')) patch.agendaId = input.agendaId === null ? null : text(input.agendaId, { field: 'agendaId', max: 40, required: true });
  return patch;
}

/* ------------------------------------------------------------------ */
/* Rutinas, reuniones y OKR (PATCH legacy)                             */
/* ------------------------------------------------------------------ */

function validateRule(rule, frequency) {
  const value = text(rule, { field: 'rule', max: LIMITS.rule, defaultValue: '' });
  if (!value) return value;
  if (frequency === 'SEMANAL') {
    const tokens = value.split(/[-–,;/\s]+/).filter(Boolean).map((token) => token.toUpperCase());
    if (!tokens.length) throw new ValidationError('rule', 'INVALID_FORMAT', 'rule semanal requiere días (LUN-MAR-…).');
    for (const token of tokens) {
      if (!WEEKDAYS.includes(token)) throw new ValidationError('rule', 'INVALID_VALUE', `Día inválido en rule: ${token}.`);
    }
  }
  if (frequency === 'MENSUAL' || frequency === 'TRIMESTRAL') {
    const day = Number(value);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new ValidationError('rule', 'INVALID_VALUE', 'rule mensual/trimestral requiere día del mes (1-31).');
  }
  return value;
}

function validateExceptions(value) {
  return arrayOf(value, (item, index) => {
    const field = `exceptions[${index}]`;
    const entry = assertObject(item, field);
    const allowed = ['date', 'type', 'time', 'durationMin', 'title', 'notes', 'reason'];
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) throw new ValidationError(`${field}.${key}`, 'UNKNOWN_FIELD', `Campo no permitido: ${field}.${key}.`);
    }
    const out = { date: dateKey(entry.date, { field: `${field}.date`, required: true }), type: enumValue(entry.type, ['skip', 'override'], { field: `${field}.type`, defaultValue: 'skip' }) };
    if (has(entry, 'time')) out.time = timeHHMM(entry.time, { field: `${field}.time`, required: true });
    if (has(entry, 'durationMin')) out.durationMin = integer(entry.durationMin, { field: `${field}.durationMin`, min: 1, max: LIMITS.maxDayMinutes, required: true });
    if (has(entry, 'title')) out.title = text(entry.title, { field: `${field}.title`, max: LIMITS.title, required: true });
    if (has(entry, 'notes')) out.notes = text(entry.notes, { field: `${field}.notes`, max: 1000, defaultValue: '' });
    if (has(entry, 'reason')) out.reason = text(entry.reason, { field: `${field}.reason`, max: 200, defaultValue: '' });
    return out;
  }, { field: 'exceptions', max: 400, defaultValue: [] });
}

export function validateRecurrencePatch(body) {
  const container = assertObject(body, 'body');
  denyFields(container, ['id']);
  const input = pickFields(container, RECURRENCE_PATCH_FIELDS);
  const patch = {};
  if (has(input, 'active')) patch.active = boolean(input.active, { field: 'active', required: true });
  const frequency = has(input, 'frequency') ? enumValue(input.frequency, RECURRENCE_FREQUENCIES, { field: 'frequency', required: true }) : null;
  if (frequency) patch.frequency = frequency;
  if (has(input, 'rule')) patch.rule = validateRule(input.rule, frequency);
  if (has(input, 'time')) patch.time = timeHHMM(input.time, { field: 'time', required: true });
  if (has(input, 'durationMin')) patch.durationMin = integer(input.durationMin, { field: 'durationMin', min: 1, max: LIMITS.maxDayMinutes, required: true });
  if (has(input, 'type')) patch.type = text(input.type, { field: 'type', max: LIMITS.type, required: true });
  if (has(input, 'title')) patch.title = text(input.title, { field: 'title', required: true, max: LIMITS.title, allowEmpty: false });
  if (has(input, 'result')) patch.result = text(input.result, { field: 'result', max: LIMITS.result, defaultValue: '' });
  if (has(input, 'priority')) patch.priority = enumValue(input.priority, PRIORITIES, { field: 'priority', required: true });
  if (has(input, 'impact')) patch.impact = integer(input.impact, { field: 'impact', min: 1, max: 5, required: true });
  if (has(input, 'urgency')) patch.urgency = integer(input.urgency, { field: 'urgency', min: 1, max: 5, required: true });
  if (has(input, 'energy')) patch.energy = enumValue(input.energy, ENERGIES, { field: 'energy', required: true });
  if (has(input, 'deepFocus')) patch.deepFocus = boolean(input.deepFocus, { field: 'deepFocus', required: true });
  if (has(input, 'reminderMin')) patch.reminderMin = integer(input.reminderMin, { field: 'reminderMin', min: 0, max: LIMITS.maxDayMinutes, required: true });
  if (has(input, 'whatsapp')) patch.whatsapp = boolean(input.whatsapp, { field: 'whatsapp', required: true });
  if (has(input, 'calendar')) patch.calendar = boolean(input.calendar, { field: 'calendar', required: true });
  if (has(input, 'owner')) patch.owner = text(input.owner, { field: 'owner', max: LIMITS.owner, defaultValue: 'Yo' });
  if (has(input, 'start')) patch.start = dateKey(input.start, { field: 'start' });
  if (has(input, 'end')) patch.end = dateKey(input.end, { field: 'end' });
  if (has(input, 'notes')) patch.notes = text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' });
  if (has(input, 'exceptions')) patch.exceptions = validateExceptions(input.exceptions);
  return patch;
}

export function validateMeetingPatch(body) {
  const container = assertObject(body, 'body');
  denyFields(container, ['id']);
  const input = pickFields(container, MEETING_PATCH_FIELDS);
  const patch = {};
  if (has(input, 'active')) patch.active = boolean(input.active, { field: 'active', required: true });
  if (has(input, 'name')) patch.name = text(input.name, { field: 'name', required: true, max: LIMITS.title, allowEmpty: false });
  const cadence = has(input, 'cadence') ? enumValue(input.cadence, RECURRENCE_FREQUENCIES, { field: 'cadence', required: true }) : null;
  if (cadence) patch.cadence = cadence;
  if (has(input, 'rule')) patch.rule = validateRule(input.rule, cadence);
  if (has(input, 'time')) patch.time = timeHHMM(input.time, { field: 'time', required: true });
  if (has(input, 'durationMin')) patch.durationMin = integer(input.durationMin, { field: 'durationMin', min: 1, max: LIMITS.maxDayMinutes, required: true });
  if (has(input, 'purpose')) patch.purpose = text(input.purpose, { field: 'purpose', max: 500, defaultValue: '' });
  if (has(input, 'requiredOutput')) patch.requiredOutput = text(input.requiredOutput, { field: 'requiredOutput', max: 500, defaultValue: '' });
  if (has(input, 'owner')) patch.owner = text(input.owner, { field: 'owner', max: LIMITS.owner, defaultValue: 'Yo' });
  if (has(input, 'participants')) patch.participants = text(input.participants, { field: 'participants', max: 300, defaultValue: '' });
  if (has(input, 'effectiveness')) patch.effectiveness = input.effectiveness === null ? null : number(input.effectiveness, { field: 'effectiveness', min: 0, max: 5, required: true });
  if (has(input, 'whatsappReminder')) patch.whatsappReminder = boolean(input.whatsappReminder, { field: 'whatsappReminder', required: true });
  if (has(input, 'calendar')) patch.calendar = boolean(input.calendar, { field: 'calendar', required: true });
  if (has(input, 'notes')) patch.notes = text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' });
  if (has(input, 'agendaLink')) patch.agendaLink = text(input.agendaLink, { field: 'agendaLink', max: 300, defaultValue: '' });
  return patch;
}

export function validateOkrPatch(body) {
  const container = assertObject(body, 'body');
  denyFields(container, ['id']);
  const input = pickFields(container, OKR_PATCH_FIELDS);
  const patch = {};
  if (has(input, 'objective')) patch.objective = text(input.objective, { field: 'objective', required: true, max: 300, allowEmpty: false });
  if (has(input, 'keyResult')) patch.keyResult = text(input.keyResult, { field: 'keyResult', required: true, max: 300, allowEmpty: false });
  if (has(input, 'owner')) patch.owner = text(input.owner, { field: 'owner', max: LIMITS.owner, defaultValue: 'Yo' });
  if (has(input, 'period')) patch.period = text(input.period, { field: 'period', max: 40, defaultValue: '' });
  if (has(input, 'baseline')) patch.baseline = number(input.baseline, { field: 'baseline', min: -1e9, max: 1e9, required: true });
  if (has(input, 'target')) patch.target = number(input.target, { field: 'target', min: -1e9, max: 1e9, required: true });
  if (has(input, 'current')) patch.current = number(input.current, { field: 'current', min: -1e9, max: 1e9, required: true });
  if (has(input, 'unit')) patch.unit = text(input.unit, { field: 'unit', max: 40, defaultValue: '' });
  if (has(input, 'progress')) patch.progress = number(input.progress, { field: 'progress', min: 0, max: 1, required: true });
  if (has(input, 'confidence')) patch.confidence = input.confidence === null ? null : integer(input.confidence, { field: 'confidence', min: 0, max: 5, required: true });
  if (has(input, 'due')) patch.due = dateKey(input.due, { field: 'due' });
  if (has(input, 'priority')) patch.priority = enumValue(input.priority, PRIORITIES, { field: 'priority', required: true });
  if (has(input, 'status')) patch.status = text(input.status, { field: 'status', max: 40, required: true });
  if (has(input, 'nextAction')) patch.nextAction = text(input.nextAction, { field: 'nextAction', max: 300, defaultValue: '' });
  if (has(input, 'notes')) patch.notes = text(input.notes, { field: 'notes', max: LIMITS.notes, defaultValue: '' });
  return patch;
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                             */
/* ------------------------------------------------------------------ */

const P95_WEIGHT_KEYS = Object.freeze(['agendaExecution', 'deepFocus', 'overdue', 'meetingEffectiveness', 'okrProgress', 'weeklyExecution', 'weeklyReview']);
const P95_FLAT_WEIGHT_KEYS = Object.freeze({
  agendaExecution: 'weightAgendaExecution',
  deepFocus: 'weightDeepFocus',
  overdue: 'weightOverdue',
  meetingEffectiveness: 'weightMeetingEffectiveness',
  okrProgress: 'weightOkrProgress',
  weeklyExecution: 'weightWeeklyExecution',
  weeklyReview: 'weightWeeklyReview'
});

function validateP95Weights(value, field = 'p95.weights') {
  const container = assertObject(value, field);
  const out = {};
  for (const [key, raw] of Object.entries(container)) {
    if (!P95_WEIGHT_KEYS.includes(key)) throw new ValidationError(`${field}.${key}`, 'UNKNOWN_FIELD', `Clave de peso no permitida: ${key}.`);
    out[key] = number(raw, { field: `${field}.${key}`, min: 0, max: 1, required: true });
  }
  if (!Object.keys(out).length) throw new ValidationError(field, 'EMPTY_PATCH', 'p95.weights no puede ir vacío.');
  if (Object.keys(out).length === P95_WEIGHT_KEYS.length) assertWeightsSum(P95_WEIGHT_KEYS.reduce((acc, key) => acc + out[key], 0), field);
  return out;
}

function assertWeightsSum(sum, field) {
  if (sum < 0.9 || sum > 1.1) {
    throw new ValidationError(field, 'INVALID_VALUE', `La suma de los 7 pesos debe estar entre 0.9 y 1.1 (recibido ${sum.toFixed(3)}).`);
  }
}

function validateP95(value) {
  const field = 'p95';
  const container = assertObject(value, field);
  const out = {};
  const ranges = {
    agendaExecution: [0, 1],
    weeklyExecution: [0, 1],
    okrProgress: [0, 1],
    weeklyReview: [0, 1],
    deepFocusDailyMin: [0, 1440],
    overdueOpen: [0, 999],
    meetingEffectiveness: [0, 5]
  };
  for (const [key, raw] of Object.entries(container)) {
    if (key === 'weights') {
      out.weights = validateP95Weights(raw);
      continue;
    }
    const flatKey = Object.keys(P95_FLAT_WEIGHT_KEYS).find((name) => P95_FLAT_WEIGHT_KEYS[name] === key);
    if (flatKey) {
      out[key] = number(raw, { field: `p95.${key}`, min: 0, max: 1, required: true });
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) {
      throw new ValidationError(`${field}.${key}`, 'UNKNOWN_FIELD', `Clave p95 no permitida: ${key}.`);
    }
    const [min, max] = ranges[key] || [-1e6, 1e6];
    out[key] = number(raw, { field: `${field}.${key}`, min, max, required: true });
  }
  const flatProvided = Object.values(P95_FLAT_WEIGHT_KEYS).filter((key) => has(out, key));
  if (flatProvided.length === P95_WEIGHT_KEYS.length) {
    assertWeightsSum(flatProvided.reduce((acc, key) => acc + out[key], 0), 'p95.weights');
  }
  if (!Object.keys(out).length) throw new ValidationError(field, 'EMPTY_PATCH', 'p95 no puede ir vacío.');
  return out;
}

function validateDefaultGoogle(value) {
  if (value === null) return null;
  const container = assertObject(value, 'defaultGoogle');
  for (const key of Object.keys(container)) {
    if (!['connectionId', 'calendarId'].includes(key)) throw new ValidationError(`defaultGoogle.${key}`, 'UNKNOWN_FIELD', `Campo no permitido: defaultGoogle.${key}.`);
  }
  return {
    connectionId: text(container.connectionId, { field: 'defaultGoogle.connectionId', required: true, max: 80, allowEmpty: false }),
    calendarId: text(container.calendarId, { field: 'defaultGoogle.calendarId', required: true, max: 300, allowEmpty: false })
  };
}

function validateSelectedCalendars(value) {
  const container = assertObject(value, 'selectedCalendars');
  const out = {};
  for (const [connectionId, calendarIds] of Object.entries(container)) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(connectionId)) throw new ValidationError('selectedCalendars', 'INVALID_FORMAT', 'ID de conexión inválido.');
    out[connectionId] = arrayOf(calendarIds, (item, index) => text(item, { field: `selectedCalendars.${connectionId}[${index}]`, max: 300, required: true, allowEmpty: false }), { field: `selectedCalendars.${connectionId}`, max: 250 });
  }
  return out;
}

function validateHolidays(value) {
  const out = [];
  const list = arrayOf(value, (item, index) => dateKey(item, { field: `holidays[${index}]`, required: true }), { field: 'holidays', max: 100, defaultValue: [] });
  for (const key of list) if (!out.includes(key)) out.push(key);
  return out.sort();
}

function validateWorkdays(value) {
  const list = arrayOf(value, (item, index) => {
    const code = enumValue(item, WEEKDAYS, { field: `workdays[${index}]`, required: true });
    return code;
  }, { field: 'workdays', max: 7, defaultValue: ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'] });
  const out = WEEKDAYS.filter((day) => list.includes(day));
  if (!out.length) throw new ValidationError('workdays', 'REQUIRED', 'workdays debe incluir al menos un día.');
  return out;
}

function validateMetricRoles(value) {
  if (value === null) return null;
  const container = assertObject(value, 'metricRoles');
  const allowed = ['plan', 'close', 'weeklyReview'];
  const out = {};
  for (const [key, raw] of Object.entries(container)) {
    if (!allowed.includes(key)) throw new ValidationError(`metricRoles.${key}`, 'UNKNOWN_FIELD', `Clave metricRoles no permitida: ${key}.`);
    const pattern = text(raw, { field: `metricRoles.${key}`, required: true, max: 200, allowEmpty: false });
    try {
      new RegExp(pattern);
    } catch {
      throw new ValidationError(`metricRoles.${key}`, 'INVALID_FORMAT', `Expresión regular inválida en metricRoles.${key}.`);
    }
    out[key] = pattern;
  }
  if (!Object.keys(out).length) throw new ValidationError('metricRoles', 'EMPTY_PATCH', 'metricRoles no puede ir vacío (usa null para limpiarlo).');
  return out;
}

export function validateSettingsPatch(body) {
  const container = assertObject(body, 'body');
  const input = pickFields(container, SETTINGS_FIELDS);
  const patch = {};
  if (has(input, 'timezone')) {
    const timeZone = timeZoneValue(input.timezone, { field: 'timezone', required: true });
    patch.timezone = timeZone;
  }
  if (has(input, 'workdayStart')) patch.workdayStart = timeHHMM(input.workdayStart, { field: 'workdayStart', required: true });
  if (has(input, 'workdayEnd')) patch.workdayEnd = timeHHMM(input.workdayEnd, { field: 'workdayEnd', required: true });
  if (has(input, 'defaultDurationMin')) patch.defaultDurationMin = integer(input.defaultDurationMin, { field: 'defaultDurationMin', min: 5, max: 480, required: true });
  if (has(input, 'reminderMin')) patch.reminderMin = integer(input.reminderMin, { field: 'reminderMin', min: 0, max: LIMITS.maxDayMinutes, required: true });
  if (has(input, 'autoSyncGoogle')) patch.autoSyncGoogle = boolean(input.autoSyncGoogle, { field: 'autoSyncGoogle', required: true });
  if (has(input, 'defaultGoogle')) patch.defaultGoogle = validateDefaultGoogle(input.defaultGoogle);
  if (has(input, 'p95')) patch.p95 = validateP95(input.p95);
  if (has(input, 'selectedCalendars')) patch.selectedCalendars = validateSelectedCalendars(input.selectedCalendars);
  if (has(input, 'locale')) patch.locale = text(input.locale, { field: 'locale', max: 20, required: true });
  if (has(input, 'theme')) patch.theme = enumValue(input.theme, THEMES, { field: 'theme', required: true });
  if (has(input, 'syncIntervalMin')) patch.syncIntervalMin = integer(input.syncIntervalMin, { field: 'syncIntervalMin', min: 5, max: 1440, required: true });
  if (has(input, 'googleSyncEnabled')) patch.googleSyncEnabled = boolean(input.googleSyncEnabled, { field: 'googleSyncEnabled', required: true });
  if (has(input, 'holidays')) patch.holidays = validateHolidays(input.holidays);
  if (has(input, 'holidayCalendar')) {
    patch.holidayCalendar = input.holidayCalendar === null
      ? null
      : enumValue(String(input.holidayCalendar).trim().toUpperCase(), ['CO'], { field: 'holidayCalendar', required: true });
  }
  if (has(input, 'workdays')) patch.workdays = validateWorkdays(input.workdays);
  if (has(input, 'slotStepMin')) patch.slotStepMin = integer(input.slotStepMin, { field: 'slotStepMin', min: 5, max: 120, required: true });
  if (has(input, 'slotIncludeWeekend')) patch.slotIncludeWeekend = boolean(input.slotIncludeWeekend, { field: 'slotIncludeWeekend', required: true });
  if (has(input, 'routineBackfillDays')) patch.routineBackfillDays = integer(input.routineBackfillDays, { field: 'routineBackfillDays', min: 1, max: 60, required: true });
  if (has(input, 'metricRoles')) patch.metricRoles = validateMetricRoles(input.metricRoles);
  if (patch.workdayStart && patch.workdayEnd && patch.workdayEnd <= patch.workdayStart) {
    throw new ValidationError('workdayEnd', 'INVALID_RANGE', 'workdayEnd debe ser posterior a workdayStart.');
  }
  return patch;
}

/* ------------------------------------------------------------------ */
/* Auth, secretos, asistente y backup                                  */
/* ------------------------------------------------------------------ */

export function validateAuthSetup(body) {
  const input = pickFields(body, AUTH_SETUP_FIELDS);
  return {
    username: text(input.username, { field: 'username', max: LIMITS.username, defaultValue: 'owner' }),
    password: text(input.password, { field: 'password', required: true, trim: false, max: LIMITS.passwordMax, allowEmpty: false }),
    setupToken: text(input.setupToken, { field: 'setupToken', max: 256, defaultValue: '' })
  };
}

export function validateLogin(body) {
  const input = pickFields(body, LOGIN_FIELDS);
  return {
    username: text(input.username, { field: 'username', max: LIMITS.username, defaultValue: null }),
    password: text(input.password, { field: 'password', required: true, trim: false, max: LIMITS.passwordMax, allowEmpty: false })
  };
}

export function validatePasswordChange(body) {
  const input = pickFields(body, PASSWORD_CHANGE_FIELDS);
  return {
    currentPassword: text(input.currentPassword, { field: 'currentPassword', required: true, trim: false, max: LIMITS.passwordMax, allowEmpty: false }),
    newPassword: text(input.newPassword, { field: 'newPassword', required: true, trim: false, max: LIMITS.passwordMax, allowEmpty: false })
  };
}

export function validateSecretPayload(body, { maxLength = LIMITS.secretValue } = {}) {
  const input = pickFields(body, SECRET_PUT_FIELDS);
  return { value: text(input.value, { field: 'value', required: true, trim: false, max: maxLength, allowEmpty: false }) };
}

export function validateAssistantRequest(body) {
  const input = pickFields(body, ASSISTANT_FIELDS, { allowEmpty: true });
  return {
    text: text(input.text, { field: 'text', required: true, max: LIMITS.assistantText, allowEmpty: false }),
    channel: text(input.channel, { field: 'channel', max: 40, defaultValue: 'web' }),
    context: text(input.context, { field: 'context', max: 200, defaultValue: null })
  };
}

/** Valida la estructura de un backup antes de restaurar. */
export function validateBackupShape(raw) {
  const data = assertObject(raw, 'data');
  for (const key of ['agenda', 'inbox', 'recurrences', 'meetings', 'okrs', 'metrics', 'googleConnections', 'activity', 'signals', 'workflows']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new ValidationError(`data.${key}`, 'INVALID_BACKUP', `data.${key} debe ser una lista.`);
  }
  for (const key of ['settings', 'auth', 'secrets', 'oauthStates', 'pendingActions', 'notificationLog']) {
    if (data[key] !== undefined && !isPlainObject(data[key])) throw new ValidationError(`data.${key}`, 'INVALID_BACKUP', `data.${key} debe ser un objeto.`);
  }
  if (data.version !== undefined) {
    const version = Number(data.version);
    if (!Number.isInteger(version) || version < 1 || version > 99) throw new ValidationError('data.version', 'INVALID_BACKUP', 'Versión de esquema inválida.');
  }
  return data;
}

export function validateBackupRestore(body) {
  const input = pickFields(body, ['confirm', 'data', 'backup'], { allowEmpty: true });
  if (!has(input, 'confirm') || input.confirm === undefined || input.confirm === null || String(input.confirm).trim() === '') {
    throw new ValidationError('confirm', 'CONFIRMATION_REQUIRED', 'Envía { "confirm": "RESTORE" } para restaurar un backup.');
  }
  const confirm = text(input.confirm, { field: 'confirm', required: true, max: 20, allowEmpty: false });
  if (!/^(RESTORE|RESTAURAR)$/i.test(confirm)) throw new ValidationError('confirm', 'CONFIRMATION_REQUIRED', 'Envía { "confirm": "RESTORE" } para restaurar un backup.');
  const raw = input.data !== undefined ? input.data : input.backup;
  if (raw === undefined || raw === null) throw new ValidationError('data', 'REQUIRED', 'Falta el objeto data con el backup.');
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.data && typeof raw.data === 'object' ? raw.data : raw;
  return { data: validateBackupShape(data) };
}

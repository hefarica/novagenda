/**
 * Utilidades de fecha/hora para el motor de agenda.
 *
 * Reglas:
 * - Todo el cálculo de "día operativo" se hace en la zona horaria configurada
 *   (settings.timezone), no en la zona del proceso.
 * - Las fechas de calendario se representan como claves `YYYY-MM-DD`.
 * - Los instantes se representan como ISO-8601 con offset local
 *   (`2026-10-27T07:30:00-05:00`) para conservar legibilidad y compatibilidad
 *   con los datos existentes.
 */

export const WEEKDAY_CODES = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
export const WEEKDAY_NAMES = {
  DOM: 'domingo', LUN: 'lunes', MAR: 'martes', MIE: 'miércoles',
  JUE: 'jueves', VIE: 'viernes', SAB: 'sábado'
};
const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function defaultTimezone() {
  return process.env.TIMEZONE || 'America/Bogota';
}

export function timezoneOf(settings) {
  return (settings && settings.timezone) || defaultTimezone();
}

export function normalizeWeekday(value) {
  if (value == null) return null;
  const raw = String(value).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const map = {
    DOM: 'DOM', DOMINGO: 'DOM', SUNDAY: 'DOM', SUN: 'DOM', '7': 'DOM', '0': 'DOM',
    LUN: 'LUN', LUNES: 'LUN', MONDAY: 'LUN', MON: 'LUN', '1': 'LUN',
    MAR: 'MAR', MARTES: 'MAR', TUESDAY: 'MAR', TUE: 'MAR', '2': 'MAR',
    MIE: 'MIE', MIERCOLES: 'MIE', WEDNESDAY: 'MIE', WED: 'MIE', '3': 'MIE',
    JUE: 'JUE', JUEVES: 'JUE', THURSDAY: 'JUE', THU: 'JUE', '4': 'JUE',
    VIE: 'VIE', VIERNES: 'VIE', FRIDAY: 'VIE', FRI: 'VIE', '5': 'VIE',
    SAB: 'SAB', SABADO: 'SAB', SATURDAY: 'SAB', SAT: 'SAB', '6': 'SAB'
  };
  return map[raw] || null;
}

export function normalizeWeekdays(list, fallback = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE']) {
  const source = Array.isArray(list) ? list : (typeof list === 'string' ? list.split(/[^A-Za-zÁÉÍÓÚáéíóú0-9]+/) : []);
  const out = [];
  for (const item of source) {
    const code = normalizeWeekday(item);
    if (code && !out.includes(code)) out.push(code);
  }
  return out.length ? out : [...fallback];
}

/** Valida una clave YYYY-MM-DD y comprueba que la fecha exista de verdad. */
export function parseDateKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d, 12));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { year: y, month: mo, day: d };
}

export function isValidDateKey(key) {
  return !!parseDateKey(key);
}

export function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
}

export function addDaysKey(key, days) {
  const p = parseDateKey(key);
  if (!p) throw new Error(`Fecha inválida: ${key}`);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12)).toISOString().slice(0, 10);
}

export function compareDateKeys(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function daysBetweenKeys(a, b) {
  const pa = parseDateKey(a), pb = parseDateKey(b);
  if (!pa || !pb) throw new Error('Fecha inválida');
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86400000);
}

export function dateKeyOf(date, tz = defaultTimezone()) {
  const parts = partsOf(date, tz);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function timeKeyOf(date, tz = defaultTimezone()) {
  const parts = partsOf(date, tz);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function minutesOfDayOf(date, tz = defaultTimezone()) {
  const parts = partsOf(date, tz);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function partsOf(date, tz = defaultTimezone()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('Fecha inválida');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second)
  };
}

/** Código de día de la semana (DOM..SAB) para una clave YYYY-MM-DD. */
export function weekdayCodeOfKey(key) {
  const p = parseDateKey(key);
  if (!p) return null;
  return WEEKDAY_CODES[new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay()];
}

export function weekdayCodeOfDate(date, tz = defaultTimezone()) {
  return weekdayCodeOfKey(dateKeyOf(date, tz));
}

/** Lunes de la semana que contiene la clave. */
export function weekStartKey(key) {
  const code = weekdayCodeOfKey(key);
  const idx = WEEKDAY_CODES.indexOf(code);
  const fromMonday = (idx + 6) % 7; // LUN=0 ... DOM=6
  return addDaysKey(key, -fromMonday);
}

export function weekEndKey(key) {
  return addDaysKey(weekStartKey(key), 6);
}

export function weekDateKeys(key) {
  const start = weekStartKey(key);
  return Array.from({ length: 7 }, (_, i) => addDaysKey(start, i));
}

export function monthKeyOf(key) {
  return String(key).slice(0, 7);
}

export function monthRange(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number);
  const last = daysInMonth(y, m);
  return { from: `${monthKey}-01`, to: `${monthKey}-${String(last).padStart(2, '0')}` };
}

/** Offset local en formato ±HH:MM para un instante y zona. */
export function offsetStringOf(date, tz = defaultTimezone()) {
  const d = new Date(date);
  const p = partsOf(d, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const diffMin = Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = diffMin >= 0 ? '+' : '-';
  const abs = Math.abs(diffMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Convierte una fecha local + hora local a ISO con offset.
 * `dateKey` debe ser YYYY-MM-DD y `hhmm` HH:MM (00:00 por defecto).
 */
export function isoAtLocal(dateKey, hhmm = '00:00', tz = defaultTimezone()) {
  const p = parseDateKey(dateKey);
  if (!p) throw new Error(`Fecha inválida: ${dateKey}`);
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmm).trim());
  if (!tm) throw new Error(`Hora inválida: ${hhmm}`);
  const hour = Number(tm[1]), minute = Number(tm[2]);
  if (hour > 23 || minute > 59) throw new Error(`Hora inválida: ${hhmm}`);
  const wallUTC = Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0);
  let instant = wallUTC;
  for (let i = 0; i < 4; i++) {
    const seen = partsOf(new Date(instant), tz);
    const seenUTC = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const delta = seenUTC - instant;
    if (delta === 0) break;
    instant -= delta;
  }
  const d = new Date(instant);
  return `${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offsetStringOf(d, tz)}`;
}

/** ISO local para el final del día (23:59:00). */
export function endOfLocalDay(dateKey, tz = defaultTimezone()) {
  return isoAtLocal(dateKey, '23:59', tz);
}

/** Parsea un ISO y devuelve la clave de fecha local (o null si inválido). */
export function dateKeyOfIso(iso, tz = defaultTimezone()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dateKeyOf(d, tz);
}

/**
 * Variante tolerante para datos heredados/corruptos: nunca lanza.
 * Devuelve `null` si el instante no es una fecha real.
 */
export function safeDateKeyOfIso(iso, tz = defaultTimezone()) {
  try {
    if (!isValidIso(iso)) return null;
    return dateKeyOfIso(iso, tz);
  } catch {
    return null;
  }
}

export function isValidIso(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  // Acepta ISO con offset/Z o naive (se interpreta en la zona configurada más
  // adelante), con segundos y fracciones opcionales.
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] || 0);
  // Calendario real: 31-feb, 31-abr o 30-feb no existen.
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const offset = match[8];
  if (offset && offset.toUpperCase() !== 'Z') {
    const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
    if (!offsetMatch) return false;
    if (Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59) return false;
  }
  return !Number.isNaN(Date.parse(raw.replace(' ', 'T')));
}

/**
 * Formatea un instante como ISO-8601 local con offset de la zona indicada:
 * `2026-10-27T07:30:00-05:00`. Conserva la fecha local real (puede cambiar de día).
 */
export function isoLocalOf(date, tz = defaultTimezone()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('Fecha inválida');
  const p = partsOf(d, tz);
  const key = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return `${key}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}${offsetStringOf(d, tz)}`;
}

export function minutesBetween(startIso, endIso) {
  const a = new Date(startIso).getTime(), b = new Date(endIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

export function overlaps(startA, endA, startB, endB) {
  const a1 = new Date(startA).getTime(), a2 = new Date(endA).getTime();
  const b1 = new Date(startB).getTime(), b2 = new Date(endB).getTime();
  if (![a1, a2, b1, b2].every(Number.isFinite)) return false;
  return a1 < b2 && a2 > b1;
}

export function rangesOverlap(a, b) {
  return overlaps(a.start, a.end, b.start, b.end);
}

export function roundUpToMinutes(date, stepMin) {
  const step = Math.max(1, Number(stepMin) || 30) * 60000;
  return new Date(Math.ceil(new Date(date).getTime() / step) * step);
}

/** Algoritmo de Pascua (Meeus/Jones/Butcher) en UTC. */
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function nextMonday(date) {
  const d = new Date(date);
  const dow = d.getUTCDay();
  if (dow === 1) return d;
  return new Date(d.getTime() + ((8 - dow) % 7) * 86400000);
}

function ymd(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Festivos de Colombia (Ley 51 de 1983) para un año.
 * Se usan solo si settings.holidayCalendar === 'CO'.
 */
export function colombiaHolidays(year) {
  const easter = easterSunday(year);
  const add = (base, days) => new Date(base.getTime() + days * 86400000);
  const fixed = [
    `${year}-01-01`, `${year}-05-01`, `${year}-07-20`, `${year}-08-07`, `${year}-12-08`, `${year}-12-25`
  ];
  const emiliani = [
    new Date(Date.UTC(year, 0, 6, 12)),      // Reyes Magos
    new Date(Date.UTC(year, 2, 19, 12)),     // San José
    new Date(Date.UTC(year, 5, 29, 12)),     // San Pedro y San Pablo
    new Date(Date.UTC(year, 7, 15, 12)),     // Asunción
    new Date(Date.UTC(year, 9, 12, 12)),     // Día de la Raza
    new Date(Date.UTC(year, 10, 1, 12)),     // Todos los Santos
    new Date(Date.UTC(year, 10, 11, 12))     // Independencia de Cartagena
  ].map(nextMonday);
  const relative = [
    add(easter, -3), // Jueves Santo
    add(easter, -2), // Viernes Santo
    nextMonday(add(easter, 43)),  // Ascensión
    nextMonday(add(easter, 64)),  // Corpus Christi
    nextMonday(add(easter, 71))   // Sagrado Corazón
  ];
  return [...new Set([...fixed, ...emiliani.map(ymd), ...relative.map(ymd)])].sort();
}

export function holidaysOfYear(year, settings = {}) {
  const explicit = Array.isArray(settings.holidays) ? settings.holidays.filter(isValidDateKey) : [];
  const calendar = String(settings.holidayCalendar || '').toUpperCase();
  const computed = calendar === 'CO' ? colombiaHolidays(year) : [];
  return new Set([...explicit, ...computed]);
}

export function isHoliday(dateKey, settings = {}) {
  if (!isValidDateKey(dateKey)) return false;
  return holidaysOfYear(Number(String(dateKey).slice(0, 4)), settings).has(dateKey);
}

export function workdayCodes(settings = {}) {
  const configured = settings.workdays || settings.workingDays || settings.businessDays;
  return normalizeWeekdays(configured, ['LUN', 'MAR', 'MIE', 'JUE', 'VIE']);
}

export function isWeekend(dateKey, settings = {}) {
  const code = weekdayCodeOfKey(dateKey);
  return !workdayCodes(settings).includes(code);
}

export function isWorkingDay(dateKey, settings = {}) {
  if (!isValidDateKey(dateKey)) return false;
  if (!workdayCodes(settings).includes(weekdayCodeOfKey(dateKey))) return false;
  if (settings.ignoreHolidays === true) return true;
  return !isHoliday(dateKey, settings);
}

/** Distancia en días hábiles (aprox.), usada para reportes. */
export function nowIso() {
  return new Date().toISOString();
}

export function formatLocal(date, tz = defaultTimezone(), opts = {}) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: tz, ...opts }).format(new Date(date));
}

export function formatDateLong(dateKey, tz = defaultTimezone()) {
  const p = parseDateKey(dateKey);
  if (!p) return String(dateKey);
  const dow = WEEKDAY_NAMES[weekdayCodeOfKey(dateKey)] || '';
  return `${dow} ${p.day} de ${MONTH_NAMES[p.month - 1]} de ${p.year}`;
}

export function formatTime(iso, tz = defaultTimezone()) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function formatShortDate(iso, tz = defaultTimezone()) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
}

/** Rango [inicio, fin) de un día local como instantes ISO. */
export function localDayRange(dateKey, tz = defaultTimezone()) {
  const start = isoAtLocal(dateKey, '00:00', tz);
  const end = isoAtLocal(addDaysKey(dateKey, 1), '00:00', tz);
  return { start, end };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { hour: h, minute: min, hhmm: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, minutes: h * 60 + min };
}

export function minutesToHHMM(total) {
  const t = ((Math.round(Number(total) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

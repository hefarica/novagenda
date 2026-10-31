/**
 * Configuración y estado persistente del motor de avisos inteligentes (t16).
 *
 * Todo vive en `data.nudges` (clave nueva, viaja en backup/restore):
 *   { version, config, state }
 *
 * - `config` es editable por API (`POST /api/nudges/config`); nunca se
 *   hardcodea en el motor.
 * - `state` guarda contadores, cooldowns, huellas, historial y reportes.
 *
 * Las funciones `ensure*` mutan el objeto `data` y se usan dentro de
 * `store.mutate`. `read*` son puras (para dry-run / lecturas).
 */
import { dateKeyOfIso, timeKeyOf } from '../agenda/time.mjs';

export const NUDGE_STATE_VERSION = 1;
export const CHANNEL_IDS = Object.freeze(['whatsapp', 'telegram', 'email']);

/** Catálogo de tipos de aviso (para docs/UI y priorización). */
export const NUDGE_TYPES = Object.freeze([
  { type: 'overdue', label: 'Vencidas', description: 'Citas abiertas con fecha pasada.', baseImpact: 100 },
  { type: 'imap_new', label: 'Correo nuevo', description: 'Bandeja IMAP con mensajes nuevos sin revisar.', baseImpact: 93 },
  { type: 'task_overdue', label: 'Tarea vencida', description: 'Tarea o compromiso abierto con fecha pasada.', baseImpact: 94 },
  { type: 'approvals', label: 'Aprobaciones', description: 'Propuestas de la oficina sin decidir.', baseImpact: 95 },
  { type: 'task_due', label: 'Tarea para hoy', description: 'Tarea o compromiso que vence hoy.', baseImpact: 86 },
  { type: 'meeting_no_place', label: 'Reunión sin lugar', description: 'Reunión próxima sin lugar ni enlace.', baseImpact: 88 },
  { type: 'daily_close', label: 'Cierre del día', description: 'El cierre diario sigue pendiente.', baseImpact: 82 },
  { type: 'unanswered', label: 'Mensajes sin responder', description: 'Entrantes de canales sin respuesta.', baseImpact: 76 },
  { type: 'focus_unmet', label: 'Foco incumplido', description: 'Foco real por debajo del objetivo.', baseImpact: 70 },
  { type: 'undated', label: 'Pendientes sin fecha', description: 'Capturas accionables sin día asignado.', baseImpact: 56 },
  { type: 'free_gap', label: 'Hueco libre', description: 'Franja libre suficiente para avanzar.', baseImpact: 46 }
]);

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  cadenceMin: 30,
  silence: Object.freeze({ enabled: true, from: '21:30', to: '07:00' }),
  channels: Object.freeze([]),
  maxPerHour: 2,
  maxPerDay: 8,
  cooldownMin: 90,
  maxItems: 3,
  freeGapMin: 60,
  focusTargetMin: null,
  unansweredMin: 30,
  meetingLookaheadMin: 180,
  closeCheckAt: '17:30',
  reportAt: '18:00',
  dedupeTtlMin: 360,
  llmEnabled: true
});

export const CONFIG_FIELDS = Object.freeze([
  'enabled', 'cadenceMin', 'silence', 'channels', 'maxPerHour', 'maxPerDay', 'cooldownMin',
  'maxItems', 'freeGapMin', 'focusTargetMin', 'unansweredMin', 'meetingLookaheadMin',
  'closeCheckAt', 'reportAt', 'dedupeTtlMin', 'llmEnabled'
]);

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function intIn(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function timeIn(value, fallback) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return fallback;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function channelsIn(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const id = String(item ?? '').trim().toLowerCase();
    if (CHANNEL_IDS.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Normaliza una configuración (tolerante a datos viejos o incompletos).
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeConfig(raw = {}) {
  const input = isPlainObject(raw) ? raw : {};
  const silence = isPlainObject(input.silence) ? input.silence : {};
  const focusRaw = input.focusTargetMin;
  const focusTargetMin = focusRaw === null || focusRaw === undefined || focusRaw === '' || Number(focusRaw) === 0
    ? null
    : intIn(focusRaw, 15, 600, null);
  return {
    enabled: input.enabled === undefined ? DEFAULT_CONFIG.enabled : input.enabled !== false,
    cadenceMin: intIn(input.cadenceMin, 5, 240, DEFAULT_CONFIG.cadenceMin),
    silence: {
      enabled: silence.enabled === undefined ? DEFAULT_CONFIG.silence.enabled : silence.enabled !== false,
      from: timeIn(silence.from, DEFAULT_CONFIG.silence.from),
      to: timeIn(silence.to, DEFAULT_CONFIG.silence.to)
    },
    channels: channelsIn(input.channels),
    maxPerHour: intIn(input.maxPerHour, 1, 12, DEFAULT_CONFIG.maxPerHour),
    maxPerDay: intIn(input.maxPerDay, 1, 50, DEFAULT_CONFIG.maxPerDay),
    cooldownMin: intIn(input.cooldownMin, 0, 1440, DEFAULT_CONFIG.cooldownMin),
    maxItems: intIn(input.maxItems, 1, 3, DEFAULT_CONFIG.maxItems),
    freeGapMin: intIn(input.freeGapMin, 15, 240, DEFAULT_CONFIG.freeGapMin),
    focusTargetMin,
    unansweredMin: intIn(input.unansweredMin, 5, 1440, DEFAULT_CONFIG.unansweredMin),
    meetingLookaheadMin: intIn(input.meetingLookaheadMin, 15, 720, DEFAULT_CONFIG.meetingLookaheadMin),
    closeCheckAt: timeIn(input.closeCheckAt, DEFAULT_CONFIG.closeCheckAt),
    reportAt: timeIn(input.reportAt, DEFAULT_CONFIG.reportAt),
    dedupeTtlMin: intIn(input.dedupeTtlMin, 0, 2880, DEFAULT_CONFIG.dedupeTtlMin),
    llmEnabled: input.llmEnabled === undefined ? DEFAULT_CONFIG.llmEnabled : input.llmEnabled !== false
  };
}

/** Config efectiva sin mutar el store (lecturas y dry-run). */
export function readConfig(data, overrides = null) {
  const raw = isPlainObject(data?.nudges?.config) ? data.nudges.config : {};
  return normalizeConfig(overrides ? { ...raw, ...overrides } : raw);
}

function freshState() {
  return {
    counters: { dateKey: null, sent: 0, dismissed: 0, reports: 0 },
    hourBuckets: {},
    cooldowns: {},
    frames: {},
    dismissedItems: {},
    history: [],
    reports: {},
    lastEvaluateAt: null,
    lastSentAt: null
  };
}

function mergeState(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const base = freshState();
  const counters = isPlainObject(input.counters) ? input.counters : {};
  return {
    counters: {
      dateKey: typeof counters.dateKey === 'string' ? counters.dateKey : null,
      sent: intIn(counters.sent, 0, 100000, 0),
      dismissed: intIn(counters.dismissed, 0, 100000, 0),
      reports: intIn(counters.reports, 0, 100000, 0)
    },
    hourBuckets: isPlainObject(input.hourBuckets) ? { ...input.hourBuckets } : {},
    cooldowns: isPlainObject(input.cooldowns) ? { ...input.cooldowns } : {},
    frames: isPlainObject(input.frames) ? { ...input.frames } : {},
    dismissedItems: isPlainObject(input.dismissedItems) ? { ...input.dismissedItems } : {},
    history: Array.isArray(input.history) ? input.history.filter((item) => item && typeof item === 'object').slice(0, 200) : [],
    reports: isPlainObject(input.reports) ? { ...input.reports } : {},
    lastEvaluateAt: typeof input.lastEvaluateAt === 'string' ? input.lastEvaluateAt : null,
    lastSentAt: typeof input.lastSentAt === 'string' ? input.lastSentAt : null
  };
}

/**
 * Garantiza `data.nudges` (mutando el store dentro de `store.mutate`).
 * @param {any} data
 * @returns {{config:object, state:object, created:boolean}}
 */
export function ensureNudgeState(data) {
  if (!isPlainObject(data)) return { config: normalizeConfig({}), state: freshState(), created: false };
  const existing = isPlainObject(data.nudges) ? data.nudges : null;
  const created = !existing;
  const base = existing || {};
  const config = normalizeConfig(base.config);
  const state = mergeState(base.state);
  data.nudges = { version: NUDGE_STATE_VERSION, config, state };
  return { config, state, created };
}

/**
 * Lectura pura (sin escribir en el store) para dry-run/GET.
 * @param {any} data
 */
export function readNudgeState(data) {
  const raw = isPlainObject(data?.nudges) ? data.nudges : {};
  return {
    version: Number(raw.version) || NUDGE_STATE_VERSION,
    config: normalizeConfig(raw.config),
    state: mergeState(raw.state)
  };
}

/** Clave de hora local `YYYY-MM-DDTHH` para el cubo de rate-limit. */
export function hourKeyOf(now, tz) {
  return `${dateKeyOfIso(now.toISOString(), tz)}T${String(timeKeyOf(now, tz)).slice(0, 2)}`;
}

/**
 * Poda estado viejo (cooldowns/huellas/descarten > 7 días, historial > 200,
 * reportes > 60 días, cubos de hora > 6 h).
 * @param {object} state
 * @param {Date} now
 */
export function pruneNudgeState(state, now) {
  if (!isPlainObject(state)) return;
  const nowMs = now.getTime();
  const week = 7 * 86_400_000;
  const pruneMap = (map, maxAgeMs) => {
    if (!isPlainObject(map)) return {};
    const out = {};
    for (const [key, value] of Object.entries(map)) {
      const at = Date.parse(value);
      if (Number.isFinite(at) && nowMs - at <= maxAgeMs) out[key] = value;
    }
    return out;
  };
  state.cooldowns = pruneMap(state.cooldowns, week);
  state.frames = pruneMap(state.frames, week);
  state.dismissedItems = pruneMap(state.dismissedItems, week);
  if (isPlainObject(state.hourBuckets)) {
    const buckets = {};
    for (const [key, value] of Object.entries(state.hourBuckets)) {
      const at = Date.parse(isPlainObject(value) ? value.at : value);
      if (Number.isFinite(at) && nowMs - at <= 6 * 3_600_000) {
        buckets[key] = isPlainObject(value) ? { count: intIn(value.count, 0, 10000, 0), at: value.at } : { count: 0, at: null };
      }
    }
    state.hourBuckets = buckets;
  }
  state.history = (Array.isArray(state.history) ? state.history : []).slice(0, 200);
  if (isPlainObject(state.reports)) {
    const reports = {};
    for (const [key, value] of Object.entries(state.reports)) {
      const at = Date.parse(value?.at || '');
      if (!Number.isFinite(at) || nowMs - at <= 60 * 86_400_000) reports[key] = value;
    }
    state.reports = reports;
  }
}



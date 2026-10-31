/**
 * Rutas del motor de avisos inteligentes (t16).
 *
 * Se montan por auto-descubrimiento. Además, al importarse registran el motor
 * en el scheduler de t8 mediante `registerTickHandler()` (sin timers propios).
 *
 *   GET  /api/nudges/config
 *   POST /api/nudges/config
 *   GET  /api/nudges/feed?limit=20&includeDismissed=1
 *   GET  /api/nudges/status
 *   GET  /api/nudges/report?date=YYYY-MM-DD
 *   POST /api/nudges/evaluate        (dry-run por defecto; {dryRun:false} envía)
 *   POST /api/nudges/:id/dismiss
 */
import { logError } from '../http/logger.mjs';
import { ValidationError } from '../http/errors.mjs';
import {
  arrayOf, assertObject, boolean, enumValue, integer, pickFields, timeHHMM
} from '../validate.mjs';
import {
  bodyOf, itemEnvelope, notFound, paramOf, queryBool, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { CHANNEL_IDS, CONFIG_FIELDS } from '../nudges/config.mjs';
import { isValidDateKey } from '../agenda/time.mjs';
import {
  dismissNudge, evaluateNudges, getConfigView, getDailyReport, listFeed, nudgesStatus, nudgesTick,
  updateConfig
} from '../nudges/engine.mjs';
import { registerTickHandler } from '../workflows/scheduler.mjs';

export const name = 'nudges';
export const priority = 100;

/* ------------------------------------------------------------------ */
/* Validación de configuración                                         */
/* ------------------------------------------------------------------ */

function nullableInteger(value, options) {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return null;
  return integer(value, options);
}

function validateConfigPatch(body) {
  const input = pickFields(assertObject(body), CONFIG_FIELDS, { field: 'body' });
  const patch = {};
  if (input.enabled !== undefined) patch.enabled = boolean(input.enabled, { field: 'enabled', required: true });
  if (input.cadenceMin !== undefined) patch.cadenceMin = integer(input.cadenceMin, { field: 'cadenceMin', min: 5, max: 240 });
  if (input.silence !== undefined) {
    const silence = pickFields(input.silence, ['enabled', 'from', 'to'], { field: 'silence', allowEmpty: false });
    const value = {};
    if (silence.enabled !== undefined) value.enabled = boolean(silence.enabled, { field: 'silence.enabled', required: true });
    if (silence.from !== undefined) value.from = timeHHMM(silence.from, { field: 'silence.from', required: true });
    if (silence.to !== undefined) value.to = timeHHMM(silence.to, { field: 'silence.to', required: true });
    patch.silence = value;
  }
  if (input.channels !== undefined) {
    patch.channels = arrayOf(input.channels, (value, index) => enumValue(value, CHANNEL_IDS, { field: `channels[${index}]` }), {
      field: 'channels', max: 3, defaultValue: []
    });
  }
  if (input.maxPerHour !== undefined) patch.maxPerHour = integer(input.maxPerHour, { field: 'maxPerHour', min: 1, max: 12 });
  if (input.maxPerDay !== undefined) patch.maxPerDay = integer(input.maxPerDay, { field: 'maxPerDay', min: 1, max: 50 });
  if (input.cooldownMin !== undefined) patch.cooldownMin = integer(input.cooldownMin, { field: 'cooldownMin', min: 0, max: 1440 });
  if (input.maxItems !== undefined) patch.maxItems = integer(input.maxItems, { field: 'maxItems', min: 1, max: 3 });
  if (input.freeGapMin !== undefined) patch.freeGapMin = integer(input.freeGapMin, { field: 'freeGapMin', min: 15, max: 240 });
  if (input.focusTargetMin !== undefined) {
    patch.focusTargetMin = nullableInteger(input.focusTargetMin, { field: 'focusTargetMin', min: 15, max: 600 });
  }
  if (input.unansweredMin !== undefined) patch.unansweredMin = integer(input.unansweredMin, { field: 'unansweredMin', min: 5, max: 1440 });
  if (input.meetingLookaheadMin !== undefined) patch.meetingLookaheadMin = integer(input.meetingLookaheadMin, { field: 'meetingLookaheadMin', min: 15, max: 720 });
  if (input.closeCheckAt !== undefined) patch.closeCheckAt = timeHHMM(input.closeCheckAt, { field: 'closeCheckAt', required: true });
  if (input.reportAt !== undefined) patch.reportAt = timeHHMM(input.reportAt, { field: 'reportAt', required: true });
  if (input.dedupeTtlMin !== undefined) patch.dedupeTtlMin = integer(input.dedupeTtlMin, { field: 'dedupeTtlMin', min: 0, max: 2880 });
  if (input.llmEnabled !== undefined) patch.llmEnabled = boolean(input.llmEnabled, { field: 'llmEnabled', required: true });
  return patch;
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function nudgesConfigGet(ctx) {
  return respond(ctx, 200, getConfigView());
}

async function nudgesConfigPost(ctx) {
  const patch = validateConfigPatch(await bodyOf(ctx));
  const config = await updateConfig(patch);
  return respond(ctx, 200, { ok: true, config, ...getConfigView() });
}

function nudgesFeed(ctx) {
  const limit = queryInt(ctx, 'limit', 20, { min: 1, max: 100 });
  const includeDismissed = queryBool(ctx, 'includeDismissed', false);
  return respond(ctx, 200, listFeed({ limit, includeDismissed }));
}

function nudgesStatusRoute(ctx) {
  const status = nudgesStatus();
  return respond(ctx, 200, {
    ...status,
    hook: {
      registered: isRegistered(),
      autostart: shouldAutostart(),
      scheduler: 'lib/workflows/scheduler.mjs'
    }
  });
}

function nudgesReport(ctx) {
  const date = queryString(ctx, 'date');
  if (date && !isValidDateKey(date)) {
    throw new ValidationError('date', 'INVALID_DATE', 'date debe ser una fecha real YYYY-MM-DD.');
  }
  return respond(ctx, 200, { date: date || null, report: getDailyReport(date) });
}

async function nudgesEvaluate(ctx) {
  let body = {};
  try { body = (await bodyOf(ctx, {})) || {}; } catch { body = {}; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  const allowed = new Set(['dryRun', 'force']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo no permitido: ${key}.`);
  }
  const queryDry = queryBool(ctx, 'dryRun', true);
  const dryRun = body.dryRun === undefined ? queryDry : body.dryRun !== false;
  const force = body.force === undefined ? true : body.force !== false;
  const result = await evaluateNudges({ dryRun, force });
  return respond(ctx, 200, { ...result, dryRun });
}

async function nudgesDismiss(ctx) {
  const id = paramOf(ctx, 'id');
  const item = await dismissNudge(id);
  if (!item) return notFound(ctx, `Aviso ${id}`);
  return respond(ctx, 200, { ok: true, ...itemEnvelope(item) });
}

export const routes = [
  { method: 'GET', path: '/api/nudges/config', name: 'nudges.config.get', handler: route(nudgesConfigGet) },
  { method: 'POST', path: '/api/nudges/config', name: 'nudges.config.post', handler: route(nudgesConfigPost) },
  { method: 'GET', path: '/api/nudges/feed', name: 'nudges.feed', handler: route(nudgesFeed) },
  { method: 'GET', path: '/api/nudges/status', name: 'nudges.status', handler: route(nudgesStatusRoute) },
  { method: 'GET', path: '/api/nudges/report', name: 'nudges.report', handler: route(nudgesReport) },
  { method: 'POST', path: '/api/nudges/evaluate', name: 'nudges.evaluate', handler: route(nudgesEvaluate) },
  { method: 'POST', path: '/api/nudges/:id/dismiss', name: 'nudges.dismiss', handler: route(nudgesDismiss) }
];

/* ------------------------------------------------------------------ */
/* Enganche al scheduler de t8 (sin timers propios)                    */
/* ------------------------------------------------------------------ */

let unregister = null;

/** Mismos guards que el scheduler/route de workflows. */
function shouldAutostart() {
  if (String(process.env.WORKFLOWS_AUTOSTART || '') === '0') return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  if (process.argv.some((arg) => arg === '--test' || arg.startsWith('--test='))) return false;
  return true;
}

/** Handler estable (misma referencia) para que el registro sea idempotente. */
const tickHandler = ({ now, dryRun }) => nudgesTick({ now, dryRun });

export function isRegistered() {
  return typeof unregister === 'function';
}

export function registerNudgesHook() {
  if (unregister) return { registered: true, already: true };
  unregister = registerTickHandler(tickHandler);
  return { registered: true, already: false };
}

export function unregisterNudgesHook() {
  if (typeof unregister === 'function') {
    try { unregister(); } catch { /* ignore */ }
  }
  unregister = null;
  return { registered: false };
}

if (shouldAutostart()) {
  try {
    registerNudgesHook();
  } catch (error) {
    logError('nudges:autostart', error);
  }
}

process.once('SIGINT', unregisterNudgesHook);
process.once('SIGTERM', unregisterNudgesHook);

export default { name, priority, routes };

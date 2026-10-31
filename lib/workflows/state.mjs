/**
 * Estado persistente del motor de workflows: siembra, ledger de ejecuciones,
 * claves de idempotencia y compatibilidad con `notificationLog`.
 *
 * Todas las funciones mutan el objeto `data` del store y están pensadas para
 * usarse DENTRO de `store.mutate(async (data) => …)`. No escriben a disco.
 */
import { nextId } from '../store.mjs';
import {
  WORKFLOW_SEED_VERSION, baseWorkflows, SIGNAL_SEED_VERSION, baseSignalRules,
  normalizeWeekdayCodes
} from './defaults.mjs';

export const RUNS_LIMIT = 500;
export const SIGNALS_LIMIT = 200;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Una ejecución "running" más vieja que esto se considera interrumpida. */
export const STALE_RUN_MS = 10 * 60_000;
/** Espera antes de reintentar según el número de intento (ms). */
export const RETRY_BACKOFF_MS = Object.freeze([0, 60_000, 300_000, 900_000]);

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* Siembra                                                             */
/* ------------------------------------------------------------------ */

/**
 * Garantiza las estructuras del motor de workflows. Siembra los workflows base
 * una sola vez (marcador `workflowsMeta.seededVersion`).
 * @param {any} data
 * @returns {{seeded:boolean, created:number}}
 */
export function ensureWorkflowState(data) {
  if (!isPlainObject(data)) return { seeded: false, created: 0 };
  if (!Array.isArray(data.workflows)) data.workflows = [];
  if (!Array.isArray(data.workflowRuns)) data.workflowRuns = [];
  if (!isPlainObject(data.workflowsMeta)) data.workflowsMeta = {};
  const version = Number(data.workflowsMeta.seededVersion) || 0;
  if (version >= WORKFLOW_SEED_VERSION) return { seeded: false, created: 0 };
  const stamp = nowIso();
  const existing = new Set(data.workflows.filter((item) => item && item.id).map((item) => item.id));
  let created = 0;
  for (const workflow of baseWorkflows(stamp)) {
    if (existing.has(workflow.id)) continue;
    data.workflows.push(workflow);
    existing.add(workflow.id);
    created += 1;
  }
  // Migración v1→v2: los seeds antiguos guardaban días en inglés (`FRI`) y el
  // motor compara contra LUN..DOM, por lo que el reporte semanal nunca corría.
  let migrated = 0;
  for (const workflow of data.workflows) {
    const trigger = workflow?.trigger;
    if (!trigger || typeof trigger !== 'object' || !Array.isArray(trigger.weekdays)) continue;
    const normalized = normalizeWeekdayCodes(trigger.weekdays);
    const next = normalized.length ? normalized : (trigger.type === 'weekly' ? ['VIE'] : normalized);
    if (String(trigger.weekdays.join(',')) !== String(next.join(','))) {
      trigger.weekdays = next;
      workflow.updatedAt = stamp;
      migrated += 1;
    }
  }
  data.workflowsMeta = {
    ...data.workflowsMeta,
    seededVersion: WORKFLOW_SEED_VERSION,
    seededAt: data.workflowsMeta.seededAt || stamp,
    updatedAt: stamp
  };
  return { seeded: true, created, migrated };
}

/**
 * Garantiza reglas de señales, cooldowns y contadores.
 * @param {any} data
 */
export function ensureSignalState(data) {
  if (!isPlainObject(data)) return { seeded: false, created: 0 };
  if (!Array.isArray(data.signals)) data.signals = [];
  if (!Array.isArray(data.signalRules)) data.signalRules = [];
  if (!isPlainObject(data.signalCooldowns)) data.signalCooldowns = {};
  if (!isPlainObject(data.signalRulesMeta)) data.signalRulesMeta = {};
  const version = Number(data.signalRulesMeta.seededVersion) || 0;
  if (version >= SIGNAL_SEED_VERSION) return { seeded: false, created: 0 };
  const stamp = nowIso();
  const existing = new Set(data.signalRules.filter((item) => item && item.id).map((item) => item.id));
  let created = 0;
  for (const rule of baseSignalRules()) {
    if (existing.has(rule.id)) continue;
    data.signalRules.push({ ...rule, createdAt: stamp, updatedAt: stamp });
    existing.add(rule.id);
    created += 1;
  }
  data.signalRulesMeta = {
    ...data.signalRulesMeta,
    seededVersion: SIGNAL_SEED_VERSION,
    seededAt: data.signalRulesMeta.seededAt || stamp,
    updatedAt: stamp
  };
  return { seeded: true, created };
}

/** ¿Hace falta sembrar algo? (para no escribir en disco en cada tick). */
export function needsSeed(data) {
  if (!isPlainObject(data)) return false;
  const workflowsOk = Array.isArray(data.workflows)
    && isPlainObject(data.workflowsMeta)
    && Number(data.workflowsMeta.seededVersion) >= WORKFLOW_SEED_VERSION;
  const signalsOk = Array.isArray(data.signalRules)
    && isPlainObject(data.signalRulesMeta)
    && Number(data.signalRulesMeta.seededVersion) >= SIGNAL_SEED_VERSION;
  return !workflowsOk || !signalsOk;
}

/* ------------------------------------------------------------------ */
/* Ledger de ejecuciones                                               */
/* ------------------------------------------------------------------ */

export function runsOf(data) {
  if (!Array.isArray(data.workflowRuns)) data.workflowRuns = [];
  return data.workflowRuns;
}

export function workflowsOf(data) {
  return Array.isArray(data.workflows) ? data.workflows : [];
}

export function findWorkflow(data, id) {
  return workflowsOf(data).find((workflow) => workflow && workflow.id === id) || null;
}

export function isFinalStatus(status) {
  return status === 'ok' || status === 'skipped';
}

export function pruneRuns(data, limit = RUNS_LIMIT) {
  const runs = runsOf(data);
  if (runs.length > limit) data.workflowRuns = runs.slice(runs.length - limit);
}

/**
 * Busca la última ejecución de una ventana concreta.
 * @param {any} data
 * @param {string} workflowId
 * @param {string} windowKey
 */
export function windowRuns(data, workflowId, windowKey) {
  return runsOf(data).filter((run) => run && run.workflowId === workflowId && run.windowKey === windowKey);
}

/** ¿La ventana ya se completó (ok/skipped)? */
export function isWindowCompleted(data, workflowId, windowKey) {
  return windowRuns(data, workflowId, windowKey).some((run) => isFinalStatus(run.status));
}

/**
 * Reclama atómicamente una ejecución para (workflow, ventana).
 *
 * - Marca ejecuciones `running` obsoletas como error (proceso caído).
 * - No permite solapes.
 * - Respeta reintentos con backoff y un máximo de intentos.
 *
 * @param {any} data
 * @param {{workflowId:string, workflowName?:string, windowKey:string, reason?:string,
 *          nowIso?:string, maxAttempts?:number, requestId?:string|null,
 *          scheduledFor?:string|null}} options
 * @returns {{claimed:boolean, reason?:string, run?:any, retryAt?:string|null}}
 */
export function claimRun(data, options) {
  // La auditoría usa el reloj REAL; `scheduledFor` conserva la hora programada.
  const realNowIso = new Date().toISOString();
  const nowMs = Date.now();
  const runs = runsOf(data);

  // Ejecuciones interrumpidas por caída del proceso.
  for (const run of runs) {
    if (!run || run.status !== 'running') continue;
    const started = Date.parse(run.startedAt || '');
    if (Number.isFinite(started) && nowMs - started > STALE_RUN_MS) {
      run.status = 'error';
      run.error = 'Ejecución interrumpida (proceso caído o reinicio).';
      run.finishedAt = realNowIso;
      run.durationMs = Math.max(0, nowMs - started);
      run.nextAttemptAt = realNowIso;
    }
  }

  const same = windowRuns(data, options.workflowId, options.windowKey);
  const completed = same.find((run) => isFinalStatus(run.status));
  if (completed) return { claimed: false, reason: 'completed', run: completed };

  const running = same.find((run) => run.status === 'running');
  if (running) return { claimed: false, reason: 'running', run: running };

  const lastError = [...same].reverse().find((run) => run.status === 'error') || null;
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const attempt = (Number(lastError?.attempt) || 0) + 1;
  if (lastError && attempt > maxAttempts) {
    return { claimed: false, reason: 'exhausted', run: lastError, retryAt: null };
  }
  if (lastError?.nextAttemptAt) {
    const retryAt = Date.parse(lastError.nextAttemptAt);
    if (Number.isFinite(retryAt) && retryAt > nowMs) {
      return { claimed: false, reason: 'backoff', run: lastError, retryAt: lastError.nextAttemptAt };
    }
  }

  const run = {
    id: nextId('RUN', runs),
    workflowId: options.workflowId,
    workflowName: options.workflowName || options.workflowId,
    windowKey: options.windowKey,
    reason: options.reason || 'schedule',
    requestId: options.requestId || null,
    status: 'running',
    dryRun: false,
    attempt,
    maxAttempts,
    startedAt: realNowIso,
    finishedAt: null,
    durationMs: null,
    scheduledFor: options.scheduledFor || null,
    steps: [],
    llm: null,
    delivery: [],
    tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    error: null,
    nextAttemptAt: null
  };
  runs.push(run);
  pruneRuns(data);
  return { claimed: true, run };
}

/**
 * Cierra una ejecución reclamada.
 * @param {any} data
 * @param {string} runId
 * @param {{status?:string, steps?:any[], llm?:any, delivery?:any[], tokens?:any,
 *          error?:string|null, finishedAt?:string, textPreview?:string|null,
 *          meta?:object}} patch
 */
export function finishRun(data, runId, patch = {}) {
  const run = runsOf(data).find((item) => item && item.id === runId);
  if (!run) return null;
  const finishedAt = patch.finishedAt || nowIso();
  const startedMs = Date.parse(run.startedAt || '');
  const finishedMs = Date.parse(finishedAt);
  run.finishedAt = finishedAt;
  run.durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null;
  run.status = patch.status || (patch.error ? 'error' : 'ok');
  if (Array.isArray(patch.steps)) run.steps = patch.steps;
  if (patch.llm !== undefined) run.llm = patch.llm;
  if (Array.isArray(patch.delivery)) run.delivery = patch.delivery;
  if (patch.tokens) run.tokens = patch.tokens;
  if (patch.error !== undefined) run.error = patch.error;
  if (patch.textPreview !== undefined) run.textPreview = patch.textPreview;
  if (patch.meta && typeof patch.meta === 'object') run.meta = patch.meta;
  if (run.status === 'error') {
    const backoff = RETRY_BACKOFF_MS[Math.min(run.attempt || 1, RETRY_BACKOFF_MS.length - 1)] || 60_000;
    run.nextAttemptAt = new Date((Number.isFinite(finishedMs) ? finishedMs : Date.now()) + backoff).toISOString();
  } else {
    run.nextAttemptAt = null;
  }
  pruneRuns(data);
  return run;
}

/**
 * Registra una ejecución ya terminada (usada por jobs "always" y ticks de
 * señales que no necesitan claim por ventana).
 * @param {any} data
 * @param {object} record
 */
export function recordRun(data, record = {}) {
  const runs = runsOf(data);
  const run = {
    id: record.id || nextId('RUN', runs),
    workflowId: record.workflowId || 'system',
    workflowName: record.workflowName || record.workflowId || 'system',
    windowKey: record.windowKey ?? null,
    reason: record.reason || 'tick',
    requestId: record.requestId || null,
    status: record.status || 'ok',
    dryRun: record.dryRun === true,
    attempt: record.attempt || 1,
    maxAttempts: record.maxAttempts || 1,
    startedAt: record.startedAt || nowIso(),
    finishedAt: record.finishedAt || nowIso(),
    durationMs: record.durationMs ?? null,
    steps: Array.isArray(record.steps) ? record.steps : [],
    llm: record.llm || null,
    delivery: Array.isArray(record.delivery) ? record.delivery : [],
    tokens: record.tokens || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    error: record.error || null,
    nextAttemptAt: null,
    textPreview: record.textPreview || null,
    meta: record.meta || null
  };
  if (run.durationMs === null) {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.finishedAt);
    run.durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  }
  runs.push(run);
  pruneRuns(data);
  return run;
}

/** Última ejecución finalizada de un workflow (para "desde la última vez"). */
export function lastFinishedRun(data, workflowId, beforeIso = null) {
  const limit = beforeIso ? Date.parse(beforeIso) : Infinity;
  return [...runsOf(data)]
    .reverse()
    .find((run) => run && run.workflowId === workflowId
      && isFinalStatus(run.status)
      && (!Number.isFinite(limit) || Date.parse(run.finishedAt || run.startedAt || '') <= limit)) || null;
}

/* ------------------------------------------------------------------ */
/* Compatibilidad con notificationLog                                  */
/* ------------------------------------------------------------------ */

export function hasNotificationKey(data, key) {
  return !!(isPlainObject(data?.notificationLog) && data.notificationLog[key]);
}

/** Marca una clave histórica. Devuelve false si ya existía. */
export function claimNotificationKey(data, key, at = nowIso()) {
  if (!isPlainObject(data.notificationLog)) data.notificationLog = {};
  if (data.notificationLog[key]) return false;
  data.notificationLog[key] = at;
  return true;
}

/** Clave histórica `<job>:<YYYY-MM-DD>` de los avisos diarios. */
export function legacyDailyKey(workflow, dateKey) {
  const compat = workflow && workflow.compatKey;
  return compat ? `${compat}:${dateKey}` : null;
}

/* ------------------------------------------------------------------ */
/* Señales                                                             */
/* ------------------------------------------------------------------ */

export function signalsOf(data) {
  if (!Array.isArray(data.signals)) data.signals = [];
  return data.signals;
}

export function pruneSignals(data, limit = SIGNALS_LIMIT) {
  const signals = signalsOf(data);
  if (signals.length > limit) data.signals = signals.slice(signals.length - limit);
}

export function findSignal(data, id) {
  return signalsOf(data).find((signal) => signal && signal.id === id) || null;
}

export function signalCooldownKey(rule, dateKey) {
  return `${rule.id}:${dateKey}`;
}

export function cooldownOf(data, key) {
  if (!isPlainObject(data.signalCooldowns)) data.signalCooldowns = {};
  return data.signalCooldowns[key] || null;
}

export function setCooldown(data, key, value) {
  if (!isPlainObject(data.signalCooldowns)) data.signalCooldowns = {};
  data.signalCooldowns[key] = { ...(data.signalCooldowns[key] || {}), ...value };
}

/** Limpia cooldowns de días anteriores (retención corta). */
export function pruneCooldowns(data, todayKey) {
  if (!isPlainObject(data.signalCooldowns)) return;
  for (const key of Object.keys(data.signalCooldowns)) {
    if (!key.includes(todayKey)) {
      const value = data.signalCooldowns[key];
      const at = Date.parse(value?.at || value?.dismissedAt || '');
      if (!Number.isFinite(at) || Date.now() - at > 7 * 24 * 3600_000) delete data.signalCooldowns[key];
    }
  }
}

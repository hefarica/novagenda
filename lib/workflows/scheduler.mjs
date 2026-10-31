/**
 * Scheduler del motor de workflows (t8).
 *
 * ÚNICO dueño de los intervalos de la app (decisión B del capitán): server.mjs
 * y core.mjs ya no programan ticks. Este módulo:
 *   - arranca al importarse desde `lib/routes/workflows.mjs` (auto-descubrimiento),
 *   - respeta `WORKFLOWS_AUTOSTART=0` y `NODE_ENV=test`,
 *   - usa `setInterval(...).unref()` para no impedir el cierre del proceso,
 *   - expone `startScheduler()`/`stopScheduler()` y handlers SIGTERM/SIGINT
 *     idempotentes que SOLO limpian sus timers (el flush del store lo hace t1).
 *
 * Idempotencia:
 *   - cada ejecución se reclama en `data.workflowRuns` por (workflow, ventana),
 *   - los avisos diarios respetan las claves históricas de `notificationLog`,
 *   - un job perdido se ejecuta UNA vez al volver (catch-up), nunca en bucle.
 */
import { store, addActivity } from '../store.mjs';
import { log, logError } from '../http/logger.mjs';
import { HttpError } from '../http/errors.mjs';
import { redactString } from '../security/redact.mjs';
import { isoAtLocal, timezoneOf } from '../agenda/time.mjs';
import { executeWorkflow } from './runner.mjs';
import {
  localParts, workflowDue, workflowTimezone, effectiveEveryMin, sinceForLastRun
} from './time.mjs';
import {
  claimRun, ensureSignalState, ensureWorkflowState, finishRun, findWorkflow,
  hasNotificationKey, isWindowCompleted, lastFinishedRun, legacyDailyKey, needsSeed,
  nowIso, recordRun, workflowsOf
} from './state.mjs';
import { evaluateSignals } from '../signals/engine.mjs';

const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 5_000;
const MAX_TICK_MS = 300_000;
const BOOT_DELAY_MS = 1_500;
const SYSTEM_MATERIALIZE_ID = 'system:materialize';
const SYSTEM_SIGNALS_ID = 'system:signals';
const MATERIALIZE_AT = '00:05';
/** Timeout duro por handler externo del tick (t16 y futuros módulos). */
const HANDLER_TIMEOUT_MS = 5_000;

const state = {
  timer: null,
  bootTimer: null,
  started: false,
  startedAt: null,
  tickMs: DEFAULT_TICK_MS,
  ticks: 0,
  lastTickAt: null,
  lastTickDurationMs: null,
  lastError: null,
  running: false,
  handlersBound: false,
  lastSignalAt: 0,
  lastSignalResult: null
};

/**
 * Handlers externos que se ejecutan al final de cada `workflowTick`.
 * Permiten que módulos como los avisos inteligentes (t16) se enganchen al
 * scheduler SIN crear timers propios. Se ejecutan aislados (try/catch + timeout).
 * @type {Set<(context:{now:Date, dryRun:boolean})=>any>}
 */
const tickHandlers = new Set();

/**
 * Registra un handler de tick (idempotente para la misma función).
 * @param {(context:{now:Date, dryRun:boolean})=>any} handler
 * @returns {() => void} función para desregistrarlo
 */
export function registerTickHandler(handler) {
  if (typeof handler !== 'function') throw new TypeError('registerTickHandler requiere una función');
  tickHandlers.add(handler);
  return function unregister() {
    tickHandlers.delete(handler);
  };
}

function runWithHandlerTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`Handler de tick excedió ${ms} ms`), { code: 'TICK_HANDLER_TIMEOUT' }));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Workflows con una ejecución en curso en este proceso (anti-solape). */
const activeWorkflows = new Set();

function beginActive(workflowId) {
  if (activeWorkflows.has(workflowId)) return false;
  activeWorkflows.add(workflowId);
  return true;
}

function endActive(workflowId) {
  activeWorkflows.delete(workflowId);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveTickMs(candidate) {
  const raw = Number(candidate ?? process.env.WORKFLOWS_TICK_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TICK_MS;
  return clamp(Math.round(raw), MIN_TICK_MS, MAX_TICK_MS);
}

function signalsEveryMin() {
  const raw = Number(process.env.SIGNALS_EVERY_MIN);
  return clamp(Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 5, 1, 120);
}

function errorText(error) {
  return redactString(String(error?.message || error || 'error desconocido')).slice(0, 300);
}

/** Siembra workflows/reglas si hace falta (una sola escritura). */
export async function ensureSeededNow() {
  const data = store.get();
  if (!needsSeed(data)) return { seeded: false };
  let result = { seeded: false };
  await store.mutate((current) => {
    const workflows = ensureWorkflowState(current);
    const signals = ensureSignalState(current);
    result = { seeded: workflows.seeded || signals.seeded, workflows, signals };
  }, { label: 'workflows-seed' });
  if (result.seeded) log('info', `Workflows: semilla aplicada (${result.workflows?.created || 0} workflows, ${result.signals?.created || 0} reglas de señales).`);
  return result;
}

/* ------------------------------------------------------------------ */
/* Vencimientos                                                        */
/* ------------------------------------------------------------------ */

/** Materialización diaria de rutinas (handoff de t1): 00:05 o al arrancar. */
function systemMaterializeDue(now, data, reason = 'tick') {
  const settings = data.settings || {};
  const tz = timezoneOf(settings);
  const parts = localParts(now, tz);
  const occurrenceAt = isoAtLocal(parts.dateKey, MATERIALIZE_AT, tz);
  const occurrenceMs = Date.parse(occurrenceAt);
  if (!Number.isFinite(occurrenceMs)) return null;
  const isStartup = reason === 'startup';
  if (!isStartup && now.getTime() < occurrenceMs) return null;
  return {
    workflowId: SYSTEM_MATERIALIZE_ID,
    windowKey: `${SYSTEM_MATERIALIZE_ID}:${parts.dateKey}`,
    occurrenceAt,
    dateKey: parts.dateKey,
    reason: isStartup ? 'startup' : (now.getTime() - occurrenceMs > 90_000 ? 'catch-up' : 'schedule'),
    type: 'system'
  };
}

/**
 * Calcula los jobs que toca ejecutar ahora (sin ejecutarlos). Puro sobre `data`.
 * @param {Date} now
 * @param {any} data
 * @param {{reason?:string}} [options]
 */
export function computeDueJobs(now, data, options = {}) {
  const jobs = [];
  const reason = options.reason || 'tick';
  const settings = data.settings || {};

  const systemDue = systemMaterializeDue(now, data, reason);
  if (systemDue && !isWindowCompleted(data, SYSTEM_MATERIALIZE_ID, systemDue.windowKey)) {
    jobs.push({ type: 'system', kind: 'materialize', workflow: null, due: systemDue });
  }

  for (const workflow of workflowsOf(data)) {
    try {
      if (!workflow || typeof workflow !== 'object' || workflow.active === false) continue;
      const due = workflowDue(workflow, { now, settings, reason });
      if (!due) continue;
      if (due.windowKey && isWindowCompleted(data, workflow.id, due.windowKey)) continue;
      const compatKey = due.windowKey ? legacyDailyKey(workflow, due.dateKey) : null;
      if (compatKey && hasNotificationKey(data, compatKey)) continue;
      jobs.push({ type: 'workflow', workflow, due });
    } catch (error) {
      logError('workflows:due', error, { workflowId: workflow?.id });
    }
  }

  jobs.sort((a, b) => {
    const aSystem = a.type === 'system' ? 0 : 1;
    const bSystem = b.type === 'system' ? 0 : 1;
    if (aSystem !== bSystem) return aSystem - bSystem;
    const aAlways = a.workflow?.trigger?.type === 'always' ? 1 : 0;
    const bAlways = b.workflow?.trigger?.type === 'always' ? 1 : 0;
    if (aAlways !== bAlways) return aAlways - bAlways;
    const aTime = Date.parse(a.due?.occurrenceAt || 0);
    const bTime = Date.parse(b.due?.occurrenceAt || 0);
    return aTime - bTime;
  });
  return jobs;
}

function computeSince(data, workflow, now) {
  const last = lastFinishedRun(data, workflow.id, now.toISOString());
  const fallbackMin = effectiveEveryMin(workflow, data.settings || {}) || 60;
  return sinceForLastRun(last, now, fallbackMin);
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                           */
/* ------------------------------------------------------------------ */

function firstError(steps) {
  const failed = (steps || []).find((step) => step && step.ok === false && step.error);
  return failed ? String(failed.error).slice(0, 300) : null;
}

function pseudoMaterializeWorkflow() {
  return {
    id: SYSTEM_MATERIALIZE_ID,
    name: 'Materialización de rutinas',
    active: true,
    trigger: { type: 'daily', at: MATERIALIZE_AT },
    conditions: {},
    actions: [{ type: 'materialize_routines' }],
    llm: { enabled: false },
    channels: []
  };
}

async function runSystemMaterialize(job, now) {
  const workflow = pseudoMaterializeWorkflow();
  const claim = await store.mutate((current) => claimRun(current, {
    workflowId: SYSTEM_MATERIALIZE_ID,
    workflowName: workflow.name,
    windowKey: job.due.windowKey,
    reason: job.due.reason,
    scheduledFor: job.due.occurrenceAt,
    maxAttempts: 3
  }), { label: 'workflow-claim' });
  if (!claim.claimed) return { workflowId: SYSTEM_MATERIALIZE_ID, skipped: true, reason: claim.reason };

  let outcome;
  try {
    outcome = await executeWorkflow(workflow, {
      now,
      reason: job.due.reason,
      windowKey: job.due.windowKey,
      dateKey: job.due.dateKey
    });
  } catch (error) {
    outcome = {
      status: 'error',
      steps: [{ name: 'materialize_routines', ok: false, error: errorText(error), fatal: true }],
      llm: null,
      delivery: [],
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      text: null
    };
  }

  let finished = null;
  await store.mutate((current) => {
    finished = finishRun(current, claim.run.id, {
      status: outcome.status,
      steps: outcome.steps,
      llm: outcome.llm,
      delivery: outcome.delivery,
      tokens: outcome.tokens,
      error: outcome.status === 'error' ? firstError(outcome.steps) || 'Fallo de materialización' : null,
      finishedAt: nowIso()
    });
    if (outcome.status === 'error') {
      addActivity('automation', `Materialización de rutinas falló: ${firstError(outcome.steps) || 'error'}`, { workflowId: SYSTEM_MATERIALIZE_ID });
    }
  }, { label: 'workflow-finish' });

  log('debug', `Workflows: materialización ${outcome.status} (${claim.run.id})`);
  return { workflowId: SYSTEM_MATERIALIZE_ID, runId: claim.run.id, status: outcome.status, steps: outcome.steps.length, run: finished };
}

async function runScheduledWorkflow(job, now) {
  const workflow = job.workflow;
  const due = job.due;
  const claim = await store.mutate((current) => claimRun(current, {
    workflowId: workflow.id,
    workflowName: workflow.name,
    windowKey: due.windowKey,
    reason: due.reason,
    scheduledFor: due.occurrenceAt,
    maxAttempts: 3
  }), { label: 'workflow-claim' });
  if (!claim.claimed) {
    return { workflowId: workflow.id, skipped: true, reason: claim.reason, retryAt: claim.retryAt || null };
  }

  const sinceIso = computeSince(store.get(), workflow, now);
  let outcome;
  try {
    outcome = await executeWorkflow(workflow, {
      now,
      reason: due.reason,
      windowKey: due.windowKey,
      dateKey: due.dateKey,
      sinceIso
    });
  } catch (error) {
    outcome = {
      status: 'error',
      steps: [{ name: 'execute', ok: false, error: errorText(error), fatal: true }],
      llm: null,
      delivery: [],
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      text: null
    };
  }

  const error = outcome.status === 'error' ? (firstError(outcome.steps) || 'Error de ejecución') : null;
  let finished = null;
  await store.mutate((current) => {
    finished = finishRun(current, claim.run.id, {
      status: outcome.status,
      steps: outcome.steps,
      llm: outcome.llm,
      delivery: outcome.delivery,
      tokens: outcome.tokens,
      error,
      finishedAt: nowIso(),
      textPreview: outcome.text ? String(outcome.text).slice(0, 220) : null
    });
    if (error) {
      addActivity('automation', `Workflow ${workflow.name || workflow.id} falló: ${error}`, { workflowId: workflow.id });
    }
  }, { label: 'workflow-finish' });

  return {
    workflowId: workflow.id,
    runId: claim.run.id,
    status: outcome.status,
    reason: due.reason,
    windowKey: due.windowKey,
    steps: outcome.steps.length,
    error,
    run: finished
  };
}

async function runAlwaysWorkflow(job, now) {
  const workflow = job.workflow;
  const startedAt = nowIso();
  const tz = workflowTimezone(workflow, store.get().settings || {});
  const dateKey = localParts(now, tz).dateKey;
  let outcome;
  try {
    outcome = await executeWorkflow(workflow, {
      now,
      reason: 'tick',
      dateKey,
      sinceIso: computeSince(store.get(), workflow, now)
    });
  } catch (error) {
    outcome = {
      status: 'error',
      steps: [{ name: 'execute', ok: false, error: errorText(error), fatal: true }],
      llm: null,
      delivery: [],
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      text: null,
      meta: null
    };
  }

  const reminders = outcome.meta?.reminders || null;
  const acted = (reminders && (reminders.sent > 0 || reminders.planned > 0))
    || outcome.status === 'error'
    || (outcome.delivery || []).length > 0;
  if (!acted) {
    return { workflowId: workflow.id, skipped: true, reason: 'nothing-due' };
  }

  let recorded = null;
  await store.mutate((current) => {
    recorded = recordRun(current, {
      workflowId: workflow.id,
      workflowName: workflow.name,
      windowKey: `${workflow.id}:tick:${now.toISOString()}`,
      reason: 'tick',
      status: outcome.status,
      steps: outcome.steps,
      llm: outcome.llm,
      delivery: outcome.delivery,
      tokens: outcome.tokens,
      error: outcome.status === 'error' ? firstError(outcome.steps) : null,
      startedAt,
      finishedAt: nowIso(),
      textPreview: outcome.text ? String(outcome.text).slice(0, 220) : null,
      meta: outcome.meta || null
    });
    if (outcome.status === 'error') {
      addActivity('automation', `Workflow ${workflow.name || workflow.id} falló: ${firstError(outcome.steps) || 'error'}`, { workflowId: workflow.id });
    }
  }, { label: 'workflow-always' });

  return {
    workflowId: workflow.id,
    runId: recorded?.id || null,
    status: outcome.status,
    reason: 'tick',
    sent: reminders?.sent || 0,
    planned: reminders?.planned || 0
  };
}

async function runDryJob(job, now) {
  const workflow = job.type === 'system' ? pseudoMaterializeWorkflow() : job.workflow;
  const outcome = await executeWorkflow(workflow, {
    now,
    reason: job.due?.reason || 'tick',
    windowKey: job.due?.windowKey || null,
    dateKey: job.due?.dateKey || null,
    sinceIso: job.type === 'system' ? null : computeSince(store.get(), workflow, now),
    dryRun: true
  });
  return {
    workflowId: workflow.id,
    dryRun: true,
    status: outcome.status,
    reason: job.due?.reason || 'tick',
    steps: outcome.steps
  };
}

/* ------------------------------------------------------------------ */
/* Tick                                                               */
/* ------------------------------------------------------------------ */

/**
 * Una pasada del scheduler. Es idempotente y no solapa consigo misma.
 * @param {{now?:Date, dryRun?:boolean, reason?:string, includeSignals?:boolean}} [options]
 */
export async function workflowTick(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dryRun = options.dryRun === true;
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'Fecha de tick inválida.' };
  if (state.running) return { ok: true, skipped: true, reason: 'already-running' };
  state.running = true;
  const startedMs = Date.now();

  try {
    if (store.isReadOnly()) return { ok: false, skipped: true, reason: 'store-read-only' };
    if (!dryRun) await ensureSeededNow();

    const data = store.get();
    const jobs = computeDueJobs(now, data, { reason: options.reason || 'tick' });
    const results = [];
    for (const job of jobs) {
      if (dryRun) {
        try {
          results.push(await runDryJob(job, now));
        } catch (error) {
          results.push({ workflowId: job.workflow?.id || job.kind, dryRun: true, status: 'error', error: errorText(error) });
        }
        continue;
      }
      const activeKey = job.type === 'system' ? SYSTEM_MATERIALIZE_ID : (job.workflow?.id || job.kind || 'system');
      if (!beginActive(activeKey)) {
        results.push({ workflowId: activeKey, skipped: true, reason: 'overlap' });
        continue;
      }
      try {
        if (job.type === 'system') results.push(await runSystemMaterialize(job, now));
        else if (job.workflow?.trigger?.type === 'always') results.push(await runAlwaysWorkflow(job, now));
        else results.push(await runScheduledWorkflow(job, now));
      } catch (error) {
        logError('workflows:run', error, { workflowId: job.workflow?.id || job.kind });
        results.push({ workflowId: job.workflow?.id || job.kind, status: 'error', error: errorText(error) });
      } finally {
        endActive(activeKey);
      }
    }

    let signals = null;
    if (!dryRun && options.includeSignals !== false) {
      const nowMs = now.getTime();
      const intervalMs = signalsEveryMin() * 60_000;
      if (state.lastSignalAt === 0 || nowMs - state.lastSignalAt >= intervalMs) {
        const signalStartedAt = nowIso();
        try {
          const result = await evaluateSignals({ now, dryRun: false, source: 'scheduler', notify: true });
          state.lastSignalAt = nowMs;
          state.lastSignalResult = { at: nowIso(), emitted: result.emitted, candidates: result.candidates.length, errors: result.errors.length };
          if (result.emitted > 0 || result.errors.length > 0) {
            await store.mutate((current) => {
              recordRun(current, {
                workflowId: SYSTEM_SIGNALS_ID,
                workflowName: 'Motor de señales',
                windowKey: `${SYSTEM_SIGNALS_ID}:${now.toISOString()}`,
                reason: 'tick',
                status: result.errors.length ? 'error' : 'ok',
                steps: [{
                  name: 'evaluate_signals',
                  ok: result.errors.length === 0,
                  emitted: result.emitted,
                  candidates: result.candidates.length,
                  errors: result.errors.slice(0, 5)
                }],
                error: result.errors.length ? String(result.errors[0].error || 'error') : null,
                startedAt: signalStartedAt,
                finishedAt: nowIso()
              });
            }, { label: 'signals-run' }).catch(() => {});
          }
          signals = state.lastSignalResult;
        } catch (error) {
          logError('workflows:signals', error);
          state.lastSignalAt = nowMs;
          signals = { at: nowIso(), error: errorText(error) };
        }
      }
    }

    state.ticks += 1;
    state.lastTickAt = nowIso();
    if (results.some((item) => !item.skipped)) {
      log('debug', `Workflows tick: ${results.filter((item) => !item.skipped).length} ejecuciones.`);
    }

    // Handlers externos (t16+): aislados y con timeout; con cero handlers el
    // resultado del tick es EXACTAMENTE el mismo que antes de existir el hook.
    let handlers = null;
    if (tickHandlers.size > 0) {
      handlers = [];
      for (const handler of [...tickHandlers]) {
        const handlerStarted = Date.now();
        try {
          const value = await runWithHandlerTimeout(
            Promise.resolve().then(() => handler({ now, dryRun })),
            HANDLER_TIMEOUT_MS
          );
          handlers.push({
            ok: true,
            durationMs: Date.now() - handlerStarted,
            result: value === undefined ? null : value
          });
        } catch (error) {
          logError('workflows:tick-handler', error);
          handlers.push({
            ok: false,
            durationMs: Date.now() - handlerStarted,
            error: errorText(error),
            code: error?.code || null
          });
        }
      }
    }

    return { ok: true, at: state.lastTickAt, jobs: results, signals, dryRun, ...(handlers ? { handlers } : {}) };
  } catch (error) {
    state.lastError = errorText(error);
    logError('workflows:tick', error);
    return { ok: false, error: state.lastError };
  } finally {
    state.running = false;
    state.lastTickDurationMs = Date.now() - startedMs;
  }
}

/* ------------------------------------------------------------------ */
/* Ejecución manual                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ejecuta un workflow concreto ahora (endpoint `POST /api/workflows/:id/run`).
 * @param {string} id
 * @param {{dryRun?:boolean, now?:Date, reason?:string}} [options]
 */
export async function runWorkflowNow(id, options = {}) {
  await ensureSeededNow();
  const data = store.get();
  const workflow = findWorkflow(data, id);
  if (!workflow) throw new HttpError(404, 'NOT_FOUND', `Workflow ${id} no encontrado.`);
  if (workflow.active === false) throw new HttpError(409, 'WORKFLOW_DISABLED', `El workflow ${id} está desactivado.`);

  const now = options.now instanceof Date ? options.now : new Date();
  const tz = workflowTimezone(workflow, data.settings || {});
  const dateKey = localParts(now, tz).dateKey;
  const sinceIso = computeSince(data, workflow, now);

  if (options.dryRun === true) {
    const startedAt = nowIso();
    const outcome = await executeWorkflow(workflow, { now, reason: 'manual', dryRun: true, windowKey: null, dateKey, sinceIso });
    const finishedAt = nowIso();
    return {
      ok: true,
      run: {
        id: `RUN-DRY-${Date.now()}`,
        workflowId: workflow.id,
        workflowName: workflow.name,
        windowKey: null,
        reason: 'manual',
        status: outcome.status,
        dryRun: true,
        attempt: 1,
        maxAttempts: 1,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        steps: outcome.steps,
        llm: outcome.llm,
        delivery: [],
        tokens: outcome.tokens,
        error: outcome.status === 'error' ? firstError(outcome.steps) : null
      }
    };
  }

  if (!beginActive(workflow.id)) {
    throw new HttpError(409, 'WORKFLOW_RUNNING', `El workflow ${id} ya se está ejecutando.`);
  }
  try {
    const windowKey = `${workflow.id}:manual:${now.toISOString()}`;
    const claim = await store.mutate((current) => claimRun(current, {
      workflowId: workflow.id,
      workflowName: workflow.name,
      windowKey,
      reason: options.reason || 'manual',
      scheduledFor: now.toISOString(),
      maxAttempts: 1
    }), { label: 'workflow-claim-manual' });
    if (!claim.claimed) {
      throw new HttpError(409, 'WORKFLOW_RUNNING', `El workflow ${id} ya se está ejecutando.`);
    }

    let outcome;
    try {
      outcome = await executeWorkflow(workflow, {
        now,
        reason: 'manual',
        windowKey,
        dateKey,
        sinceIso
      });
    } catch (error) {
      outcome = {
        status: 'error',
        steps: [{ name: 'execute', ok: false, error: errorText(error), fatal: true }],
        llm: null,
        delivery: [],
        tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        text: null
      };
    }

    let finished = null;
    await store.mutate((current) => {
      finished = finishRun(current, claim.run.id, {
        status: outcome.status,
        steps: outcome.steps,
        llm: outcome.llm,
        delivery: outcome.delivery,
        tokens: outcome.tokens,
        error: outcome.status === 'error' ? firstError(outcome.steps) : null,
        finishedAt: nowIso(),
        textPreview: outcome.text ? String(outcome.text).slice(0, 220) : null
      });
    }, { label: 'workflow-finish-manual' });

    return { ok: true, run: finished };
  } finally {
    endActive(workflow.id);
  }
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

function processSignal() {
  stopScheduler();
}

function bindProcessHandlers() {
  if (state.handlersBound) return;
  state.handlersBound = true;
  process.once('SIGINT', processSignal);
  process.once('SIGTERM', processSignal);
}

/**
 * Arranca el scheduler (idempotente).
 * @param {{tickMs?:number, force?:boolean, immediate?:boolean}} [options]
 */
export function startScheduler(options = {}) {
  const autostart = String(process.env.WORKFLOWS_AUTOSTART || '').trim();
  const disabled = !options.force && (autostart === '0' || process.env.NODE_ENV === 'test');
  if (disabled) {
    return {
      started: false,
      reason: autostart === '0' ? 'WORKFLOWS_AUTOSTART=0' : 'NODE_ENV=test',
      ...schedulerStatus()
    };
  }
  if (state.timer) return { started: true, already: true, ...schedulerStatus() };

  state.tickMs = resolveTickMs(options.tickMs);
  bindProcessHandlers();
  state.timer = setInterval(() => {
    workflowTick({ reason: 'tick' }).catch((error) => logError('workflows:tick', error));
  }, state.tickMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();

  if (options.immediate !== false) {
    state.bootTimer = setTimeout(() => {
      workflowTick({ reason: 'startup' }).catch((error) => logError('workflows:startup', error));
    }, BOOT_DELAY_MS);
    if (typeof state.bootTimer.unref === 'function') state.bootTimer.unref();
  }

  state.started = true;
  state.startedAt = nowIso();
  log('info', `Workflows: scheduler activo (tick ${state.tickMs} ms, señales cada ${signalsEveryMin()} min).`);
  return { started: true, ...schedulerStatus() };
}

/** Detiene los timers (idempotente; NO cierra el servidor ni el store). */
export function stopScheduler() {
  if (state.timer) clearInterval(state.timer);
  if (state.bootTimer) clearTimeout(state.bootTimer);
  state.timer = null;
  state.bootTimer = null;
  const wasStarted = state.started;
  state.started = false;
  if (wasStarted) log('info', 'Workflows: scheduler detenido.');
  return schedulerStatus();
}

/** Estado observable del scheduler (para `/api/workflows/status` y tests). */
export function schedulerStatus() {
  const data = store.get();
  const workflows = workflowsOf(data);
  return {
    started: state.started,
    startedAt: state.startedAt,
    tickMs: state.tickMs,
    ticks: state.ticks,
    running: state.running,
    lastTickAt: state.lastTickAt,
    lastTickDurationMs: state.lastTickDurationMs,
    lastError: state.lastError,
    signalsEveryMin: signalsEveryMin(),
    lastSignalAt: state.lastSignalAt ? new Date(state.lastSignalAt).toISOString() : null,
    lastSignalResult: state.lastSignalResult,
    autostart: String(process.env.WORKFLOWS_AUTOSTART || '') !== '0' && process.env.NODE_ENV !== 'test',
    workflows: workflows.length,
    activeWorkflows: workflows.filter((workflow) => workflow && workflow.active !== false).length
  };
}

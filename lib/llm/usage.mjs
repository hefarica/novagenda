/**
 * Control de costo, abuso y observabilidad del LLM.
 *
 *   - Contadores diarios persistidos en `store.llm.usage` (llamadas, tokens,
 *     errores, cacheadas), por workflow y por proveedor.
 *   - Topes: globales (`limits.dailyCalls`, `limits.dailyTokens`) y por
 *     workflow (`limits.perWorkflow.<perfil>`).
 *   - Kill-switch global (`store.llm.killSwitch`) y apagado general
 *     (`store.llm.enabled`); viven en `config.mjs`, aquí solo se consultan.
 *   - Caché de respuestas idempotentes con TTL (en memoria).
 *   - Rate limit por usuario/canal (ventana de 60 s).
 *   - Registro de acciones del agente (`store.llm.actions`, máx. 200).
 *
 * Todas las escrituras son best-effort: si el store está en solo lectura, el
 * subsistema sigue funcionando con contadores en memoria y lo reporta.
 */
import crypto from 'node:crypto';
import { store, localDateKey } from '../store.mjs';
import { isPlainObject } from '../validate.mjs';
import { redactString } from '../security/redact.mjs';

const MAX_DAYS = 30;
const MAX_ACTIONS = 200;
const CACHE_MAX_ENTRIES = 120;
const RATE_WINDOW_MS = 60_000;

/** @type {Map<string, {at:number, payload:any}>} */
const cache = new Map();
/** @type {Map<string, {windowStart:number, count:number, blockedUntil:number}>} */
const rateWindows = new Map();

let persistTimer = null;

/* ------------------------------------------------------------------ */
/* Estructura y persistencia diferida                                  */
/* ------------------------------------------------------------------ */

function emptyDay() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, tokens: 0, errors: 0, cached: 0, byWorkflow: {}, byProvider: {} };
}

function ensureStoreShape(data) {
  if (!isPlainObject(data.llm)) data.llm = {};
  if (!isPlainObject(data.llm.usage)) data.llm.usage = { updatedAt: null, days: {} };
  if (!isPlainObject(data.llm.usage.days)) data.llm.usage.days = {};
  return data.llm.usage;
}

function dayOf(usage, date = localDateKey()) {
  if (!isPlainObject(usage.days[date])) usage.days[date] = emptyDay();
  const day = usage.days[date];
  if (!isPlainObject(day.byWorkflow)) day.byWorkflow = {};
  if (!isPlainObject(day.byProvider)) day.byProvider = {};
  return day;
}

function bucketOf(map, key) {
  if (!isPlainObject(map[key])) map[key] = { calls: 0, promptTokens: 0, completionTokens: 0, tokens: 0, errors: 0, cached: 0 };
  return map[key];
}

function pruneDays(usage) {
  const keys = Object.keys(usage.days).sort();
  while (keys.length > MAX_DAYS) {
    const oldest = keys.shift();
    if (oldest) delete usage.days[oldest];
  }
}

/** Persiste con debounce (1,2 s) sin bloquear la respuesta del LLM. */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      void Promise.resolve(store.mutate(() => {}, { label: 'llm-usage' })).catch(() => {});
    } catch {
      /* store en solo lectura */
    }
  }, 1_200);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

/** Fuerza el guardado inmediato (pruebas/cierre). */
export async function flushUsage() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    await store.mutate(() => {}, { label: 'llm-usage-flush' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: redactString(error?.message || String(error)) };
  }
}

/* ------------------------------------------------------------------ */
/* Lectura                                                             */
/* ------------------------------------------------------------------ */

/**
 * Resumen de uso del día + histórico corto.
 * @param {{days?:number, limits?:object}} [options]
 */
export function usageSnapshot({ days = 7, limits = null } = {}) {
  const data = store.get();
  const raw = isPlainObject(data.llm?.usage) ? data.llm.usage : { days: {} };
  const today = localDateKey();
  const todayDay = isPlainObject(raw.days?.[today]) ? raw.days[today] : emptyDay();
  const keys = Object.keys(raw.days || {}).sort().slice(-Math.max(1, Math.min(MAX_DAYS, days)));
  const history = keys.map((date) => {
    const day = raw.days[date] || emptyDay();
    return { date, calls: day.calls || 0, tokens: day.tokens || 0, errors: day.errors || 0, cached: day.cached || 0 };
  });
  const totals = history.reduce((acc, row) => ({
    calls: acc.calls + row.calls,
    tokens: acc.tokens + row.tokens,
    errors: acc.errors + row.errors,
    cached: acc.cached + row.cached
  }), { calls: 0, tokens: 0, errors: 0, cached: 0 });
  const byWorkflow = {};
  for (const key of keys) {
    const day = raw.days[key] || {};
    for (const [workflow, bucket] of Object.entries(day.byWorkflow || {})) {
      if (!byWorkflow[workflow]) byWorkflow[workflow] = { calls: 0, tokens: 0, errors: 0, cached: 0 };
      byWorkflow[workflow].calls += bucket.calls || 0;
      byWorkflow[workflow].tokens += bucket.tokens || 0;
      byWorkflow[workflow].errors += bucket.errors || 0;
      byWorkflow[workflow].cached += bucket.cached || 0;
    }
  }
  const byProvider = {};
  for (const key of keys) {
    const day = raw.days[key] || {};
    for (const [provider, bucket] of Object.entries(day.byProvider || {})) {
      if (!byProvider[provider]) byProvider[provider] = { calls: 0, tokens: 0 };
      byProvider[provider].calls += bucket.calls || 0;
      byProvider[provider].tokens += bucket.tokens || 0;
    }
  }
  const limitsOut = limits
    ? {
        dailyCalls: limits.dailyCalls ?? null,
        dailyTokens: limits.dailyTokens ?? null,
        ratePerMin: limits.ratePerMin ?? null,
        perWorkflow: limits.perWorkflow || {}
      }
    : null;
  return {
    date: today,
    today: {
      calls: todayDay.calls || 0,
      promptTokens: todayDay.promptTokens || 0,
      completionTokens: todayDay.completionTokens || 0,
      tokens: todayDay.tokens || 0,
      errors: todayDay.errors || 0,
      cached: todayDay.cached || 0,
      byWorkflow: todayDay.byWorkflow || {},
      byProvider: todayDay.byProvider || {}
    },
    totals,
    byWorkflow,
    byProvider,
    history,
    days: history,
    limits: limitsOut,
    remaining: limitsOut ? {
      calls: limitsOut.dailyCalls === null ? null : Math.max(0, limitsOut.dailyCalls - (todayDay.calls || 0)),
      tokens: limitsOut.dailyTokens === null ? null : Math.max(0, limitsOut.dailyTokens - (todayDay.tokens || 0))
    } : null,
    updatedAt: raw.updatedAt || null,
    storage: store.isReadOnly() ? 'read-only' : 'ok'
  };
}

/**
 * Evalúa si un workflow puede llamar al proveedor.
 * @param {string} workflow
 * @param {{dailyCalls:number, dailyTokens:number, perWorkflow?:object}} limits
 * @returns {{allowed:boolean, code:string|null, reason:string|null, used:{calls:number,tokens:number}, caps:{calls:number,tokens:number}}}
 */
export function evaluateBudget(workflow, limits) {
  const data = store.get();
  const today = localDateKey();
  const day = isPlainObject(data.llm?.usage?.days?.[today]) ? data.llm.usage.days[today] : emptyDay();
  const usedCalls = day.calls || 0;
  const usedTokens = day.tokens || 0;
  const perWorkflow = isPlainObject(limits?.perWorkflow) ? limits.perWorkflow[workflow] : null;
  const capCalls = Math.min(
    Number.isFinite(limits?.dailyCalls) ? limits.dailyCalls : Infinity,
    Number.isFinite(perWorkflow?.calls) ? perWorkflow.calls : Infinity
  );
  const capTokens = Math.min(
    Number.isFinite(limits?.dailyTokens) ? limits.dailyTokens : Infinity,
    Number.isFinite(perWorkflow?.tokens) ? perWorkflow.tokens : Infinity
  );
  const workflowUsed = day.byWorkflow?.[workflow] || { calls: 0, tokens: 0 };
  const callsForCap = Number.isFinite(perWorkflow?.calls) ? workflowUsed.calls || 0 : usedCalls;
  const tokensForCap = Number.isFinite(perWorkflow?.tokens) ? workflowUsed.tokens || 0 : usedTokens;
  if (Number.isFinite(capCalls) && callsForCap >= capCalls) {
    return {
      allowed: false,
      code: 'LLM_BUDGET_CALLS',
      reason: Number.isFinite(perWorkflow?.calls)
        ? `El workflow "${workflow}" alcanzó su tope diario de llamadas (${capCalls}).`
        : `Se alcanzó el tope diario de llamadas LLM (${capCalls}).`,
      used: { calls: usedCalls, tokens: usedTokens },
      caps: { calls: capCalls, tokens: capTokens }
    };
  }
  if (Number.isFinite(capTokens) && tokensForCap >= capTokens) {
    return {
      allowed: false,
      code: 'LLM_BUDGET_TOKENS',
      reason: `Se alcanzó el tope de tokens LLM (${capTokens}).`,
      used: { calls: usedCalls, tokens: usedTokens },
      caps: { calls: capCalls, tokens: capTokens }
    };
  }
  return { allowed: true, code: null, reason: null, used: { calls: usedCalls, tokens: usedTokens }, caps: { calls: capCalls, tokens: capTokens } };
}

/**
 * Registra una llamada (o un acierto de caché) en los contadores.
 * @param {{workflow:string, provider?:string|null, usage?:{promptTokens:number,completionTokens:number,totalTokens:number}, cached?:boolean, error?:string|null, calls?:number}} entry
 */
export function recordUsage({ workflow = 'chat', provider = null, usage = null, cached = false, error = null, calls = 1 } = {}) {
  try {
    const data = store.get();
    const usageStore = ensureStoreShape(data);
    const day = dayOf(usageStore);
    const promptTokens = Math.max(0, Math.round(Number(usage?.promptTokens) || 0));
    const completionTokens = Math.max(0, Math.round(Number(usage?.completionTokens) || 0));
    const tokens = Math.max(0, Math.round(Number(usage?.totalTokens) || promptTokens + completionTokens));
    const callCount = Math.max(0, Math.round(Number(calls) || 0));
    day.calls += callCount;
    day.promptTokens += promptTokens;
    day.completionTokens += completionTokens;
    day.tokens += tokens;
    if (error) day.errors += 1;
    if (cached) day.cached += 1;
    const wf = bucketOf(day.byWorkflow, workflow || 'chat');
    wf.calls += callCount;
    wf.promptTokens += promptTokens;
    wf.completionTokens += completionTokens;
    wf.tokens += tokens;
    if (error) wf.errors += 1;
    if (cached) wf.cached += 1;
    if (provider) {
      const pv = bucketOf(day.byProvider, provider);
      pv.calls += callCount;
      pv.promptTokens += promptTokens;
      pv.completionTokens += completionTokens;
      pv.tokens += tokens;
      if (error) pv.errors += 1;
      if (cached) pv.cached += 1;
    }
    usageStore.updatedAt = new Date().toISOString();
    pruneDays(usageStore);
    schedulePersist();
  } catch {
    /* El control de costo nunca debe romper una respuesta. */
  }
  return usageSnapshot({ days: 1 });
}

/** Reset de contadores (mantenimiento/pruebas). */
export async function resetUsage() {
  try {
    await store.mutate((data) => {
      if (isPlainObject(data.llm)) data.llm.usage = { updatedAt: new Date().toISOString(), days: {} };
    }, { label: 'llm-usage-reset' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: redactString(error?.message || String(error)) };
  }
}

/* ------------------------------------------------------------------ */
/* Caché de respuestas idempotentes                                    */
/* ------------------------------------------------------------------ */

export function cacheKey(parts) {
  const stable = JSON.stringify(parts ?? null);
  return crypto.createHash('sha256').update(stable).digest('hex');
}

/**
 * @param {string} key
 * @param {number} ttlSec
 * @returns {object|null}
 */
export function cacheGet(key, ttlSec) {
  if (!(ttlSec > 0)) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlSec * 1000) {
    cache.delete(key);
    return null;
  }
  // Reinserta para LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit.payload;
}

/** @param {string} key @param {object} payload */
export function cacheSet(key, payload) {
  cache.set(key, { at: Date.now(), payload });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cacheClear() {
  cache.clear();
  return { ok: true, size: 0 };
}

export function cacheSize() {
  return cache.size;
}

/* ------------------------------------------------------------------ */
/* Rate limit por usuario/canal                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {string} scope identificador estable (`web:owner`, `telegram:123`…)
 * @param {number} limit llamadas por minuto
 */
export function checkRateLimit(scope, limit) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : 30;
  const key = String(scope || 'anon');
  const now = Date.now();
  const entry = rateWindows.get(key) || { windowStart: now, count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000), remaining: 0, limit: max };
  }
  if (now - entry.windowStart >= RATE_WINDOW_MS) {
    entry.windowStart = now;
    entry.count = 0;
  }
  entry.count += 1;
  if (entry.count > max) {
    entry.blockedUntil = entry.windowStart + RATE_WINDOW_MS;
    rateWindows.set(key, entry);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)), remaining: 0, limit: max };
  }
  rateWindows.set(key, entry);
  // Limpieza acotada de ventanas viejas.
  if (rateWindows.size > 500) {
    for (const [scopeKey, value] of rateWindows) {
      if (now - value.windowStart > RATE_WINDOW_MS * 5) rateWindows.delete(scopeKey);
    }
  }
  return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, max - entry.count), limit: max };
}

export function resetRateLimits() {
  rateWindows.clear();
}

/* ------------------------------------------------------------------ */
/* Registro de acciones                                                */
/* ------------------------------------------------------------------ */

/**
 * Registra una acción del agente (auditoría visible en la UI).
 * @param {{type:string, status?:string, agendaId?:string|null, detail?:string, channel?:string, user?:string, dryRun?:boolean, source?:string, intent?:string|null}} entry
 */
export function recordAction(entry = {}) {
  const at = new Date().toISOString();
  const record = {
    id: `LA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at,
    type: String(entry.type || 'accion').slice(0, 40),
    status: String(entry.status || 'ok').slice(0, 20),
    agendaId: entry.agendaId || null,
    detail: redactString(String(entry.detail || '')).slice(0, 300),
    channel: entry.channel ? String(entry.channel).slice(0, 40) : null,
    user: entry.user ? String(entry.user).slice(0, 80) : null,
    dryRun: entry.dryRun === true,
    source: entry.source === 'llm' ? 'llm' : 'deterministic',
    intent: entry.intent || null
  };
  try {
    const data = store.get();
    if (!isPlainObject(data.llm)) data.llm = {};
    if (!Array.isArray(data.llm.actions)) data.llm.actions = [];
    data.llm.actions.unshift(record);
    data.llm.actions = data.llm.actions.slice(0, MAX_ACTIONS);
    schedulePersist();
  } catch {
    /* best-effort */
  }
  return record;
}

/** @param {number} limit */
export function listActions(limit = 50) {
  const max = Math.max(1, Math.min(MAX_ACTIONS, Math.round(Number(limit) || 50)));
  const rows = Array.isArray(store.get().llm?.actions) ? store.get().llm.actions : [];
  return rows.slice(0, max);
}

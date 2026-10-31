/**
 * Cliente LLM: perfiles, cadena de proveedores, fallback determinista,
 * presupuestos, caché, rate limit y estado.
 *
 * Cascada obligatoria (degradación garantizada):
 *   1. API principal (OpenAI-compatible o adaptador específico).
 *   2. Ollama local, solo si está habilitado y configurado.
 *   3. Respuesta determinista que aporta el llamador (nunca se inventa texto).
 *
 * Si no hay proveedor, si el kill-switch está activo, si se agotó el
 * presupuesto o si el perfil está apagado, `llmComplete` devuelve
 * `fallback:true` con el texto determinista y el motivo en `errorCode`.
 * La app funciona igual sin LLM.
 */
import { store } from '../store.mjs';
import { dateKeyOfIso, timezoneOf, formatTime } from '../agenda/time.mjs';
import { redactString } from '../security/redact.mjs';
import { log } from '../http/logger.mjs';
import { HttpError } from '../http/errors.mjs';
import {
  resolveLlmConfig, buildProviderChain, resolvedProfiles, publicConfig
} from './config.mjs';
import { resolveProfile } from './profiles.mjs';
import {
  callProvider, checkProviderHealth, listProviderModels, LlmProviderError, publicBaseUrl
} from './providers.mjs';
import {
  evaluateBudget, recordUsage, cacheGet, cacheSet, cacheKey, cacheSize, checkRateLimit, usageSnapshot
} from './usage.mjs';

export const HEALTH_TTL_MS = 30_000;
const MAX_MESSAGES = 24;
const MAX_CONTENT = 8_000;
const DEFAULT_OPERATION_BUDGET_MS = 25_000;

/** @type {Map<string, {at:number, result:object}>} */
const healthCache = new Map();
let lastTest = null;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/* ------------------------------------------------------------------ */
/* Utilidades de mensajes / JSON                                       */
/* ------------------------------------------------------------------ */

/**
 * Sanea un mensaje: quita caracteres de control, recorta longitud y redacta
 * cualquier secreto registrado (evita enviar una clave pegada por error).
 * @param {string} value
 * @param {number} [max]
 */
export function sanitizeText(value, max = MAX_CONTENT) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return redactString(raw.replace(CONTROL_RE, '')).slice(0, max);
}

/**
 * Envuelve texto del usuario como DATO delimitado (anti prompt-injection).
 * El system prompt indica al modelo que ignore instrucciones dentro del bloque.
 * @param {string} value
 * @param {number} [max]
 */
export function wrapUserData(value, max = 4_000) {
  const clean = sanitizeText(value, max).replace(/<\/?usuario>/gi, '');
  return `<usuario>\n${clean}\n</usuario>`;
}

/**
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Array<{role:'system'|'user'|'assistant', content:string}>}
 */
export function sanitizeMessages(messages) {
  const rows = Array.isArray(messages) ? messages.slice(0, MAX_MESSAGES) : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.content !== 'string') continue;
    const role = row.role === 'system' || row.role === 'assistant' ? row.role : 'user';
    const content = sanitizeText(row.content, role === 'system' ? MAX_CONTENT : 4_000);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * Extrae el primer objeto/array JSON válido de una respuesta (tolera markdown,
 * texto antes/después y bloques ```json).
 * @param {string} text
 * @returns {any|null}
 */
export function extractJson(text) {
  if (text === null || text === undefined) return null;
  let raw = String(text).trim();
  if (!raw) return null;
  raw = raw.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const direct = tryParse(raw);
  if (direct !== undefined) return direct;
  // Escanea el primer objeto/array balanceado respetando cadenas.
  for (let start = 0; start < raw.length; start += 1) {
    const char = raw[start];
    if (char !== '{' && char !== '[') continue;
    const end = findBalancedEnd(raw, start);
    if (end < 0) continue;
    const parsed = tryParse(raw.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function tryParse(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function findBalancedEnd(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char === '}' || char === ']') {
      const open = stack.pop();
      if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Salud                                                               */
/* ------------------------------------------------------------------ */

function healthKey(providerConfig) {
  return `${providerConfig.provider}|${providerConfig.baseUrl}|${providerConfig.model}|${providerConfig.apiKey ? 'key' : 'nokey'}`;
}

async function healthOf(providerConfig, { force = false, timeoutMs = 6_000 } = {}) {
  const key = healthKey(providerConfig);
  const hit = healthCache.get(key);
  if (!force && hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.result;
  const result = await checkProviderHealth(providerConfig, { timeoutMs });
  healthCache.set(key, { at: Date.now(), result });
  return result;
}

export function invalidateHealthCache() {
  healthCache.clear();
}

/** Estado del subsistema LLM (contrato: GET /api/llm/status). */
export async function llmStatus({ probe = false, timeoutMs = 3_000 } = {}) {
  const config = resolveLlmConfig();
  const chain = buildProviderChain(config);
  const chainStatus = [];
  for (const providerConfig of chain) {
    const health = await healthOf(providerConfig, { force: probe, timeoutMs });
    chainStatus.push({
      provider: health.provider,
      model: health.model || providerConfig.model,
      configured: true,
      reachable: health.ok === true,
      available: health.ok === true && config.enabled && !config.killSwitch,
      latencyMs: health.latencyMs ?? null,
      error: health.ok ? null : health.error || null,
      errorCode: health.ok ? null : health.code || null,
      via: health.via || null,
      checkedAt: health.checkedAt || null
    });
  }
  const primary = chainStatus[0] || null;
  const active = chainStatus.find((entry) => entry.reachable) || null;
  const reachable = !!active;
  const available = reachable && config.enabled && !config.killSwitch;
  const usage = usageSnapshot({ days: 1, limits: config.limits });
  return {
    // Campos del contrato (§12)
    provider: active ? active.provider : primary ? primary.provider : null,
    model: active ? active.model : primary ? primary.model : (config.kind === 'ollama' ? config.ollamaInfo.model : config.api.model) || null,
    available,
    reachable,
    fallback: 'deterministic',
    latencyMs: active ? active.latencyMs : primary ? primary.latencyMs : null,
    lastError: active ? null : primary ? primary.error || null : null,
    errorCode: active ? null : primary ? primary.errorCode || null : null,
    ollamaUrl: config.ollamaInfo.baseUrl || null,
    ollamaConfigured: !!(config.ollamaInfo.enabled && config.ollamaInfo.configured),
    openaiConfigured: config.api.keyConfigured,
    // Extras útiles para la UI/scheduler
    configured: config.configured,
    enabled: config.enabled,
    killSwitch: config.killSwitch,
    requestedProvider: config.requested,
    kind: config.kind,
    baseUrl: publicBaseUrl((active && active.provider === 'ollama' ? config.ollamaInfo.baseUrl : config.api.baseUrl) || config.ollamaInfo.baseUrl),
    timeoutMs: config.api.timeoutMs,
    maxRetries: config.api.maxRetries,
    checkedAt: primary ? primary.checkedAt : new Date().toISOString(),
    chain: chainStatus,
    activeProvider: active ? active.provider : null,
    mode: available ? (active && active.provider === 'ollama' ? 'ollama' : 'api') : 'deterministic',
    usage: {
      date: usage.date,
      calls: usage.today.calls,
      tokens: usage.today.tokens,
      errors: usage.today.errors,
      cached: usage.today.cached,
      remaining: usage.remaining
    },
    limits: usage.limits,
    cache: { size: cacheSize(), ttlSec: config.limits.cacheTtlSec },
    profiles: resolvedProfiles(),
    lastTestAt: lastTest ? lastTest.at : null,
    lastTest: lastTest ? { ...lastTest } : null
  };
}

/** Catálogo de modelos (contrato: GET /api/llm/models). */
export async function llmModels({ timeoutMs = 8_000 } = {}) {
  const config = resolveLlmConfig();
  const chain = buildProviderChain(config);
  const items = [];
  const seen = new Set();
  let firstError = null;
  for (const providerConfig of chain) {
    const result = await listProviderModels(providerConfig, { timeoutMs });
    if (!result.ok) {
      if (!firstError) firstError = result.error || 'No se pudo listar modelos.';
      continue;
    }
    for (const item of result.items) {
      const key = `${item.provider}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  if (!items.length && !chain.length && (config.api.model || config.ollamaInfo.model)) {
    const model = config.api.model || config.ollamaInfo.model;
    items.push({ id: model, provider: config.kind, sizeBytes: null, configured: true });
  }
  return {
    items,
    count: items.length,
    provider: chain[0]?.provider || null,
    configured: config.configured,
    error: items.length ? null : firstError
  };
}

/* ------------------------------------------------------------------ */
/* Prueba de proveedor                                                 */
/* ------------------------------------------------------------------ */

/** Presupuesto de tokens del probe de chat (evita falsos negativos tipo DeepSeek). */
export const PROBE_MAX_TOKENS = 32;

function probeMessages() {
  return [
    { role: 'system', content: 'Eres un verificador de conectividad. Responde solo con la palabra ok.' },
    { role: 'user', content: 'Responde solo con: ok' }
  ];
}

/**
 * Prueba real del proveedor (contrato: POST /api/llm/test).
 *
 * El probe de chat usa un presupuesto suficiente (32 tokens) y un prompt
 * trivial para evitar falsos negativos de proveedores que devuelven contenido
 * vacío con `max_tokens` muy bajo (p. ej. DeepSeek). Si el chat responde 200
 * pero sin texto (`finish_reason:"length"`), NO se considera fallo: se degrada
 * a un probe de salud (models/health) y se devuelve `ok:true` con `detail`.
 * Los fallos reales (timeout, 401, 5xx) conservan sus códigos.
 *
 * @param {{probe?:'chat'|'health', timeoutMs?:number}} [options]
 */
export async function llmTest({ probe = 'chat', timeoutMs = 12_000 } = {}) {
  const config = resolveLlmConfig();
  const chain = buildProviderChain(config);
  const at = new Date().toISOString();
  const baseResult = { configured: config.configured, enabled: config.enabled, killSwitch: config.killSwitch };
  if (!chain.length) {
    lastTest = { at, ok: false, provider: null, model: null, latencyMs: null, error: 'Proveedor LLM no configurado (faltan clave y/o modelo).', errorCode: 'LLM_NOT_CONFIGURED', detail: 'Sin cadena de proveedores.', probe };
    return { ...lastTest, ...baseResult };
  }
  const attempts = [];
  for (const providerConfig of chain) {
    if (config.killSwitch || !config.enabled) {
      lastTest = {
        at,
        ok: false,
        provider: providerConfig.provider,
        model: providerConfig.model,
        latencyMs: null,
        error: config.killSwitch ? 'Kill-switch activo.' : 'El subsistema LLM está apagado.',
        errorCode: config.killSwitch ? 'LLM_KILL_SWITCH' : 'LLM_DISABLED',
        detail: config.killSwitch ? 'Kill-switch global activo.' : 'Subsistema LLM apagado (enabled=false).',
        probe
      };
      return { ...lastTest, ...baseResult };
    }

    if (probe === 'health') {
      const health = await healthOf(providerConfig, { force: true, timeoutMs });
      attempts.push({ provider: providerConfig.provider, ok: health.ok, latencyMs: health.latencyMs, error: health.ok ? null : health.error, errorCode: health.ok ? null : health.code });
      if (health.ok) {
        lastTest = {
          at,
          ok: true,
          provider: health.provider,
          model: health.model || providerConfig.model,
          latencyMs: health.latencyMs,
          error: null,
          errorCode: null,
          detail: `Probe de salud (${health.via || 'models'}): el proveedor responde.`,
          probe: 'health',
          attempts
        };
        recordUsage({ workflow: 'test', provider: health.provider, usage: null, error: null });
        return { ...lastTest, ...baseResult };
      }
      continue;
    }

    const started = Date.now();
    try {
      const result = await callProvider({ ...providerConfig, maxRetries: Math.min(1, providerConfig.maxRetries ?? 1) }, {
        messages: probeMessages(),
        temperature: 0,
        maxTokens: PROBE_MAX_TOKENS,
        // Un 200 sin texto (finish_reason "length") no debe lanzar LLM_BAD_RESPONSE.
        allowEmpty: true,
        timeoutMs: Math.min(timeoutMs, providerConfig.timeoutMs || timeoutMs)
      });
      const latencyMs = Date.now() - started;
      const hasText = typeof result.text === 'string' && result.text.trim() !== '';

      if (hasText) {
        attempts.push({ provider: result.provider, ok: true, latencyMs, error: null, errorCode: null, mode: 'chat' });
        lastTest = {
          at,
          ok: true,
          provider: result.provider,
          model: result.model,
          latencyMs,
          error: null,
          errorCode: null,
          usage: result.usage,
          detail: `Probe de chat: el modelo devolvió contenido (${String(result.text).trim().slice(0, 24)}).`,
          probe: 'chat',
          attempts
        };
        recordUsage({ workflow: 'test', provider: result.provider, usage: result.usage, error: null });
        log('info', `LLM test OK con ${result.provider} en ${latencyMs} ms (modelo ${result.model}, probe chat).`);
        return { ...lastTest, ...baseResult };
      }

      // Chat 200 pero vacío: tolerancia + degradación a health check.
      const health = await healthOf(providerConfig, { force: true, timeoutMs });
      const emptyDetail = `El probe de chat volvió vacío (finish_reason=${result.finishReason || 'n/d'}, maxTokens=${PROBE_MAX_TOKENS}).`;
      if (health.ok) {
        attempts.push({
          provider: result.provider,
          ok: true,
          latencyMs,
          error: null,
          errorCode: null,
          mode: 'health',
          emptyChat: true,
          finishReason: result.finishReason || null
        });
        lastTest = {
          at,
          ok: true,
          provider: health.provider || result.provider,
          model: health.model || result.model,
          latencyMs: health.latencyMs ?? latencyMs,
          error: null,
          errorCode: null,
          usage: result.usage,
          detail: `${emptyDetail} Se usó el probe de salud (${health.via || 'models'}): el proveedor está operativo.`,
          probe: 'health',
          attempts
        };
        recordUsage({ workflow: 'test', provider: health.provider || result.provider, usage: result.usage, error: null });
        log('info', `LLM test OK con ${result.provider} vía health (el chat devolvió vacío con ${PROBE_MAX_TOKENS} tokens).`);
        return { ...lastTest, ...baseResult };
      }

      const reason = health.error || health.code || 'sin respuesta del health check';
      attempts.push({
        provider: providerConfig.provider,
        ok: false,
        latencyMs,
        error: `${emptyDetail} Health también falló: ${reason}`,
        errorCode: 'LLM_BAD_RESPONSE',
        mode: 'health'
      });
      recordUsage({ workflow: 'test', provider: providerConfig.provider, usage: result.usage || null, error: 'LLM_BAD_RESPONSE' });
      log('warn', `LLM test: chat vacío y health falló con ${providerConfig.provider}: ${reason}.`);
    } catch (error) {
      const latencyMs = Date.now() - started;
      const code = error instanceof LlmProviderError ? error.code : 'LLM_ERROR';
      attempts.push({ provider: providerConfig.provider, ok: false, latencyMs, error: redactString(error?.message || 'error'), errorCode: code, mode: 'chat' });
      recordUsage({ workflow: 'test', provider: providerConfig.provider, usage: null, error: code });
      log('warn', `LLM test falló con ${providerConfig.provider}: ${code}.`);
    }
  }
  const lastAttempt = attempts[attempts.length - 1] || null;
  lastTest = {
    at,
    ok: false,
    provider: attempts[0]?.provider || null,
    model: chain[0]?.model || null,
    latencyMs: attempts[0]?.latencyMs ?? null,
    error: lastAttempt?.error || 'No se pudo contactar al proveedor LLM.',
    errorCode: lastAttempt?.errorCode || 'LLM_ERROR',
    detail: `Sin éxito: ${attempts.length} intento(s) sobre ${chain.length} eslabón(es).`,
    probe,
    attempts
  };
  return { ...lastTest, ...baseResult };
}

/* ------------------------------------------------------------------ */
/* Llamada principal con cascada                                       */
/* ------------------------------------------------------------------ */

async function resolveFallback(fallback) {
  try {
    if (typeof fallback === 'function') {
      const value = await fallback();
      return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);
    }
    if (typeof fallback === 'string') return fallback;
  } catch (error) {
    log('warn', `Fallback determinista del LLM falló: ${redactString(error?.message || String(error))}`);
  }
  return null;
}

function emptyResult(profile, extra = {}) {
  return {
    ok: false,
    text: null,
    provider: null,
    model: null,
    fallback: true,
    cached: false,
    latencyMs: null,
    usage: null,
    error: null,
    errorCode: null,
    profile,
    workflow: profile,
    attempts: [],
    ...extra
  };
}

/**
 * Llamada LLM con perfiles, cascada y degradación garantizada.
 *
 * @param {object} options
 * @param {string} [options.profile='chat'] perfil por workflow
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {string|(()=>string|Promise<string>)} [options.fallback] texto determinista
 * @param {boolean} [options.json] fuerza salida JSON (si el perfil ya lo pide)
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.deadlineMs] presupuesto total de la operación (por defecto 25 s)
 * @param {boolean|'auto'} [options.cache='auto'] 'auto' = según perfil
 * @param {string} [options.scope] ámbito del rate limit (`web:owner`, `telegram:123`…)
 * @param {boolean} [options.rateLimit=true]
 * @param {string} [options.workflow] nombre a efectos de presupuesto/métricas
 * @returns {Promise<object>}
 */
export async function llmComplete(options = {}) {
  const profileName = options.profile || 'chat';
  const config = resolveLlmConfig();
  const profile = resolveProfile(profileName, config.profiles);
  const workflow = String(options.workflow || profile.id);
  const messages = sanitizeMessages(options.messages || []);
  const result = emptyResult(profile.id, { workflow });

  if (!messages.length) {
    return { ...result, error: 'La petición no contiene mensajes.', errorCode: 'LLM_BAD_REQUEST' };
  }

  const fail = async (errorCode, message, extra = {}) => {
    const text = await resolveFallback(options.fallback);
    if (options.onDegrade) {
      try { options.onDegrade({ errorCode, message, profile: profile.id }); } catch { /* ignore */ }
    }
    return { ...result, ...extra, text, fallback: true, error: message, errorCode, ok: text !== null };
  };

  if (config.killSwitch) return fail('LLM_KILL_SWITCH', 'Kill-switch global activo: se usa el fallback determinista.');
  if (!config.enabled) return fail('LLM_DISABLED', 'El subsistema LLM está apagado: se usa el fallback determinista.');
  if (!profile.enabled) return fail('LLM_PROFILE_DISABLED', `El workflow "${profile.id}" está apagado: se usa el fallback determinista.`);

  if (options.rateLimit !== false) {
    const rate = checkRateLimit(options.scope || 'system', config.limits.ratePerMin);
    if (!rate.allowed) {
      return fail('LLM_RATE_LIMITED', `Demasiadas llamadas LLM (${rate.limit}/min): se usa el fallback determinista.`, { retryAfterSec: rate.retryAfterSec });
    }
  }

  const budget = evaluateBudget(workflow, config.limits);
  if (!budget.allowed) return fail(budget.code || 'LLM_BUDGET_EXCEEDED', budget.reason || 'Presupuesto LLM agotado.', { budget });

  const chain = buildProviderChain(config);
  if (!chain.length) {
    return fail('LLM_NOT_CONFIGURED', 'No hay proveedor LLM configurado: se usa el fallback determinista.');
  }

  const effectiveProfile = profile.model ? { ...profile, modelOverride: profile.model } : profile;
  const temperature = Number.isFinite(options.temperature) ? Math.min(2, Math.max(0, Number(options.temperature))) : profile.temperature;
  const maxTokens = Number.isFinite(options.maxTokens) ? Math.max(1, Math.round(options.maxTokens)) : profile.maxTokens;
  const json = options.json === true || profile.json === true;
  const cacheEnabled = options.cache === true || (options.cache !== false && profile.cacheable === true);
  const cacheTtl = Number.isFinite(profile.cacheTtlSec) ? profile.cacheTtlSec : config.limits.cacheTtlSec;
  const key = cacheKey({
    kind: config.kind,
    chain: chain.map((entry) => `${entry.provider}:${entry.model}`),
    profile: effectiveProfile.id,
    messages,
    temperature,
    maxTokens,
    json
  });

  if (cacheEnabled) {
    const hit = cacheGet(key, cacheTtl);
    if (hit) {
      recordUsage({ workflow, provider: hit.provider || null, usage: null, cached: true });
      return {
        ...result,
        ...hit,
        ok: true,
        fallback: false,
        cached: true,
        latencyMs: 0,
        workflow,
        profile: effectiveProfile.id
      };
    }
  }

  const deadline = Date.now() + Math.max(2_000, Number(options.deadlineMs) || DEFAULT_OPERATION_BUDGET_MS);
  const attempts = [];
  let lastError = null;

  for (const providerConfig of chain) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) {
      attempts.push({ provider: providerConfig.provider, ok: false, error: 'Sin tiempo disponible en la operación.', errorCode: 'LLM_TIMEOUT', latencyMs: 0 });
      break;
    }
    const providerForCall = effectiveProfile.modelOverride
      ? { ...providerConfig, model: effectiveProfile.modelOverride }
      : providerConfig;
    const started = Date.now();
    try {
      const response = await callProvider(providerForCall, {
        messages,
        temperature,
        maxTokens,
        json,
        signal: options.signal,
        timeoutMs: Math.min(providerForCall.timeoutMs || 20_000, remaining),
        deadline: Math.min(deadline, Date.now() + remaining)
      });
      attempts.push({ provider: response.provider, ok: true, latencyMs: response.latencyMs, error: null, errorCode: null, attempts: response.attempts });
      recordUsage({ workflow, provider: response.provider, usage: response.usage, error: null, calls: response.attempts || 1 });
      const payload = {
        text: response.text,
        provider: response.provider,
        model: response.model,
        latencyMs: response.latencyMs,
        usage: response.usage,
        finishReason: response.finishReason || null
      };
      if (cacheEnabled) cacheSet(key, payload);
      return {
        ...result,
        ...payload,
        ok: true,
        fallback: false,
        cached: false,
        error: null,
        errorCode: null,
        workflow,
        profile: effectiveProfile.id,
        attempts
      };
    } catch (error) {
      const code = error instanceof LlmProviderError ? error.code : 'LLM_ERROR';
      lastError = { code, message: redactString(error?.message || 'Error del proveedor LLM.') };
      attempts.push({
        provider: providerConfig.provider,
        ok: false,
        latencyMs: Date.now() - started,
        error: lastError.message,
        errorCode: code
      });
      recordUsage({ workflow, provider: providerConfig.provider, usage: null, error: code, calls: Math.max(1, error?.attempts || 1) });
      log('warn', `LLM ${workflow}: fallo en ${providerConfig.provider} (${code}); se intenta el siguiente eslabón.`);
    }
  }

  return fail(lastError?.code || 'LLM_UNAVAILABLE', lastError?.message || 'Ningún proveedor LLM respondió.', { attempts });
}

/**
 * Chat genérico (contrato: POST /api/llm/chat).
 * @param {{messages:Array, profile?:string, temperature?:number, maxTokens?:number, requireLlm?:boolean, scope?:string, fallback?:string|Function}} options
 */
export async function llmChat(options = {}) {
  const config = resolveLlmConfig();
  const profile = resolveProfile(options.profile || 'chat', config.profiles);
  const fallbackText = options.fallback !== undefined
    ? options.fallback
    : 'Modo local sin LLM: puedo responder a HOY, CAPTURA …, HECHO AG-0002, POSPONER AG-0002 30, FOCO 90 …, CIERRE, SEMANA y balance. Configura el proveedor en Integraciones → LLM.';
  const result = await llmComplete({
    profile: profile.id,
    messages: options.messages,
    fallback: fallbackText,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    json: options.json,
    signal: options.signal,
    scope: options.scope,
    rateLimit: options.rateLimit,
    cache: options.cache,
    workflow: options.workflow || profile.id,
    deadlineMs: options.deadlineMs
  });
  if (options.requireLlm === true && result.fallback) {
    throw new HttpError(503, 'LLM_UNAVAILABLE', result.error || 'El proveedor LLM no está disponible.', {
      details: { errorCode: result.errorCode, attempts: result.attempts || [], fallbackAvailable: true }
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Helpers de contexto                                                 */
/* ------------------------------------------------------------------ */

/** Fecha/hora local y zona para inyectar en los prompts. */
export function localContext() {
  const settings = store.get().settings || {};
  const tz = timezoneOf(settings);
  const now = new Date();
  const today = dateKeyOfIso(now.toISOString(), tz);
  const time = formatTime(now.toISOString(), tz);
  return {
    today,
    time,
    iso: now.toISOString(),
    timezone: tz,
    workdayStart: settings.workdayStart || '07:00',
    workdayEnd: settings.workdayEnd || '19:00',
    defaultDurationMin: settings.defaultDurationMin || 60
  };
}

/** Configuración pública + estado en una sola llamada (uso interno de rutas). */
export async function llmOverview({ probe = false } = {}) {
  const [status] = await Promise.all([llmStatus({ probe })]);
  return { ...status, config: publicConfig() };
}

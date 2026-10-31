/**
 * Configuración del subsistema LLM.
 *
 * Fuentes (en orden de prioridad):
 *   1. `process.env` (lo define el usuario; nunca se pisa).
 *   2. Bóveda de t1 (`store.secrets`, AES-256-GCM) para claves y valores del
 *      catálogo: `llm.provider`, `llm.openai.apiKey`, `llm.openai.baseUrl`,
 *      `llm.openai.model`, `llm.ollama.url`, `llm.ollama.model`, `llm.timeoutMs`.
 *   3. `store.llm` (ajustes NO secretos que no están en el catálogo): cabeceras
 *      extra, versión de API, límites de costo, perfiles, kill-switch, etc.
 *
 * La clave se lee con `getSecret()` y NUNCA se devuelve en `publicConfig()` ni
 * se registra en logs. Este módulo no hace peticiones de red.
 */
import { store } from '../store.mjs';
import { getSecret, setSecret, deleteSecret, secretSource, refreshRedactionIndex } from '../security/vault.mjs';
import { ValidationError } from '../http/errors.mjs';
import { isPlainObject, text, integer, boolean, enumValue } from '../validate.mjs';
import { DEFAULT_PROFILES, PROFILE_IDS, normalizeProfileName, resolveAllProfiles } from './profiles.mjs';
import { sanitizeBaseUrl, publicBaseUrl } from './providers.mjs';

export const PROVIDER_KINDS = Object.freeze(['auto', 'openai', 'openai-responses', 'anthropic', 'ollama']);

export const DEFAULT_BASE_URLS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434'
});

export const DEFAULT_LIMITS = Object.freeze({
  dailyCalls: 500,
  dailyTokens: 300_000,
  ratePerMin: 30,
  cacheTtlSec: 300,
  perWorkflow: Object.freeze({})
});

export const DEFAULT_MEMORY = Object.freeze({ maxMessages: 12, maxConversations: 50, pendingTtlSec: 600 });

export const CONFIG_FIELDS = Object.freeze([
  'provider', 'enabled', 'killSwitch', 'baseUrl', 'model', 'apiKey', 'apiVersion',
  'extraHeaders', 'timeoutMs', 'maxRetries', 'ollamaEnabled', 'ollamaUrl', 'ollamaModel',
  'limits', 'profiles', 'memory', 'clearApiKey'
]);

const FORBIDDEN_HEADERS = new Set([
  'authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'expect'
]);

function tunables() {
  const raw = isPlainObject(store.get().llm) ? store.get().llm : {};
  const ollamaEnvFlag = /^(1|true|si|sí|yes|on)$/i.test(String(process.env.LLM_OLLAMA_ENABLED || '').trim());
  const enabled = raw.enabled === undefined ? true : raw.enabled !== false;
  const killSwitch = raw.killSwitch === true;
  const extraHeaders = isPlainObject(raw.extraHeaders) ? { ...raw.extraHeaders } : {};
  const apiVersion = typeof raw.apiVersion === 'string' && raw.apiVersion.trim() ? raw.apiVersion.trim() : null;
  const maxRetries = Number.isFinite(Number(raw.maxRetries)) ? Math.max(0, Math.min(4, Math.round(Number(raw.maxRetries)))) : 2;
  const ollamaEnabled = raw.ollamaEnabled === undefined ? ollamaEnvFlag : raw.ollamaEnabled === true;
  const limits = {
    ...DEFAULT_LIMITS,
    ...(isPlainObject(raw.limits) ? raw.limits : {}),
    perWorkflow: isPlainObject(raw.limits?.perWorkflow) ? { ...raw.limits.perWorkflow } : {}
  };
  const profiles = isPlainObject(raw.profiles) ? { ...raw.profiles } : {};
  const memory = { ...DEFAULT_MEMORY, ...(isPlainObject(raw.memory) ? raw.memory : {}) };
  return { enabled, killSwitch, extraHeaders, apiVersion, maxRetries, ollamaEnabled, limits, profiles, memory };
}

function timeoutFromVault() {
  const raw = Number(getSecret('llm.timeoutMs'));
  if (!Number.isFinite(raw)) return 20_000;
  return Math.min(120_000, Math.max(1_000, Math.round(raw)));
}

function requestedProvider() {
  const raw = String(getSecret('llm.provider') || 'auto').trim().toLowerCase();
  return PROVIDER_KINDS.includes(raw) ? raw : 'auto';
}

function apiBaseUrl(kind) {
  const configured = sanitizeBaseUrl(getSecret('llm.openai.baseUrl') || '', DEFAULT_BASE_URLS.openai);
  const isOpenAiDefault = configured === DEFAULT_BASE_URLS.openai || configured === `${DEFAULT_BASE_URLS.openai}/`;
  if (kind === 'anthropic' && isOpenAiDefault) return DEFAULT_BASE_URLS.anthropic;
  if (kind === 'ollama') return sanitizeBaseUrl(getSecret('llm.ollama.url') || '', DEFAULT_BASE_URLS.ollama);
  return configured || DEFAULT_BASE_URLS[kind] || DEFAULT_BASE_URLS.openai;
}

/**
 * Configuración resuelta (contiene la clave en memoria; no serializar).
 * @returns {object}
 */
export function resolveLlmConfig() {
  const t = tunables();
  const requested = requestedProvider();
  const apiKey = getSecret('llm.openai.apiKey') || '';
  const apiModel = String(getSecret('llm.openai.model') || '').trim();
  const ollamaUrl = sanitizeBaseUrl(getSecret('llm.ollama.url') || '', DEFAULT_BASE_URLS.ollama);
  const ollamaModel = String(getSecret('llm.ollama.model') || '').trim();
  const kind = requested === 'auto'
    ? (apiKey && apiModel ? 'openai' : (t.ollamaEnabled && ollamaModel ? 'ollama' : 'auto'))
    : requested;
  const effectiveKind = kind;
  const primary = effectiveKind === 'ollama' || effectiveKind === 'auto' ? null : {
    provider: effectiveKind,
    baseUrl: apiBaseUrl(effectiveKind),
    model: apiModel || null,
    apiKey,
    apiVersion: t.apiVersion,
    extraHeaders: t.extraHeaders,
    timeoutMs: timeoutFromVault(),
    maxRetries: t.maxRetries
  };
  const ollama = {
    provider: 'ollama',
    baseUrl: ollamaUrl,
    model: ollamaModel || null,
    apiKey: null,
    apiVersion: null,
    extraHeaders: t.extraHeaders,
    timeoutMs: timeoutFromVault(),
    maxRetries: t.maxRetries
  };
  const apiConfigured = !!(primary && primary.apiKey && primary.model && primary.baseUrl);
  const ollamaConfigured = !!(ollama.baseUrl && ollama.model);
  const ollamaUsable = ollamaConfigured && (t.ollamaEnabled || requested === 'ollama');
  const configured = effectiveKind === 'ollama' ? ollamaUsable : apiConfigured;
  return {
    requested,
    kind: effectiveKind,
    enabled: t.enabled,
    killSwitch: t.killSwitch,
    configured,
    apiConfigured,
    ollamaConfigured,
    ollamaEnabled: t.ollamaEnabled,
    primary,
    ollama: ollamaUsable ? ollama : null,
    api: {
      kind: effectiveKind,
      baseUrl: primary ? primary.baseUrl : null,
      model: primary ? primary.model : null,
      keyConfigured: !!apiKey,
      keySource: apiKey ? secretSource('llm.openai.apiKey') : null,
      timeoutMs: timeoutFromVault(),
      maxRetries: t.maxRetries
    },
    ollamaInfo: { baseUrl: ollamaUrl, model: ollamaModel || null, configured: ollamaConfigured, enabled: t.ollamaEnabled },
    limits: t.limits,
    profiles: t.profiles,
    memory: t.memory
  };
}

/**
 * Cadena de proveedores en orden de intento: API principal → Ollama (si está
 * habilitado y configurado) → (el fallback determinista lo aplica el cliente).
 * @returns {object[]}
 */
export function buildProviderChain(config = resolveLlmConfig()) {
  const chain = [];
  if (!config.enabled || config.killSwitch) return chain;
  if (config.primary && config.apiConfigured) chain.push(config.primary);
  if (config.ollama && config.ollamaConfigured) chain.push(config.ollama);
  return chain;
}

/** ¿Hay alguna clave de API configurada? (usado por el agente para no llamar a terceros). */
export function apiKeyPresent() {
  return !!String(getSecret('llm.openai.apiKey') || '').trim();
}

/** Perfiles resueltos con overrides del store. */
export function resolvedProfiles() {
  return resolveAllProfiles(tunables().profiles);
}

/** Estado público SIN secretos (apto para API/UI). */
export function publicConfig() {
  const config = resolveLlmConfig();
  const t = tunables();
  return {
    enabled: config.enabled,
    killSwitch: config.killSwitch,
    configured: config.configured,
    provider: {
      requested: config.requested,
      kind: config.kind,
      label: providerLabel(config.kind),
      configured: config.apiConfigured || (config.kind === 'ollama' && config.ollamaConfigured),
      keyConfigured: config.api.keyConfigured,
      keySource: config.api.keySource,
      model: config.api.model || (config.kind === 'ollama' ? config.ollamaInfo.model : null),
      baseUrl: publicBaseUrl(config.api.baseUrl || config.ollamaInfo.baseUrl),
      apiVersion: t.apiVersion,
      extraHeaders: Object.keys(t.extraHeaders || {}),
      timeoutMs: config.api.timeoutMs,
      maxRetries: config.api.maxRetries
    },
    ollama: {
      enabled: config.ollamaInfo.enabled,
      configured: config.ollamaInfo.configured,
      url: publicBaseUrl(config.ollamaInfo.baseUrl),
      model: config.ollamaInfo.model
    },
    limits: {
      dailyCalls: config.limits.dailyCalls,
      dailyTokens: config.limits.dailyTokens,
      ratePerMin: config.limits.ratePerMin,
      cacheTtlSec: config.limits.cacheTtlSec,
      perWorkflow: config.limits.perWorkflow || {}
    },
    memory: config.memory,
    profiles: resolvedProfiles()
  };
}

/** Nombre legible del proveedor. */
export function providerLabel(kind) {
  switch (kind) {
    case 'openai': return 'API OpenAI-compatible';
    case 'openai-responses': return 'API Responses';
    case 'anthropic': return 'API Anthropic';
    case 'ollama': return 'Ollama local';
    default: return 'Sin proveedor';
  }
}

/* ------------------------------------------------------------------ */
/* Validación y actualización de configuración                         */
/* ------------------------------------------------------------------ */

/** Valida una URL http(s) y devuelve la versión normalizada sin barra final. */
function assertHttpUrl(value, field) {
  try {
    return sanitizeBaseUrl(value);
  } catch (error) {
    throw new ValidationError(field, 'INVALID_URL', 'Debe ser una URL http(s) válida (ej. https://api.proveedor.com/v1).', error?.message || null);
  }
}

function validateHeaders(raw) {  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ValidationError('extraHeaders', 'INVALID_TYPE', 'extraHeaders debe ser un objeto {cabecera: valor}.');
  const entries = Object.entries(raw);
  if (entries.length > 12) throw new ValidationError('extraHeaders', 'INVALID_VALUE', 'extraHeaders admite como máximo 12 cabeceras.');
  const out = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(key)) throw new ValidationError(`extraHeaders.${key}`, 'INVALID_FORMAT', 'Nombre de cabecera inválido.');
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      throw new ValidationError(`extraHeaders.${key}`, 'INVALID_VALUE', `La cabecera ${key} la gestiona la app y no se puede sobreescribir.`);
    }
    if (typeof value !== 'string') throw new ValidationError(`extraHeaders.${key}`, 'INVALID_TYPE', 'El valor de la cabecera debe ser texto.');
    if (/[\r\n\u0000]/.test(value)) throw new ValidationError(`extraHeaders.${key}`, 'INVALID_CHARS', 'El valor de la cabecera no puede contener saltos de línea.');
    if (value.length > 200) throw new ValidationError(`extraHeaders.${key}`, 'TOO_LONG', 'El valor de la cabecera supera 200 caracteres.');
    out[key] = value.trim();
  }
  return out;
}

function validateProfiles(raw) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ValidationError('profiles', 'INVALID_TYPE', 'profiles debe ser un objeto por workflow.');
  const out = {};
  for (const [rawName, value] of Object.entries(raw)) {
    const id = normalizeProfileName(rawName);
    if (!id) throw new ValidationError(`profiles.${rawName}`, 'INVALID_VALUE', `Perfil desconocido: ${rawName}. Válidos: ${PROFILE_IDS.join(', ')}.`);
    if (!isPlainObject(value)) throw new ValidationError(`profiles.${rawName}`, 'INVALID_TYPE', 'Cada perfil debe ser un objeto.');
    const allowed = new Set(['enabled', 'model', 'temperature', 'maxTokens', 'cacheable', 'cacheTtlSec', 'json']);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new ValidationError(`profiles.${rawName}.${key}`, 'UNKNOWN_FIELD', `Campo no permitido en el perfil: ${key}`);
    }
    const entry = {};
    if (value.enabled !== undefined) entry.enabled = boolean(value.enabled, { field: `profiles.${rawName}.enabled`, required: true });
    if (value.model !== undefined) {
      entry.model = value.model === null ? null : text(value.model, { field: `profiles.${rawName}.model`, max: 120, allowEmpty: false });
    }
    if (value.temperature !== undefined) {
      const n = Number(value.temperature);
      if (!Number.isFinite(n) || n < 0 || n > 2) throw new ValidationError(`profiles.${rawName}.temperature`, 'OUT_OF_RANGE', 'temperature debe estar entre 0 y 2.');
      entry.temperature = n;
    }
    if (value.maxTokens !== undefined) entry.maxTokens = integer(value.maxTokens, { field: `profiles.${rawName}.maxTokens`, min: 16, max: 4096, required: true });
    if (value.cacheable !== undefined) entry.cacheable = boolean(value.cacheable, { field: `profiles.${rawName}.cacheable`, required: true });
    if (value.cacheTtlSec !== undefined) entry.cacheTtlSec = integer(value.cacheTtlSec, { field: `profiles.${rawName}.cacheTtlSec`, min: 0, max: 86_400, required: true });
    if (value.json !== undefined) entry.json = boolean(value.json, { field: `profiles.${rawName}.json`, required: true });
    out[id] = { ...(out[id] || {}), ...entry };
  }
  return out;
}

function validateLimits(raw) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ValidationError('limits', 'INVALID_TYPE', 'limits debe ser un objeto.');
  const allowed = new Set(['dailyCalls', 'dailyTokens', 'ratePerMin', 'cacheTtlSec', 'perWorkflow']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ValidationError(`limits.${key}`, 'UNKNOWN_FIELD', `Campo no permitido en limits: ${key}`);
  }
  const out = {};
  if (raw.dailyCalls !== undefined) out.dailyCalls = integer(raw.dailyCalls, { field: 'limits.dailyCalls', min: 0, max: 100_000, required: true });
  if (raw.dailyTokens !== undefined) out.dailyTokens = integer(raw.dailyTokens, { field: 'limits.dailyTokens', min: 0, max: 100_000_000, required: true });
  if (raw.ratePerMin !== undefined) out.ratePerMin = integer(raw.ratePerMin, { field: 'limits.ratePerMin', min: 1, max: 600, required: true });
  if (raw.cacheTtlSec !== undefined) out.cacheTtlSec = integer(raw.cacheTtlSec, { field: 'limits.cacheTtlSec', min: 0, max: 86_400, required: true });
  if (raw.perWorkflow !== undefined) {
    if (!isPlainObject(raw.perWorkflow)) throw new ValidationError('limits.perWorkflow', 'INVALID_TYPE', 'limits.perWorkflow debe ser un objeto por workflow.');
    const per = {};
    for (const [rawName, value] of Object.entries(raw.perWorkflow)) {
      const id = normalizeProfileName(rawName);
      if (!id) throw new ValidationError(`limits.perWorkflow.${rawName}`, 'INVALID_VALUE', `Perfil desconocido: ${rawName}.`);
      if (!isPlainObject(value)) throw new ValidationError(`limits.perWorkflow.${rawName}`, 'INVALID_TYPE', 'Cada tope debe ser un objeto.');
      const entry = {};
      if (value.calls !== undefined) entry.calls = integer(value.calls, { field: `limits.perWorkflow.${rawName}.calls`, min: 0, max: 10_000, required: true });
      if (value.tokens !== undefined) entry.tokens = integer(value.tokens, { field: `limits.perWorkflow.${rawName}.tokens`, min: 0, max: 10_000_000, required: true });
      per[id] = entry;
    }
    out.perWorkflow = per;
  }
  return out;
}

function validateMemory(raw) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new ValidationError('memory', 'INVALID_TYPE', 'memory debe ser un objeto.');
  const allowed = new Set(['maxMessages', 'maxConversations', 'pendingTtlSec']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ValidationError(`memory.${key}`, 'UNKNOWN_FIELD', `Campo no permitido en memory: ${key}`);
  }
  const out = {};
  if (raw.maxMessages !== undefined) out.maxMessages = integer(raw.maxMessages, { field: 'memory.maxMessages', min: 4, max: 50, required: true });
  if (raw.maxConversations !== undefined) out.maxConversations = integer(raw.maxConversations, { field: 'memory.maxConversations', min: 1, max: 500, required: true });
  if (raw.pendingTtlSec !== undefined) out.pendingTtlSec = integer(raw.pendingTtlSec, { field: 'memory.pendingTtlSec', min: 30, max: 7200, required: true });
  return out;
}

/**
 * Valida un patch de configuración y lo separa en:
 *   - `secrets`: valores del catálogo de la bóveda (clave incluida).
 *   - `stored`: ajustes no secretos que viven en `store.llm`.
 *   - `clearApiKey`: borrar la clave guardada.
 * @param {object} body
 */
export function validateConfigPatch(body) {
  if (!isPlainObject(body)) throw new ValidationError('body', 'INVALID_BODY', 'El cuerpo debe ser un objeto JSON.');
  for (const key of Object.keys(body)) {
    if (!CONFIG_FIELDS.includes(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo de configuración no permitido: ${key}`);
  }
  const secrets = {};
  const stored = {};
  let clearApiKey = false;

  if (body.provider !== undefined) {
    secrets['llm.provider'] = enumValue(body.provider, PROVIDER_KINDS, { field: 'provider', required: true });
  }
  if (body.baseUrl !== undefined) {
    const clean = text(body.baseUrl, { field: 'baseUrl', required: true, max: 300, allowEmpty: false });
    assertHttpUrl(clean, 'baseUrl');
    secrets['llm.openai.baseUrl'] = clean;
  }
  if (body.model !== undefined) {
    secrets['llm.openai.model'] = text(body.model, { field: 'model', required: true, max: 120, allowEmpty: false });
  }
  if (body.apiKey !== undefined) {
    const clean = String(body.apiKey).trim();
    if (!clean) throw new ValidationError('apiKey', 'REQUIRED', 'La clave no puede estar vacía.');
    if (clean.length > 512) throw new ValidationError('apiKey', 'TOO_LONG', 'La clave supera 512 caracteres.');
    if (/[\r\n\u0000]/.test(clean)) throw new ValidationError('apiKey', 'INVALID_CHARS', 'La clave no puede contener saltos de línea.');
    secrets['llm.openai.apiKey'] = clean;
  }
  if (body.ollamaUrl !== undefined) {
    const clean = text(body.ollamaUrl, { field: 'ollamaUrl', required: true, max: 300, allowEmpty: false });
    assertHttpUrl(clean, 'ollamaUrl');
    secrets['llm.ollama.url'] = clean;
  }
  if (body.ollamaModel !== undefined) {
    secrets['llm.ollama.model'] = text(body.ollamaModel, { field: 'ollamaModel', required: true, max: 120, allowEmpty: false });
  }
  if (body.timeoutMs !== undefined) {
    const value = integer(body.timeoutMs, { field: 'timeoutMs', min: 1_000, max: 120_000, required: true });
    secrets['llm.timeoutMs'] = String(value);
  }
  if (body.apiVersion !== undefined) {
    stored.apiVersion = body.apiVersion === null ? null : text(body.apiVersion, { field: 'apiVersion', max: 40, allowEmpty: false });
  }
  if (body.extraHeaders !== undefined) stored.extraHeaders = validateHeaders(body.extraHeaders);
  if (body.maxRetries !== undefined) stored.maxRetries = integer(body.maxRetries, { field: 'maxRetries', min: 0, max: 4, required: true });
  if (body.enabled !== undefined) stored.enabled = boolean(body.enabled, { field: 'enabled', required: true });
  if (body.killSwitch !== undefined) stored.killSwitch = boolean(body.killSwitch, { field: 'killSwitch', required: true });
  if (body.ollamaEnabled !== undefined) stored.ollamaEnabled = boolean(body.ollamaEnabled, { field: 'ollamaEnabled', required: true });
  if (body.limits !== undefined) stored.limits = validateLimits(body.limits);
  if (body.profiles !== undefined) stored.profiles = validateProfiles(body.profiles);
  if (body.memory !== undefined) stored.memory = validateMemory(body.memory);
  if (body.clearApiKey !== undefined) clearApiKey = boolean(body.clearApiKey, { field: 'clearApiKey', required: true }) === true;

  if (clearApiKey && secrets['llm.openai.apiKey']) {
    throw new ValidationError('clearApiKey', 'INVALID_VALUE', 'No puedes enviar apiKey y clearApiKey en la misma petición.');
  }
  if (!Object.keys(secrets).length && !Object.keys(stored).length && !clearApiKey) {
    throw new ValidationError('body', 'EMPTY_PATCH', 'No se envió ningún ajuste de configuración.');
  }
  return { secrets, stored, clearApiKey };
}

/**
 * Aplica un patch validado: bóveda para secretos/valores del catálogo y
 * `store.llm` para el resto. Devuelve el estado público resultante.
 * @param {object} body
 */
export async function updateLlmConfig(body) {
  const { secrets, stored, clearApiKey } = validateConfigPatch(body);
  for (const [name, value] of Object.entries(secrets)) {
    await setSecret(name, value);
  }
  if (clearApiKey) await deleteSecret('llm.openai.apiKey');
  if (Object.keys(stored).length) {
    await store.mutate((data) => {
      if (!isPlainObject(data.llm)) data.llm = {};
      const current = data.llm;
      for (const key of ['apiVersion', 'extraHeaders', 'maxRetries', 'enabled', 'killSwitch', 'ollamaEnabled', 'memory']) {
        if (stored[key] !== undefined) current[key] = stored[key];
      }
      if (stored.limits) {
        current.limits = {
          ...(isPlainObject(current.limits) ? current.limits : {}),
          ...stored.limits,
          perWorkflow: {
            ...(isPlainObject(current.limits?.perWorkflow) ? current.limits.perWorkflow : {}),
            ...(stored.limits.perWorkflow || {})
          }
        };
      }
      if (stored.profiles) {
        current.profiles = { ...(isPlainObject(current.profiles) ? current.profiles : {}) };
        for (const [id, entry] of Object.entries(stored.profiles)) {
          current.profiles[id] = { ...(isPlainObject(current.profiles[id]) ? current.profiles[id] : {}), ...entry };
        }
      }
    }, { label: 'llm-config' });
  }
  refreshRedactionIndex();
  return publicConfig();
}

/** Perfil por defecto del catálogo (para rutas/estado). */
export function defaultProfiles() {
  return DEFAULT_PROFILES;
}

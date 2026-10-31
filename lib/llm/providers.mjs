/**
 * Adaptadores de proveedores LLM de Agenda Copilot P95.
 *
 * Reglas de diseño:
 *   - Sin dependencias: `fetch` global de Node 24 y `AbortSignal`.
 *   - El proveedor PRINCIPAL es una API OpenAI-compatible (`chat/completions`).
 *     Se añaden adaptadores específicos para APIs que no son compatibles:
 *     `openai-responses` (endpoint /responses), `anthropic` (/v1/messages) y
 *     `ollama` (/api/chat), este último solo como alternativa offline opcional.
 *   - Timeout por intento, reintentos con backoff exponencial + jitter para
 *     errores transitorios (red, timeout, 408/409/425/429/5xx), respetando
 *     `Retry-After` con un tope.
 *   - La clave NUNCA se registra: los errores se redactan con `redactString`.
 *
 * Este módulo no lee del store ni de la bóveda: recibe una configuración ya
 * resuelta (ver `lib/llm/config.mjs`) para poder probarse con un mock.
 */
import { redactString } from '../security/redact.mjs';

export const OPENAI_CHAT_PATH = '/chat/completions';
export const OPENAI_RESPONSES_PATH = '/responses';
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const OLLAMA_CHAT_PATH = '/api/chat';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_BODY_EXCERPT = 400;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 507, 522, 524]);

/** Error tipado de proveedor (nunca contiene la clave: el mensaje se redacta). */
export class LlmProviderError extends Error {
  constructor(code, message, { status = 0, retryable = false, provider = null, attempts = 0, attemptLog = [] } = {}) {
    super(redactString(message));
    this.name = 'LlmProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
    this.attempts = attempts;
    this.attemptLog = attemptLog;
  }
}

/** Estimación de tokens cuando el proveedor no informa consumo (≈4 caracteres/token). */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

/**
 * Normaliza el bloque `usage` de los distintos proveedores.
 * @param {object} raw
 * @param {{prompt?:string, completion?:string}} [texts] textos para estimar si falta usage
 */
export function normalizeUsage(raw, texts = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const promptRaw = Number(source.prompt_tokens ?? source.input_tokens ?? source.prompt_eval_count ?? NaN);
  const completionRaw = Number(source.completion_tokens ?? source.output_tokens ?? source.eval_count ?? NaN);
  const promptTokens = Number.isFinite(promptRaw) ? Math.max(0, Math.round(promptRaw)) : estimateTokens(texts.prompt || '');
  const completionTokens = Number.isFinite(completionRaw) ? Math.max(0, Math.round(completionRaw)) : estimateTokens(texts.completion || '');
  const totalTokens = Number(source.total_tokens ?? source.total ?? NaN);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(totalTokens) ? Math.max(0, Math.round(totalTokens)) : promptTokens + completionTokens,
    reported: Number.isFinite(promptRaw) || Number.isFinite(completionRaw)
  };
}

function excerpt(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return redactString(String(text)).slice(0, MAX_BODY_EXCERPT);
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
  return 0;
}

/** Valida y normaliza la base URL del proveedor (solo http/https). */
export function sanitizeBaseUrl(raw, fallback = '') {
  const value = String(raw ?? fallback ?? '').trim().replace(/\/+$/, '');
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LlmProviderError('LLM_CONFIG', 'La baseUrl del proveedor LLM no es una URL válida.', { status: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmProviderError('LLM_CONFIG', 'La baseUrl del proveedor LLM debe ser http o https.', { status: 400 });
  }
  return value;
}

/** Base URL visible en el estado, sin credenciales ni query. */
export function publicBaseUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function withApiVersion(url, apiVersion) {
  if (!apiVersion) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('api-version')) parsed.searchParams.set('api-version', apiVersion);
    return parsed.toString();
  } catch {
    return url;
  }
}

function joinUrl(base, path) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  if (!cleanBase) return path;
  return `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`;
}

function headersFor(config, extra = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...(config.extraHeaders || {}), ...extra };
  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = config.apiVersion || '2023-06-01';
  } else if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function authHeadersForHealth(config) {
  if (config.provider === 'anthropic') {
    return { 'x-api-key': config.apiKey, 'anthropic-version': config.apiVersion || '2023-06-01', accept: 'application/json' };
  }
  if (config.provider === 'ollama') return { accept: 'application/json' };
  return { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' };
}

async function readJson(response) {
  const raw = await response.text().catch(() => '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: excerpt(raw) };
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function timeoutSignal(outerSignal, ms) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.round(ms)));
  if (!outerSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([outerSignal, timeout]);
  return timeout;
}

async function postJson(url, { headers, body, timeoutMs, signal }) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeoutSignal(signal, timeoutMs)
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new LlmProviderError(isTimeout ? 'LLM_TIMEOUT' : 'LLM_NETWORK', isTimeout ? `El proveedor no respondió en ${timeoutMs} ms.` : `No se pudo contactar al proveedor: ${error?.message || 'error de red'}`, {
      retryable: true
    });
  }
  const json = await readJson(response);
  return { response, json };
}

function httpError(provider, response, json) {
  const status = response.status;
  const apiMessage = json?.error?.message || json?.error?.type || json?.message || json?._raw || '';
  const retryable = RETRYABLE_STATUS.has(status);
  const code = status === 401 || status === 403 ? 'LLM_AUTH' : status === 429 ? 'LLM_RATE_LIMITED' : status >= 500 ? 'LLM_UPSTREAM' : 'LLM_BAD_REQUEST';
  return new LlmProviderError(code, `Proveedor ${provider} respondió ${status}${apiMessage ? `: ${excerptType(apiMessage)}` : ''}`, {
    status,
    retryable,
    provider
  });
}

function excerptType(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return redactString(String(text)).slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Peticiones por adaptador                                            */
/* ------------------------------------------------------------------ */

async function callOpenAiChat(config, request) {
  const base = sanitizeBaseUrl(config.baseUrl, 'https://api.openai.com/v1');
  const url = withApiVersion(joinUrl(base, OPENAI_CHAT_PATH), config.apiVersion);
  const body = {
    model: config.model,
    messages: request.messages,
    temperature: request.temperature,
    stream: false
  };
  if (request.maxTokens) body.max_tokens = request.maxTokens;
  let jsonMode = request.json === true && config.jsonMode !== false;
  if (jsonMode) body.response_format = { type: 'json_object' };

  let result = await postJson(url, { headers: headersFor(config), body, timeoutMs: request.timeoutMs, signal: request.signal });
  // Algunos proveedores OpenAI-compatibles no soportan response_format: se reintenta sin él.
  if (!result.response.ok && result.response.status === 400 && jsonMode && /response_format|json_object/i.test(JSON.stringify(result.json || {}))) {
    delete body.response_format;
    jsonMode = false;
    result = await postJson(url, { headers: headersFor(config), body, timeoutMs: request.timeoutMs, signal: request.signal });
  }
  if (!result.response.ok) throw httpError(config.provider, result.response, result.json);

  const json = result.json || {};
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const text = contentToText(choice?.message?.content ?? choice?.text ?? '');
  if (!text && request.allowEmpty !== true) throw new LlmProviderError('LLM_BAD_RESPONSE', 'El proveedor respondió sin contenido utilizable.', { status: 502, provider: config.provider });
  return {
    provider: config.provider,
    model: json.model || config.model,
    text,
    empty: text === '',
    finishReason: choice?.finish_reason || null,
    usage: normalizeUsage(json.usage, { prompt: request.messages.map((m) => m.content).join('\n'), completion: text }),
    status: result.response.status
  };
}

async function callOpenAiResponses(config, request) {
  const base = sanitizeBaseUrl(config.baseUrl, 'https://api.openai.com/v1');
  const url = withApiVersion(joinUrl(base, OPENAI_RESPONSES_PATH), config.apiVersion);
  const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const input = request.messages.filter((message) => message.role !== 'system').map((message) => message.content).join('\n\n');
  const body = { model: config.model, input };
  if (system) body.instructions = system;
  if (request.maxTokens) body.max_output_tokens = request.maxTokens;
  if (Number.isFinite(request.temperature)) body.temperature = request.temperature;
  const { response, json } = await postJson(url, { headers: headersFor(config), body, timeoutMs: request.timeoutMs, signal: request.signal });
  if (!response.ok) throw httpError(config.provider, response, json);
  let text = typeof json.output_text === 'string' ? json.output_text : '';
  if (!text && Array.isArray(json.output)) {
    for (const item of json.output) {
      for (const piece of item?.content || []) {
        if (typeof piece?.text === 'string') text += piece.text;
      }
    }
  }
  text = contentToText(text);
  if (!text && request.allowEmpty !== true) throw new LlmProviderError('LLM_BAD_RESPONSE', 'El proveedor respondió sin contenido utilizable.', { status: 502, provider: config.provider });
  return {
    provider: config.provider,
    model: json.model || config.model,
    text,
    empty: text === '',
    finishReason: json.status || null,
    usage: normalizeUsage(json.usage, { prompt: `${system}\n${input}`, completion: text }),
    status: response.status
  };
}

async function callAnthropic(config, request) {
  const base = sanitizeBaseUrl(config.baseUrl, 'https://api.anthropic.com');
  // Si la baseUrl ya incluye /v1 (lo habitual), el endpoint es /messages.
  const url = joinUrl(base, /\/v1$/.test(base) ? '/messages' : ANTHROPIC_MESSAGES_PATH);
  const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }));
  const body = {
    model: config.model,
    max_tokens: request.maxTokens || 800,
    temperature: Number.isFinite(request.temperature) ? request.temperature : 0.3,
    messages
  };
  if (system) body.system = system;
  const { response, json } = await postJson(url, { headers: headersFor(config), body, timeoutMs: request.timeoutMs, signal: request.signal });
  if (!response.ok) throw httpError(config.provider, response, json);
  const text = (Array.isArray(json.content) ? json.content : []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  if (!text && request.allowEmpty !== true) throw new LlmProviderError('LLM_BAD_RESPONSE', 'El proveedor respondió sin contenido utilizable.', { status: 502, provider: config.provider });
  return {
    provider: config.provider,
    model: json.model || config.model,
    text,
    empty: text === '',
    finishReason: json.stop_reason || null,
    usage: normalizeUsage(json.usage, { prompt: `${system}\n${messages.map((m) => m.content).join('\n')}`, completion: text }),
    status: response.status
  };
}

async function callOllama(config, request) {
  const base = sanitizeBaseUrl(config.baseUrl, 'http://127.0.0.1:11434');
  const url = joinUrl(base, OLLAMA_CHAT_PATH);
  const body = {
    model: config.model,
    messages: request.messages,
    stream: false,
    options: {}
  };
  if (Number.isFinite(request.temperature)) body.options.temperature = request.temperature;
  if (request.maxTokens) body.options.num_predict = request.maxTokens;
  if (request.json === true) body.format = 'json';
  const { response, json } = await postJson(url, { headers: headersFor(config), body, timeoutMs: request.timeoutMs, signal: request.signal });
  if (!response.ok) throw httpError(config.provider, response, json);
  const text = contentToText(json.message?.content ?? json.response ?? '');
  if (!text && request.allowEmpty !== true) throw new LlmProviderError('LLM_BAD_RESPONSE', 'Ollama respondió sin contenido utilizable.', { status: 502, provider: config.provider });
  return {
    provider: config.provider,
    model: json.model || config.model,
    text,
    empty: text === '',
    finishReason: json.done_reason || null,
    usage: normalizeUsage(json, { prompt: request.messages.map((m) => m.content).join('\n'), completion: text }),
    status: response.status
  };
}

const CALLERS = {
  openai: callOpenAiChat,
  'openai-responses': callOpenAiResponses,
  anthropic: callAnthropic,
  ollama: callOllama
};

/**
 * Ejecuta una petición de chat contra el proveedor configurado, con timeout y
 * hasta `maxRetries` reintentos con backoff exponencial + jitter.
 *
 * @param {object} config configuración resuelta:
 *   {provider, baseUrl, model, apiKey, apiVersion, extraHeaders, timeoutMs, maxRetries}
 * @param {{messages:Array<{role:string,content:string}>, temperature?:number, maxTokens?:number, json?:boolean, signal?:AbortSignal, deadline?:number, timeoutMs?:number, allowEmpty?:boolean}} request
 * @returns {Promise<{ok:true, provider:string, model:string, text:string, usage:object, latencyMs:number, attempts:number, status:number}>}
 */
export async function callProvider(config, request = {}) {
  const provider = String(config?.provider || '').trim();
  const caller = CALLERS[provider];
  if (!caller) {
    throw new LlmProviderError('LLM_NOT_CONFIGURED', `Proveedor LLM no soportado: ${provider || '(vacío)'}.`, { provider: provider || null });
  }
  if (!config.model) throw new LlmProviderError('LLM_NOT_CONFIGURED', 'Falta el modelo del proveedor LLM.', { provider });
  const messages = Array.isArray(request.messages) ? request.messages.filter((message) => message && typeof message.content === 'string' && message.content.length > 0) : [];
  if (!messages.length) throw new LlmProviderError('LLM_BAD_REQUEST', 'La petición no contiene mensajes.', { status: 400, provider });

  const timeoutMs = Math.max(500, Math.round(Number(request.timeoutMs || config.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const maxRetries = Math.max(0, Math.min(4, Math.round(Number(config.maxRetries ?? DEFAULT_MAX_RETRIES))));
  const deadline = Number.isFinite(request.deadline) ? request.deadline : Date.now() + timeoutMs * (maxRetries + 1) + 2_000;
  const attemptLog = [];
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) {
      lastError = new LlmProviderError('LLM_TIMEOUT', 'Se agotó el tiempo total disponible para el proveedor LLM.', { provider, attempts: attempt, attemptLog });
      break;
    }
    const started = Date.now();
    try {
      const result = await caller(config, {
        messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        json: request.json === true,
        allowEmpty: request.allowEmpty === true,
        signal: request.signal,
        timeoutMs: Math.min(timeoutMs, remaining)
      });
      return {
        ok: true,
        ...result,
        usage: result.usage,
        latencyMs: Date.now() - started,
        attempts: attempt + 1,
        attemptLog
      };
    } catch (error) {
      const normalized = error instanceof LlmProviderError
        ? error
        : new LlmProviderError('LLM_NETWORK', error?.message || 'Error desconocido del proveedor.', { provider, retryable: true });
      normalized.provider = normalized.provider || provider;
      lastError = normalized;
      attemptLog.push({ attempt: attempt + 1, code: normalized.code, status: normalized.status || 0, error: normalized.message, ms: Date.now() - started });
      if (!normalized.retryable || attempt === maxRetries) break;
      const backoff = Math.min(4_000, 300 * 2 ** attempt) + Math.floor(Math.random() * 120);
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now() - 100)));
      continue;
    }
  }

  const finalError = lastError || new LlmProviderError('LLM_UNKNOWN', 'Fallo desconocido del proveedor LLM.', { provider });
  finalError.attempts = Math.max(finalError.attempts || 0, attemptLog.length);
  finalError.attemptLog = attemptLog;
  throw finalError;
}

/* ------------------------------------------------------------------ */
/* Salud y catálogo de modelos                                         */
/* ------------------------------------------------------------------ */

function modelsUrl(config) {
  if (config.provider === 'ollama') return joinUrl(sanitizeBaseUrl(config.baseUrl, 'http://127.0.0.1:11434'), '/api/tags');
  const base = sanitizeBaseUrl(config.baseUrl, config.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  if (config.provider === 'anthropic') return joinUrl(base.replace(/\/v1$/, ''), '/v1/models');
  return joinUrl(base, '/models');
}

function parseModels(provider, json) {
  const items = [];
  if (Array.isArray(json?.data)) {
    for (const row of json.data) {
      const id = typeof row?.id === 'string' ? row.id : null;
      if (!id) continue;
      items.push({ id, provider, sizeBytes: Number.isFinite(Number(row?.size)) ? Number(row.size) : null });
    }
  }
  if (Array.isArray(json?.models)) {
    for (const row of json.models) {
      const id = typeof row?.name === 'string' ? row.name : typeof row?.model === 'string' ? row.model : null;
      if (!id) continue;
      items.push({ id, provider, sizeBytes: Number.isFinite(Number(row?.size)) ? Number(row.size) : null });
    }
  }
  return items;
}

async function getJson(url, { headers, timeoutMs, signal }) {
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: timeoutSignal(signal, timeoutMs) });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new LlmProviderError(isTimeout ? 'LLM_TIMEOUT' : 'LLM_NETWORK', isTimeout ? 'El proveedor no respondió al health check.' : `No se pudo contactar al proveedor: ${error?.message || 'error de red'}`, { retryable: false });
  }
  const json = await readJson(response);
  return { response, json };
}

/**
 * Health check real del proveedor (sin lanzar excepciones).
 * 1) Lista de modelos; 2) si el endpoint no existe, una petición mínima de chat.
 * @returns {Promise<{ok:boolean, provider:string, model:string, latencyMs:number, error:string|null, code:string|null, models:Array, checkedAt:string, via:string}>}
 */
export async function checkProviderHealth(config, { timeoutMs = 6_000, signal } = {}) {
  const started = Date.now();
  const provider = String(config?.provider || '');
  const base = { ok: false, provider, model: config?.model || null, latencyMs: 0, error: null, code: null, models: [], checkedAt: new Date().toISOString(), via: 'models' };
  if (!provider || !config?.model) {
    return { ...base, latencyMs: Date.now() - started, error: 'Proveedor LLM no configurado.', code: 'LLM_NOT_CONFIGURED' };
  }
  if (provider !== 'ollama' && !config?.apiKey) {
    return { ...base, latencyMs: Date.now() - started, error: 'Falta la clave del proveedor LLM.', code: 'LLM_NOT_CONFIGURED' };
  }
  try {
    const { response, json } = await getJson(modelsUrl(config), { headers: authHeadersForHealth(config), timeoutMs, signal });
    if (response.ok) {
      return { ...base, ok: true, latencyMs: Date.now() - started, models: parseModels(provider, json), code: null };
    }
    if (![404, 405, 501].includes(response.status)) {
      const error = httpError(provider, response, json);
      return { ...base, latencyMs: Date.now() - started, error: error.message, code: error.code, codeStatus: response.status };
    }
  } catch (error) {
    // Se intenta la petición mínima antes de declarar el proveedor caído.
  }

  // Segundo intento: una petición mínima de chat (verifica clave + modelo).
  // Presupuesto suficiente (32 tokens) y `allowEmpty`: un finish_reason "length"
  // sin texto NO significa que el proveedor esté caído.
  try {
    const result = await callProvider({ ...config, maxRetries: 0, timeoutMs }, {
      messages: [
        { role: 'system', content: 'Eres un verificador de conectividad. Responde solo con la palabra ok.' },
        { role: 'user', content: 'Responde solo con: ok' }
      ],
      maxTokens: 32,
      temperature: 0,
      allowEmpty: true,
      timeoutMs: Math.min(timeoutMs, 5_000)
    });
    return {
      ...base,
      ok: true,
      via: 'chat',
      emptyCompletion: result.text === '',
      latencyMs: Date.now() - started,
      model: result.model || config.model,
      models: [{ id: result.model || config.model, provider, sizeBytes: null }]
    };
  } catch (error) {
    return {
      ...base,
      via: 'chat',
      latencyMs: Date.now() - started,
      error: error instanceof LlmProviderError ? error.message : String(error?.message || error),
      code: error instanceof LlmProviderError ? error.code : 'LLM_NETWORK',
      codeStatus: error?.status || 0
    };
  }
}

/** Catálogo de modelos del proveedor (para el selector de la UI). */
export async function listProviderModels(config, { timeoutMs = 8_000, signal } = {}) {
  const provider = String(config?.provider || '');
  if (!provider) return { ok: false, provider: null, items: [], error: 'Proveedor LLM no configurado.', code: 'LLM_NOT_CONFIGURED' };
  try {
    const { response, json } = await getJson(modelsUrl(config), { headers: authHeadersForHealth(config), timeoutMs, signal });
    if (!response.ok) {
      const error = httpError(provider, response, json);
      return { ok: false, provider, items: [], error: error.message, code: error.code, status: response.status };
    }
    const items = parseModels(provider, json);
    const fallbackItems = items.length ? items : (config.model ? [{ id: config.model, provider, sizeBytes: null }] : []);
    return { ok: true, provider, items: fallbackItems, error: null };
  } catch (error) {
    return { ok: false, provider, items: [], error: error instanceof LlmProviderError ? error.message : String(error?.message || error), code: error instanceof LlmProviderError ? error.code : 'LLM_NETWORK' };
  }
}

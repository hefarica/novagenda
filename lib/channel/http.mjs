/**
 * Transporte HTTP de los canales.
 *
 * Sin dependencias: usa `fetch` global de Node 24. Aporta lo que los canales
 * necesitan y no conviene repetir en cada adaptador:
 *   - timeouts con `AbortSignal` (y cancelación externa para el long polling),
 *   - reintentos con backoff exponencial + jitter y respeto de `Retry-After`,
 *   - clasificación de errores (`NETWORK`, `TIMEOUT`, `ABORTED`, HTTP),
 *   - bases URL con override por entorno para poder probar sin red/credenciales
 *     (`TELEGRAM_API_BASE`, `WA_GRAPH_BASE`, `GMAIL_API_BASE`, `GOOGLE_TOKEN_URL`).
 */

/** Error de canal con código estable y sin secretos en el mensaje. */
export class ChannelError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?:number, retryAfterMs?:number, channel?:string, details?:unknown, cause?:unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(String(message || code));
    this.name = 'ChannelError';
    this.code = String(code || 'CHANNEL_ERROR');
    this.status = Number(extra.status) || 0;
    this.retryAfterMs = Number(extra.retryAfterMs) || 0;
    this.channel = extra.channel || null;
    this.details = extra.details ?? null;
    if (extra.cause) this.cause = extra.cause;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_RETRY_MAX_MS = 4_000;

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Backoff exponencial con jitter (documentado en docs/CANALES.md).
 * @param {number} attempt 1-based
 * @param {{baseMs?:number, maxMs?:number, retryAfterMs?:number}} [options]
 * @returns {number} milisegundos
 */
export function backoffMs(attempt, options = {}) {
  const base = Math.max(50, Number(options.baseMs) || DEFAULT_RETRY_BASE_MS);
  const max = Math.max(base, Number(options.maxMs) || DEFAULT_RETRY_MAX_MS);
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.random() * base * 0.35;
  const suggested = Number(options.retryAfterMs) || 0;
  return Math.round(Math.min(Math.max(exponential + jitter, suggested), Math.max(max, suggested)));
}

/** @param {string} name @param {string} fallback */
export function envUrl(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return (value || fallback).replace(/\/+$/, '');
}

export function telegramApiBase() {
  return envUrl('TELEGRAM_API_BASE', 'https://api.telegram.org');
}

export function whatsappGraphBase() {
  return envUrl('WA_GRAPH_BASE', 'https://graph.facebook.com');
}

export function gmailApiBase() {
  return envUrl('GMAIL_API_BASE', 'https://gmail.googleapis.com/gmail/v1');
}

export function googleTokenUrl() {
  return envUrl('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token');
}

export function googleUserinfoUrl() {
  return envUrl('GOOGLE_USERINFO_URL', 'https://www.googleapis.com/oauth2/v2/userinfo');
}

export function googleAuthBase() {
  return envUrl('GOOGLE_AUTH_BASE', 'https://accounts.google.com/o/oauth2/v2/auth');
}

/**
 * Combina la señal externa (parar) con el timeout del request.
 * @param {AbortSignal|null} external
 * @param {number} timeoutMs
 * @returns {{signal:AbortSignal, cleanup:()=>void}}
 */
function combineSignals(external, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!external) return { signal: timeoutSignal, cleanup: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([external, timeoutSignal]), cleanup: () => {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort(external.reason);
  if (external.aborted) abort();
  else external.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutSignal.reason), Math.max(1, timeoutMs));
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external.removeEventListener('abort', abort);
    }
  };
}

function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return 0;
  const raw = headers.get('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** ¿El fallo de red ocurrió antes de enviar la petición? (seguro reintentar) */
function isPreflightNetworkError(err) {
  const code = String(err?.cause?.code || err?.code || '');
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
}

const IDEMPOTENT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SAFE_POST_RETRY_STATUSES = new Set([429, 503]);

/**
 * Petición HTTP con JSON opcional.
 *
 * @param {string} url
 * @param {{
 *   method?:string, headers?:Record<string,string>, body?:string|Buffer|URLSearchParams,
 *   timeoutMs?:number, parse?:'json'|'text'|'none', signal?:AbortSignal|null,
 *   retries?:number, retryBaseMs?:number, retryMaxMs?:number, idempotent?:boolean,
 *   channel?:string, expectJson?:boolean
 * }} [options]
 * @returns {Promise<{ok:boolean, status:number, json:any, text:string, headers:Headers}>}
 */
export async function requestUrl(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const idempotent = options.idempotent ?? (method === 'GET' || method === 'HEAD');
  const retries = Math.max(0, Number(options.retries ?? (idempotent ? 2 : 0)));
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const headers = { ...(options.headers || {}) };
  const channel = options.channel || null;

  let lastError = null;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const { signal, cleanup } = combineSignals(options.signal || null, timeoutMs);
    let response;
    try {
      response = await fetch(url, { method, headers, body: options.body, signal });
    } catch (err) {
      cleanup();
      const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      const externalAbort = !!options.signal?.aborted;
      if (externalAbort) {
        throw new ChannelError('ABORTED', 'Operación cancelada.', { channel, cause: err });
      }
      if (aborted) {
        lastError = new ChannelError('TIMEOUT', `El canal no respondió en ${timeoutMs} ms.`, { channel, cause: err });
      } else {
        lastError = new ChannelError('NETWORK', `No se pudo contactar al canal (${err?.message || 'error de red'}).`, { channel, cause: err });
      }
      const retryable = aborted ? idempotent : idempotent || isPreflightNetworkError(err);
      if (retryable && attempt <= retries) {
        await sleep(backoffMs(attempt, { baseMs: options.retryBaseMs, maxMs: options.retryMaxMs }));
        continue;
      }
      throw lastError;
    }

    let text = '';
    try {
      text = await response.text();
    } catch (err) {
      cleanup();
      if (options.signal?.aborted) throw new ChannelError('ABORTED', 'Operación cancelada.', { channel, cause: err });
      throw new ChannelError('NETWORK', 'La respuesta del canal se cortó a mitad.', { channel, cause: err });
    }
    cleanup();

    let json = null;
    if (options.parse !== 'text' && text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    const result = { ok: response.ok, status: response.status, json, text, headers: response.headers };
    if (response.ok) return result;

    const retryAfterMs = parseRetryAfterMs(response.headers);
    const retryableStatus = idempotent
      ? IDEMPOTENT_RETRY_STATUSES.has(response.status)
      : SAFE_POST_RETRY_STATUSES.has(response.status);
    if (retryableStatus && attempt <= retries) {
      await sleep(backoffMs(attempt, {
        baseMs: options.retryBaseMs, maxMs: options.retryMaxMs, retryAfterMs
      }));
      continue;
    }
    return result;
  }
  throw lastError || new ChannelError('NETWORK', 'El canal no respondió.', { channel });
}

/**
 * Petición multipart (FormData). No serializa ni reintenta: se usa para subir
 * documentos una sola vez (Telegram sendDocument, WhatsApp media upload).
 * @param {string} url
 * @param {FormData} form
 * @param {{method?:string, timeoutMs?:number, signal?:AbortSignal|null, channel?:string}} [options]
 */
export async function requestForm(url, form, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 60_000);
  const { signal, cleanup } = combineSignals(options.signal || null, timeoutMs);
  const headers = { ...(options.headers || {}) };
  let response;
  try {
    response = await fetch(url, { method, headers, body: form, signal });
  } catch (err) {
    cleanup();
    if (options.signal?.aborted) throw new ChannelError('ABORTED', 'Operación cancelada.', { channel: options.channel });
    throw new ChannelError('NETWORK', `No se pudo enviar el archivo (${err?.message || 'error de red'}).`, { channel: options.channel, cause: err });
  }
  let text = '';
  try { text = await response.text(); } catch { text = ''; }
  cleanup();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: response.ok, status: response.status, json, text, headers: response.headers };
}

/**
 * Atajo JSON con cabeceras y cuerpo ya serializado.
 * @param {string} url
 * @param {object} [options]
 */
export async function requestJson(url, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    body = JSON.stringify(body);
  }
  return requestUrl(url, { ...options, headers, body });
}

/**
 * URL con query string a partir de un objeto (ignora undefined/null).
 * @param {string} base
 * @param {string} path
 * @param {Record<string, unknown>} [query]
 */
export function buildUrl(base, path, query = {}) {
  const url = new URL(`${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return url.toString();
}

/**
 * Envuelve una llamada con reintentos y backoff (para operaciones locales o
 * enviadas a proveedores que no usan `requestUrl`).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?:number, baseMs?:number, maxMs?:number, retryOn?:(error:unknown)=>boolean}} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const retryOn = options.retryOn || (() => true);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !retryOn(err)) break;
      await sleep(backoffMs(attempt, { baseMs: options.baseMs, maxMs: options.maxMs }));
    }
  }
  throw lastError;
}

/**
 * Mensaje de error corto y sin secretos para estado/auditoría.
 * @param {unknown} err
 */
export function describeError(err) {
  const code = err?.code ? `${err.code}: ` : '';
  const message = String(err?.message || 'error desconocido');
  return `${code}${message}`.slice(0, 300);
}

/**
 * Extrae un mensaje de error de una respuesta de proveedor.
 * @param {{json:any, text:string, status:number}} response
 * @param {string[]} [paths]
 */
export function providerErrorMessage(response, paths = []) {
  const json = response?.json;
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), json);
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
  }
  if (typeof json?.error?.message === 'string') return json.error.message.slice(0, 300);
  if (typeof json?.description === 'string') return json.description.slice(0, 300);
  if (typeof json?.error_description === 'string') return json.error_description.slice(0, 300);
  if (typeof json?.message === 'string') return json.message.slice(0, 300);
  return `HTTP ${response?.status || 0}`;
}

/**
 * Cliente HTTP del frontend.
 * - Envelopa errores del contrato ({error, code, field, details, requestId}).
 * - Distingue "sin conexión" de "ruta no disponible" para poder degradar.
 * - Reintenta UNA vez los métodos idempotentes (GET/HEAD/PUT/DELETE) cuando el
 *   fallo es de red (p. ej. el navegador reutiliza un socket keep-alive que el
 *   servidor acaba de cerrar). POST y PATCH NUNCA se reintentan solos: podrían
 *   duplicar una cita, una captura o un envío.
 * - Un DELETE cuyo reintento responde 404 se considera ya ejecutado.
 * - Mensajes de error diferenciados: red/offline, timeout y error real de API.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = '', field = '', details = null, requestId = '', path = '', method = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
    this.requestId = requestId;
    this.path = path;
    this.method = method;
  }
}

export class NetworkError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: 'offline'|'unreachable'|'timeout'|'cancelled', method?: string, path?: string, cause?: unknown}} [options]
   */
  constructor(message = 'Sin conexión con la app. Comprueba que el servidor siga encendido.', { kind = 'unreachable', method = '', path = '', cause = null } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.kind = kind;
    this.method = method;
    this.path = path;
    this.cause = cause;
  }
}

/** Estado por endpoint opcional: { ok, missing, status, error }. */
export const endpointState = new Map();
let unauthorizedHandler = null;

/** Métodos que se pueden repetir sin efectos secundarios. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
/** Espera entre el intento fallido y el reintento (ms). */
const RETRY_DELAY_MS = 300;

export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

export function endpoint(key) {
  return endpointState.get(key) || null;
}

export function isEndpointReady(key) {
  const value = endpointState.get(key);
  return Boolean(value && value.ok);
}

export function isNetworkError(error) {
  return error instanceof NetworkError;
}

export function isAlreadyDeleted(result) {
  return Boolean(result && result.alreadyDeleted === true);
}

/**
 * Mensaje listo para mostrar al usuario:
 * - red/offline → el mensaje del NetworkError (ya viene claro),
 * - API real → mensaje del servidor + código (+ campo).
 */
export function formatError(error) {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ApiError) {
    const code = error.code ? ` (${error.code})` : error.status ? ` (HTTP ${error.status})` : '';
    const field = error.field ? ` · campo: ${error.field}` : '';
    return `${error.message || 'Error del servidor'}${code}${field}`;
  }
  const message = error?.message ? String(error.message) : 'Error desconocido';
  return message;
}

function isMissingStatus(status) {
  return status === 404 || status === 405 || status === 501 || status === 502;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Un único intento HTTP. No reintenta nada por sí solo. */
export async function request(path, { method = 'GET', body, headers = {}, timeoutMs = 25000, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs));
  const onAbort = () => controller.abort(new Error('cancelled'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const init = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...headers }
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  init.signal = controller.signal;
  try {
    const response = await fetch(path, init);
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 200) }; }
    }
    if (response.status === 401 && unauthorizedHandler) unauthorizedHandler();
    if (!response.ok) {
      throw new ApiError(payload?.error || `Error HTTP ${response.status}`, {
        status: response.status,
        code: payload?.code || '',
        field: payload?.field || '',
        details: payload?.details ?? null,
        requestId: payload?.requestId || response.headers.get('x-request-id') || '',
        path,
        method
      });
    }
    return payload ?? {};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const reason = controller.signal.reason?.message || '';
    if (reason === 'timeout') {
      throw new NetworkError('El servidor tardó demasiado en responder. Vuelve a intentarlo.', {
        kind: 'timeout', method, path, cause: error
      });
    }
    if (reason === 'cancelled') {
      throw new NetworkError('La petición se canceló antes de terminar.', { kind: 'cancelled', method, path, cause: error });
    }
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new NetworkError(
      offline
        ? 'Sin conexión a la red. Revisa tu conexión e inténtalo de nuevo.'
        : 'Sin conexión con la app. El servidor no respondió; comprueba que siga encendido.',
      { kind: offline ? 'offline' : 'unreachable', method, path, cause: error }
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Reintento único para métodos idempotentes ante un fallo de red.
 * Un error de API (4xx/5xx con respuesta) NUNCA se reintenta.
 */
async function requestIdempotent(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!IDEMPOTENT_METHODS.has(method)) return request(path, options);
  try {
    return await request(path, options);
  } catch (error) {
    if (!(error instanceof NetworkError) || error.kind === 'cancelled') throw error;
    await sleep(RETRY_DELAY_MS);
    return request(path, options);
  }
}

/**
 * API pública usada por los módulos. Las firmas no cambian.
 * - get/head: reintento único ante fallo de red.
 * - put: idempotente por definición, reintento único.
 * - del: idempotente, reintento único; si el reintento responde 404 se
 *   interpreta como "ya estaba borrado" y se devuelve éxito.
 * - post/patch: sin reintento automático (evita duplicados).
 */
export const api = {
  get: (path, options = {}) => requestIdempotent(path, { ...options, method: 'GET' }),
  head: (path, options = {}) => requestIdempotent(path, { ...options, method: 'HEAD' }),
  post: (path, body, options = {}) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options = {}) => request(path, { ...options, method: 'PATCH', body }),
  put: (path, body, options = {}) => requestIdempotent(path, { ...options, method: 'PUT', body }),
  del: async (path, options = {}) => {
    const init = { ...options, method: 'DELETE' };
    try {
      return await request(path, init);
    } catch (error) {
      if (!(error instanceof NetworkError) || error.kind === 'cancelled') throw error;
      await sleep(RETRY_DELAY_MS);
      try {
        return await request(path, init);
      } catch (retryError) {
        /* El primer intento pudo llegar al servidor y perderse la respuesta:
           un 404 en el reintento significa que el recurso ya no está. */
        if (retryError instanceof ApiError && retryError.status === 404) {
          return { ok: true, deleted: true, alreadyDeleted: true, item: null };
        }
        throw retryError;
      }
    }
  },
  request
};

/**
 * Sondea un endpoint opcional y guarda su disponibilidad.
 * @returns {Promise<{ok:boolean,data?:any,missing?:boolean,error?:Error}>}
 */
export async function probeEndpoint(key, path, options = {}) {
  try {
    const data = await requestIdempotent(path, { timeoutMs: 9000, ...options });
    endpointState.set(key, { ok: true, missing: false, status: 200, checkedAt: Date.now() });
    return { ok: true, data };
  } catch (error) {
    const missing = error instanceof ApiError ? isMissingStatus(error.status) : false;
    endpointState.set(key, {
      ok: false,
      missing,
      status: error?.status || 0,
      error: error.message,
      checkedAt: Date.now()
    });
    return { ok: false, missing, error };
  }
}

export function rememberEndpoint(key, ok, extra = {}) {
  endpointState.set(key, { ok, missing: false, status: ok ? 200 : 0, checkedAt: Date.now(), ...extra });
}

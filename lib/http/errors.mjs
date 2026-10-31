/**
 * Errores HTTP tipados. Todo error de la API se serializa como:
 *   { error: string, code: string, field?: string|null, details?: any, requestId: string }
 */
import { redactString } from '../security/redact.mjs';

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{field?:string|null, details?:unknown, headers?:Record<string,string>, cause?:unknown}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(String(message || code));
    this.name = 'HttpError';
    this.status = Number(status) || 500;
    this.code = String(code || 'ERROR');
    this.field = extra.field ?? null;
    this.details = extra.details ?? null;
    this.headers = extra.headers || null;
    this.expose = this.status < 500;
    if (extra.cause) this.cause = extra.cause;
  }

  /** Mensaje seguro para el cliente. */
  get safeMessage() {
    return this.expose ? redactString(this.message) : 'Error interno del servidor';
  }
}

export class ValidationError extends HttpError {
  /**
   * @param {string} field
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(field, code, message, details = null) {
    super(400, code, message, { field, details });
    this.name = 'ValidationError';
  }
}

/** ¿Es un error HTTP controlado (con status 4xx/5xx y code)? */
export function isHttpError(err) {
  return !!err && typeof err === 'object' && typeof err.status === 'number' && typeof err.code === 'string' && err.status >= 400 && err.status < 600;
}

export const Errors = {
  /** @param {number} limit */
  payloadTooLarge(limit = 1_000_000) {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', `El cuerpo supera el máximo permitido (${limit} bytes).`, { headers: { connection: 'close' } });
  },
  invalidJson(message = 'JSON inválido o mal formado.') {
    return new HttpError(400, 'INVALID_JSON', message, { field: 'body' });
  },
  invalidBody(message = 'El cuerpo debe ser un objeto JSON.') {
    return new HttpError(400, 'INVALID_BODY', message, { field: 'body' });
  },
  unsupportedMediaType(message = 'Se esperaba Content-Type: application/json.') {
    return new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message, { field: 'content-type' });
  },
  /** @param {string} [message] @param {unknown} [details] */
  unauthorized(message = 'Sesión requerida.', details = null) {
    return new HttpError(401, 'UNAUTHENTICATED', message, { details, headers: { 'www-authenticate': 'Session realm="Agenda Copilot"' } });
  },
  /** @param {string} code @param {string} message @param {unknown} [details] */
  forbidden(code, message, details = null) {
    return new HttpError(403, code, message, { details });
  },
  /** @param {string} what */
  notFound(what = 'Recurso') {
    return new HttpError(404, 'NOT_FOUND', `${what} no encontrado.`);
  },
  methodNotAllowed(message = 'Método no permitido.') {
    return new HttpError(405, 'METHOD_NOT_ALLOWED', message);
  },
  /** @param {string} code @param {string} message @param {unknown} [details] */
  conflict(code, message, details = null) {
    return new HttpError(409, code, message, { details });
  },
  /** @param {number} retryAfterSec */
  tooManyRequests(retryAfterSec = 60) {
    return new HttpError(429, 'TOO_MANY_REQUESTS', 'Demasiados intentos. Inténtalo de nuevo más tarde.', {
      details: { retryAfterSec },
      headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) }
    });
  },
  storeReadOnly(message = 'Almacén en modo solo lectura: no se pueden guardar cambios.') {
    return new HttpError(503, 'STORE_READ_ONLY', message);
  },
  internal(message = 'Error interno del servidor.') {
    return new HttpError(500, 'INTERNAL', message);
  }
};

/**
 * Normaliza cualquier excepción a la forma pública de error HTTP.
 * @param {unknown} err
 * @param {string} requestId
 * @returns {{status:number, body:{error:string, code:string, field:string|null, details:unknown, requestId:string}, headers:Record<string,string>}}
 */
export function normalizeError(err, requestId) {
  if (isHttpError(err)) {
    return {
      status: err.status,
      body: {
        error: err.expose ? redactString(err.message) : 'Error interno del servidor',
        code: err.code,
        field: err.field ?? null,
        details: err.expose ? err.details ?? null : null,
        requestId
      },
      headers: err.headers || {}
    };
  }
  return {
    status: 500,
    body: { error: 'Error interno del servidor', code: 'INTERNAL', field: null, details: null, requestId },
    headers: {}
  };
}

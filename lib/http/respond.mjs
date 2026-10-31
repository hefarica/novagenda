/**
 * Respuestas HTTP y cabeceras de seguridad.
 */
import { redactObject } from '../security/redact.mjs';
import { normalizeError } from './errors.mjs';

export const CONTENT_TYPE = {
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8'
};

/** Cabeceras aplicadas a TODAS las respuestas (API y estáticos). */
export const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
  'x-dns-prefetch-control': 'off',
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'"
  ].join('; ')
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{https?:boolean, requestId?:string}} [options]
 */
export function applySecurityHeaders(res, options = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (options.requestId) res.setHeader('x-request-id', options.requestId);
  if (options.https) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

/**
 * Serializa un payload JSON redactando secretos.
 * @param {unknown} payload
 * @param {{redact?:boolean}} [options]
 */
export function serializeJSON(payload, options = {}) {
  const safe = options.redact === false ? payload : redactObject(payload);
  const text = JSON.stringify(safe === undefined ? null : safe);
  return text === undefined ? 'null' : text;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{status?:number, payload?:unknown, head?:boolean, requestId?:string, headers?:Record<string,string>, redact?:boolean}} [options]
 */
export function sendJson(res, options = {}) {
  const status = Number(options.status) || 200;
  const body = serializeJSON(options.payload, { redact: options.redact });
  res.statusCode = status;
  res.setHeader('content-type', CONTENT_TYPE.json);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-robots-tag', 'noindex');
  for (const [name, value] of Object.entries(options.headers || {})) res.setHeader(name, value);
  if (options.requestId) res.setHeader('x-request-id', options.requestId);
  res.setHeader('content-length', String(Buffer.byteLength(body)));
  if (options.head) {
    res.end();
  } else {
    res.end(body);
  }
  return status;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{status?:number, body?:string, contentType?:string, head?:boolean, requestId?:string, headers?:Record<string,string>}} [options]
 */
export function sendText(res, options = {}) {
  const status = Number(options.status) || 200;
  const body = String(options.body ?? '');
  res.statusCode = status;
  res.setHeader('content-type', options.contentType || CONTENT_TYPE.text);
  res.setHeader('cache-control', 'no-store');
  for (const [name, value] of Object.entries(options.headers || {})) res.setHeader(name, value);
  if (options.requestId) res.setHeader('x-request-id', options.requestId);
  res.setHeader('content-length', String(Buffer.byteLength(body)));
  if (options.head) res.end();
  else res.end(body);
  return status;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} location
 * @param {number} [status]
 */
export function sendRedirect(res, location, status = 302) {
  res.statusCode = status;
  res.setHeader('location', location);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', '0');
  res.end();
  return status;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string,string>} [headers]
 */
export function sendEmpty(res, status = 204, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('content-length', '0');
  res.end();
  return status;
}

/**
 * Envía un error normalizado. Si la respuesta ya empezó, solo cierra.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {{requestId?:string, head?:boolean}} [options]
 * @returns {number} status enviado
 */
export function sendError(res, error, options = {}) {
  const requestId = options.requestId || '';
  const normalized = normalizeError(error, requestId);
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return normalized.status;
  }
  return sendJson(res, {
    status: normalized.status,
    payload: normalized.body,
    headers: normalized.headers,
    requestId,
    head: options.head,
    redact: false
  });
}

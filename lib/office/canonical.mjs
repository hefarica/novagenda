/**
 * Utilidades criptográficas y de canonicalización de la Oficina.
 *
 * - `stableStringify` produce JSON determinista (claves ordenadas) para que los
 *   hashes y las firmas no dependan del orden de las propiedades.
 * - El secreto HMAC se toma de `OFFICE_HMAC_SECRET` o `APP_SECRET` (bóveda/entorno
 *   de t1). Si ninguno está definido se deriva de la clave maestra persistente,
 *   nunca se escribe en logs ni en las respuestas.
 */
import crypto from 'node:crypto';
import { deriveKey } from '../security/keys.mjs';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const GENESIS_HASH = '0'.repeat(64);

/**
 * JSON determinista: claves ordenadas y sin `undefined`.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * @param {unknown} value objeto o cadena
 * @returns {string} SHA-256 hex
 */
export function sha256Hex(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Secreto HMAC de la oficina (nunca se expone). */
export function officeSecret() {
  const fromEnv = String(process.env.OFFICE_HMAC_SECRET || process.env.APP_SECRET || '').trim();
  if (fromEnv.length >= 8) return fromEnv;
  try {
    return deriveKey('office-hmac-v1').toString('hex');
  } catch {
    // Último recurso: proceso sin DATA_DIR escribible. La firma sigue siendo
    // determinista durante la vida del proceso.
    return 'office-dev-secret-no-persist';
  }
}

/**
 * @param {unknown} payload
 * @returns {string} firma HMAC-SHA256 hex
 */
export function hmacHex(payload) {
  const text = typeof payload === 'string' ? payload : stableStringify(payload);
  return crypto.createHmac('sha256', officeSecret()).update(text, 'utf8').digest('hex');
}

/**
 * Comparación en tiempo constante.
 * @param {unknown} payload
 * @param {string|undefined|null} signature
 * @returns {boolean}
 */
export function hmacVerify(payload, signature) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(hmacHex(payload), 'hex');
  const provided = Buffer.from(signature, 'hex');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Comparación simple en tiempo constante para códigos/firmas ya hasheadas.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** @param {number} bytes */
export function randomNonce(bytes = 16) {
  return crypto.randomBytes(Math.max(8, Math.min(32, Math.round(bytes)))).toString('base64url');
}

/**
 * Código N3 de 6 caracteres sin ambigüedad (sin 0/O, 1/I/L).
 * @param {number} [length]
 */
export function randomCode(length = 6) {
  const size = Math.max(4, Math.min(10, Math.round(length)));
  let out = '';
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < size) {
    const byte = crypto.randomBytes(1)[0];
    if (byte >= max) continue;
    out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Hash del código N3 ligado al nonce de la aprobación (no se guarda en claro).
 * @param {string} code
 * @param {string} nonce
 */
export function hashCode(code, nonce) {
  return sha256Hex(`office-n3|${String(nonce || '')}|${String(code || '').trim().toUpperCase()}`);
}

/** Token compacto: payload firmado en base64url + firma. */
export function signedToken(payload, signature) {
  return `${Buffer.from(stableStringify(payload), 'utf8').toString('base64url')}.${signature}`;
}

/** @returns {string} ISO now */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Clona y recorta un objeto para almacenarlo/auditarlo sin datos gigantes.
 * @param {unknown} value
 * @param {{maxString?:number, maxArray?:number, depth?:number}} [options]
 */
export function sanitizeValue(value, options = {}) {
  const maxString = options.maxString ?? 500;
  const maxArray = options.maxArray ?? 40;
  const depthLimit = options.depth ?? 6;
  const walk = (input, depth) => {
    if (input === null || input === undefined) return null;
    const type = typeof input;
    if (type === 'string') return input.length > maxString ? `${input.slice(0, maxString)}…` : input;
    if (type === 'number' || type === 'boolean') return input;
    if (type === 'bigint') return input.toString();
    if (type !== 'object') return String(input);
    if (depth >= depthLimit) return '[…]';
    if (Array.isArray(input)) return input.slice(0, maxArray).map((item) => walk(item, depth + 1));
    if (input instanceof Date) return input.toISOString();
    const out = {};
    for (const [key, item] of Object.entries(input)) {
      if (item === undefined) continue;
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * Lectura de cuerpos con límite de tamaño y errores tipados.
 */
import { Errors, isHttpError } from './errors.mjs';

export const DEFAULT_BODY_LIMIT = 1_000_000;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?:number}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readRawBody(req, options = {}) {
  const limit = Number(options.limit) || DEFAULT_BODY_LIMIT;
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > limit) throw Errors.payloadTooLarge(limit);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      try { req.pause(); } catch { /* ignore */ }
      throw Errors.payloadTooLarge(limit);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?:number, requireJson?:boolean}} [options]
 * @returns {Promise<any>} objeto JSON ({} si el cuerpo está vacío)
 */
export async function readJsonBody(req, options = {}) {
  const raw = await readRawBody(req, options);
  if (!raw.length) return {};
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (options.requireJson !== false && contentType && !contentType.includes('json')) {
    throw Errors.unsupportedMediaType();
  }
  const text = raw.toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    if (isHttpError(err)) throw err;
    throw Errors.invalidJson(`JSON inválido: ${err.message}`);
  }
}

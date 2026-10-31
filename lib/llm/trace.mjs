/**
 * Trazas del subsistema LLM con redacción de PII.
 *
 * Objetivo: poder diagnosticar sin filtrar datos personales ni secretos.
 *   - `redactPii()` enmascara correos, teléfonos, tarjetas y URLs con tokens.
 *   - `traceLlm()` solo escribe metadatos (workflow, proveedor, latencia,
 *     tokens, longitud del prompt), nunca el prompt ni la respuesta completa.
 */
import { redactString } from '../security/redact.mjs';
import { log } from '../http/logger.mjs';

const EMAIL_RE = /[^\s@<>()\[\]]+@[^\s@<>()\[\]]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;
const CARD_RE = /\b(?:\d[ -]*?){13,16}\b/g;
const TOKEN_URL_RE = /([?&](?:token|key|secret|api_key|access_token|auth)=)[^&\s#]+/gi;

/**
 * Enmascara PII en una cadena.
 * @param {unknown} value
 * @returns {string}
 */
export function redactPii(value) {
  let out = redactString(typeof value === 'string' ? value : String(value ?? ''));
  out = out.replace(EMAIL_RE, '«email»');
  out = out.replace(TOKEN_URL_RE, '$1«token»');
  out = out.replace(CARD_RE, '«numero»');
  out = out.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 7 ? '«telefono»' : match;
  });
  return out;
}

/**
 * Registra una traza de llamada LLM (sin contenido sensible).
 * @param {{level?:'debug'|'info'|'warn'|'error', workflow?:string, provider?:string|null, model?:string|null, ok?:boolean, latencyMs?:number|null, tokens?:number|null, chars?:number|null, errorCode?:string|null, cached?:boolean, fallback?:boolean, detail?:string}} entry
 */
export function traceLlm(entry = {}) {
  const level = entry.level || (entry.ok === false ? 'warn' : 'debug');
  const parts = [
    `llm:${entry.workflow || 'chat'}`,
    entry.provider ? `provider=${entry.provider}` : 'provider=none',
    entry.model ? `model=${entry.model}` : null,
    entry.ok === undefined ? null : `ok=${entry.ok}`,
    entry.fallback ? 'fallback=true' : null,
    entry.cached ? 'cached=true' : null,
    Number.isFinite(entry.latencyMs) ? `ms=${entry.latencyMs}` : null,
    Number.isFinite(entry.tokens) ? `tokens=${entry.tokens}` : null,
    Number.isFinite(entry.chars) ? `chars=${entry.chars}` : null,
    entry.errorCode ? `code=${entry.errorCode}` : null,
    entry.detail ? redactPii(entry.detail).slice(0, 200) : null
  ].filter(Boolean);
  log(level, parts.join(' '));
}

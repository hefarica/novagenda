/**
 * Modelo de mensaje unificado para todos los canales.
 *
 * Todo lo que entra o sale de la agenda por un canal se normaliza a esta forma:
 *
 * {
 *   id:         'MSG-…'            // identificador local del mensaje
 *   channel:    'telegram'         // id del adaptador
 *   direction:  'inbound'|'outbound'
 *   userId:     '12345678'         // identidad del usuario en ese canal
 *   text:       'HOY'              // texto saneado (nunca secretos)
 *   timestamp:  '2026-10-27T…Z'
 *   dedupeKey:  'tg:update:123'    // clave idempotente del proveedor
 *   status:     'received'|'sent'|'failed'|'skipped'|'duplicate'
 *   replyTo:    null               // id del mensaje respondido (hilos)
 *   meta:       {…}                // datos no sensibles del canal
 *   error:      null
 * }
 *
 * `dedupeKey` es la pieza clave de la idempotencia: WhatsApp reenvía el mismo
 * `message.id`, Telegram puede repetir un `update_id` si el offset no se
 * persistió a tiempo y Gmail puede devolver el mismo `messageId` mientras no se
 * marque como leído. La clave es estable, corta y opaca a efectos de logs.
 */
import crypto from 'node:crypto';

export const MAX_TEXT = 4000;
export const MAX_META_KEYS = 12;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Sanea texto de canal: quita caracteres de control, normaliza saltos de línea
 * y recorta al máximo del asistente.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function sanitizeText(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  const text = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_RE, '')
    .trim();
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/**
 * Sanea metadatos: solo primitivos, claves cortas, sin objetos anidados
 * profundos. Evita que un payload externo gigante acabe en el store.
 * @param {unknown} meta
 * @returns {Record<string, unknown>|null}
 */
export function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (keys >= MAX_META_KEYS) break;
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) continue;
    if (value === undefined) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = sanitizeText(value, 300);
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 10)
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map((item) => (typeof item === 'string' ? sanitizeText(item, 120) : item));
    } else if (typeof value === 'object') {
      // Un nivel de anidamiento: suficiente para `reply` (hilo de correo) o
      // `whatsapp` (ventana/estado) sin abrir la puerta a payloads enormes.
      const nested = {};
      let nestedKeys = 0;
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedKeys >= 6) break;
        if (!/^[A-Za-z0-9_.-]{1,40}$/.test(nestedKey)) continue;
        if (nestedValue === undefined) continue;
        if (nestedValue === null || typeof nestedValue === 'boolean' || typeof nestedValue === 'number') {
          nested[nestedKey] = nestedValue;
        } else if (typeof nestedValue === 'string') {
          nested[nestedKey] = sanitizeText(nestedValue, 300);
        }
        nestedKeys += 1;
      }
      if (Object.keys(nested).length) out[key] = nested;
    }
    keys += 1;
  }
  return Object.keys(out).length ? out : null;
}

/** ¿El valor es un identificador de mensaje válido para dedupe? */
function isUsableKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Construye la clave idempotente a partir de una clave explícita del proveedor,
 * el par canal+usuario y el texto. Sin proveedor de clave se genera una clave
 * única (nunca deduplica mensajes legítimos repetidos).
 * @param {{channel:string, userId:string, dedupeKey?:string|null, text?:string, id?:string|null}} input
 * @returns {string}
 */
export function buildDedupeKey({ channel, userId, dedupeKey, text, id }) {
  if (isUsableKey(dedupeKey)) return `${channel}:${dedupeKey}`;
  if (isUsableKey(id)) return `${channel}:msg:${id}`;
  const digest = crypto
    .createHash('sha256')
    .update(`${channel}\u0000${userId}\u0000${text || ''}`)
    .digest('hex')
    .slice(0, 24);
  return `${channel}:hash:${digest}`;
}

/**
 * Clave idempotente única (simulador y mensajes sin id del proveedor).
 * @param {string} channel
 * @param {string} [prefix]
 */
export function uniqueDedupeKey(channel, prefix = 'local') {
  return `${channel}:${prefix}:${crypto.randomUUID()}`;
}

/**
 * Crea un mensaje normalizado.
 * @param {object} input
 * @returns {object}
 */
export function makeMessage(input) {
  const channel = String(input.channel || 'simulator');
  const direction = input.direction === 'outbound' ? 'outbound' : 'inbound';
  const userId = sanitizeText(input.userId ?? 'anon', 120) || 'anon';
  const timestamp = Number.isFinite(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : new Date().toISOString();
  const text = sanitizeText(input.text ?? '');
  const dedupeKey = isUsableKey(input.dedupeKey)
    ? input.dedupeKey
    : buildDedupeKey({ channel, userId, text, id: input.id });
  const id = isUsableKey(input.id) ? String(input.id) : `MSG-${crypto.randomUUID()}`;
  const status = ['received', 'sent', 'failed', 'skipped', 'duplicate'].includes(input.status) ? input.status : direction === 'inbound' ? 'received' : 'sent';
  const message = {
    id,
    channel,
    direction,
    userId,
    text,
    timestamp,
    dedupeKey,
    status,
    replyTo: isUsableKey(input.replyTo) ? String(input.replyTo) : null,
    meta: sanitizeMeta(input.meta) || {},
    error: input.error ? sanitizeText(input.error, 500) : null,
    errorCode: input.errorCode ? sanitizeText(input.errorCode, 60) : null
  };
  return message;
}

/**
 * Detecta opciones numeradas 1) / 1. en una respuesta del asistente para
 * ofrecerlas como botones inline en Telegram.
 * @param {unknown} text
 * @returns {string[]} ['1','2','3'] (vacío si no hay una elección real)
 */
export function extractNumberedOptions(text) {
  const found = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*([123])[).]\s+\S/.exec(line);
    if (match && !found.includes(match[1])) found.push(match[1]);
  }
  return found.length >= 2 ? found.sort() : [];
}

/** Texto visible (sin markdown) para títulos de botones de Telegram. */
export function optionButtonText(option, text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^\\s*${option}[).]\\s+`).test(candidate));
  const label = line ? line.replace(/^\s*[123][).]\s+/, '').trim() : '';
  return `Opción ${option}${label ? `: ${label.slice(0, 24)}` : ''}`;
}

/**
 * Extrae el primer texto útil de un payload arbitrario (webhook genérico).
 * @param {unknown} payload
 * @returns {string}
 */
export function extractPayloadText(payload) {
  if (typeof payload === 'string') return sanitizeText(payload);
  if (!payload || typeof payload !== 'object') return '';
  const direct = ['text', 'message', 'content', 'body', 'msg', 'input', 'query', 'reply'];
  for (const key of direct) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return sanitizeText(value);
    if (value && typeof value === 'object' && typeof value.text === 'string' && value.text.trim()) {
      return sanitizeText(value.text);
    }
  }
  for (const container of ['data', 'payload', 'event', 'message']) {
    const nested = payload[container];
    if (nested && typeof nested === 'object' && nested !== payload) {
      const text = extractPayloadText(nested);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Extrae la identidad del usuario de un payload arbitrario.
 * @param {unknown} payload
 * @param {string} [fallback]
 * @returns {string}
 */
export function extractPayloadUser(payload, fallback = 'webhook') {
  if (!payload || typeof payload !== 'object') return fallback;
  const keys = ['userId', 'user', 'sender', 'from', 'author', 'chatId', 'username', 'email'];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return sanitizeText(value, 120);
    if (value && typeof value === 'object') {
      for (const inner of ['id', 'username', 'email', 'name']) {
        if (typeof value[inner] === 'string' && value[inner].trim()) return sanitizeText(value[inner], 120);
        if (typeof value[inner] === 'number') return String(value[inner]);
      }
    }
  }
  return fallback;
}

/**
 * Extrae un identificador idempotente de un payload arbitrario.
 * @param {unknown} payload
 * @returns {string|null}
 */
export function extractPayloadId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const keys = ['id', 'messageId', 'message_id', 'eventId', 'event_id', 'update_id', 'updateId', 'uuid'];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() && value.length <= 200) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  for (const container of ['message', 'data', 'event']) {
    const nested = payload[container];
    if (nested && typeof nested === 'object' && nested !== payload) {
      const id = extractPayloadId(nested);
      if (id) return id;
    }
  }
  return null;
}

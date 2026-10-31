/**
 * Estado persistente de los canales.
 *
 * Todo vive dentro de `store.channelState`, que el store ya reserva como objeto
 * plano (no requiere migración de esquema):
 *
 *   channelState = {
 *     version: 1,
 *     messages: [ …últimos 300 mensajes normalizados, el más reciente primero ],
 *     dedupe:   { 'telegram:update:123': '2026-…' },        // idempotencia
 *     windows:  { 'whatsapp:57300…': '2026-…' },            // ventana 24 h
 *     channels: {
 *       telegram: { offset, mode, botUsername, lastPollAt, lastError, stats },
 *       whatsapp: { statuses:{}, lastError, stats },
 *       email:    { oauth:{box cifrada}, seen:{}, account, lastPollAt, lastError, stats },
 *       'webhook:mi-canal': { token:{box cifrada}, createdAt, lastInboundAt, stats }
 *     },
 *     config:   { telegram:{…}, whatsapp:{…}, email:{…}, 'webhook:mi-canal':{…} },
 *     audit:    [ { at, channel, action, outcome, detail } ]   // últimos 150
 *   }
 *
 * Reglas:
 *   - Nunca se guardan secretos en claro: los tokens/credenciales van cifrados
 *     con `encryptJSON` (AES-256-GCM derivado de la clave maestra) o dentro de
 *     la bóveda de secretos (`store.secrets`, también cifrada).
 *   - Los mensajes se recortan (300) para que el JSON no crezca sin control.
 *   - La deduplicación se poda a 7 días y como máximo 3 000 claves.
 */
import crypto from 'node:crypto';
import { store, encryptJSON, addActivity } from '../store.mjs';
import { redactString } from '../security/redact.mjs';
import { sanitizeText } from './message.mjs';

export const STATE_VERSION = 1;
export const MAX_MESSAGES = 300;
export const MAX_AUDIT = 150;
export const MAX_DEDUPE = 3_000;
export const DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CHANNEL_NAMES = ['simulator', 'telegram', 'whatsapp', 'email'];

/** Copia JSON-safe (evita referencias compartidas que la redacción marca como «[circular]»). */
export function plainClone(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Garantiza la forma del estado (idempotente) y devuelve la referencia viva.
 * @param {any} [data]
 */
export function ensureChannelState(data = store.get()) {
  if (!isPlainObject(data.channelState)) data.channelState = {};
  const state = data.channelState;
  if (state.version !== STATE_VERSION) state.version = STATE_VERSION;
  if (!Array.isArray(state.messages)) state.messages = [];
  if (!Array.isArray(state.audit)) state.audit = [];
  if (!isPlainObject(state.dedupe)) state.dedupe = {};
  if (!isPlainObject(state.windows)) state.windows = {};
  if (!isPlainObject(state.channels)) state.channels = {};
  if (!isPlainObject(state.config)) state.config = {};
  if (!isPlainObject(state.oauthStates)) state.oauthStates = {};
  for (const name of CHANNEL_NAMES) {
    if (!isPlainObject(state.channels[name])) state.channels[name] = {};
    if (!isPlainObject(state.config[name])) state.config[name] = {};
    const section = state.channels[name];
    if (!isPlainObject(section.stats)) section.stats = emptyStats();
  }
  return state;
}

function emptyStats() {
  return { received: 0, sent: 0, errors: 0, duplicates: 0, ignored: 0 };
}

/** Acceso de lectura al estado (nunca muta si el store no ha cargado). */
export function channelStateView() {
  return ensureChannelState(store.get());
}

/**
 * Sección de un canal concreto (`telegram`, `whatsapp`, `email`, `webhook:<id>`).
 * @param {string} channel
 */
export function getChannelSection(channel) {
  const state = channelStateView();
  if (!isPlainObject(state.channels[channel])) state.channels[channel] = {};
  const section = state.channels[channel];
  if (!isPlainObject(section.stats)) section.stats = emptyStats();
  return section;
}

/**
 * Configuración no secreta de un canal.
 * @param {string} channel
 * @returns {Record<string, any>}
 */
export function getChannelConfig(channel) {
  const state = channelStateView();
  if (!isPlainObject(state.config[channel])) state.config[channel] = {};
  return state.config[channel];
}

/**
 * Aplica una mutación al estado de canales y persiste (atómico + journal).
 * @param {(state:any, data:any)=>any} mutator
 * @param {string} [label]
 */
export async function updateChannelState(mutator, label = 'canal') {
  return store.mutate((data) => {
    const state = ensureChannelState(data);
    return mutator(state, data);
  }, { label });
}

function pruneDedupe(state) {
  const now = Date.now();
  const entries = Object.entries(state.dedupe);
  if (entries.length <= MAX_DEDUPE) {
    // Poda perezosa: sin llegar al tope, solo se limpian claves caducadas si hay
    // más de 500 (evita recorrer el objeto en cada mensaje).
    if (entries.length < 500) return;
  }
  const fresh = {};
  for (const [key, at] of entries) {
    const timestamp = Date.parse(at);
    if (Number.isFinite(timestamp) && now - timestamp <= DEDUPE_TTL_MS) fresh[key] = at;
  }
  // Si sigue por encima del tope, conserva las más recientes.
  const keys = Object.keys(fresh);
  if (keys.length > MAX_DEDUPE) {
    keys.sort((a, b) => Date.parse(fresh[b]) - Date.parse(fresh[a]));
    for (const key of keys.slice(MAX_DEDUPE)) delete fresh[key];
  }
  state.dedupe = fresh;
}

function pruneMessages(state) {
  if (state.messages.length > MAX_MESSAGES) state.messages.length = MAX_MESSAGES;
}

function pruneAudit(state) {
  if (state.audit.length > MAX_AUDIT) state.audit.length = MAX_AUDIT;
}

function bumpStat(section, key, delta = 1) {
  if (!isPlainObject(section.stats)) section.stats = emptyStats();
  section.stats[key] = Math.max(0, Number(section.stats[key] || 0) + delta);
}

/**
 * Registra un mensaje en la bandeja y en el contador del canal.
 * @param {object} message mensaje normalizado
 * @param {{kind?:'inbound'|'outbound'|'duplicate'|'ignored'}} [options]
 */
function pushMessage(state, message, options = {}) {
  state.messages.unshift(message);
  pruneMessages(state);
  const section = state.channels[message.channel] || (state.channels[message.channel] = {});
  if (!isPlainObject(section.stats)) section.stats = emptyStats();
  const kind = options.kind || message.direction;
  if (kind === 'inbound') {
    section.lastInboundAt = message.timestamp;
    bumpStat(section, 'received');
  } else if (kind === 'outbound') {
    section.lastOutboundAt = message.timestamp;
    bumpStat(section, 'sent');
  } else if (kind === 'duplicate') {
    bumpStat(section, 'duplicates');
    section.lastDuplicateAt = message.timestamp;
  } else if (kind === 'ignored') {
    bumpStat(section, 'ignored');
    section.lastIgnoredAt = message.timestamp;
  }
  return message;
}

/**
 * Reserva de idempotencia + registro del mensaje entrante en una sola escritura.
 *
 * Devuelve `{duplicate:true, duplicateOf}` si la clave ya se procesó en los
 * últimos 7 días; en ese caso NO se llama al asistente (no se duplica la cita).
 *
 * @param {object} message mensaje normalizado (direction inbound)
 * @returns {Promise<{duplicate:boolean, message:object, duplicateOf:string|null}>}
 */
export async function claimInbound(message) {
  return updateChannelState((state) => {
    pruneDedupe(state);
    const previous = state.dedupe[message.dedupeKey];
    if (previous && Date.now() - Date.parse(previous) <= DEDUPE_TTL_MS) {
      const duplicateMessage = {
        ...message,
        id: `MSG-DUP-${crypto.randomUUID()}`,
        status: 'duplicate',
        meta: { ...message.meta, duplicateOf: message.dedupeKey, firstSeenAt: previous },
        error: null
      };
      pushMessage(state, duplicateMessage, { kind: 'duplicate' });
      return { duplicate: true, message: duplicateMessage, duplicateOf: previous };
    }
    // Se guarda el instante de la reserva (no la hora del proveedor): así la
    // ventana de 7 días no se acorta si el mensaje llegó con retraso.
    state.dedupe[message.dedupeKey] = new Date().toISOString();
    // Ventana de conversación (WhatsApp 24 h): se refresca con cada entrante.
    state.windows[`${message.channel}:${message.userId}`] = message.timestamp;
    pushMessage(state, message, { kind: 'inbound' });
    return { duplicate: false, message, duplicateOf: null };
  }, `canal-entrante:${message.channel}`);
}

/**
 * Registra la respuesta saliente de un canal.
 * @param {object} message mensaje normalizado (direction outbound)
 */
export async function recordOutbound(message) {
  return updateChannelState((state) => {
    pushMessage(state, message, { kind: message.status === 'failed' ? 'outbound' : 'outbound' });
    const section = state.channels[message.channel];
    if (message.status === 'failed') {
      bumpStat(section, 'errors');
      section.lastError = {
        at: message.timestamp,
        code: message.errorCode || 'CHANNEL_ERROR',
        message: sanitizeText(message.error || 'Error de envío', 300),
        source: 'outbound'
      };
    }
    return message;
  }, `canal-saliente:${message.channel}`);
}

/**
 * Marca un mensaje entrante como ignorado (p. ej. remitente no autorizado) sin
 * llamar al asistente.
 * @param {object} message
 * @param {string} reason
 */
export async function recordIgnored(message, reason) {
  return updateChannelState((state) => {
    const ignored = { ...message, status: 'skipped', error: null, meta: { ...message.meta, ignoredReason: sanitizeText(reason, 120) } };
    pushMessage(state, ignored, { kind: 'ignored' });
    return ignored;
  }, `canal-ignorado:${message.channel}`);
}

/**
 * ¿Sigue abierta la ventana de conversación de 24 h para este usuario?
 * @param {string} channel
 * @param {string} userId
 * @param {number} [hours]
 */
export function conversationWindowOpen(channel, userId, hours = 24) {
  const state = channelStateView();
  const at = Date.parse(state.windows[`${channel}:${userId}`] || '');
  if (!Number.isFinite(at)) return false;
  return Date.now() - at <= Math.max(1, hours) * 60 * 60 * 1000;
}

/**
 * Número de ventanas de conversación abiertas para un canal (sin exponer ids).
 * @param {string} channel
 * @param {number} [hours]
 */
export function countOpenWindows(channel, hours = 24) {
  const state = channelStateView();
  const now = Date.now();
  let count = 0;
  for (const [key, value] of Object.entries(state.windows || {})) {
    if (!key.startsWith(`${channel}:`)) continue;
    const at = Date.parse(value);
    if (Number.isFinite(at) && now - at <= Math.max(1, hours) * 60 * 60 * 1000) count += 1;
  }
  return count;
}

/**
 * Estado de entrega de WhatsApp (delivered/read/failed) por id de mensaje.
 * @param {string} channel
 * @param {string} messageId
 * @param {object} detail
 */
export async function recordDeliveryStatus(channel, messageId, detail) {
  if (!messageId) return null;
  return updateChannelState((state) => {
    const section = state.channels[channel] || (state.channels[channel] = {});
    if (!isPlainObject(section.statuses)) section.statuses = {};
    const entry = {
      status: sanitizeText(detail.status || 'unknown', 20),
      at: new Date().toISOString(),
      recipient: detail.recipient ? redactString(String(detail.recipient)) : null,
      error: detail.error ? sanitizeText(detail.error, 300) : null
    };
    section.statuses[messageId] = entry;
    const keys = Object.keys(section.statuses);
    if (keys.length > 200) {
      keys.sort((a, b) => Date.parse(section.statuses[a].at) - Date.parse(section.statuses[b].at));
      for (const key of keys.slice(0, keys.length - 200)) delete section.statuses[key];
    }
    if (entry.status === 'failed') {
      section.lastError = { at: entry.at, code: 'WA_DELIVERY_FAILED', message: entry.error || 'Fallo de entrega', source: 'status' };
    }
    return entry;
  }, `canal-estado:${channel}`);
}

/**
 * Guarda `lastError` visible en la UI (sin secretos).
 * @param {string} channel
 * @param {unknown} error
 * @param {{source?:string, code?:string}} [options]
 */
export async function setChannelError(channel, error, options = {}) {
  const message = sanitizeText(redactString(String(error?.message || error || 'error desconocido')), 300);
  const code = sanitizeText(options.code || error?.code || 'CHANNEL_ERROR', 60);
  try {
    await updateChannelState((state) => {
      const section = state.channels[channel] || (state.channels[channel] = {});
      section.lastError = { at: new Date().toISOString(), code, message, source: options.source || 'runtime' };
      if (!isPlainObject(section.stats)) section.stats = emptyStats();
      bumpStat(section, 'errors');
    }, `canal-error:${channel}`);
  } catch {
    /* store en solo lectura: no se puede persistir, el error ya se registró en log */
  }
}

/**
 * Limpia el último error de un canal (tras una prueba correcta).
 * @param {string} channel
 */
export async function clearChannelError(channel) {
  try {
    await updateChannelState((state) => {
      const section = state.channels[channel];
      if (section) delete section.lastError;
    }, `canal-error-limpio:${channel}`);
  } catch { /* ignore */ }
}

/**
 * Auditoría de canales: acciones humanas y de sistema relevantes.
 * @param {{channel:string, action:string, outcome?:string, detail?:string}} entry
 * @param {{activity?:boolean}} [options]
 */
export async function recordAudit(entry, options = {}) {
  const safe = {
    at: new Date().toISOString(),
    channel: sanitizeText(entry.channel || 'sistema', 40),
    action: sanitizeText(entry.action || 'acción', 60),
    outcome: sanitizeText(entry.outcome || 'ok', 20),
    detail: sanitizeText(redactString(entry.detail || ''), 300)
  };
  try {
    await updateChannelState((state) => {
      state.audit.unshift(safe);
      pruneAudit(state);
      if (options.activity) {
        addActivity('channel', `Canal ${safe.channel}: ${safe.action}${safe.detail ? ` — ${safe.detail}` : ''}`);
      }
      return safe;
    }, `canal-auditoria:${safe.channel}`);
  } catch { /* solo lectura */ }
  return safe;
}

/**
 * Cambia la configuración no secreta de un canal (merge superficial).
 * @param {string} channel
 * @param {Record<string, unknown>} patch
 */
export async function patchChannelConfig(channel, patch) {
  return updateChannelState((state) => {
    if (!isPlainObject(state.config[channel])) state.config[channel] = {};
    Object.assign(state.config[channel], patch);
    return state.config[channel];
  }, `canal-config:${channel}`);
}

/**
 * Guarda un token de canal cifrado con la clave maestra.
 * @param {string} channel
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{hint:string, updatedAt:string}>}
 */
export async function saveEncryptedToken(channel, payload) {
  const box = encryptJSON(payload);
  const updatedAt = new Date().toISOString();
  const hint = payload && typeof payload === 'object' && typeof payload.refresh_token === 'string'
    ? `••••${String(payload.refresh_token).slice(-4)}`
    : '••••';
  await updateChannelState((state) => {
    const section = state.channels[channel] || (state.channels[channel] = {});
    section.token = { ...box, updatedAt, hint };
  }, `canal-token:${channel}`);
  return { hint, updatedAt };
}

/**
 * Estado del token cifrado guardado para un canal (nunca el valor).
 * @param {string} channel
 */
export function encryptedTokenMeta(channel) {
  const section = channelStateView().channels[channel];
  const box = section && section.token;
  if (!box || typeof box !== 'object' || !box.data) return null;
  return { hint: box.hint || '••••', updatedAt: box.updatedAt || null };
}

/**
 * Bandeja local normalizada.
 * @param {{limit?:number, channel?:string|null, direction?:string|null}} [options]
 */
export function inboxMessages(options = {}) {
  const state = channelStateView();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const channel = options.channel ? String(options.channel) : null;
  const direction = options.direction === 'inbound' || options.direction === 'outbound' ? options.direction : null;
  const filtered = state.messages.filter((message) => {
    if (channel && message.channel !== channel) return false;
    if (direction && message.direction !== direction) return false;
    return true;
  });
  return {
    items: filtered.slice(0, limit),
    count: Math.min(filtered.length, limit),
    total: filtered.length,
    stored: state.messages.length
  };
}

/**
 * Configuración pública de un canal: solo claves y valores no secretos.
 * @param {string} channel
 */
export function publicChannelConfig(channel) {
  const config = getChannelConfig(channel);
  return JSON.parse(JSON.stringify(config));
}

/**
 * Estado de los flujos OAuth (correo) para validar el callback.
 * @param {string} stateValue
 * @param {Record<string, unknown>} payload
 */
export async function saveOAuthState(stateValue, payload) {
  return updateChannelState((state) => {
    state.oauthStates[stateValue] = { ...payload, createdAt: Date.now() };
    const keys = Object.keys(state.oauthStates);
    if (keys.length > 20) {
      keys.sort((a, b) => (state.oauthStates[a].createdAt || 0) - (state.oauthStates[b].createdAt || 0));
      for (const key of keys.slice(0, keys.length - 20)) delete state.oauthStates[key];
    }
  }, 'canal-oauth-state');
}

/**
 * Consume (una sola vez) un state de OAuth y devuelve su payload.
 * @param {string} stateValue
 * @param {number} [maxAgeMs]
 */
export function consumeOAuthState(stateValue, maxAgeMs = 10 * 60 * 1000) {
  const state = channelStateView();
  const entry = state.oauthStates[stateValue];
  if (!entry) return null;
  if (Date.now() - Number(entry.createdAt || 0) > maxAgeMs) return null;
  return entry;
}

/**
 * Elimina un state de OAuth usado (persistente).
 * @param {string} stateValue
 */
export async function deleteOAuthState(stateValue) {
  try {
    await updateChannelState((state) => { delete state.oauthStates[stateValue]; }, 'canal-oauth-state-borrado');
  } catch { /* ignore */ }
}

/**
 * Marca un mensaje de Gmail como ya procesado (idempotencia persistente).
 * @param {string} messageId
 * @param {string} [timestamp]
 */
export async function markEmailSeen(messageId, timestamp = new Date().toISOString()) {
  return updateChannelState((state) => {
    const section = state.channels.email || (state.channels.email = {});
    if (!isPlainObject(section.seen)) section.seen = {};
    section.seen[messageId] = timestamp;
    const keys = Object.keys(section.seen);
    if (keys.length > 1_000) {
      keys.sort((a, b) => Date.parse(section.seen[a]) - Date.parse(section.seen[b]));
      for (const key of keys.slice(0, keys.length - 1_000)) delete section.seen[key];
    }
  }, 'canal-email-visto');
}

/**
 * ¿Se procesó ya este mensaje de Gmail?
 * @param {string} messageId
 */
export function emailSeen(messageId) {
  const section = channelStateView().channels.email;
  return !!(section && isPlainObject(section.seen) && section.seen[messageId]);
}

/** Estado de Telegram (offset persistido, modo, bot) para el adaptador. */
export function telegramState() {
  const section = getChannelSection('telegram');
  if (!Number.isFinite(Number(section.offset))) section.offset = 0;
  return section;
}

/** Persiste el offset y el modo de Telegram sin tocar el resto. */
export async function saveTelegramState(patch) {
  return updateChannelState((state) => {
    const section = state.channels.telegram || (state.channels.telegram = {});
    Object.assign(section, patch);
    return section;
  }, 'canal-telegram-estado');
}

/** Estado de WhatsApp (ventana, estados de entrega, error). */
export function whatsappState() {
  return getChannelSection('whatsapp');
}

/** Estado de correo (token cifrado, cuenta, polling). */
export function emailState() {
  return getChannelSection('email');
}

/**
 * Memoria de conversación del agente.
 *
 * Persistida en `store.llm.conversations` y aislada por canal + usuario
 * (`web:owner`, `whatsapp:57300…`, `telegram:123456`). Guarda:
 *   - los últimos N mensajes (12 por defecto, configurable en `memory.maxMessages`),
 *   - la acción pendiente de confirmación o de elección de alternativa,
 *   - el último intento interpretado (para depurar y para la UI).
 *
 * Limpieza: máximo `memory.maxConversations` conversaciones (se descartan las
 * más antiguas) y caducidad de pendientes (`memory.pendingTtlSec`).
 */
import crypto from 'node:crypto';
import { store } from '../store.mjs';
import { isPlainObject } from '../validate.mjs';
import { cleanText } from './context.mjs';

const DEFAULTS = { maxMessages: 12, maxConversations: 50, pendingTtlSec: 600 };

function memoryConfig() {
  const raw = isPlainObject(store.get().llm?.memory) ? store.get().llm.memory : {};
  return {
    maxMessages: Number.isFinite(Number(raw.maxMessages)) ? Math.max(4, Math.min(50, Math.round(Number(raw.maxMessages)))) : DEFAULTS.maxMessages,
    maxConversations: Number.isFinite(Number(raw.maxConversations)) ? Math.max(1, Math.min(500, Math.round(Number(raw.maxConversations)))) : DEFAULTS.maxConversations,
    pendingTtlSec: Number.isFinite(Number(raw.pendingTtlSec)) ? Math.max(30, Math.min(7200, Math.round(Number(raw.pendingTtlSec)))) : DEFAULTS.pendingTtlSec
  };
}

/** Clave estable y segura para el store: `canal:usuario`. */
export function conversationKey(channel = 'web', userId = 'local') {
  const cleanChannel = String(channel || 'web').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'web';
  const cleanUser = String(userId || 'local').toLowerCase().replace(/[^a-z0-9@._:-]/g, '').slice(0, 80) || 'local';
  return `${cleanChannel}:${cleanUser}`;
}

function emptyConversation(key) {
  const [channel, ...rest] = key.split(':');
  return {
    key,
    channel,
    userId: rest.join(':') || 'local',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    pending: null,
    lastIntent: null
  };
}

function conversationsStore(data, { create = false } = {}) {
  if (!isPlainObject(data.llm)) {
    if (!create) return null;
    data.llm = {};
  }
  if (!isPlainObject(data.llm.conversations)) {
    if (!create) return null;
    data.llm.conversations = {};
  }
  return data.llm.conversations;
}

/** Lee (sin crear) una conversación. */
export function readConversation(key) {
  const all = conversationsStore(store.get());
  const row = all ? all[key] : null;
  if (!isPlainObject(row)) return emptyConversation(key);
  return {
    ...emptyConversation(key),
    ...row,
    messages: Array.isArray(row.messages) ? row.messages.slice(-memoryConfig().maxMessages) : [],
    pending: isPlainObject(row.pending) ? row.pending : null
  };
}

/** Historial visible para la UI. */
export function getHistory(key, { limit } = {}) {
  const conversation = readConversation(key);
  const max = Math.max(1, Math.min(50, Math.round(Number(limit) || conversation.messages.length || 12)));
  return conversation.messages.slice(-max);
}

/** Pendiente vigente (o null si caducó). */
export function getPending(key) {
  const conversation = readConversation(key);
  const pending = conversation.pending;
  if (!pending) return null;
  const { pendingTtlSec } = memoryConfig();
  const created = Date.parse(pending.createdAt || '');
  if (Number.isFinite(created) && Date.now() - created > pendingTtlSec * 1000) return null;
  return pending;
}

/**
 * Guarda la conversación (mensajes + pendiente + último intento) y poda.
 * @param {string} key
 * @param {{messages?:Array, pending?:object|null, lastIntent?:object|null}} patch
 */
export async function saveConversation(key, patch = {}) {
  const { maxMessages, maxConversations } = memoryConfig();
  let saved = null;
  try {
    await store.mutate((data) => {
      const all = conversationsStore(data, { create: true });
      const current = isPlainObject(all[key]) ? all[key] : emptyConversation(key);
      const messages = Array.isArray(patch.messages)
        ? patch.messages
          .filter((message) => message && typeof message.content === 'string' && message.content)
          .slice(-maxMessages)
          .map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: cleanText(message.content).slice(0, 4000),
            at: message.at || new Date().toISOString(),
            source: message.source === 'llm' ? 'llm' : message.source === 'system' ? 'system' : 'deterministic'
          }))
        : (current.messages || []).slice(-maxMessages);
      all[key] = {
        ...emptyConversation(key),
        ...current,
        key,
        messages,
        pending: patch.pending === undefined ? (isPlainObject(current.pending) ? current.pending : null) : (isPlainObject(patch.pending) ? patch.pending : null),
        lastIntent: patch.lastIntent === undefined ? (current.lastIntent || null) : (isPlainObject(patch.lastIntent) ? patch.lastIntent : null),
        updatedAt: new Date().toISOString()
      };
      // Poda por antigüedad.
      const entries = Object.entries(all).sort((a, b) => String(a[1]?.updatedAt || '').localeCompare(String(b[1]?.updatedAt || '')));
      while (entries.length > maxConversations) {
        const oldest = entries.shift();
        if (oldest) delete all[oldest[0]];
      }
      saved = all[key];
    }, { label: 'agent-memory' });
  } catch {
    // Store en solo lectura: la conversación se mantiene en memoria del request.
    return { ok: false, conversation: readConversation(key) };
  }
  return { ok: true, conversation: saved || readConversation(key) };
}

/** Añade un mensaje y persiste. */
export async function appendMessage(key, message) {
  const conversation = readConversation(key);
  const messages = [...conversation.messages, message];
  return saveConversation(key, { messages, pending: conversation.pending, lastIntent: conversation.lastIntent });
}

/** Guarda/limpia el pendiente. */
export async function setPending(key, pending) {
  const conversation = readConversation(key);
  return saveConversation(key, { messages: conversation.messages, pending, lastIntent: conversation.lastIntent });
}

export async function clearPending(key) {
  return setPending(key, null);
}

/** Borra una conversación. */
export async function clearConversation(key) {
  try {
    await store.mutate((data) => {
      const all = conversationsStore(data);
      if (all && all[key]) delete all[key];
    }, { label: 'agent-memory-clear' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Lista de conversaciones (resumen para la UI). */
export function listConversations({ limit = 20, channel = null } = {}) {
  const all = conversationsStore(store.get()) || {};
  const max = Math.max(1, Math.min(100, Math.round(Number(limit) || 20)));
  return Object.values(all)
    .filter((row) => isPlainObject(row) && (!channel || row.channel === channel))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, max)
    .map((row) => {
      const messages = Array.isArray(row.messages) ? row.messages : [];
      const last = messages[messages.length - 1] || null;
      return {
        key: row.key,
        channel: row.channel,
        userId: row.userId,
        updatedAt: row.updatedAt || null,
        messageCount: messages.length,
        lastMessage: last ? { role: last.role, content: String(last.content).slice(0, 160), at: last.at } : null,
        pending: isPlainObject(row.pending)
          ? { type: row.pending.type, action: row.pending.action, summary: row.pending.summary, createdAt: row.pending.createdAt }
          : null
      };
    });
}

/** Genera un token de confirmación. */
export function newConfirmToken() {
  return crypto.randomBytes(9).toString('base64url');
}

/** Filtra el historial para enviarlo al LLM (roles y tamaño). */
export function historyForPrompt(key, { limit = 8, maxChars = 400 } = {}) {
  return getHistory(key, { limit }).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content).slice(0, maxChars)
  }));
}

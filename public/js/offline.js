/**
 * Cola offline de capturas.
 * Sin red, la captura se guarda en localStorage y se sincroniza al volver.
 */
import { api } from './api.js';
import { emit } from './state.js';

const STORAGE_KEY = 'agenda-p95.queue.v1';
const listeners = new Set();

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.text) : [];
  } catch {
    return [];
  }
}

function writeStore(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* almacenamiento lleno o modo privado: la cola vive solo en memoria */
  }
  emit('queue', items.length);
  for (const listener of listeners) {
    try { listener(items.length); } catch { /* ignorado */ }
  }
}

let queue = readStore();

export function getQueue() {
  return [...queue];
}

export function queueCount() {
  return queue.length;
}

export function subscribeQueue(listener) {
  listeners.add(listener);
  listener(queue.length);
  return () => listeners.delete(listener);
}

export function enqueueCapture(text, { source = 'App (sin conexión)', at = new Date().toISOString() } = {}) {
  const item = {
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text: String(text || '').trim().slice(0, 2000),
    source,
    at
  };
  if (!item.text) return null;
  queue = [...queue, item];
  writeStore(queue);
  return item;
}

export function removeFromQueue(id) {
  queue = queue.filter((item) => item.id !== id);
  writeStore(queue);
}

export function clearQueue() {
  queue = [];
  writeStore(queue);
}

/**
 * Intenta enviar todas las capturas pendientes.
 * @returns {Promise<{sent:number, failed:number}>}
 */
export async function flushQueue() {
  if (!queue.length) return { sent: 0, failed: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { sent: 0, failed: queue.length };
  let sent = 0;
  let failed = 0;
  for (const item of [...queue]) {
    try {
      await api.post('/api/inbox', { input: item.text, source: item.source || 'App' });
      removeFromQueue(item.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      /* Sin conexión: se conserva todo para el próximo intento. */
      if (error?.name === 'NetworkError') break;
      /* Error de validación (por ejemplo, captura demasiado larga): no bloquea la cola. */
      if (error?.code === 'TOO_LONG' || error?.code === 'REQUIRED' || error?.status === 400) removeFromQueue(item.id);
    }
  }
  emit('queue', queue.length);
  return { sent, failed };
}

/**
 * Envía una captura y, si no hay red, la guarda en la cola.
 * @returns {Promise<{queued:boolean,item?:object}>}
 */
export async function captureOrQueue(text, { source = 'App' } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Escribe algo para capturar.');
  try {
    const result = await api.post('/api/inbox', { input: clean, source });
    return { queued: false, item: result?.item || null };
  } catch (error) {
    if (error?.name === 'NetworkError') {
      const item = enqueueCapture(clean, { source: `${source} (sin conexión)` });
      return { queued: true, item };
    }
    throw error;
  }
}

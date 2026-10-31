/**
 * Loop guard: evita que un canal repita el mismo mensaje hasta convertirse en
 * un bot. Trabaja en tres modos (feature `loop_guard`):
 *
 *   off    → solo observa y cuenta.
 *   shadow → detecta y cuenta "habría bloqueado", pero no bloquea.
 *   on     → bloquea el envío duplicado.
 *
 * La ventana y los umbrales son deliberadamente conservadores: 3 mensajes
 * idénticos al mismo destino en 10 minutos, o 20 mensajes al mismo destino en
 * 10 minutos.
 */
import { createHash } from 'node:crypto';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_IDENTICAL = 3;
const MAX_PER_TARGET = 20;
const MAX_ENTRIES_PER_TARGET = 60;

const history = new Map();
const stats = {
  attempts: 0,
  recorded: 0,
  blocked: 0,
  wouldBlock: 0,
  lastReason: null,
  lastAt: null
};

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function subjectBase(subject) {
  return normalize(subject).replace(/^((re|fw|fwd|rv)\s*:\s*)+/i, '');
}

function targetOf(input) {
  return normalize(input.to || input.target || input.userId || '-');
}

function keyOf(channel, target) {
  return `${normalize(channel) || 'generic'}|${target}`;
}

function hashOf({ channel, target, subject, text }) {
  const raw = `${normalize(channel)}|${target}|${subjectBase(subject)}|${normalize(text)}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function prune(entries, now) {
  return entries.filter((entry) => now - entry.at < WINDOW_MS);
}

/**
 * Decide si un envío parece un bucle. No registra nada.
 * @param {{channel:string,to?:string,subject?:string,text:string,mode?:'off'|'shadow'|'on',now?:number}} input
 */
export function evaluateOutbound(input = {}) {
  const channel = String(input.channel || 'generic');
  const target = targetOf(input);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const mode = input.mode === 'on' || input.mode === 'shadow' ? input.mode : 'off';
  const key = keyOf(channel, target);
  const entries = prune(history.get(key) || [], now);
  const hash = hashOf({ channel, target, subject: input.subject, text: input.text });
  const identical = entries.filter((entry) => entry.hash === hash).length;
  let reason = null;
  if (identical >= MAX_IDENTICAL - 1) {
    reason = { code: 'DUPLICATE', identical, limit: MAX_IDENTICAL, windowMin: WINDOW_MS / 60_000 };
  } else if (entries.length >= MAX_PER_TARGET) {
    reason = { code: 'RATE', count: entries.length, limit: MAX_PER_TARGET, windowMin: WINDOW_MS / 60_000 };
  }
  const detected = reason !== null;
  return {
    channel,
    target,
    key,
    hash,
    detected,
    blocked: detected && mode === 'on',
    wouldBlock: detected && mode === 'shadow',
    mode,
    reason
  };
}

/** Registra un envío exitoso (no los fallidos ni los omitidos). */
export function recordOutbound(input = {}) {
  const channel = String(input.channel || 'generic');
  const target = targetOf(input);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const key = keyOf(channel, target);
  const entries = prune(history.get(key) || [], now);
  entries.push({ at: now, hash: hashOf({ channel, target, subject: input.subject, text: input.text }) });
  while (entries.length > MAX_ENTRIES_PER_TARGET) entries.shift();
  history.set(key, entries);
  stats.recorded += 1;
  stats.lastAt = new Date(now).toISOString();
}

/** Cuenta la decisión para diagnóstico; se llama en cada envío. */
export function noteDecision(decision) {
  stats.attempts += 1;
  if (decision?.blocked) {
    stats.blocked += 1;
    stats.lastReason = decision.reason?.code || 'DUPLICATE';
    stats.lastAt = new Date().toISOString();
  } else if (decision?.wouldBlock) {
    stats.wouldBlock += 1;
    stats.lastReason = decision.reason?.code || 'DUPLICATE';
    stats.lastAt = new Date().toISOString();
  }
}

export function loopGuardError(decision) {
  const detail = decision?.reason?.code === 'RATE'
    ? `demasiados mensajes al mismo destino (${decision.reason.count}/${decision.reason.limit} en ${decision.reason.windowMin} min)`
    : `mensaje idéntico repetido (${decision?.reason?.identical || MAX_IDENTICAL}/${MAX_IDENTICAL} en ${decision?.reason?.windowMin || 10} min)`;
  const error = new Error(`Loop guard: ${detail}. No se envió para evitar un bucle.`);
  error.code = 'LOOP_GUARD';
  error.status = 429;
  error.details = decision?.reason || null;
  return error;
}

/**
 * Envuelve un adaptador y protege `send`. No toca adaptadores simulados.
 * @param {object} adapter
 * @param {{getMode?:()=>string}} [options]
 */
export function guardAdapter(adapter, options = {}) {
  if (!adapter || typeof adapter.send !== 'function') return adapter;
  if (adapter.id === 'simulator') return adapter;
  const original = adapter.send.bind(adapter);
  const getMode = typeof options.getMode === 'function' ? options.getMode : () => 'off';
  adapter.send = async (input = {}) => {
    const mode = getMode();
    const decision = evaluateOutbound({
      channel: adapter.id,
      to: input.to,
      subject: input.subject || input.meta?.subject,
      text: input.text,
      mode
    });
    noteDecision(decision);
    if (decision.blocked) throw loopGuardError(decision);
    const result = await original(input);
    if (result?.skipped !== true) {
      recordOutbound({
        channel: adapter.id,
        to: input.to,
        subject: input.subject || input.meta?.subject,
        text: input.text
      });
    }
    return result;
  };
  return adapter;
}

export function loopGuardStats() {
  const now = Date.now();
  let targets = 0;
  let recent = 0;
  for (const entries of history.values()) {
    const live = prune(entries, now);
    if (live.length) {
      targets += 1;
      recent += live.length;
    }
  }
  return {
    ...stats,
    targets,
    recent,
    windowMin: WINDOW_MS / 60_000,
    maxIdentical: MAX_IDENTICAL,
    maxPerTarget: MAX_PER_TARGET
  };
}

/** Solo pruebas. */
export function resetLoopGuard() {
  history.clear();
  stats.attempts = 0;
  stats.recorded = 0;
  stats.blocked = 0;
  stats.wouldBlock = 0;
  stats.lastReason = null;
  stats.lastAt = null;
}


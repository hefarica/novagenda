/**
 * Puente entre Lingo y la redacción.
 *
 * Todo es defensivo: si el léxico está vacío, `applyCanonical` devuelve el
 * mismo texto; si el módulo falla, se conserva el original. Sin léxico el
 * resultado es idéntico al de antes de t47.
 */
import { store } from '../store.mjs';
import { applyCanonical } from '../lingo/engine.mjs';
import { buildFilename } from '../docs/ooxml.mjs';

function safeCanonical(value, { data = store.get() } = {}) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return applyCanonical(value, { data }).text;
  } catch {
    return value;
  }
}

/** Texto canónico para nombres propios/entidades/predios. */
export function canonicalText(value, options = {}) {
  return safeCanonical(value, options);
}

/**
 * Aplica Lingo a los hechos de una redacción sin cambiar su estructura:
 * strings, arrays y valores de objetos. Las claves y los números se conservan.
 */
export function canonicalFacts(facts, { data = store.get() } = {}) {
  if (typeof facts === 'string') return canonicalText(facts, { data });
  if (Array.isArray(facts)) return facts.map((item) => canonicalFacts(item, { data }));
  if (facts && typeof facts === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(facts)) out[key] = canonicalFacts(value, { data });
    return out;
  }
  return facts;
}

/** Destinatario con `name` canónico; los correos no se tocan. */
export function canonicalRecipient(recipient, { data = store.get() } = {}) {
  if (!recipient) return recipient;
  if (typeof recipient === 'string') {
    return /@/.test(recipient) ? recipient : canonicalText(recipient, { data });
  }
  if (typeof recipient !== 'object') return recipient;
  return {
    ...recipient,
    ...(recipient.name ? { name: canonicalText(String(recipient.name), { data }) } : {})
  };
}

/** Hilo de mensajes con nombres/entidades canónicos, conservando el formato. */
export function canonicalThread(thread, { data = store.get() } = {}) {
  if (!Array.isArray(thread)) return thread;
  return thread.map((message) => {
    if (typeof message === 'string') return canonicalText(message, { data });
    if (!message || typeof message !== 'object') return message;
    const out = { ...message };
    for (const key of ['text', 'body', 'content']) {
      if (typeof out[key] === 'string') out[key] = canonicalText(out[key], { data });
    }
    return out;
  });
}

/**
 * Título de documento con la forma canónica. `docs` puede usar esta función
 * antes de `buildFilename` para que el archivo generado lleve el nombre bueno.
 */
export function canonicalDocumentTitle(title, { data = store.get() } = {}) {
  return canonicalText(String(title ?? ''), { data });
}

/**
 * Nombre de archivo canónico compatible con el que genera `lib/docs`.
 * `canonicalFilename('hector fabio riascos','docx')` →
 * `hector-fabio-riascos-c-2026-10-28.docx` si el término está aprobado.
 */
export function canonicalFilename(title, extension = 'docx', { data = store.get(), date = new Date() } = {}) {
  const canonical = canonicalDocumentTitle(title, { data }) || 'documento';
  try {
    return buildFilename(canonical, extension, { date });
  } catch {
    const slug = canonical
      .normalize('NFD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const stamp = date instanceof Date ? date.toISOString().slice(0, 10) : '';
    return `${slug || 'documento'}${stamp ? `-${stamp}` : ''}.${extension}`;
  }
}

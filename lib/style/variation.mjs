/**
 * Anti-repetición de fórmulas por contacto y tipo (apertura / cierre / acuse).
 *
 * Regla: en una ventana de 7 días no se repite la misma fórmula con el mismo
 * contacto. Se persiste en `data.style.variations` del store (JSON atómico).
 */
import { store } from '../store.mjs';
import { fold, normalizeText } from './features.mjs';
import { ensureVariations } from './profile.mjs';

export const VARIATION_TYPES = Object.freeze(['apertura', 'cierre', 'acuse']);
export const VARIATION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Clave estable del contacto: email en minúsculas o nombre normalizado. */
export function contactKey(recipient) {
  if (!recipient) return 'sin-destinatario';
  if (typeof recipient === 'string') {
    const value = recipient.trim();
    if (/@/.test(value)) return value.toLowerCase();
    return fold(value).replace(/\s+/g, ' ').trim() || 'sin-destinatario';
  }
  const email = recipient.email || (Array.isArray(recipient.emails) ? recipient.emails[0] : null);
  if (email && /@/.test(String(email))) return String(email).trim().toLowerCase();
  const name = recipient.name || '';
  return fold(name).replace(/\s+/g, ' ').trim() || 'sin-destinatario';
}

function atOf(entry) {
  const value = Date.parse(entry?.at || '');
  return Number.isFinite(value) ? value : 0;
}

/** Variaciones recientes de un contacto/tipo dentro de la ventana. */
export function variationsFor(data, contact, type, { now = Date.now(), windowDays = VARIATION_WINDOW_DAYS } = {}) {
  const key = contactKey(contact);
  const since = now - Math.max(1, windowDays) * DAY_MS;
  return ensureVariations(data).filter((entry) => (
    entry
    && entry.contact === key
    && entry.type === type
    && atOf(entry) >= since
  ));
}

/** ¿Se usó ya esta fórmula con este contacto/tipo en la ventana? */
export function isUsed(data, contact, type, text, options = {}) {
  const target = fold(normalizeText(text));
  if (!target) return false;
  return variationsFor(data, contact, type, options).some((entry) => fold(normalizeText(entry.text)) === target);
}

function usedSet(data, contact, type, options) {
  return new Set(variationsFor(data, contact, type, options).map((entry) => fold(normalizeText(entry.text))));
}

function synthesize(type, base, used) {
  const cleaned = normalizeText(base).replace(/[:,]\s*$/, '').replace(/[.,]\s*$/, '');
  const options = type === 'cierre'
    ? [`${cleaned} y gracias,`, `${cleaned} fuerte,`, `${cleaned} de nuevo,`, `${cleaned} y buen día,`]
    : type === 'acuse'
      ? [`${cleaned}, acuse de recibo:`, `${cleaned}, confirmo recepción:`, `${cleaned}, gracias por el envío:`]
      : [`${cleaned}, retomo el hilo:`, `${cleaned} de nuevo:`, `${cleaned}, otra vez por aquí:`, `${cleaned}, ¿cómo va todo?`];
  for (const candidate of options) {
    if (!used.has(fold(candidate))) return candidate;
  }
  return null;
}

/**
 * Elige una fórmula no usada recientemente.
 * - Respeta `prefer` si no se ha usado.
 * - Si todas las candidatas están usadas, sintetiza una variante determinista.
 * @param {object} data
 * @param {object|string} contact
 * @param {'apertura'|'cierre'|'acuse'} type
 * @param {string[]} candidates
 * @param {{now?:number, windowDays?:number, prefer?:string|null}} [options]
 * @returns {{text:string|null, replaced:boolean, exhausted:boolean, synthesized:boolean, recent:string[]}}
 */
export function pickVariant(data, contact, type, candidates, { now = Date.now(), windowDays = VARIATION_WINDOW_DAYS, prefer = null } = {}) {
  const options = { now, windowDays };
  const used = usedSet(data, contact, type, options);
  const recent = variationsFor(data, contact, type, options).map((entry) => entry.text);
  const pool = [...new Set((Array.isArray(candidates) ? candidates : []).map((item) => normalizeText(item)).filter(Boolean))];
  const normalizedPrefer = prefer ? normalizeText(prefer) : '';

  if (normalizedPrefer && !used.has(fold(normalizedPrefer))) {
    return { text: normalizedPrefer, replaced: false, exhausted: false, synthesized: false, recent };
  }
  const free = pool.find((candidate) => !used.has(fold(candidate)));
  if (free) {
    return {
      text: free,
      replaced: Boolean(normalizedPrefer) && free !== normalizedPrefer,
      exhausted: false,
      synthesized: false,
      recent
    };
  }
  const base = normalizedPrefer || pool[0] || (type === 'cierre' ? 'Saludos,' : 'Hola:');
  const synthetic = synthesize(type, base, used);
  if (synthetic) {
    return {
      text: synthetic,
      replaced: Boolean(normalizedPrefer),
      exhausted: true,
      synthesized: true,
      recent
    };
  }
  return { text: null, replaced: false, exhausted: true, synthesized: false, recent };
}

/** Poda el histórico de variaciones (30 días / 1000 entradas). */
export function pruneVariations(data, { now = Date.now(), maxAgeDays = 30, maxEntries = 1000 } = {}) {
  const style = data.style || {};
  const list = ensureVariations(data);
  const since = now - maxAgeDays * DAY_MS;
  const kept = list.filter((entry) => entry && atOf(entry) >= since);
  const trimmed = kept.slice(-maxEntries);
  style.variations = trimmed;
  return { removed: list.length - trimmed.length, kept: trimmed.length };
}

/**
 * Registra fórmulas usadas (mutación de datos, sin persistir).
 * @param {object} data
 * @param {Array<{type:string, text:string}>} entries
 * @param {{contact:object|string, register?:string, now?:number}} context
 */
export function recordVariationEntries(data, entries, { contact, register = null, now = Date.now() } = {}) {
  const style = data.style || {};
  const list = ensureVariations(data);
  const key = contactKey(contact);
  const at = new Date(now).toISOString();
  const recorded = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !VARIATION_TYPES.includes(entry.type)) continue;
    const textValue = normalizeText(entry.text || '');
    if (!textValue) continue;
    const row = { at, contact: key, type: entry.type, text: textValue, register };
    list.push(row);
    recorded.push(row);
  }
  pruneVariations(data, { now });
  style.updatedAt = at;
  return { contact: key, recorded };
}

/** Registra y persiste las fórmulas elegidas por compose. */
export async function recordComposeVariations({ contact, register = null, entries, now = Date.now() } = {}) {
  let result = { contact: contactKey(contact), recorded: [] };
  await store.mutate((data) => {
    result = recordVariationEntries(data, entries, { contact, register, now });
  }, { label: 'style-variation' });
  return result;
}

/** Estado de variaciones de un contacto (para UI/diagnóstico). */
export function variationStats(data, contact, { now = Date.now(), windowDays = VARIATION_WINDOW_DAYS } = {}) {
  const key = contactKey(contact);
  const recent = ensureVariations(data)
    .filter((entry) => entry && entry.contact === key && atOf(entry) >= now - windowDays * DAY_MS)
    .map((entry) => ({ type: entry.type, text: entry.text, at: entry.at }))
    .slice(-40);
  return {
    contact: key,
    windowDays,
    recent,
    counts: VARIATION_TYPES.reduce((acc, type) => {
      acc[type] = recent.filter((entry) => entry.type === type).length;
      return acc;
    }, {})
  };
}

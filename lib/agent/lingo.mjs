/**
 * Puente entre Lingo y el agente.
 *
 * Normaliza `title`, `person`, `attendeeNames`, `context` y `notes` con el
 * léxico aprobado antes de guardar. Si hay ambigüedad (la misma forma exacta
 * pertenece a dos términos, datos heredados), NO se cambia el texto: se devuelve
 * el original con `lingoWarning`. Si Lingo está vacío o lanza un error, el
 * comportamiento es idéntico al de antes de t47.
 */
import { store } from '../store.mjs';
import { applyCanonical } from '../lingo/engine.mjs';
import { ensureLingo, normalizeKey } from '../lingo/store.mjs';
import { buildFilename } from '../docs/ooxml.mjs';

export const LINGO_AGENT_FIELDS = Object.freeze(['title', 'person', 'context', 'notes', 'owner']);
const FIELD_MAX = Object.freeze({ title: 200, person: 120, context: 200, notes: 2000, owner: 120 });

function clampField(field, value) {
  const max = FIELD_MAX[field] || 200;
  return value.length > max ? value.slice(0, max).trim() : value;
}

function plainTerms(data) {
  try {
    return ensureLingo(data).terms;
  } catch {
    return [];
  }
}

function exactOwners(data, value) {
  const key = normalizeKey(value);
  if (!key) return [];
  return plainTerms(data)
    .filter((term) => term.status === 'approved')
    .filter((term) => [term.term, ...(term.variants || [])]
      .map((form) => normalizeKey(form))
      .includes(key));
}

/**
 * Detecta formas que pertenecen a más de un término aprobado dentro del texto
 * (datos heredados o conflictos previos). Devuelve los términos implicados.
 */
function ambiguousFormOwners(data, value) {
  const normalized = ` ${normalizeKey(value)} `;
  if (!normalized.trim()) return [];
  const ownersByForm = new Map();
  for (const term of plainTerms(data)) {
    if (term.status !== 'approved') continue;
    for (const form of [term.term, ...(term.variants || [])]) {
      const key = normalizeKey(form);
      if (!key || !normalized.includes(` ${key} `)) continue;
      if (!ownersByForm.has(key)) ownersByForm.set(key, []);
      const list = ownersByForm.get(key);
      if (!list.some((item) => item.id === term.id)) list.push(term);
    }
  }
  const ambiguous = [];
  const seen = new Set();
  for (const rows of ownersByForm.values()) {
    if (rows.length < 2) continue;
    for (const term of rows) {
      if (seen.has(term.id)) continue;
      seen.add(term.id);
      ambiguous.push(term);
    }
  }
  return ambiguous;
}

/**
 * @param {string} value
 * @param {{field?:string, data?:object}} [options]
 * @returns {{value:string, changed:boolean, warning:object|null, terms:string[]}}
 */
export function canonicalizeValue(value, { field = 'text', data = store.get() } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return { value, changed: false, warning: null, terms: [] };
  }
  let owners;
  try {
    owners = exactOwners(data, value);
  } catch {
    return { value, changed: false, warning: null, terms: [] };
  }
  let ambiguous = [];
  try {
    ambiguous = ambiguousFormOwners(data, value);
  } catch {
    ambiguous = [];
  }
  if (owners.length > 1 || ambiguous.length > 1) {
    const candidates = [...(owners.length > 1 ? owners : ambiguous)];
    return {
      value,
      changed: false,
      warning: {
        field,
        reason: 'ambiguous',
        original: value,
        candidates: candidates.slice(0, 5).map((term) => ({ id: term.id, term: term.term, status: term.status }))
      },
      terms: candidates.map((term) => term.id)
    };
  }
  try {
    const result = applyCanonical(value, { data });
    if (!result.changed) return { value, changed: false, warning: null, terms: result.terms };
    return { value: result.text, changed: true, warning: null, terms: result.terms };
  } catch {
    // Lingo no disponible: se conserva el original, sin inventar.
    return { value, changed: false, warning: null, terms: [] };
  }
}

/**
 * Aplica Lingo a los campos que el agente extrae del lenguaje natural.
 * No toca correos, IDs, fechas ni importes.
 *
 * @param {object} args
 * @param {{data?:object}} [options]
 */
export function canonicalizeAgentArgs(args = {}, { data = store.get() } = {}) {
  const next = { ...(args && typeof args === 'object' ? args : {}) };
  const warnings = [];
  const applied = [];

  for (const field of LINGO_AGENT_FIELDS) {
    if (typeof next[field] !== 'string') continue;
    const result = canonicalizeValue(next[field], { field, data });
    if (result.warning) warnings.push(result.warning);
    if (result.changed) {
      const value = clampField(field, result.value);
      applied.push({ field, from: next[field], to: value, terms: result.terms });
      next[field] = value;
    }
  }

  if (Array.isArray(next.attendeeNames)) {
    next.attendeeNames = next.attendeeNames.map((value, index) => {
      if (typeof value !== 'string') return value;
      const result = canonicalizeValue(value, { field: `attendeeNames[${index}]`, data });
      if (result.warning) warnings.push(result.warning);
      if (result.changed) {
        const canonical = clampField('person', result.value);
        applied.push({ field: `attendeeNames[${index}]`, from: value, to: canonical, terms: result.terms });
        return canonical;
      }
      return value;
    });
  }

  if (warnings.length) next.lingoWarning = warnings;
  if (applied.length) next.lingoApplied = applied;
  return { args: next, warnings, applied };
}

/** Título canónico para documentos (sin generar el archivo). */
export function canonicalDocumentTitle(title, { data = store.get() } = {}) {
  const result = canonicalizeValue(String(title ?? ''), { field: 'title', data });
  return result.value;
}

/** Nombre de archivo canónico compatible con `lib/docs` (para el generador). */
export function canonicalDocumentFilename(title, extension = 'docx', { data = store.get(), date = new Date() } = {}) {
  const canonical = canonicalDocumentTitle(title, { data }) || 'documento';
  try {
    return buildFilename(canonical, extension, { date });
  } catch {
    const slug = canonical.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const stamp = date instanceof Date ? date.toISOString().slice(0, 10) : '';
    return `${slug || 'documento'}${stamp ? `-${stamp}` : ''}.${extension}`;
  }
}

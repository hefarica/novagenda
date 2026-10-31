/**
 * Lingo: léxico único de la oficina.
 *
 * Modelo persistido sin migración en `data.lingo`:
 *
 *   {
 *     version: 1,
 *     terms: [{
 *       id: 'LG-0001',
 *       term: 'Héctor Fabio Riascos C.',   // forma canónica (se conserva)
 *       variants: ['hector fabio riascos', 'Héctor Riascos'],
 *       context: 'actas, predios',
 *       sources: ['manual', 'asr'],
 *       status: 'shadow'|'approved'|'rejected',
 *       uses: 0,
 *       corrections: 0,
 *       createdAt, updatedAt
 *     }],
 *     updatedAt
 *   }
 *
 * La comparación ignora mayúsculas, tildes y puntuación; la forma canónica y
 * las variantes conservan su escritura original. Los términos nuevos nacen en
 * `shadow` y solo `approved` se aplica a texto/hotwords. La promoción automática
 * por correcciones ocurre a las 3 (`learn`), nunca con una sola.
 */
import { store, nextId } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';
import { appendLedger } from '../office/ledger.mjs';

export const LINGO_VERSION = 1;
export const TERM_STATUSES = Object.freeze(['shadow', 'approved', 'rejected']);
export const MAX_TERMS = 5000;
export const MAX_VARIANTS = 30;
export const MAX_CONTEXT = 120;
export const MAX_SOURCES = 20;
export const MAX_TERM_LENGTH = 120;
export const PROMOTION_CORRECTIONS = 3;
export const TERM_ID_RE = /^LG-\d{1,6}$/i;

const MAX_SOURCE_LENGTH = 80;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Texto limpio conservando mayúsculas/tildes (forma canónica). */
export function cleanText(value, max = MAX_TERM_LENGTH) {
  if (value === undefined || value === null) return '';
  const text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

/** Forma canónica legible: conserva la escritura original, sin espacios extra. */
export function canonicalForm(value, max = MAX_TERM_LENGTH) {
  return cleanText(value, max);
}

/**
 * Clave de comparación: minúsculas, sin diacríticos, sin puntuación.
 * «Héctor Fabio Riascos C.» → «hector fabio riascos c».
 */
export function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function termKeys(term) {
  return [...new Set([term.term, ...(Array.isArray(term.variants) ? term.variants : [])]
    .map((value) => normalizeKey(value))
    .filter(Boolean))];
}

function normalizeSources(value, fallback = ['manual']) {
  const raw = value === undefined ? fallback : Array.isArray(value) ? value : [value];
  const rows = raw.length ? raw : fallback;
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const source = cleanText(row, MAX_SOURCE_LENGTH);
    if (!source) continue;
    const key = normalizeKey(source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(source);
    if (result.length >= MAX_SOURCES) break;
  }
  return result;
}

/** Garantiza la forma de `data.lingo` (idempotente, sin migración). */
export function ensureLingo(data = store.get()) {
  if (!isPlainObject(data.lingo)) data.lingo = {};
  const lingo = data.lingo;
  if (lingo.version !== LINGO_VERSION) lingo.version = LINGO_VERSION;
  if (!Array.isArray(lingo.terms)) lingo.terms = [];
  lingo.updatedAt = lingo.updatedAt || new Date().toISOString();
  return lingo;
}

/** Copia pública de un término (sin referencias compartidas). */
export function publicTerm(term) {
  if (!term) return null;
  return {
    id: term.id,
    term: term.term,
    variants: Array.isArray(term.variants) ? [...term.variants] : [],
    context: term.context || '',
    sources: Array.isArray(term.sources) ? [...term.sources] : [],
    status: term.status,
    uses: Number(term.uses) || 0,
    corrections: Number(term.corrections) || 0,
    createdAt: term.createdAt || null,
    updatedAt: term.updatedAt || null
  };
}

export function getTerm(data = store.get(), id) {
  const terms = ensureLingo(data).terms;
  return terms.find((term) => String(term.id).toLowerCase() === String(id || '').toLowerCase()) || null;
}

function findOwner(data, key, excludeId = null) {
  if (!key) return null;
  for (const term of ensureLingo(data).terms) {
    if (excludeId && String(term.id).toLowerCase() === String(excludeId).toLowerCase()) continue;
    if (termKeys(term).includes(key)) return term;
  }
  return null;
}

function assertKeysAvailable(data, keys, excludeId = null) {
  for (const key of keys) {
    const owner = findOwner(data, key, excludeId);
    if (owner) {
      throw new HttpError(409, 'LINGO_CONFLICT',
        `La variante «${key}» ya pertenece al término «${owner.term}» (${owner.id}).`);
    }
  }
}

function contextMatches(term, ctx) {
  if (!ctx) return true;
  const wanted = normalizeKey(ctx);
  if (!wanted) return true;
  const context = normalizeKey(term.context || '');
  if (!context || context === 'global' || context === 'general' || context === 'todas') return true;
  const tokens = context.split(/[,\s]+/).filter(Boolean);
  return tokens.includes(wanted) || context.includes(wanted) || wanted.includes(context);
}

/** Lista/busca términos. */
export function listTerms(data = store.get(), { status = null, ctx = null, q = '', limit = 100, offset = 0 } = {}) {
  const lingo = ensureLingo(data);
  const wantedStatus = status && status !== 'all' ? String(status).toLowerCase() : null;
  const query = normalizeKey(q);
  const rows = lingo.terms
    .filter((term) => {
      if (wantedStatus && term.status !== wantedStatus) return false;
      if (!contextMatches(term, ctx)) return false;
      if (query) {
        const haystack = normalizeKey([term.term, ...(term.variants || [])].join(' '));
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const rank = { approved: 0, shadow: 1, rejected: 2 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        || String(a.term).localeCompare(String(b.term), 'es');
    });
  const size = Math.max(1, Math.min(500, Math.round(Number(limit) || 100)));
  const skip = Math.max(0, Math.round(Number(offset) || 0));
  return {
    items: rows.slice(skip, skip + size).map(publicTerm),
    count: Math.max(0, Math.min(rows.length - skip, size)),
    total: rows.length,
    offset: skip,
    statuses: [...TERM_STATUSES]
  };
}

function logChange(data, payload) {
  appendLedger(data, { actor: 'lingo', action: 'lingo.change', payload });
}

/**
 * Crea un término (siempre `shadow`) o actualiza uno existente por su forma
 * canónica. Cualquier variante que ya pertenezca a otro término → 409.
 */
export function createOrUpdateTerm(data, input = {}, { actor = 'lingo' } = {}) {
  const lingo = ensureLingo(data);
  if (lingo.terms.length >= MAX_TERMS) {
    throw new HttpError(409, 'LINGO_LIMIT', `El léxico alcanzó el máximo de ${MAX_TERMS} términos.`);
  }
  const termText = canonicalForm(input.term);
  if (!termText) throw new ValidationError('term', 'REQUIRED', 'term es obligatorio.');
  if (!normalizeKey(termText)) throw new ValidationError('term', 'INVALID_VALUE', 'term necesita letras o números.');
  const variants = [];
  const seenVariants = new Set();
  const rawVariants = input.variants === undefined ? [] : Array.isArray(input.variants) ? input.variants : [input.variants];
  for (const value of rawVariants) {
    const variant = canonicalForm(value);
    const key = normalizeKey(variant);
    if (!variant || !key || seenVariants.has(key)) continue;
    seenVariants.add(key);
    variants.push(variant);
    if (variants.length >= MAX_VARIANTS) break;
  }
  const context = canonicalForm(input.context || '', MAX_CONTEXT);
  const sources = normalizeSources(input.sources, ['manual']);
  const canonicalKey = normalizeKey(termText);
  const existing = lingo.terms.find((term) => normalizeKey(term.term) === canonicalKey) || null;

  if (existing) {
    const mergedVariants = [...existing.variants];
    for (const variant of variants) {
      if (!termKeys(existing).includes(normalizeKey(variant))) mergedVariants.push(variant);
    }
    const mergedKeys = [existing.term, ...mergedVariants].map(normalizeKey).filter(Boolean);
    assertKeysAvailable(data, [...new Set(mergedKeys)], existing.id);
    existing.variants = [...new Set(mergedVariants)].slice(0, MAX_VARIANTS);
    if (context) existing.context = context;
    existing.sources = normalizeSources([...(existing.sources || []), ...sources], existing.sources);
    existing.updatedAt = new Date().toISOString();
    lingo.updatedAt = existing.updatedAt;
    return { item: publicTerm(existing), created: false, updated: true };
  }

  const keys = [...new Set([canonicalKey, ...variants.map(normalizeKey).filter(Boolean)])];
  assertKeysAvailable(data, keys);
  const now = new Date().toISOString();
  const term = {
    id: nextId('LG', lingo.terms),
    term: termText,
    variants,
    context,
    sources,
    status: 'shadow',
    uses: 0,
    corrections: 0,
    createdAt: now,
    updatedAt: now
  };
  lingo.terms.push(term);
  lingo.updatedAt = now;
  logChange(data, {
    change: 'created',
    termId: term.id,
    term: term.term,
    variants: term.variants,
    status: term.status,
    actor
  });
  return { item: publicTerm(term), created: true, updated: false };
}

/** Aprueba/rechaza (o vuelve a shadow) un término, con ledger. */
export function setTermStatus(data, id, status, { actor = 'lingo', reason = '' } = {}) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (!TERM_STATUSES.includes(normalizedStatus)) {
    throw new ValidationError('status', 'INVALID_VALUE', `status debe ser uno de: ${TERM_STATUSES.join(', ')}.`);
  }
  if (!TERM_ID_RE.test(String(id || ''))) {
    throw new ValidationError('id', 'INVALID_FORMAT', 'El id del término debe ser LG-0001.');
  }
  const term = getTerm(data, id);
  if (!term) throw new HttpError(404, 'LINGO_NOT_FOUND', `No encontré el término ${id}.`);
  const previous = term.status;
  if (previous === normalizedStatus) {
    return { item: publicTerm(term), changed: false, previous };
  }
  term.status = normalizedStatus;
  term.updatedAt = new Date().toISOString();
  ensureLingo(data).updatedAt = term.updatedAt;
  logChange(data, {
    change: normalizedStatus === 'approved' ? 'approved' : normalizedStatus === 'rejected' ? 'rejected' : 'reset_shadow',
    termId: term.id,
    term: term.term,
    from: previous,
    to: normalizedStatus,
    reason: canonicalForm(reason, 300),
    actor
  });
  return { item: publicTerm(term), changed: true, previous };
}

/**
 * Aprende de una corrección. Primera vez crea en `shadow`; tres correcciones
 * del mismo término lo promueven a `approved`. Nunca aprueba con una sola.
 */
export function learnCorrection(data, { original, corrected, source = 'aprendizaje', actor = 'lingo' } = {}) {
  const lingo = ensureLingo(data);
  const originalText = canonicalForm(original);
  const correctedText = canonicalForm(corrected);
  if (!originalText) throw new ValidationError('original', 'REQUIRED', 'original es obligatorio.');
  if (!correctedText) throw new ValidationError('corrected', 'REQUIRED', 'corrected es obligatorio.');
  const originalKey = normalizeKey(originalText);
  const correctedKey = normalizeKey(correctedText);
  if (!originalKey || !correctedKey) {
    throw new ValidationError('corrected', 'INVALID_VALUE', 'original y corrected necesitan letras o números.');
  }
  const sourceText = cleanText(source, MAX_SOURCE_LENGTH) || 'aprendizaje';
  const existing = lingo.terms.find((term) => termKeys(term).includes(correctedKey)) || null;

  if (existing) {
    if (originalText === correctedText) {
      return { item: publicTerm(existing), changed: false, created: false, promoted: false, corrections: Number(existing.corrections) || 0, status: existing.status };
    }
    assertKeysAvailable(data, [originalKey], existing.id);
    const already = termKeys(existing).includes(originalKey);
    if (!already) {
      if (existing.variants.length >= MAX_VARIANTS) {
        throw new HttpError(409, 'LINGO_LIMIT', `El término ${existing.id} alcanzó el máximo de variantes.`);
      }
      existing.variants.push(originalText);
    }
    existing.corrections = (Number(existing.corrections) || 0) + 1;
    existing.sources = normalizeSources([...(existing.sources || []), sourceText], existing.sources);
    existing.updatedAt = new Date().toISOString();
    lingo.updatedAt = existing.updatedAt;
    let promoted = false;
    if (existing.status === 'shadow' && existing.corrections >= PROMOTION_CORRECTIONS) {
      existing.status = 'approved';
      promoted = true;
      logChange(data, {
        change: 'approved',
        reason: 'promotion',
        termId: existing.id,
        term: existing.term,
        corrections: existing.corrections,
        actor
      });
    }
    return {
      item: publicTerm(existing),
      changed: true,
      created: false,
      promoted,
      corrections: existing.corrections,
      status: existing.status
    };
  }

  assertKeysAvailable(data, [correctedKey, originalKey]);
  const now = new Date().toISOString();
  const variants = originalKey !== correctedKey ? [originalText] : [];
  const term = {
    id: nextId('LG', lingo.terms),
    term: correctedText,
    variants,
    context: 'aprendizaje',
    sources: [sourceText],
    status: 'shadow',
    uses: 0,
    corrections: 1,
    createdAt: now,
    updatedAt: now
  };
  lingo.terms.push(term);
  lingo.updatedAt = now;
  logChange(data, {
    change: 'created',
    reason: 'learn',
    termId: term.id,
    term: term.term,
    variants: term.variants,
    status: term.status,
    actor
  });
  return {
    item: publicTerm(term),
    changed: true,
    created: true,
    promoted: false,
    corrections: 1,
    status: 'shadow'
  };
}

/** Suma usos a términos aplicados (no cambia el estado). */
export function recordTermUses(data, ids = []) {
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id).toLowerCase()));
  if (!set.size) return { updated: 0 };
  let updated = 0;
  const now = new Date().toISOString();
  for (const term of ensureLingo(data).terms) {
    if (!set.has(String(term.id).toLowerCase())) continue;
    term.uses = (Number(term.uses) || 0) + 1;
    term.updatedAt = now;
    updated += 1;
  }
  if (updated) ensureLingo(data).updatedAt = now;
  return { updated };
}

export function lingoStats(data = store.get()) {
  const terms = ensureLingo(data).terms;
  const counts = Object.fromEntries(TERM_STATUSES.map((status) => [status, 0]));
  for (const term of terms) counts[term.status] = (counts[term.status] || 0) + 1;
  return {
    total: terms.length,
    counts,
    updatedAt: ensureLingo(data).updatedAt
  };
}

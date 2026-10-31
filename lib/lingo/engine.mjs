/**
 * Motor de Lingo.
 *
 *   findTerms(text)                 términos/variantes encontrados
 *   applyCanonical(text)            sustituye variantes por la forma canónica
 *   suggest(text)                   candidatos a nombres propios/entidades
 *   hotwords(ctx, maxChars)         vocabulario para ASR con presupuesto
 *   learn({original, corrected})    aprende correcciones y promueve a las 3
 *
 * Solo los términos `approved` se aplican a texto y hotwords. Los `shadow` se
 * pueden revisar/consultar/sugerir, pero no se usan en producción hasta que el
 * jefe los aprueba (PATCH) o `learn` acumula 3 correcciones.
 *
 * Todas las funciones son deterministas y no llaman a ningún LLM.
 */
import { store } from '../store.mjs';
import {
  ensureLingo, listTerms, learnCorrection, normalizeKey, publicTerm
} from './store.mjs';

export const DEFAULT_HOTWORDS_MAX_CHARS = 400;
export const MIN_HOTWORDS_MAX_CHARS = 16;
export const MAX_HOTWORDS_MAX_CHARS = 4000;

const RANK = Object.freeze({ approved: 0, shadow: 1, rejected: 2 });
const CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos']);
const ENTITY_CUES = new Set([
  'predio', 'lote', 'matricula', 'matrícula', 'finca', 'hacienda', 'vereda', 'parcela',
  'senor', 'señor', 'sra', 'srta', 'sr', 'doctor', 'doctora', 'dr', 'dra',
  'entidad', 'empresa', 'fondo', 'banco', 'cliente', 'proveedor', 'notaria', 'notaría'
]);
const SINGLE_STOP = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'este', 'esta', 'estos', 'estas',
  'hoy', 'ayer', 'manana', 'mañana', 'acta', 'reunion', 'reunión', 'sesion', 'sesión',
  'se', 'en', 'con', 'por', 'para', 'del', 'al', 'y', 'o', 'pero', 'como', 'cuando',
  'donde', 'quien', 'quién', 'nosotros', 'ustedes', 'senor', 'señor', 'sra', 'sr',
  'predio', 'lote', 'matricula', 'matrícula', 'finca', 'hacienda', 'vereda', 'notaria', 'notaría',
  'informe', 'anexo', 'acuerdo', 'punto', 'orden', 'dia', 'día'
]);
const SENTENCE_STARTERS = new Set([
  'firmo', 'firmó', 'asistio', 'asistió', 'reunieron', 'acordo', 'acordó', 'presente',
  'presentó', 'siendo', 'dado', 'consta', 'certifica', 'manifiesta', 'expone', 'solicita'
]);

/* ------------------------------------------------------------------ */
/* Normalización con mapa de posiciones                                */
/* ------------------------------------------------------------------ */

/**
 * Pliega el texto (minúsculas, sin diacríticos) conservando un mapa de cada
 * carácter plegado a su índice en el texto original.
 */
export function foldWithMap(input) {
  const text = String(input ?? '');
  let folded = '';
  const map = [];
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index);
    const char = String.fromCodePoint(code);
    const normalized = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const piece of normalized) {
      folded += piece;
      map.push(index);
    }
    index += char.length;
  }
  map.push(text.length);
  return { text, folded, map };
}

/** Clave de comparación de un término/variante. */
export function termMatchKey(value) {
  return normalizeKey(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* Índice de términos                                                  */
/* ------------------------------------------------------------------ */

function termStatusAllowed(status, { includeShadow = false } = {}) {
  if (status === 'approved') return true;
  if (status === 'shadow') return includeShadow === true;
  return false;
}

/**
 * Construye las entradas de búsqueda (término + variantes) de los términos
 * utilizables. Las variantes comparten el canónico del término.
 */
export function buildIndex(data = store.get(), { includeShadow = false } = {}) {
  const entries = [];
  const seen = new Set();
  const terms = ensureLingo(data).terms;
  for (const term of terms) {
    if (!termStatusAllowed(term.status, { includeShadow })) continue;
    if (term.status === 'rejected') continue;
    const forms = [...new Set([term.term, ...(term.variants || [])].filter(Boolean))];
    for (const form of forms) {
      const key = termMatchKey(form);
      if (!key || seen.has(`${term.id}:${key}`)) continue;
      seen.add(`${term.id}:${key}`);
      const endsWithDot = String(term.term).trim().endsWith('.');
      const pattern = `(?<![\\p{L}\\p{N}])${escapeRegExp(key)}${endsWithDot ? '\\.?' : ''}(?![\\p{L}\\p{N}])`;
      entries.push({
        id: term.id,
        term: term.term,
        canonical: term.term,
        variant: form,
        key,
        status: term.status,
        context: term.context || '',
        corrections: Number(term.corrections) || 0,
        uses: Number(term.uses) || 0,
        regex: new RegExp(pattern, 'gu')
      });
    }
  }
  return entries;
}

function rawMatches(text, entries) {
  if (!text || !entries.length) return [];
  const { folded, map } = foldWithMap(text);
  const matches = [];
  for (const entry of entries) {
    entry.regex.lastIndex = 0;
    let match;
    while ((match = entry.regex.exec(folded)) !== null) {
      if (!match[0]) break;
      const startFolded = match.index;
      const endFolded = startFolded + match[0].length;
      const start = map[startFolded];
      const end = map[endFolded];
      if (start === undefined || end === undefined || end <= start) continue;
      matches.push({
        id: entry.id,
        term: entry.term,
        canonical: entry.canonical,
        variant: entry.variant,
        matched: text.slice(start, end),
        status: entry.status,
        context: entry.context,
        start,
        end
      });
    }
  }
  return matches;
}

/** Selecciona coincidencias sin solapamientos (la más larga al mismo inicio). */
export function selectMatches(matches) {
  const sorted = [...matches].sort((a, b) => (
    a.start - b.start
    || b.end - a.end
    || (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
    || a.id.localeCompare(b.id)
  ));
  const selected = [];
  let lastEnd = -1;
  const seen = new Set();
  for (const match of sorted) {
    if (match.start < lastEnd) continue;
    const key = `${match.id}:${match.start}:${match.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(match);
    lastEnd = match.end;
  }
  return selected;
}

/* ------------------------------------------------------------------ */
/* API pública del motor                                               */
/* ------------------------------------------------------------------ */

/**
 * Busca términos/variantes en un texto.
 * @param {string} text
 * @param {{data?:object, includeShadow?:boolean, limit?:number}} [options]
 * @returns {Array<{id:string,term:string,canonical:string,variant:string,matched:string,status:string,start:number,end:number}>}
 */
export function findTerms(text, { data = store.get(), includeShadow = false, limit = 50 } = {}) {
  const entries = buildIndex(data, { includeShadow });
  const matches = selectMatches(rawMatches(String(text ?? ''), entries));
  return matches.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map((match) => ({
    id: match.id,
    term: match.term,
    canonical: match.canonical,
    variant: match.variant,
    matched: match.matched,
    status: match.status,
    context: match.context,
    start: match.start,
    end: match.end
  }));
}

/**
 * Sustituye variantes (y la forma canónica escrita con otra caja/tildes) por la
 * forma canónica exacta. Solo términos aprobados salvo `includeShadow`.
 * @param {string} text
 * @param {{data?:object, includeShadow?:boolean}} [options]
 */
export function applyCanonical(text, { data = store.get(), includeShadow = false } = {}) {
  const original = String(text ?? '');
  const entries = buildIndex(data, { includeShadow });
  const matches = selectMatches(rawMatches(original, entries));
  if (!matches.length) {
    return { text: original, changed: false, changes: [], terms: [] };
  }
  let output = '';
  let cursor = 0;
  const changes = [];
  const terms = new Set();
  for (const match of matches) {
    output += original.slice(cursor, match.start);
    output += match.canonical;
    cursor = match.end;
    terms.add(match.id);
    if (original.slice(match.start, match.end) !== match.canonical) {
      changes.push({
        id: match.id,
        canonical: match.canonical,
        from: original.slice(match.start, match.end),
        to: match.canonical,
        start: match.start,
        end: match.end
      });
    }
  }
  output += original.slice(cursor);
  return {
    text: output,
    changed: changes.length > 0,
    changes,
    terms: [...terms]
  };
}

/* ------------------------------------------------------------------ */
/* Sugerencias de nombres propios/entidades                            */
/* ------------------------------------------------------------------ */

function tokenizeWithOffsets(text) {
  const tokens = [];
  const regex = /[\p{L}][\p{L}.'’'-]*|\d{1,6}/gu;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      lower: match[0].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    });
  }
  return tokens;
}

function isCapitalized(token) {
  return /^\p{Lu}/u.test(token.raw);
}

function cueBefore(text, index) {
  const before = text.slice(Math.max(0, index - 48), index).toLowerCase();
  const normalized = before.normalize('NFD').replace(/\p{M}/gu, '');
  return /\b(?:predio|lote|matricula|finca|hacienda|vereda|parcela|senor|sra|srta|sr|doctor|doctora|dr|dra|entidad|empresa|fondo|banco|cliente|proveedor|notaria)\s*$/i.test(normalized);
}

function kindOf(candidate, knownTerm = null, cue = false) {
  const normalized = candidate.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const contextText = `${normalized} ${knownTerm?.context || ''}`;
  if (/\b(predio|finca|hacienda|lote|vereda|parcela)\b/.test(contextText)) return 'predio';
  if (/\b(banco|empresa|fondo|entidad|sas|ltda|cia)\b/.test(contextText)) return 'entidad';
  if (cue) return 'predio';
  return 'nombre';
}

function cleanCandidate(value) {
  // Conserva el punto final de iniciales («C.»), pero limpia comas/espacios y
  // el punto de fin de frase («Ana María Gómez.» → «Ana María Gómez»).
  let candidate = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.-]+/, '')
    .replace(/[\s,;:]+$/, '')
    .trim();
  if (candidate.endsWith('.') && !/(?:^|\s)\p{L}\.$/u.test(candidate)) {
    candidate = candidate.slice(0, -1).trim();
  }
  return candidate;
}

/**
 * Sugiere candidatos a nombres propios/entidades presentes en un texto (acta,
 * correo, transcripción). No inventa: solo devuelve fragmentos del texto y
 * términos del léxico que aparezcan literalmente.
 * @param {string} text
 * @param {{data?:object, limit?:number}} [options]
 * @returns {Array<{candidate:string, confidence:number, kind:string, known:boolean, termId:string|null, occurrences:number}>}
 */
export function suggest(text, { data = store.get(), limit = 10 } = {}) {
  const input = String(text ?? '');
  if (!input.trim()) return [];
  const tokens = tokenizeWithOffsets(input);
  const candidates = new Map();

  const add = (candidateRaw, { known = false, term = null, occurrences = 1, cue = false } = {}) => {
    const candidate = cleanCandidate(candidateRaw);
    if (!candidate) return;
    const key = normalizeKey(candidate);
    if (!key) return;
    const existing = candidates.get(key);
    if (existing) {
      existing.occurrences += occurrences;
      existing.known = existing.known || known;
      existing.termId = existing.termId || term?.id || null;
      existing.confidence = Math.max(existing.confidence, score(candidate, { known, occurrences: existing.occurrences, cue }));
      return;
    }
    candidates.set(key, {
      candidate,
      confidence: score(candidate, { known, occurrences, cue }),
      kind: kindOf(candidate, term, cue),
      known,
      termId: term?.id || null,
      occurrences
    });
  };

  const score = (candidate, { known = false, occurrences = 1, cue = false } = {}) => {
    const words = candidate.split(/\s+/).filter(Boolean).length;
    let value = 0.5;
    if (words >= 2) value += 0.15;
    if (words >= 3) value += 0.08;
    if (cue) value += 0.1;
    value += Math.min(0.12, Math.max(0, occurrences - 1) * 0.04);
    if (known) value = Math.max(value, 0.94);
    return Math.round(Math.min(0.99, value) * 100) / 100;
  };

  // 1) Términos conocidos (aprobados o shadow): aunque estén en minúsculas.
  const knownMatches = selectMatches(rawMatches(input, buildIndex(data, { includeShadow: true })));
  const termsById = new Map(ensureLingo(data).terms.map((term) => [term.id, term]));
  const knownKeys = new Set();
  for (const match of knownMatches) {
    const term = termsById.get(match.id);
    if (!term) continue;
    knownKeys.add(normalizeKey(match.matched));
    add(term.term, { known: true, term, occurrences: 1, cue: cueBefore(input, match.start) });
  }

  // 2) Secuencias de palabras capitalizadas (nombres, predios, entidades).
  for (let index = 0; index < tokens.length; index += 1) {
    const first = tokens[index];
    if (!isCapitalized(first)) continue;
    if (CONNECTORS.has(first.lower)) continue;
    // Solo iniciar en el borde de una secuencia capitalizada, no dentro.
    if (index > 0) {
      const previous = tokens[index - 1];
      const gap = input.slice(previous.end, first.start);
      const sentenceGap = /[.;!?]\s|\n/.test(gap);
      if (isCapitalized(previous) && !sentenceGap) continue;
      if (CONNECTORS.has(previous.lower) && !['y', 'e'].includes(previous.lower) && index > 1 && isCapitalized(tokens[index - 2]) && !sentenceGap) continue;
    }
    let last = index;
    let cursor = index + 1;
    let words = 1;
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      const gap = input.slice(tokens[last].end, token.start);
      if (/[.;!?]\s|\n/.test(gap)) break;
      if (isCapitalized(token)) {
        last = cursor;
        words += 1;
        cursor += 1;
        if (token.raw.endsWith('.') && !/^[A-ZÁÉÍÓÚÑ]\.$/u.test(token.raw)) break;
        continue;
      }
      if (CONNECTORS.has(token.lower)) {
        if (token.lower === 'y' || token.lower === 'e') break;
        const next = tokens[cursor + 1];
        if (next && isCapitalized(next)) {
          last = cursor + 1;
          words += 2;
          cursor += 2;
          if (next.raw.endsWith('.') && !/^[A-ZÁÉÍÓÚÑ]\.$/u.test(next.raw)) break;
          continue;
        }
      }
      if (/^\d{1,6}$/.test(token.raw) && words >= 1) {
        const previous = input.slice(Math.max(0, tokens[last].start - 30), tokens[last].start).toLowerCase();
        if (/lote|predio|matr[ií]cula|finca|parcela|vereda/.test(previous)) {
          last = cursor;
          cursor += 1;
          continue;
        }
      }
      break;
    }
    const candidate = input.slice(first.start, tokens[last].end);
    const cue = cueBefore(input, first.start);
    const isSingleStop = words === 1 && SINGLE_STOP.has(normalizeKey(candidate));
    const key = normalizeKey(candidate);
    if (isSingleStop) continue;
    if (SENTENCE_STARTERS.has(normalizeKey(first.raw)) && !cue) continue;
    if (/^(?:acta|reuni[oó]n|sesi[oó]n|informe|anexo)\b/i.test(candidate) && !cue) continue;
    if (words === 1 && !knownKeys.has(key) && !cue) continue;
    // Evita oraciones enteras: máximo 7 palabras.
    if (words > 7) continue;
    add(candidate, { known: knownKeys.has(key), cue, occurrences: 1 });
  }

  return [...candidates.values()]
    .sort((a, b) => b.confidence - a.confidence || a.candidate.localeCompare(b.candidate, 'es'))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

/* ------------------------------------------------------------------ */
/* Hotwords para ASR                                                   */
/* ------------------------------------------------------------------ */

/**
 * Devuelve el vocabulario aprobado para un contexto, respetando un presupuesto
 * de caracteres. Solo `approved`; los `shadow` no entran.
 *
 * Firma principal: hotwords(ctx, maxChars). También acepta
 * `hotwords({ctx, maxChars, data})` para integraciones.
 *
 * @param {string|{ctx?:string,maxChars?:number,data?:object}} ctxOrOptions
 * @param {number} [maxCharsArg]
 * @param {{data?:object}} [options]
 */
export function hotwords(ctxOrOptions = '', maxCharsArg = DEFAULT_HOTWORDS_MAX_CHARS, options = {}) {
  let ctx = ctxOrOptions;
  let maxChars = maxCharsArg;
  let data = options.data || store.get();
  if (ctxOrOptions && typeof ctxOrOptions === 'object') {
    ctx = ctxOrOptions.ctx || '';
    maxChars = ctxOrOptions.maxChars ?? DEFAULT_HOTWORDS_MAX_CHARS;
    data = ctxOrOptions.data || data;
  }
  const budget = Math.max(MIN_HOTWORDS_MAX_CHARS, Math.min(MAX_HOTWORDS_MAX_CHARS, Math.round(Number(maxChars) || DEFAULT_HOTWORDS_MAX_CHARS)));
  const eligible = listTerms(data, { status: 'approved', ctx: ctx || null, limit: 500 }).items
    .filter((term) => term.status === 'approved')
    .sort((a, b) => (
      (Number(b.uses) || 0) - (Number(a.uses) || 0)
      || (Number(b.corrections) || 0) - (Number(a.corrections) || 0)
      || String(a.term).length - String(b.term).length
      || String(a.term).localeCompare(String(b.term), 'es')
    ));
  const chosen = [];
  let text = '';
  for (const term of eligible) {
    const next = text ? `${text} ${term.term}` : term.term;
    if (next.length > budget) continue;
    chosen.push(term);
    text = next;
  }
  return {
    ctx: ctx ? String(ctx).slice(0, 120) : null,
    maxChars: budget,
    chars: text.length,
    count: chosen.length,
    hotwords: chosen.map((term) => term.term),
    terms: chosen.map(publicTerm),
    truncated: chosen.length < eligible.length,
    eligible: eligible.length
  };
}

/**
 * Aprende una corrección. Delegación directa en `store.learnCorrection`.
 * @param {{original:string, corrected:string, source?:string}} input
 * @param {{data?:object}} [options]
 */
export function learn({ original, corrected, source = 'aprendizaje' } = {}, { data = store.get() } = {}) {
  return learnCorrection(data, { original, corrected, source });
}

export { normalizeKey };

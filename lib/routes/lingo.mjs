/**
 * API de Lingo (léxico único de la oficina).
 *
 *   GET    /api/lingo/terms?status=&ctx=&q=&limit=&offset=
 *   POST   /api/lingo/terms             {term, variants[], context?, sources[]?}
 *   PATCH  /api/lingo/terms/:id         {status:"approved"|"rejected"|"shadow", reason?}
 *   POST   /api/lingo/learn             {original, corrected, source?}
 *   POST   /api/lingo/apply             {text, includeShadow?}
 *   POST   /api/lingo/suggest           {text}
 *   GET    /api/lingo/hotwords?ctx=&maxChars=
 *
 * Auto-descubierto (priority 120), autenticación normal. Las mutaciones pasan
 * por `store.mutate` y dejan `lingo.change` en el ledger de la Oficina al crear
 * o aprobar/rechazar.
 */
import {
  bodyOf, paramOf, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { boolean, isPlainObject, text } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import { store } from '../store.mjs';
import {
  TERM_STATUSES, createOrUpdateTerm, getTerm, listTerms, lingoStats, recordTermUses, setTermStatus
} from '../lingo/store.mjs';
import { applyCanonical, hotwords, learn, suggest } from '../lingo/engine.mjs';

export const name = 'lingo';
export const priority = 120;

const TERM_FIELDS = Object.freeze(['term', 'variants', 'context', 'sources', 'source']);
const PATCH_FIELDS = Object.freeze(['status', 'action', 'reason']);
const LEARN_FIELDS = Object.freeze(['original', 'corrected', 'source']);
const APPLY_FIELDS = Object.freeze(['text', 'includeShadow']);
const SUGGEST_FIELDS = Object.freeze(['text']);
const TERM_ID_RE = /^LG-\d{1,6}$/i;

function assertBody(body, allowed, { allowEmpty = false } = {}) {
  if (!isPlainObject(body)) throw new ValidationError('body', 'INVALID_BODY', 'El cuerpo debe ser un objeto JSON.');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`);
  }
  if (!allowEmpty && Object.keys(body).length === 0) {
    throw new ValidationError('body', 'EMPTY_PATCH', 'El cuerpo no puede estar vacío.');
  }
  return body;
}

function stringArray(value, field, { max = 30, maxLength = 120 } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(field, 'INVALID_TYPE', `${field} debe ser un array de textos.`);
  if (value.length > max) throw new ValidationError(field, 'TOO_LONG', `${field} admite ${max} elementos.`);
  return value.map((item, index) => text(item, {
    field: `${field}[${index}]`, required: true, min: 1, max: maxLength, allowEmpty: false
  }));
}

function statusValue(value, { allowAll = false } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  if (allowAll && raw === 'all') return 'all';
  if (!TERM_STATUSES.includes(raw)) {
    throw new ValidationError('status', 'INVALID_VALUE', `status debe ser uno de: ${TERM_STATUSES.join(', ')}.`);
  }
  return raw;
}

function booleanValue(value, field = 'includeShadow', fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  try {
    return boolean(value, { field });
  } catch {
    throw new ValidationError(field, 'INVALID_TYPE', `${field} debe ser booleano.`);
  }
}

async function termsGet(ctx) {
  const rawStatus = queryString(ctx, 'status', 'all');
  const status = statusValue(rawStatus, { allowAll: true });
  const ctxFilter = queryString(ctx, 'ctx', '') || null;
  const q = queryString(ctx, 'q', '');
  const limit = queryInt(ctx, 'limit', 100, { min: 1, max: 500 });
  const offset = queryInt(ctx, 'offset', 0, { min: 0, max: 100000 });
  const result = listTerms(store.get(), { status, ctx: ctxFilter, q, limit, offset });
  return respond(ctx, 200, { ok: true, ...result, stats: lingoStats(store.get()) });
}

async function termsPost(ctx) {
  const body = assertBody(await bodyOf(ctx), TERM_FIELDS);
  const term = text(body.term, { field: 'term', required: true, min: 2, max: 120, allowEmpty: false });
  const variants = stringArray(body.variants, 'variants', { max: 30, maxLength: 120 }) || [];
  const context = body.context === undefined ? undefined : text(body.context, { field: 'context', max: 120, allowEmpty: true });
  const sourceList = stringArray(body.source === undefined ? undefined : [body.source], 'source', { max: 1, maxLength: 80 }) || [];
  const sources = stringArray(body.sources, 'sources', { max: 20, maxLength: 80 });
  const input = {
    term,
    variants,
    ...(context !== undefined ? { context } : {}),
    sources: [...(sources || []), ...sourceList]
  };
  let result;
  await store.mutate((data) => {
    result = createOrUpdateTerm(data, input, { actor: 'api' });
  }, { label: 'lingo-term' });
  return respond(ctx, result.created ? 201 : 200, {
    ok: true,
    item: result.item,
    created: result.created,
    updated: result.updated,
    stats: lingoStats(store.get())
  });
}

async function termsPatch(ctx) {
  const id = paramOf(ctx, 'id');
  if (!TERM_ID_RE.test(String(id || ''))) throw new ValidationError('id', 'INVALID_FORMAT', 'El id debe ser LG-0001.');
  const body = assertBody(await bodyOf(ctx), PATCH_FIELDS, { allowEmpty: false });
  let status = body.status;
  if (status === undefined && body.action !== undefined) {
    const action = String(body.action).trim().toLowerCase();
    status = action === 'approve' || action === 'aprobar' ? 'approved'
      : action === 'reject' || action === 'rechazar' ? 'rejected'
        : action === 'shadow' || action === 'sombra' ? 'shadow'
          : undefined;
    if (!status) throw new ValidationError('action', 'INVALID_VALUE', 'action debe ser approve, reject o shadow.');
  }
  if (status === undefined) throw new ValidationError('status', 'REQUIRED', 'Envía status o action.');
  const reason = body.reason === undefined ? '' : text(body.reason, { field: 'reason', max: 300, allowEmpty: true });
  let result;
  await store.mutate((data) => {
    result = setTermStatus(data, id, statusValue(status), { actor: 'api', reason });
  }, { label: 'lingo-status' });
  return respond(ctx, 200, {
    ok: true,
    item: result.item,
    changed: result.changed,
    previous: result.previous,
    stats: lingoStats(store.get())
  });
}

async function learnPost(ctx) {
  const body = assertBody(await bodyOf(ctx), LEARN_FIELDS);
  const original = text(body.original, { field: 'original', required: true, min: 2, max: 200, allowEmpty: false });
  const corrected = text(body.corrected, { field: 'corrected', required: true, min: 2, max: 200, allowEmpty: false });
  const source = body.source === undefined ? 'aprendizaje' : text(body.source, { field: 'source', min: 1, max: 80, allowEmpty: false });
  let result;
  await store.mutate((data) => {
    result = learn({ original, corrected, source }, { data });
  }, { label: 'lingo-learn' });
  return respond(ctx, 200, {
    ok: true,
    term: result.item,
    status: result.status,
    corrections: result.corrections,
    promoted: result.promoted,
    created: result.created,
    changed: result.changed,
    stats: lingoStats(store.get())
  });
}

async function applyPost(ctx) {
  const body = assertBody(await bodyOf(ctx), APPLY_FIELDS);
  const value = text(body.text, { field: 'text', required: true, min: 1, max: 20000, allowEmpty: false });
  const includeShadow = booleanValue(body.includeShadow, 'includeShadow', false);
  const result = applyCanonical(value, { data: store.get(), includeShadow });
  let usesRecorded = false;
  if (result.terms.length) {
    try {
      await store.mutate((data) => {
        recordTermUses(data, result.terms);
      }, { label: 'lingo-uses' });
      usesRecorded = true;
    } catch {
      // El texto canónico se devuelve aunque el store sea de solo lectura.
    }
  }
  return respond(ctx, 200, { ok: true, ...result, usesRecorded });
}

async function suggestPost(ctx) {
  const body = assertBody(await bodyOf(ctx), SUGGEST_FIELDS);
  const value = text(body.text, { field: 'text', required: true, min: 1, max: 20000, allowEmpty: false });
  const candidates = suggest(value, { data: store.get() });
  return respond(ctx, 200, { ok: true, candidates, count: candidates.length });
}

async function hotwordsGet(ctx) {
  const ctxFilter = queryString(ctx, 'ctx', '');
  const maxChars = queryInt(ctx, 'maxChars', 400, { min: 16, max: 4000 });
  const result = hotwords(ctxFilter, maxChars, { data: store.get() });
  return respond(ctx, 200, { ok: true, ...result });
}

export const routes = [
  { method: 'GET', path: '/api/lingo/terms', name: 'lingo.terms.list', handler: route(termsGet) },
  { method: 'POST', path: '/api/lingo/terms', name: 'lingo.terms.upsert', handler: route(termsPost) },
  { method: 'PATCH', path: '/api/lingo/terms/:id', name: 'lingo.terms.status', handler: route(termsPatch) },
  { method: 'POST', path: '/api/lingo/learn', name: 'lingo.learn', handler: route(learnPost) },
  { method: 'POST', path: '/api/lingo/apply', name: 'lingo.apply', handler: route(applyPost) },
  { method: 'POST', path: '/api/lingo/suggest', name: 'lingo.suggest', handler: route(suggestPost) },
  { method: 'GET', path: '/api/lingo/hotwords', name: 'lingo.hotwords', handler: route(hotwordsGet) }
];

export { applyCanonical, hotwords, findTerms, suggest, learn } from '../lingo/engine.mjs';

export default { name, priority, routes };

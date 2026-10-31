/**
 * OKR: objetivos con resultados clave y avance calculado.
 *
 * Se guardan en `data.okr.objectives` (máx. 30 objetivos, 10 resultados por
 * objetivo). Cada mutación deja `okr.change` en el ledger de la Oficina.
 */
import { HttpError } from '../http/errors.mjs';
import { appendLedger } from '../office/ledger.mjs';

const MAX_OBJECTIVES = 30;
const MAX_KEY_RESULTS = 10;
const STATUSES = Object.freeze(['active', 'done', 'paused']);
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function ensureOkr(data) {
  if (!data.okr || typeof data.okr !== 'object' || Array.isArray(data.okr)) data.okr = {};
  if (!Array.isArray(data.okr.objectives)) data.okr.objectives = [];
  return data.okr;
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function requireText(value, field, { min = 2, max = 160 } = {}) {
  const text = clean(value, max);
  if (text.length < min) throw new HttpError(400, 'INVALID_VALUE', `${field} debe tener al menos ${min} caracteres.`, { field });
  return text;
}

function optionalText(value, field, max = 80) {
  if (value === undefined || value === null || value === '') return '';
  return clean(value, max);
}

function numberValue(value, field, { min = 0, max = 1e12 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw new HttpError(400, 'INVALID_VALUE', `${field} debe ser un número entre ${min} y ${max}.`, { field });
  }
  return Math.round(numeric * 100) / 100;
}

function statusValue(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!STATUSES.includes(status)) {
    throw new HttpError(400, 'INVALID_VALUE', `status debe ser ${STATUSES.join(', ')}.`, { field: 'status' });
  }
  return status;
}

function quarterValue(value) {
  if (value === undefined || value === null || value === '') return '';
  const quarter = String(value).trim().toUpperCase();
  if (!QUARTER_RE.test(quarter)) {
    throw new HttpError(400, 'INVALID_VALUE', 'quarter debe tener formato AAAA-Q1..Q4.', { field: 'quarter' });
  }
  return quarter;
}

function nextId(prefix, items) {
  let max = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(String(item.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function krProgress(kr) {
  const target = Number(kr.target) || 0;
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(kr.current) || 0) / target * 100));
}

function objectiveProgress(objective) {
  const results = Array.isArray(objective.keyResults) ? objective.keyResults : [];
  if (!results.length) return 0;
  return Math.round(results.reduce((sum, kr) => sum + krProgress(kr), 0) / results.length);
}

function publicKeyResult(kr) {
  return {
    id: kr.id,
    title: kr.title,
    target: kr.target,
    current: kr.current,
    unit: kr.unit,
    progress: Math.round(krProgress(kr)),
    updatedAt: kr.updatedAt
  };
}

function publicObjective(objective) {
  return {
    id: objective.id,
    title: objective.title,
    owner: objective.owner,
    quarter: objective.quarter,
    status: objective.status,
    progress: objectiveProgress(objective),
    keyResults: (objective.keyResults || []).map(publicKeyResult),
    createdAt: objective.createdAt,
    updatedAt: objective.updatedAt
  };
}

function findObjective(data, id) {
  const okr = ensureOkr(data);
  const objective = okr.objectives.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!objective) throw new HttpError(404, 'NOT_FOUND', `No existe el objetivo ${id}.`);
  return objective;
}

function logChange(data, payload) {
  appendLedger(data, { actor: 'okr', action: 'okr.change', payload });
}

export function listObjectives(data, { status = null, q = '' } = {}) {
  const okr = ensureOkr(data);
  const wanted = status ? statusValue(status) : null;
  const query = clean(q, 120).toLowerCase();
  const rows = okr.objectives
    .filter((item) => !wanted || item.status === wanted)
    .filter((item) => {
      if (!query) return true;
      return `${item.title} ${item.owner} ${(item.keyResults || []).map((kr) => kr.title).join(' ')}`.toLowerCase().includes(query);
    })
    .sort((a, b) => (a.status === 'active' ? -1 : 0) - (b.status === 'active' ? -1 : 0)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { items: rows.map(publicObjective), total: okr.objectives.length, count: rows.length, statuses: [...STATUSES] };
}

export function getObjective(data, id) {
  return publicObjective(findObjective(data, id));
}

export function createObjective(data, input = {}) {
  const okr = ensureOkr(data);
  if (okr.objectives.length >= MAX_OBJECTIVES) {
    throw new HttpError(409, 'OKR_LIMIT', `Máximo ${MAX_OBJECTIVES} objetivos.`);
  }
  const now = nowIso();
  const objective = {
    id: nextId('OK', okr.objectives),
    title: requireText(input.title, 'title', { min: 3, max: 160 }),
    owner: optionalText(input.owner, 'owner', 80),
    quarter: quarterValue(input.quarter),
    status: input.status === undefined ? 'active' : statusValue(input.status),
    keyResults: [],
    createdAt: now,
    updatedAt: now
  };
  okr.objectives.push(objective);
  okr.updatedAt = now;
  logChange(data, { change: 'objective_created', objectiveId: objective.id, title: objective.title });
  return publicObjective(objective);
}

export function updateObjective(data, id, input = {}) {
  const objective = findObjective(data, id);
  const before = { title: objective.title, status: objective.status, owner: objective.owner, quarter: objective.quarter };
  if (input.title !== undefined) objective.title = requireText(input.title, 'title', { min: 3, max: 160 });
  if (input.owner !== undefined) objective.owner = optionalText(input.owner, 'owner', 80);
  if (input.quarter !== undefined) objective.quarter = quarterValue(input.quarter);
  if (input.status !== undefined) objective.status = statusValue(input.status);
  objective.updatedAt = nowIso();
  ensureOkr(data).updatedAt = objective.updatedAt;
  logChange(data, { change: 'objective_updated', objectiveId: objective.id, before, after: { title: objective.title, status: objective.status, owner: objective.owner, quarter: objective.quarter } });
  return publicObjective(objective);
}

export function deleteObjective(data, id) {
  const okr = ensureOkr(data);
  const objective = findObjective(data, id);
  okr.objectives = okr.objectives.filter((item) => item !== objective);
  okr.updatedAt = nowIso();
  logChange(data, { change: 'objective_deleted', objectiveId: objective.id, title: objective.title });
  return publicObjective(objective);
}

export function addKeyResult(data, objectiveId, input = {}) {
  const objective = findObjective(data, objectiveId);
  if ((objective.keyResults || []).length >= MAX_KEY_RESULTS) {
    throw new HttpError(409, 'KR_LIMIT', `Máximo ${MAX_KEY_RESULTS} resultados por objetivo.`);
  }
  const now = nowIso();
  const kr = {
    id: nextId('KR', (ensureOkr(data).objectives || []).flatMap((item) => item.keyResults || [])),
    title: requireText(input.title, 'title', { min: 3, max: 160 }),
    target: numberValue(input.target, 'target', { min: 0.01 }),
    current: input.current === undefined ? 0 : numberValue(input.current, 'current'),
    unit: optionalText(input.unit, 'unit', 20) || '%',
    updatedAt: now
  };
  objective.keyResults.push(kr);
  objective.updatedAt = now;
  ensureOkr(data).updatedAt = now;
  logChange(data, { change: 'kr_created', objectiveId: objective.id, krId: kr.id, title: kr.title });
  return publicObjective(objective);
}

export function updateKeyResult(data, objectiveId, krId, input = {}) {
  const objective = findObjective(data, objectiveId);
  const kr = (objective.keyResults || []).find((item) => String(item.id).toLowerCase() === String(krId || '').toLowerCase());
  if (!kr) throw new HttpError(404, 'NOT_FOUND', `No existe el resultado ${krId}.`);
  if (input.title !== undefined) kr.title = requireText(input.title, 'title', { min: 3, max: 160 });
  if (input.target !== undefined) kr.target = numberValue(input.target, 'target', { min: 0.01 });
  if (input.current !== undefined) kr.current = numberValue(input.current, 'current');
  if (input.unit !== undefined) kr.unit = optionalText(input.unit, 'unit', 20) || '%';
  kr.updatedAt = nowIso();
  objective.updatedAt = kr.updatedAt;
  ensureOkr(data).updatedAt = kr.updatedAt;
  logChange(data, { change: 'kr_updated', objectiveId: objective.id, krId: kr.id, current: kr.current, target: kr.target });
  return publicObjective(objective);
}

export function deleteKeyResult(data, objectiveId, krId) {
  const objective = findObjective(data, objectiveId);
  const kr = (objective.keyResults || []).find((item) => String(item.id).toLowerCase() === String(krId || '').toLowerCase());
  if (!kr) throw new HttpError(404, 'NOT_FOUND', `No existe el resultado ${krId}.`);
  objective.keyResults = objective.keyResults.filter((item) => item !== kr);
  objective.updatedAt = nowIso();
  ensureOkr(data).updatedAt = objective.updatedAt;
  logChange(data, { change: 'kr_deleted', objectiveId: objective.id, krId: kr.id, title: kr.title });
  return publicObjective(objective);
}

export function okrStats(data) {
  const okr = ensureOkr(data);
  const objectives = okr.objectives.map(publicObjective);
  const active = objectives.filter((item) => item.status === 'active');
  const average = active.length
    ? Math.round(active.reduce((sum, item) => sum + item.progress, 0) / active.length)
    : 0;
  return {
    total: objectives.length,
    active: active.length,
    done: objectives.filter((item) => item.status === 'done').length,
    paused: objectives.filter((item) => item.status === 'paused').length,
    averageProgress: average,
    atRisk: active.filter((item) => item.progress < 40).map((item) => ({ id: item.id, title: item.title, progress: item.progress })).slice(0, 10)
  };
}

export { ensureOkr, MAX_OBJECTIVES, MAX_KEY_RESULTS, STATUSES };

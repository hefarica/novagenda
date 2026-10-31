/**
 * Tipos de aprobación y solicitudes declarativas.
 *
 * Un tipo define nombre, nivel (N1/N2) y campos. Una solicitud guarda los
 * valores de esos campos y se aprueba o rechaza; todo queda en el ledger.
 * No ejecuta envíos ni sustituye al gate de la Oficina.
 */
import { HttpError } from '../http/errors.mjs';
import { appendLedger } from '../office/ledger.mjs';

const MAX_TYPES = 20;
const MAX_REQUESTS = 1000;
const LEVELS = Object.freeze(['N1', 'N2']);
const TYPES = Object.freeze(['text', 'number', 'date', 'checkbox']);

function ensureApprovals(data) {
  if (!data.approvals || typeof data.approvals !== 'object' || Array.isArray(data.approvals)) data.approvals = {};
  if (!Array.isArray(data.approvals.types)) data.approvals.types = [];
  if (!Array.isArray(data.approvals.requests)) data.approvals.requests = [];
  return data.approvals;
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

function normalizeLevel(value) {
  const level = String(value || 'N2').trim().toUpperCase();
  if (!LEVELS.includes(level)) throw new HttpError(400, 'INVALID_VALUE', `level debe ser ${LEVELS.join(' o ')}.`, { field: 'level' });
  return level;
}

function normalizeSla(value) {
  if (value === undefined || value === null || value === '') return 48;
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new HttpError(400, 'INVALID_VALUE', 'El SLA debe ser un entero entre 1 y 720 horas.', { field: 'slaHours' });
  }
  return hours;
}

function nextId(prefix, items) {
  let max = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(String(item.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function normalizeFieldType(value) {
  const raw = String(value || 'text').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const aliases = { texto: 'text', text: 'text', numero: 'number', number: 'number', fecha: 'date', date: 'date', casilla: 'checkbox', checkbox: 'checkbox', bool: 'checkbox' };
  return aliases[raw] || raw;
}

function parseFields(input) {
  if (typeof input === 'string') {
    return input.split(',').map((piece) => piece.trim()).filter(Boolean).slice(0, 12).map((piece, index) => {
      const [label, type = 'text'] = piece.split(':').map((part) => part.trim());
      return { key: `c${index + 1}`, label: label.slice(0, 80), type: normalizeFieldType(type) };
    });
  }
  if (!Array.isArray(input)) return [];
  return input.slice(0, 12).map((field, index) => ({
    key: `c${index + 1}`,
    label: clean(field?.label || field?.name || `Campo ${index + 1}`, 80),
    type: normalizeFieldType(field?.type)
  }));
}

function validateFields(input) {
  const fields = parseFields(input);
  for (const field of fields) {
    if (!field.label) throw new HttpError(400, 'INVALID_VALUE', 'Cada campo necesita etiqueta.', { field: 'fields' });
    if (!TYPES.includes(field.type)) throw new HttpError(400, 'INVALID_VALUE', `Tipo de campo no válido: ${field.type}.`, { field: 'fields' });
  }
  return fields;
}

function findType(data, id) {
  const type = ensureApprovals(data).types.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!type) throw new HttpError(404, 'NOT_FOUND', `No existe el tipo ${id}.`);
  return type;
}

function findRequest(data, id) {
  const request = ensureApprovals(data).requests.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!request) throw new HttpError(404, 'NOT_FOUND', `No existe la solicitud ${id}.`);
  return request;
}

function publicType(type) {
  return { ...type, fields: type.fields.map((field) => ({ ...field })) };
}

function publicRequest(request, now = Date.now()) {
  const due = request.dueAt ? Date.parse(request.dueAt) : null;
  const overdue = request.status === 'pending' && Number.isFinite(due) && due < now;
  return {
    ...request,
    values: { ...(request.values || {}) },
    overdue,
    overdueHours: overdue ? Math.max(1, Math.round((now - due) / 3600000)) : 0
  };
}

function coerce(column, value) {
  if (column.type === 'number') {
    if (value === '' || value === undefined || value === null) return '';
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(400, 'INVALID_VALUE', `«${column.label}» debe ser un número.`, { field: column.key });
    return number;
  }
  if (column.type === 'date') {
    const text = String(value || '').trim();
    if (!text) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T12:00:00Z`))) {
      throw new HttpError(400, 'INVALID_VALUE', `«${column.label}» debe ser AAAA-MM-DD.`, { field: column.key });
    }
    return text;
  }
  if (column.type === 'checkbox') return value === true || value === 'true' || value === 'on' || value === 1 || value === '1' || value === 'sí' || value === 'si';
  return clean(value, 500);
}

export function listTypes(data) {
  return { items: ensureApprovals(data).types.map(publicType), count: ensureApprovals(data).types.length, levels: [...LEVELS] };
}

export function createType(data, input = {}) {
  const approvals = ensureApprovals(data);
  if (approvals.types.length >= MAX_TYPES) throw new HttpError(409, 'TYPE_LIMIT', `Máximo ${MAX_TYPES} tipos.`);
  const now = nowIso();
  const type = {
    id: nextId('APT', approvals.types),
    name: requireText(input.name, 'name', { min: 2, max: 80 }),
    description: clean(input.description, 240),
    level: normalizeLevel(input.level),
    slaHours: normalizeSla(input.slaHours),
    fields: validateFields(input.fields),
    active: true,
    createdAt: now,
    updatedAt: now
  };
  approvals.types.push(type);
  approvals.updatedAt = now;
  appendLedger(data, { actor: 'approvals', action: 'approval.change', payload: { change: 'type_created', typeId: type.id, name: type.name } });
  return publicType(type);
}

export function updateType(data, id, input = {}) {
  const type = findType(data, id);
  if (input.name !== undefined) type.name = requireText(input.name, 'name', { min: 2, max: 80 });
  if (input.description !== undefined) type.description = clean(input.description, 240);
  if (input.level !== undefined) type.level = normalizeLevel(input.level);
  if (input.slaHours !== undefined) type.slaHours = normalizeSla(input.slaHours);
  type.updatedAt = nowIso();
  ensureApprovals(data).updatedAt = type.updatedAt;
  appendLedger(data, { actor: 'approvals', action: 'approval.change', payload: { change: 'type_updated', typeId: type.id, name: type.name } });
  return publicType(type);
}

export function deleteType(data, id) {
  const approvals = ensureApprovals(data);
  const type = findType(data, id);
  approvals.types = approvals.types.filter((item) => item !== type);
  approvals.updatedAt = nowIso();
  appendLedger(data, { actor: 'approvals', action: 'approval.change', payload: { change: 'type_deleted', typeId: type.id, name: type.name } });
  return publicType(type);
}

export function listRequests(data, { status = null } = {}) {
  const approvals = ensureApprovals(data);
  const wanted = status ? String(status).toLowerCase() : null;
  const items = approvals.requests
    .filter((request) => !wanted || request.status === wanted)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((request) => publicRequest(request));
  return { items, count: items.length, pending: approvals.requests.filter((item) => item.status === 'pending').length };
}

export function createRequest(data, input = {}) {
  const approvals = ensureApprovals(data);
  if (approvals.requests.length >= MAX_REQUESTS) throw new HttpError(409, 'REQUEST_LIMIT', `Máximo ${MAX_REQUESTS} solicitudes.`);
  const type = findType(data, input.typeId);
  if (type.active === false) throw new HttpError(409, 'TYPE_INACTIVE', 'El tipo está inactivo.');
  const raw = input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
  const values = {};
  for (const field of type.fields) {
    const value = coerce(field, raw[field.key]);
    if (field.type !== 'checkbox' && (value === '' || value === undefined || value === null)) {
      throw new HttpError(400, 'INVALID_VALUE', `Falta el campo «${field.label}».`, { field: field.key });
    }
    values[field.key] = value;
  }
  const now = nowIso();
  const request = {
    id: nextId('APR', approvals.requests),
    typeId: type.id,
    typeName: type.name,
    title: requireText(input.title || type.name, 'title', { min: 2, max: 160 }),
    level: type.level,
    values,
    status: 'pending',
    createdAt: now,
    dueAt: new Date(Date.parse(now) + type.slaHours * 3600000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    reason: ''
  };
  approvals.requests.push(request);
  approvals.updatedAt = now;
  appendLedger(data, { actor: 'approvals', action: 'approval.change', payload: { change: 'request_created', requestId: request.id, typeId: type.id, level: type.level } });
  return publicRequest(request);
}

export function decideRequest(data, id, { decision = 'approved', by = 'owner', reason = '' } = {}) {
  const request = findRequest(data, id);
  if (request.status !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', 'La solicitud ya fue decidida.');
  const next = String(decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(next)) throw new HttpError(400, 'INVALID_VALUE', 'decision debe ser approved o rejected.', { field: 'decision' });
  request.status = next;
  request.decidedAt = nowIso();
  request.decidedBy = clean(by, 80) || 'owner';
  request.reason = clean(reason, 500);
  ensureApprovals(data).updatedAt = request.decidedAt;
  appendLedger(data, { actor: request.decidedBy, action: 'approval.change', payload: { change: `request_${next}`, requestId: request.id, reason: request.reason } });
  return publicRequest(request);
}

export function approvalsStats(data) {
  const approvals = ensureApprovals(data);
  return {
    types: approvals.types.length,
    requests: approvals.requests.length,
    pending: approvals.requests.filter((item) => item.status === 'pending').length,
    approved: approvals.requests.filter((item) => item.status === 'approved').length,
    rejected: approvals.requests.filter((item) => item.status === 'rejected').length,
    overdue: approvals.requests.filter((item) => publicRequest(item).overdue).length
  };
}

export { ensureApprovals, MAX_TYPES, MAX_REQUESTS, LEVELS };


/**
 * Estado y auditoría del ACL.
 *
 * Modelo (creado perezosamente, sin migración):
 *   data.acl = {
 *     documents: { [docId]: { label, owner, updatedAt, by } },
 *     defaults: { document:'interno', proposal:'interno' },
 *     ledger: [ { seq, ts, actor, action:'acl.change'|'acl.defaults', payload } ]
 *   }
 *
 * Cada cambio se replica en el ledger de la oficina (`data.office.ledger`,
 * acción `acl.change`) para que la auditoría existente lo vea. Si la oficina
 * no está disponible, el ledger propio de ACL conserva el registro.
 */

import { appendLedger } from '../office/ledger.mjs';
import {
  AclError, DEFAULT_ACL_DEFAULTS, isPlainObject, normalizeKind, normalizeLabel
} from './constants.mjs';

export const MAX_ACL_DOCUMENTS = 5000;
export const MAX_ACL_LEDGER = 5000;

function nowIso() {
  return new Date().toISOString();
}

export function ensureAclState(data) {
  if (!isPlainObject(data.acl)) data.acl = {};
  if (!isPlainObject(data.acl.documents) || Array.isArray(data.acl.documents)) data.acl.documents = {};
  if (!isPlainObject(data.acl.defaults) || Array.isArray(data.acl.defaults)) data.acl.defaults = { ...DEFAULT_ACL_DEFAULTS };
  data.acl.defaults.document = normalizeLabel(data.acl.defaults.document) || DEFAULT_ACL_DEFAULTS.document;
  data.acl.defaults.proposal = normalizeLabel(data.acl.defaults.proposal) || DEFAULT_ACL_DEFAULTS.proposal;
  if (!Array.isArray(data.acl.ledger)) data.acl.ledger = [];
  if (!Array.isArray(data.acl.ownDomains)) data.acl.ownDomains = [];
  if (!Array.isArray(data.acl.internalContacts)) data.acl.internalContacts = [];
  return data.acl;
}

export function defaultsOf(data) {
  const acl = ensureAclState(data);
  return { document: acl.defaults.document, proposal: acl.defaults.proposal };
}

export function getDocumentRecord(data, docId) {
  const acl = ensureAclState(data);
  const key = String(docId ?? '').trim();
  if (!key) return null;
  const record = acl.documents[key];
  if (!record || typeof record !== 'object') return null;
  return {
    docId: key,
    label: normalizeLabel(record.label),
    owner: record.owner ?? null,
    updatedAt: record.updatedAt || null,
    by: record.by || null
  };
}

/**
 * Etiqueta efectiva: la del documento o el default del tipo.
 * @param {any} data
 * @param {string} docId
 * @param {'document'|'proposal'} [kind]
 */
export function effectiveLabel(data, docId, kind = 'document') {
  const normalizedKind = normalizeKind(kind);
  const defaults = defaultsOf(data);
  const record = getDocumentRecord(data, docId);
  if (record?.label) {
    return { docId: String(docId), label: record.label, source: 'document', record };
  }
  return {
    docId: String(docId || '').trim() || null,
    label: defaults[normalizedKind] || 'interno',
    source: 'default',
    record: null
  };
}

export function publicDocument(data, docId) {
  const record = getDocumentRecord(data, docId);
  const effective = effectiveLabel(data, docId, 'document');
  return {
    docId: String(docId),
    label: record?.label || null,
    effectiveLabel: effective.label,
    source: effective.source,
    owner: record?.owner ?? null,
    updatedAt: record?.updatedAt ?? null,
    by: record?.by ?? null
  };
}

function appendAclAudit(data, { actor, action, payload }) {
  const acl = ensureAclState(data);
  const ts = nowIso();
  const record = {
    seq: acl.ledger.length + 1,
    ts,
    actor: String(actor || 'api').slice(0, 80),
    action,
    payload: { ...payload }
  };
  acl.ledger.push(record);
  if (acl.ledger.length > MAX_ACL_LEDGER) acl.ledger = acl.ledger.slice(-MAX_ACL_LEDGER);
  try {
    // Auditoría principal de la oficina: misma acción acl.change. Es una llamada
    // a un servicio existente, no se modifica lib/office/**.
    appendLedger(data, { actor: record.actor, action, payload: { ...payload } });
  } catch { /* el ledger propio de ACL sigue siendo la fuente local */ }
  return record;
}

/**
 * Etiqueta un documento y registra `acl.change`.
 * @param {any} data
 * @param {string} docId
 * @param {{label:string, owner?:string, by?:string}} input
 */
export function setDocumentLabel(data, docId, input = {}) {
  const key = String(docId ?? '').trim();
  if (!key || key.length > 200) {
    throw new AclError(400, 'VALIDATION', 'docId es requerido (máx. 200 caracteres)', { field: 'docId' });
  }
  const label = normalizeLabel(input.label);
  if (!label) {
    throw new AclError(400, 'VALIDATION', 'label debe ser público, interno o reservado', { field: 'label' });
  }
  const by = String(input.by || 'api').slice(0, 80);
  const acl = ensureAclState(data);
  const previous = acl.documents[key];
  const owner = String(input.owner ?? previous?.owner ?? by).slice(0, 200);
  const updatedAt = nowIso();
  const record = { label, owner, updatedAt, by };
  acl.documents[key] = record;
  if (Object.keys(acl.documents).length > MAX_ACL_DOCUMENTS) {
    // Conserva los más recientes por updatedAt; el resto se poda.
    const entries = Object.entries(acl.documents)
      .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')));
    acl.documents = Object.fromEntries(entries.slice(0, MAX_ACL_DOCUMENTS));
  }
  appendAclAudit(data, {
    actor: by,
    action: 'acl.change',
    payload: {
      docId: key,
      label,
      previousLabel: normalizeLabel(previous?.label) || null,
      owner,
      updatedAt
    }
  });
  return {
    docId: key,
    label,
    owner,
    updatedAt,
    by,
    previousLabel: normalizeLabel(previous?.label) || null
  };
}

/**
 * Cambia defaults y registra `acl.defaults`.
 * @param {any} data
 * @param {{document?:string, proposal?:string}} patch
 */
export function setDefaults(data, patch = {}, { by = 'api' } = {}) {
  const acl = ensureAclState(data);
  const before = { ...acl.defaults };
  const next = { ...acl.defaults };
  let changed = false;
  for (const kind of ['document', 'proposal']) {
    if (patch[kind] === undefined) continue;
    const label = normalizeLabel(patch[kind]);
    if (!label) {
      throw new AclError(400, 'VALIDATION', `defaults.${kind} debe ser público, interno o reservado`, { field: `defaults.${kind}` });
    }
    next[kind] = label;
    changed = true;
  }
  if (!changed) {
    throw new AclError(400, 'VALIDATION', 'Indica defaults.document y/o defaults.proposal', { field: 'defaults' });
  }
  acl.defaults = next;
  const actor = String(by || 'api').slice(0, 80);
  appendAclAudit(data, {
    actor,
    action: 'acl.defaults',
    payload: { before, after: { ...next } }
  });
  return { ...next };
}

export function listDocumentLabels(data, { limit = 200 } = {}) {
  const acl = ensureAclState(data);
  const size = Math.max(1, Math.min(MAX_ACL_DOCUMENTS, Number(limit) || 200));
  return Object.entries(acl.documents)
    .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
    .slice(0, size)
    .map(([docId, record]) => ({
      docId,
      label: normalizeLabel(record?.label),
      owner: record?.owner ?? null,
      updatedAt: record?.updatedAt ?? null,
      by: record?.by ?? null
    }));
}

export function aclLedger(data) {
  return ensureAclState(data).ledger;
}

/**
 * Contexto de clasificación de destinatarios para el ACL.
 *
 * Fuentes de dominios propios (en orden, se unen):
 *   - cuentas Google conectadas (`data.googleConnections[].email`),
 *   - `data.office.ownDomains`, `data.acl.ownDomains`, `data.settings.ownDomains`,
 *   - `OFFICE_OWN_DOMAINS` y `ACL_OWN_DOMAINS` (coma-separados).
 *
 * Contactos internos explícitos (no se deduce de «conocido»):
 *   - `data.acl.internalContacts`, `data.office.internalContacts`,
 *   - `ACL_INTERNAL_CONTACTS`, `OFFICE_INTERNAL_CONTACTS`.
 *
 * `data.office.contacts` y los asistentes de agenda son «conocidos», pero por
 * defecto NO se convierten en internos: un contacto externo conocido sigue
 * siendo externo para evitar fugas. Se puede activar explícitamente con
 * `data.acl.knownContactsAreInternal = true` (no recomendado).
 */

import { collectKnownContacts, collectOwnDomains } from '../office/contacts.mjs';
import { store } from '../store.mjs';
import { normalizeLabel } from './constants.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function splitList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,;\s]+/);
  return [];
}

function addDomains(target, value) {
  for (const item of splitList(value)) {
    const domain = String(item || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (domain) target.add(domain);
  }
}

function addContacts(target, value) {
  for (const item of splitList(value)) {
    const raw = String(item || '').trim().toLowerCase();
    if (!raw) continue;
    const email = raw.startsWith('email:') ? raw.slice(6) : raw;
    if (!EMAIL_RE.test(email)) continue;
    target.add(email);
    target.add(`email:${email}`);
  }
}

function defaultsFrom(data) {
  const raw = data?.acl?.defaults;
  return {
    document: normalizeLabel(raw?.document) || 'interno',
    proposal: normalizeLabel(raw?.proposal) || 'interno'
  };
}

/**
 * Construye un contexto inmutable a partir de un snapshot de datos.
 * @param {any} data
 */
export function contextFromData(data = {}) {
  const ownDomains = new Set();
  for (const domain of collectOwnDomains(data || {})) ownDomains.add(domain);
  addDomains(ownDomains, data?.acl?.ownDomains);
  addDomains(ownDomains, data?.settings?.ownDomains);
  addDomains(ownDomains, process.env.ACL_OWN_DOMAINS);
  addDomains(ownDomains, process.env.OFFICE_OWN_DOMAINS);

  const internalContacts = new Set();
  addContacts(internalContacts, data?.acl?.internalContacts);
  addContacts(internalContacts, data?.office?.internalContacts);
  addContacts(internalContacts, process.env.ACL_INTERNAL_CONTACTS);
  addContacts(internalContacts, process.env.OFFICE_INTERNAL_CONTACTS);

  const knownContacts = collectKnownContacts(data || {});
  for (const item of splitList(data?.acl?.knownContacts)) {
    const email = String(item || '').trim().toLowerCase();
    if (email) knownContacts.add(email.startsWith('email:') ? email : `email:${email}`);
  }

  return Object.freeze({
    ownDomains,
    internalContacts,
    knownContacts,
    knownAsInternal: data?.acl?.knownContactsAreInternal === true || data?.acl?.knownAsInternal === true,
    defaults: Object.freeze(defaultsFrom(data))
  });
}

let override = null;

/** Contexto de prueba/configuración sin depender del store. */
export function setAclConfig(config = {}) {
  override = {
    ownDomains: new Set(splitList(config.ownDomains).map((value) => String(value).toLowerCase().replace(/^@/, ''))),
    internalContacts: new Set(),
    knownContacts: new Set(),
    knownAsInternal: config.knownAsInternal === true,
    defaults: {
      document: normalizeLabel(config.defaults?.document) || 'interno',
      proposal: normalizeLabel(config.defaults?.proposal) || 'interno'
    }
  };
  addContacts(override.internalContacts, config.internalContacts);
  addContacts(override.knownContacts, config.knownContacts);
  return loadContext();
}

export function resetAclConfig() {
  override = null;
}

/** Contexto actual: override de test o snapshot del store. */
export function loadContext() {
  if (override) return override;
  return contextFromData(store.get());
}

export function normalizeEmail(value) {
  const text = String(value || '').trim().replace(/^mailto:/i, '');
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(text);
  const candidate = (angle ? angle[1] : text).trim().toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

/** Serializa el contexto para /api/acl/status y /policy sin Sets. */
export function serializeContext(context = loadContext()) {
  return {
    ownDomains: [...context.ownDomains].sort(),
    internalContacts: [...context.internalContacts].filter((value) => !value.startsWith('email:')).sort(),
    knownContacts: context.knownContacts.size,
    knownContactsAreInternal: context.knownAsInternal === true
  };
}

export { EMAIL_RE };

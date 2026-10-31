/**
 * Rutas de identidad multicorreo.
 *
 *   GET  /api/identity/people?q=&limit=   → grafo de personas (búsqueda)
 *   POST /api/identity/resolve {name|email} → {candidates, requiresConfirmation}
 *   POST /api/identity/expand {query}     → {people, recipients, duplicatesRemoved}
 *   POST /api/identity/contacts {name, emails[], aliases?, note?} → mapeo manual
 *
 * Fuentes locales primero; Gmail solo si hay conexión (sin red en este módulo).
 */
import {
  bodyOf, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { isPlainObject, text } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import { store } from '../store.mjs';
import {
  buildIdentityGraph, expandRecipients, listPeople, resolveIdentity
} from '../identity/resolve.mjs';
import { fold } from '../style/features.mjs';

export const name = 'identity';
export const priority = 120;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESOLVE_FIELDS = Object.freeze(['name', 'email']);
const EXPAND_FIELDS = Object.freeze(['query']);
const CONTACT_FIELDS = Object.freeze(['name', 'emails', 'aliases', 'note']);

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

function emailsValue(value, field = 'emails', { required = true } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new ValidationError(field, 'INVALID_TYPE', `${field} debe ser un array de correos.`);
  if (value.length === 0 && required) throw new ValidationError(field, 'REQUIRED', `${field} necesita al menos un correo.`);
  if (value.length > 10) throw new ValidationError(field, 'TOO_LONG', `${field} admite 10 correos.`);
  return value.map((email, index) => {
    const clean = text(email, { field: `${field}[${index}]`, required: true, max: 254, allowEmpty: false }).toLowerCase();
    if (!EMAIL_RE.test(clean)) throw new ValidationError(`${field}[${index}]`, 'INVALID_FORMAT', `Correo inválido: ${clean}`);
    return clean;
  });
}

function peopleGet(ctx) {
  const q = queryString(ctx, 'q', '');
  const limit = queryInt(ctx, 'limit', 50, { min: 1, max: 100 });
  return respond(ctx, 200, listPeople({ q, limit }, { data: store.get() }));
}

async function resolvePost(ctx) {
  const input = assertBody(await bodyOf(ctx), RESOLVE_FIELDS, { allowEmpty: true });
  const name = input.name === undefined ? null : text(input.name, { field: 'name', max: 120, allowEmpty: false });
  let email = null;
  if (input.email !== undefined) {
    email = text(input.email, { field: 'email', max: 254, allowEmpty: false }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('email', 'INVALID_FORMAT', `Correo inválido: ${email}`);
  }
  if (!name && !email) throw new ValidationError('name', 'REQUIRED', 'Envía name o email para resolver la identidad.');
  const result = resolveIdentity({ name, email }, { data: store.get() });
  return respond(ctx, 200, result);
}

async function expandPost(ctx) {
  const input = assertBody(await bodyOf(ctx), EXPAND_FIELDS);
  const query = text(input.query, { field: 'query', required: true, max: 200, min: 2, allowEmpty: false });
  const result = expandRecipients({ query }, { data: store.get() });
  return respond(ctx, 200, result);
}

async function contactsPost(ctx) {
  const input = assertBody(await bodyOf(ctx), CONTACT_FIELDS);
  const name = text(input.name, { field: 'name', required: true, max: 120, min: 2, allowEmpty: false });
  const emails = emailsValue(input.emails, 'emails', { required: true });
  const aliases = [];
  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases)) throw new ValidationError('aliases', 'INVALID_TYPE', 'aliases debe ser un array.');
    if (input.aliases.length > 10) throw new ValidationError('aliases', 'TOO_LONG', 'aliases admite 10 nombres.');
    for (const [index, alias] of input.aliases.entries()) {
      aliases.push(text(alias, { field: `aliases[${index}]`, max: 120, allowEmpty: false }));
    }
  }
  const note = input.note === undefined ? '' : text(input.note, { field: 'note', max: 500, allowEmpty: true });
  let saved = null;
  let total = 0;
  await store.mutate((data) => {
    if (!isPlainObject(data.identity)) data.identity = {};
    if (!Array.isArray(data.identity.contacts)) data.identity.contacts = [];
    const key = fold(name);
    const existing = data.identity.contacts.find((entry) => entry && fold(entry.name || '') === key);
    if (existing) {
      const set = new Set([...(Array.isArray(existing.emails) ? existing.emails : []), ...emails]);
      existing.emails = [...set];
      existing.aliases = [...new Set([...(Array.isArray(existing.aliases) ? existing.aliases : []), ...aliases])];
      if (note) existing.note = note;
      existing.updatedAt = new Date().toISOString();
      saved = existing;
    } else {
      saved = { name, emails, aliases, note, updatedAt: new Date().toISOString() };
      data.identity.contacts.push(saved);
    }
    total = data.identity.contacts.length;
  }, { label: 'identity-contact' });
  return respond(ctx, 200, { ok: true, contact: saved, total });
}

export const routes = [
  { method: 'GET', path: '/api/identity/people', name: 'identity.people', handler: route(peopleGet) },
  { method: 'POST', path: '/api/identity/resolve', name: 'identity.resolve', handler: route(resolvePost) },
  { method: 'POST', path: '/api/identity/expand', name: 'identity.expand', handler: route(expandPost) },
  { method: 'POST', path: '/api/identity/contacts', name: 'identity.contacts.create', handler: route(contactsPost) }
];

export { buildIdentityGraph };

export default { name, priority, routes };

/**
 * Contactos conocidos y detección de destinatarios externos.
 *
 * Fuentes de "conocido":
 *   - `data.office.contacts` (aprendidos al aprobar una propuesta),
 *   - asistentes de la agenda (`event.attendees`),
 *   - cuentas de Google conectadas.
 *
 * Una dirección de correo es externa si su dominio no es propio (dominios de las
 * cuentas Google conectadas, `data.office.ownDomains` o `OFFICE_OWN_DOMAINS`).
 * Teléfonos y URLs se consideran externos por naturaleza.
 */
import { isPlainObject } from '../validate.mjs';
import { MAX_CONTACTS } from './state.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PHONE_RE = /^\+?[\d\s().-]{7,25}$/;

/**
 * Normaliza un destinatario (correo, teléfono, URL o texto).
 * @param {unknown} value
 * @returns {{raw:string,key:string,type:'email'|'phone'|'url'|'text',address:string}|null}
 */
export function normalizeRecipient(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (EMAIL_RE.test(raw)) {
    const address = raw.toLowerCase();
    return { raw, key: `email:${address}`, type: 'email', address };
  }
  if (URL_RE.test(raw)) {
    const address = raw.toLowerCase();
    return { raw, key: `url:${address}`, type: 'url', address };
  }
  if (PHONE_RE.test(raw)) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7) {
      return { raw, key: `phone:${digits.slice(-10)}`, type: 'phone', address: digits };
    }
  }
  const address = raw.toLowerCase();
  return { raw, key: `text:${address}`, type: 'text', address };
}

/** @param {unknown} value @returns {string|null} */
export function recipientKey(value) {
  const normalized = normalizeRecipient(value);
  return normalized ? normalized.key : null;
}

/**
 * @param {any} data
 * @returns {Set<string>} dominios propios en minúsculas
 */
export function collectOwnDomains(data) {
  const domains = new Set();
  const addEmailDomain = (email) => {
    const value = String(email || '').trim().toLowerCase();
    const at = value.lastIndexOf('@');
    if (at > 0) domains.add(value.slice(at + 1));
  };
  for (const connection of Array.isArray(data?.googleConnections) ? data.googleConnections : []) {
    addEmailDomain(connection?.email);
  }
  const extra = [
    ...(Array.isArray(data?.office?.ownDomains) ? data.office.ownDomains : []),
    ...String(process.env.OFFICE_OWN_DOMAINS || '').split(',')
  ];
  for (const item of extra) {
    const value = String(item || '').trim().toLowerCase().replace(/^@/, '');
    if (value) domains.add(value);
  }
  return domains;
}

/**
 * @param {any} data
 * @returns {Set<string>} claves normalizadas de contactos conocidos
 */
export function collectKnownContacts(data) {
  const known = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const raw = value.trim();
    if (/^(email|phone|url|text):/.test(raw)) {
      known.add(raw.toLowerCase());
      return;
    }
    const normalized = normalizeRecipient(raw);
    if (normalized) known.add(normalized.key);
  };
  for (const contact of Array.isArray(data?.office?.contacts) ? data.office.contacts : []) add(contact);
  for (const event of Array.isArray(data?.agenda) ? data.agenda : []) {
    for (const attendee of Array.isArray(event?.attendees) ? event.attendees : []) add(attendee);
  }
  for (const connection of Array.isArray(data?.googleConnections) ? data.googleConnections : []) add(connection?.email);
  return known;
}

/**
 * @param {any} data
 * @param {unknown} value
 * @returns {'email'|'phone'|'url'|'text'|null}
 */
export function recipientType(data, value) {
  const normalized = normalizeRecipient(value);
  return normalized ? normalized.type : null;
}

/**
 * ¿El destinatario está fuera de la organización?
 * @param {any} data
 * @param {unknown} value
 * @param {Set<string>} [ownDomains]
 */
export function isExternalRecipient(data, value, ownDomains = null) {
  const normalized = normalizeRecipient(value);
  if (!normalized) return false;
  if (normalized.type !== 'email') return true;
  const domains = ownDomains || collectOwnDomains(data);
  const domain = normalized.address.split('@').pop();
  return !domains.has(domain);
}

/**
 * @param {string[]} recipients
 * @param {Set<string>} knownContacts
 */
export function knownContactFor(recipients, knownContacts) {
  const list = Array.isArray(recipients) ? recipients : [];
  if (!list.length) return true;
  return list.every((recipient) => {
    const key = recipientKey(recipient);
    return key ? knownContacts.has(key) : false;
  });
}

/**
 * Aprende contactos aprobados (solo se llama con decisión humana).
 * @param {any} data
 * @param {string[]} recipients
 * @returns {number} añadidos
 */
export function learnContacts(data, recipients) {
  if (!isPlainObject(data.office)) data.office = {};
  if (!Array.isArray(data.office.contacts)) data.office.contacts = [];
  const existing = new Set(data.office.contacts.map((item) => String(item).toLowerCase()));
  let added = 0;
  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const key = recipientKey(recipient);
    if (!key || existing.has(key)) continue;
    data.office.contacts.push(key);
    existing.add(key);
    added += 1;
  }
  if (data.office.contacts.length > MAX_CONTACTS) {
    data.office.contacts = data.office.contacts.slice(-MAX_CONTACTS);
  }
  return added;
}

/**
 * Resumen para la tarjeta/ledger (sin cuerpos completos).
 * @param {string[]} recipients
 */
export function recipientsSummary(recipients) {
  const list = Array.isArray(recipients) ? recipients : [];
  return { count: list.length, preview: list.slice(0, 5) };
}

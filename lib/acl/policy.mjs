/**
 * Política ACL determinista.
 *
 * No envía nada ni muta estado: decide si un contenido con una etiqueta puede
 * salir por un canal a una lista de destinatarios. La integración (channel,
 * docs, office) debe llamar a `guardOutbound` en el follow-up.
 */

import { normalizeRecipient } from '../office/contacts.mjs';
import {
  ACL_VERSION, AclError, DEFAULT_ACL_DEFAULTS, LABELS, normalizeKind, normalizeLabel
} from './constants.mjs';
import {
  EMAIL_RE, contextFromData, loadContext, normalizeEmail
} from './context.mjs';

function asSet(value, transform = (item) => item) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(transform));
  return new Set();
}

function coerceContext(context) {
  if (!context) return loadContext();
  if (context.ownDomains instanceof Set || context.internalContacts instanceof Set) {
    return {
      ownDomains: asSet(context.ownDomains, (value) => String(value).toLowerCase().replace(/^@/, '')),
      internalContacts: asSet(context.internalContacts, (value) => String(value).toLowerCase()),
      knownContacts: asSet(context.knownContacts, (value) => String(value).toLowerCase()),
      knownAsInternal: context.knownAsInternal === true,
      defaults: {
        document: normalizeLabel(context.defaults?.document) || DEFAULT_ACL_DEFAULTS.document,
        proposal: normalizeLabel(context.defaults?.proposal) || DEFAULT_ACL_DEFAULTS.proposal
      }
    };
  }
  if (context.ownDomains || context.internalContacts || context.knownContacts) {
    return {
      ownDomains: asSet(context.ownDomains, (value) => String(value).toLowerCase().replace(/^@/, '')),
      internalContacts: asSet(context.internalContacts, (value) => String(value).toLowerCase()),
      knownContacts: asSet(context.knownContacts, (value) => String(value).toLowerCase()),
      knownAsInternal: context.knownAsInternal === true,
      defaults: {
        document: normalizeLabel(context.defaults?.document) || DEFAULT_ACL_DEFAULTS.document,
        proposal: normalizeLabel(context.defaults?.proposal) || DEFAULT_ACL_DEFAULTS.proposal
      }
    };
  }
  if (context.acl || context.office || context.settings || context.googleConnections || context.agenda) {
    return contextFromData(context);
  }
  return context;
}

function recipientValue(value) {
  if (value && typeof value === 'object') {
    return value.email ?? value.address ?? value.raw ?? value.value ?? '';
  }
  return value;
}

function normalizeRecipientEntry(value) {
  let raw = String(recipientValue(value) || '').trim();
  if (!raw) return null;
  raw = raw.replace(/^mailto:/i, '');
  const directEmail = normalizeEmail(raw);
  if (directEmail) {
    return { raw, key: `email:${directEmail}`, type: 'email', email: directEmail, address: directEmail };
  }
  const normalized = normalizeRecipient(raw);
  if (!normalized) return null;
  const email = normalized.type === 'email' ? normalizeEmail(normalized.address) : null;
  return {
    raw,
    key: normalized.key,
    type: normalized.type,
    email,
    address: normalized.address
  };
}

/**
 * Clasificación detallada (útil para auditoría/UI).
 * @param {unknown} email
 * @param {any} [context] contexto de `contextFromData` o snapshot de datos
 * @returns {{type:'interno'|'externo', email:string|null, domain:string|null, known:boolean, internal:boolean}}
 */
export function classifyRecipientDetailed(email, context = null) {
  const ctx = coerceContext(context);
  const address = normalizeEmail(email);
  if (!address) return { type: 'externo', email: null, domain: null, known: false, internal: false };
  const domain = address.split('@').pop();
  const internal = ctx.ownDomains.has(domain)
    || ctx.internalContacts.has(address)
    || ctx.internalContacts.has(`email:${address}`);
  const known = ctx.knownContacts.has(`email:${address}`) || ctx.knownContacts.has(address);
  const type = internal || (ctx.knownAsInternal && known) ? 'interno' : 'externo';
  return { type, email: address, domain, known, internal };
}

/**
 * @param {unknown} email
 * @param {any} [context]
 * @returns {'interno'|'externo'}
 */
export function classifyRecipient(email, context = null) {
  return classifyRecipientDetailed(email, context).type;
}

/**
 * @param {unknown} recipients
 * @param {any} context
 */
export function classifyRecipients(recipients, context = null) {
  const ctx = coerceContext(context);
  const sourceValues = Array.isArray(recipients)
    ? recipients
    : (recipients === undefined || recipients === null
      ? []
      : (typeof recipients === 'string' && /[,;]/.test(recipients) ? recipients.split(/[,;]+/) : [recipients]));
  const values = sourceValues;
  const seen = new Set();
  const list = [];
  for (const value of values) {
    const entry = normalizeRecipientEntry(value);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const detail = entry.email
      ? classifyRecipientDetailed(entry.email, ctx)
      : { type: 'externo', email: null, domain: null, known: false, internal: false };
    list.push({ ...entry, type: detail.type, known: detail.known, internal: detail.internal });
  }
  return list;
}

function normalizeConfirmed(value) {
  return value === true || value === 1 || value === '1'
    || String(value || '').trim().toLowerCase() === 'true'
    || String(value || '').trim().toLowerCase() === 'si'
    || String(value || '').trim().toLowerCase() === 'sí';
}

function defaultLabelFor(context, kind) {
  return context.defaults?.[kind] || DEFAULT_ACL_DEFAULTS[kind] || 'interno';
}

/**
 * Decide la salida de un contenido.
 *
 * @param {{label?:string|null,channel?:string,recipients?:string[]|string,confirmedReserved?:boolean,kind?:'document'|'proposal'}} input
 * @param {any} [context]
 * @returns {{allowed:boolean,level:'N0'|'N1'|'N2'|'N3',reason:string,requiresConfirmation:boolean,label:string,labelSource:'explicit'|'default',requestedLabel:string|null,kind:string,channel:string,audience:string,recipients:string[],internals:string[],externals:string[],confirmedReserved:boolean,requiresApproval:boolean,requiresCode:boolean,policyVersion:string}}
 */
export function decide(input = {}, context = null) {
  const ctx = coerceContext(context);
  const kind = normalizeKind(input?.kind);
  const requested = input?.label === undefined || input?.label === null || String(input.label).trim() === ''
    ? null
    : String(input.label).trim();
  const explicit = normalizeLabel(requested);
  const label = explicit || defaultLabelFor(ctx, kind);
  const labelSource = explicit ? 'explicit' : 'default';
  const channel = String(input?.channel || 'none').trim().toLowerCase() || 'none';
  const recipients = classifyRecipients(input?.recipients, ctx);
  const internals = recipients.filter((item) => item.type === 'interno').map((item) => item.raw);
  const externals = recipients.filter((item) => item.type === 'externo').map((item) => item.raw);
  const hasExternal = externals.length > 0;
  const hasInternal = internals.length > 0;
  const audience = recipients.length === 0
    ? 'sin_destinatarios'
    : (hasExternal && hasInternal ? 'mixto' : (hasExternal ? 'externo' : 'interno'));
  const confirmedReserved = normalizeConfirmed(input?.confirmedReserved);

  let allowed = true;
  let level = 'N0';
  let requiresConfirmation = false;
  let reason = '';

  if (label === 'público') {
    allowed = true;
    level = 'N0';
    requiresConfirmation = false;
    reason = 'Etiqueta público: se permite en cualquier canal sin aprobación adicional.';
  } else if (label === 'interno') {
    if (hasExternal) {
      allowed = true;
      level = 'N2';
      requiresConfirmation = true;
      reason = 'Etiqueta interno con destinatarios externos: requiere aprobación N2 adicional y aviso.';
    } else {
      allowed = true;
      level = 'N1';
      requiresConfirmation = false;
      reason = 'Etiqueta interno: todos los destinatarios son internos; borrador interno con N1.';
    }
  } else {
    // reservado
    if (hasExternal) {
      level = 'N3';
      requiresConfirmation = !confirmedReserved;
      allowed = confirmedReserved;
      reason = confirmedReserved
        ? 'Etiqueta reservado: salida externa confirmada explícitamente; siempre exige N3 con código.'
        : 'Etiqueta reservado: nunca puede salir a externos sin confirmedReserved:true; requiere N3 con código.';
    } else {
      allowed = true;
      level = 'N2';
      requiresConfirmation = false;
      reason = 'Etiqueta reservado: salida solo interna; requiere aprobación N2.';
    }
  }

  return {
    allowed,
    level,
    reason,
    requiresConfirmation,
    label,
    labelSource,
    requestedLabel: requested,
    kind,
    channel,
    audience,
    recipients: recipients.map((item) => item.raw),
    internals,
    externals,
    confirmedReserved,
    requiresApproval: level === 'N2' || level === 'N3',
    requiresCode: level === 'N3',
    policyVersion: ACL_VERSION
  };
}

/**
 * Matriz efectiva para documentación/API (sin datos de usuarios).
 */
export function policyMatrix() {
  return {
    version: ACL_VERSION,
    labels: [...LABELS],
    defaults: { ...DEFAULT_ACL_DEFAULTS },
    rules: [
      { label: 'público', audience: 'cualquiera', allowed: true, level: 'N0', requiresConfirmation: false, requiresCode: false },
      { label: 'interno', audience: 'interno', allowed: true, level: 'N1', requiresConfirmation: false, requiresCode: false },
      { label: 'interno', audience: 'externo/mixto', allowed: true, level: 'N2', requiresConfirmation: true, requiresCode: false },
      { label: 'reservado', audience: 'interno', allowed: true, level: 'N2', requiresConfirmation: false, requiresCode: false },
      { label: 'reservado', audience: 'externo/mixto sin confirmar', allowed: false, level: 'N3', requiresConfirmation: true, requiresCode: true },
      { label: 'reservado', audience: 'externo/mixto confirmado', allowed: true, level: 'N3', requiresConfirmation: false, requiresCode: true }
    ],
    notes: [
      'Sin etiqueta se aplica data.acl.defaults (document o proposal).',
      'Teléfonos, URLs y textos se consideran externos.',
      'Un contacto conocido externo NO se vuelve interno por estar en contactos; usa internalContacts para declararlo interno.',
      'La etiqueta reservado exige N3 (código) incluso con confirmedReserved:true.'
    ]
  };
}

export { LABELS, ACL_VERSION, normalizeLabel, normalizeKind, AclError, EMAIL_RE };

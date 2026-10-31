/**
 * Constantes y vocabulario del ACL de Agenda Copilot P95.
 *
 * Etiquetas canónicas (con tilde en «público»):
 *   público  → se puede compartir por cualquier canal.
 *   interno  → solo dentro de la organización; a externos exige N2 + aviso.
 *   reservado→ a externos solo con confirmación explícita y siempre N3 (código).
 */

export const ACL_VERSION = 'acl-1.0';

export const LABELS = Object.freeze(['público', 'interno', 'reservado']);

export const LABEL_KINDS = Object.freeze(['document', 'proposal']);

export const DEFAULT_ACL_DEFAULTS = Object.freeze({
  document: 'interno',
  proposal: 'interno'
});

const ALIASES = new Map([
  ['publico', 'público'],
  ['público', 'público'],
  ['public', 'público'],
  ['interno', 'interno'],
  ['internal', 'interno'],
  ['reservado', 'reservado'],
  ['reserved', 'reservado'],
  ['privado', 'reservado'],
  ['private', 'reservado'],
  ['confidencial', 'reservado'],
  ['confidential', 'reservado']
]);

/**
 * Normaliza una etiqueta (acepta sin tilde y alias razonables).
 * @param {unknown} value
 * @returns {'público'|'interno'|'reservado'|null}
 */
export function normalizeLabel(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  return ALIASES.get(raw) || null;
}

export function isLabel(value) {
  return normalizeLabel(value) !== null;
}

export function normalizeKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'proposal' ? 'proposal' : 'document';
}

export class AclError extends Error {
  constructor(status, code, message, { field, details } = {}) {
    super(message);
    this.name = 'AclError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Organigrama declarativo de la Oficina.
 *
 * Roles consultivos: cada propuesta recibe una opinión rubricada de los 7 roles.
 * `puede_proponer` / `puede_ejecutar` describen capacidades, no permisos de
 * seguridad: la puerta real es la política N0-N3 + aprobación del jefe.
 */

export const ROLES = Object.freeze([
  Object.freeze({
    id: 'chief_of_staff',
    nombre: 'Jefe de Gabinete',
    descripcion: 'Coordina la oficina, prioriza propuestas y aprueba o rechaza en nombre del usuario.',
    capacidades: Object.freeze(['coordinar', 'priorizar', 'aprobar', 'rechazar', 'delegar']),
    puede_proponer: true,
    puede_ejecutar: true,
    canal_de_salida: 'interno'
  }),
  Object.freeze({
    id: 'agenda',
    nombre: 'Agenda',
    descripcion: 'Propone citas, huecos, reprogramaciones y detecta conflictos de calendario.',
    capacidades: Object.freeze(['calendario', 'disponibilidad', 'conflictos', 'recordatorios']),
    puede_proponer: true,
    puede_ejecutar: true,
    canal_de_salida: 'interno'
  }),
  Object.freeze({
    id: 'correspondencia',
    nombre: 'Correspondencia',
    descripcion: 'Redacta y envía mensajes por correo, WhatsApp o Telegram con el tono del usuario.',
    capacidades: Object.freeze(['redactar', 'email', 'whatsapp', 'telegram', 'seguimiento']),
    puede_proponer: true,
    puede_ejecutar: true,
    canal_de_salida: 'email'
  }),
  Object.freeze({
    id: 'documentos',
    nombre: 'Documentos',
    descripcion: 'Prepara borradores, documentos y adjuntos; controla versiones y formato.',
    capacidades: Object.freeze(['borradores', 'documentos', 'adjuntos', 'plantillas']),
    puede_proponer: true,
    puede_ejecutar: true,
    canal_de_salida: 'documento'
  }),
  Object.freeze({
    id: 'research',
    nombre: 'Research',
    descripcion: 'Investiga, resume fuentes y prepara contexto para decisiones y propuestas.',
    capacidades: Object.freeze(['investigar', 'resumir', 'fuentes', 'comparar']),
    puede_proponer: true,
    puede_ejecutar: false,
    canal_de_salida: 'informe'
  }),
  Object.freeze({
    id: 'qa',
    nombre: 'QA',
    descripcion: 'Revisa claridad, exactitud y completitud antes de que algo salga de la oficina.',
    capacidades: Object.freeze(['revisar', 'validar', 'detectar-errores', 'checklist']),
    puede_proponer: false,
    puede_ejecutar: false,
    canal_de_salida: 'informe'
  }),
  Object.freeze({
    id: 'auditoria',
    nombre: 'Auditoría',
    descripcion: 'Vigila el ledger, los niveles de riesgo y el cumplimiento de la política de aprobación.',
    capacidades: Object.freeze(['auditar', 'ledger', 'cumplimiento', 'trazabilidad']),
    puede_proponer: false,
    puede_ejecutar: false,
    canal_de_salida: 'auditoria'
  })
]);

export const ROLE_IDS = Object.freeze(ROLES.map((role) => role.id));
export const ROLE_ORDER = ROLE_IDS;

const BY_ID = new Map(ROLES.map((role) => [role.id, role]));

/** @param {string} id */
export function getRole(id) {
  return BY_ID.get(String(id || '')) || null;
}

/** @returns {object[]} copia mutable para la API */
export function rosterList() {
  return ROLES.map((role) => ({
    ...role,
    capacidades: [...role.capacidades]
  }));
}

/** Roles que pueden opinar (todos) y que pueden proponer. */
export function proposingRoles() {
  return ROLES.filter((role) => role.puede_proponer);
}

/** @returns {{items:object[], count:number, roles:object[]}} */
export function rosterPayload() {
  const items = rosterList();
  // `roles` es un alias independiente (no la misma referencia que `items`): el
  // serializador HTTP marca referencias duplicadas como "[circular]".
  const roles = items.map((role) => ({ ...role, capacidades: [...role.capacidades] }));
  return { items, count: items.length, roles };
}

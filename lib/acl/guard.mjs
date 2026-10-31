/**
 * Guard reutilizable para canales, documentos y oficina.
 *
 * No envía ni muta: resuelve la etiqueta efectiva (documento → default) y
 * devuelve la decisión ACL. Los dueños de channel/docs/office deben llamarlo
 * antes de cualquier salida externa; si `allowed` es false, bloquear; si
 * `requiresConfirmation` es true, pedir confirmación explícita.
 */

import { store } from '../store.mjs';
import { AclError, normalizeLabel } from './constants.mjs';
import { contextFromData, loadContext } from './context.mjs';
import { decide } from './policy.mjs';
import { effectiveLabel, publicDocument } from './state.mjs';

/**
 * @param {{
 *   docId?:string|null,
 *   label?:string|null,
 *   channel?:string,
 *   recipients?:string[]|string,
 *   confirmedReserved?:boolean,
 *   kind?:'document'|'proposal',
 *   data?:any,
 *   context?:any
 * }} input
 */
export function guardOutbound({
  docId = null,
  label = null,
  channel = 'email',
  recipients = [],
  confirmedReserved = false,
  kind = 'document',
  data = store.get(),
  context = null
} = {}) {
  const ctx = context || contextFromData(data);
  const hasDoc = docId !== undefined && docId !== null && String(docId).trim() !== '';
  const explicit = label !== undefined && label !== null && String(label).trim() !== '';
  let resolved;
  let labelSource;
  let document = null;

  if (hasDoc) {
    const documentId = String(docId).trim();
    document = publicDocument(data, documentId);
    const effective = effectiveLabel(data, documentId, kind);
    if (effective.source === 'document') {
      resolved = effective.label;
      labelSource = 'document';
    } else if (explicit) {
      resolved = normalizeLabel(label);
      if (!resolved) throw new AclError(400, 'VALIDATION', 'label debe ser público, interno o reservado', { field: 'label' });
      labelSource = 'explicit';
    } else {
      resolved = effective.label;
      labelSource = 'default';
    }
  } else if (explicit) {
    resolved = normalizeLabel(label);
    if (!resolved) throw new AclError(400, 'VALIDATION', 'label debe ser público, interno o reservado', { field: 'label' });
    labelSource = 'explicit';
  } else {
    const defaults = ctx.defaults || loadContext().defaults;
    resolved = defaults?.[kind === 'proposal' ? 'proposal' : 'document'] || 'interno';
    labelSource = 'default';
  }

  const decision = decide({
    label: resolved,
    channel,
    recipients,
    confirmedReserved,
    kind
  }, ctx);

  return {
    ...decision,
    docId: hasDoc ? String(docId).trim() : null,
    labelSource,
    label: decision.label,
    requestedLabel: explicit ? String(label).trim() : null,
    owner: document?.owner ?? null,
    document
  };
}

/**
 * Variante que lanza si la salida está bloqueada. Útil para integraciones que
 * prefieren excepción a comprobar `allowed` manualmente.
 */
export function assertOutbound(input = {}) {
  const decision = guardOutbound(input);
  if (!decision.allowed) {
    throw new AclError(403, 'ACL_BLOCKED', decision.reason, {
      field: 'docId',
      details: { level: decision.level, label: decision.label, requiresConfirmation: decision.requiresConfirmation }
    });
  }
  return decision;
}

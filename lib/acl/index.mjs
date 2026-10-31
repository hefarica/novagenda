/**
 * API pública del ACL de Agenda Copilot P95.
 *
 * Uso desde channel/docs/office (integración en follow-up):
 *   import { guardOutbound } from './lib/acl/index.mjs';
 *   const acl = guardOutbound({ docId, channel: 'email', recipients, confirmedReserved: false });
 *   if (!acl.allowed) return { blocked: true, acl };
 *   if (acl.requiresConfirmation) pedirConfirmacion(acl);
 *   if (acl.requiresCode) pedirCodigo(acl);
 */

export {
  ACL_VERSION, LABELS, LABEL_KINDS, DEFAULT_ACL_DEFAULTS, AclError,
  normalizeLabel, normalizeKind, isLabel
} from './constants.mjs';

export {
  contextFromData, loadContext, setAclConfig, resetAclConfig,
  serializeContext, normalizeEmail, EMAIL_RE
} from './context.mjs';

export {
  classifyRecipient, classifyRecipientDetailed, classifyRecipients,
  decide, policyMatrix
} from './policy.mjs';

export {
  ensureAclState, defaultsOf, getDocumentRecord, effectiveLabel, publicDocument,
  setDocumentLabel, setDefaults, listDocumentLabels, aclLedger,
  MAX_ACL_DOCUMENTS, MAX_ACL_LEDGER
} from './state.mjs';

export { guardOutbound, assertOutbound } from './guard.mjs';

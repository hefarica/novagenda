/**
 * Puente entre el ACL de seguridad y las salidas de canal.
 *
 * - `evaluateOutboundAcl` consulta `guardOutbound` con import perezoso. Si el
 *   módulo ACL no está disponible devuelve 503 ACL_UNAVAILABLE (fail-closed).
 * - `auditAclEnforcement` deja `acl.enforced` en el ledger de la Oficina antes
 *   de crear/denegar una salida restringida.
 * - `forceN3ForAcl` reclasifica a N3 una propuesta confirmada de reservado,
 *   recalcula el riesgo y reconstruye la tarjeta con la API pública de Oficina.
 *
 * No importa `lib/acl/**` en el top-level para que su ausencia sea detectable.
 */
import { store } from '../store.mjs';
import { appendLedger, buildCard, publicProposal } from '../office/index.mjs';
import { HttpError } from '../http/errors.mjs';

const LEVEL_RANK = Object.freeze({ N0: 0, N1: 1, N2: 2, N3: 3 });
let aclModulePromise = null;

function rank(level) {
  return LEVEL_RANK[String(level || 'N0').toUpperCase()] ?? 0;
}

function unavailable(message) {
  return new HttpError(503, 'ACL_UNAVAILABLE', message || 'El módulo ACL no está disponible; no se ha enviado nada.');
}

async function loadAclModule() {
  if (process.env.CHANNELS_TEST_DISABLE_ACL === '1') {
    throw unavailable('ACL deshabilitado por inyección de prueba; no se ha enviado nada.');
  }
  try {
    if (!aclModulePromise) aclModulePromise = import('../acl/index.mjs');
    const module = await aclModulePromise;
    if (typeof module.guardOutbound !== 'function') throw new Error('guardOutbound ausente');
    return module;
  } catch {
    aclModulePromise = null;
    throw unavailable();
  }
}

function mapAclError(error) {
  if (error instanceof HttpError) return error;
  const status = Number(error?.status) || 400;
  const code = String(error?.code || 'ACL_ERROR');
  return new HttpError(status, code, String(error?.message || 'Error del ACL.').slice(0, 300), {
    ...(error?.field ? { field: error.field } : {}),
    ...(error?.details ? { details: error.details } : {})
  });
}

/**
 * Evalúa una o varias salidas ACL y agrega la decisión más restrictiva.
 *
 * @param {{docIds?:string[],label?:string|null,channel:string,recipients:string[],confirmedReserved?:boolean,kind?:'document'|'proposal'}} input
 * @returns {Promise<{blocked:boolean,decision:object,decisions:object[],docIds:string[],requiresConfirmation:boolean,level:string,label:string,reason:string}>}
 */
export async function evaluateOutboundAcl({
  docIds = [], label = null, channel, recipients = [], confirmedReserved = false, kind = 'document'
} = {}) {
  const module = await loadAclModule();
  const ids = [...new Set((Array.isArray(docIds) ? docIds : [docIds]).map((id) => String(id || '').trim()).filter(Boolean))];
  const values = Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []);
  let decisions;
  try {
    if (ids.length) {
      decisions = ids.map((docId) => module.guardOutbound({
        docId, channel, recipients: values, confirmedReserved, kind
      }));
    } else {
      decisions = [module.guardOutbound({
        docId: null, label, channel, recipients: values, confirmedReserved, kind
      })];
    }
  } catch (error) {
    throw mapAclError(error);
  }
  const blockedDecision = decisions
    .filter((decision) => decision.allowed !== true)
    .sort((a, b) => rank(b.level) - rank(a.level))[0] || null;
  const primary = [...decisions].sort((a, b) => rank(b.level) - rank(a.level))[0];
  const decision = blockedDecision || primary;
  return {
    blocked: !!blockedDecision,
    decision,
    decisions,
    docIds: ids,
    requiresConfirmation: decisions.some((item) => item.requiresConfirmation === true),
    level: decision.level,
    label: decision.label,
    reason: decision.reason
  };
}

/** Datos que viajan en `proposal.meta.acl`. */
export function aclMeta(result) {
  if (!result?.decision) return null;
  const decision = result.decision;
  return {
    label: decision.label,
    level: decision.level,
    reason: decision.reason,
    requiresConfirmation: decision.requiresConfirmation === true,
    confirmedReserved: decision.confirmedReserved === true,
    ...(result.docIds?.length ? { docIds: [...result.docIds] } : {})
  };
}

/** Vista pública breve para la respuesta HTTP. */
export function aclDecisionView(result) {
  if (!result?.decision) return null;
  return {
    label: result.label,
    level: result.level,
    reason: result.reason,
    requiresConfirmation: result.requiresConfirmation === true,
    confirmedReserved: result.decision.confirmedReserved === true,
    ...(result.docIds?.length ? { docIds: [...result.docIds] } : {})
  };
}

/**
 * Registra `acl.enforced` antes de crear o denegar una salida restringida.
 * Si el ledger falla no se continúa (fail-closed).
 */
export async function auditAclEnforcement(result, {
  channel, recipients = [], proposalId = null
} = {}) {
  if (!result?.decision) return null;
  const decision = result.decision;
  try {
    let entry = null;
    await store.mutate((data) => {
      entry = appendLedger(data, {
        actor: 'channels:acl',
        action: 'acl.enforced',
        payload: {
          proposalId: proposalId || null,
          channel: String(channel || decision.channel || '').slice(0, 40),
          docId: result.docIds?.[0] || null,
          docIds: result.docIds?.length ? [...result.docIds] : [],
          label: decision.label,
          level: decision.level,
          reason: String(decision.reason || '').slice(0, 500),
          allowed: decision.allowed === true,
          requiresConfirmation: decision.requiresConfirmation === true,
          confirmedReserved: decision.confirmedReserved === true,
          recipients: Array.isArray(recipients) ? recipients.length : 0
        }
      });
    }, { label: 'acl-enforced' });
    return entry;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'No se pudo registrar acl.enforced; no se ha enviado nada.');
  }
}

/**
 * Fuerza N3 en una propuesta pendiente ya creada para un reservado confirmado.
 * Recalcula el riesgo (mínimo 7), añade ACL_RESERVED, actualiza policy/card y
 * devuelve la propuesta pública. No crea entradas de ledger (ya se auditó antes).
 */
export async function forceN3ForAcl(proposalId, result) {
  let updated = null;
  try {
    await store.mutate((data) => {
      const proposal = (data.office?.proposals || []).find((item) => item.id === proposalId);
      if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${proposalId} no encontrada.`);
      const currentRisk = proposal.risk && typeof proposal.risk === 'object' ? proposal.risk : {};
      const currentScore = Number(currentRisk.score) || 0;
      const score = Math.max(7, currentScore);
      const flags = Array.isArray(currentRisk.flags) ? [...currentRisk.flags] : [];
      if (!flags.some((flag) => flag?.code === 'ACL_RESERVED')) {
        flags.push({
          code: 'ACL_RESERVED',
          label: 'ACL reservado',
          weight: Math.max(0, score - currentScore),
          detail: result.reason || 'Contenido reservado confirmado para salida externa.'
        });
      }
      proposal.risk = {
        ...currentRisk,
        score,
        maxScore: Math.max(10, Number(currentRisk.maxScore) || 10),
        flags,
        signals: { ...(currentRisk.signals || {}), acl: result.label, aclLevel: 'N3', aclConfirmed: true }
      };
      proposal.flags = [...new Set([...(Array.isArray(proposal.flags) ? proposal.flags : []), 'ACL_RESERVED'])];
      proposal.level = 'N3';
      proposal.policy = {
        ...(proposal.policy || {}),
        level: 'N3',
        action: 'approve',
        autoExecute: false,
        requiresApproval: true,
        requiresCode: true,
        reason: `ACL reservado confirmado: ${result.reason}`
      };
      proposal.meta = {
        ...(proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {}),
        acl: aclMeta(result)
      };
      proposal.updatedAt = new Date().toISOString();
      proposal.card = buildCard(proposal);
      updated = publicProposal(proposal);
    }, { label: 'acl-force-n3' });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'No se pudo forzar N3 en la propuesta ACL; no se ha enviado nada.');
  }
  return updated;
}

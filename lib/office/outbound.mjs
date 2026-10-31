/**
 * Salida de correo con gate de Oficina.
 *
 * Cualquier envío de correo desde una ruta HTTP debe pasar por aquí:
 *   - por defecto crea una propuesta N2 (canal email) y NO envía;
 *   - el envío real ocurre al aprobar/ejecutar la propuesta (ejecutor email);
 *   - `direct:true` solo se admite si `settings.office.allowDirectSend === true`
 *     y deja un evento `email.direct_override` en el ledger ANTES de enviar;
 *   - si la Oficina no está disponible se deniega con `OFFICE_UNAVAILABLE`.
 */
import { store } from '../store.mjs';
import { HttpError } from '../http/errors.mjs';
import { redactString } from '../security/redact.mjs';

export const ENFORCE_OUTBOUND = true;

/** @param {any} [data] */
export function allowDirectSend(data = store.get()) {
  return data?.settings?.office?.allowDirectSend === true;
}

/** Autonomía de salida explícita; por defecto false. @param {any} [data] */
export function allowAutonomousOutbound(data = store.get()) {
  return data?.settings?.office?.allowAutonomousOutbound === true;
}

/**
 * Vista normalizada y segura del bloque `settings.office` para health/status.
 * `enforceOutbound` es derivado y siempre true.
 * @param {any} [data]
 */
export function outboundSettingsView(data = store.get()) {
  return {
    enforceOutbound: ENFORCE_OUTBOUND,
    allowDirectSend: allowDirectSend(data),
    allowAutonomousOutbound: allowAutonomousOutbound(data)
  };
}


async function loadProposals() {
  try {
    const module = await import('./proposals.mjs');
    if (typeof module.createProposal !== 'function') throw new Error('sin createProposal');
    return module;
  } catch {
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'La Oficina no está disponible; el correo no se envía directamente.');
  }
}

async function loadLedger() {
  try {
    const module = await import('./ledger.mjs');
    if (typeof module.appendLedger !== 'function') throw new Error('sin appendLedger');
    return module;
  } catch {
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'La Oficina no está disponible; no se puede auditar el envío directo.');
  }
}

/**
 * Crea la propuesta N2 que reemplaza al envío directo.
 * @param {{to:string, subject:string, body:string, connectionId?:string|null, actor?:string}} input
 * @returns {Promise<{proposal:object, result:object}>}
 */
export async function createOutboundEmailProposal({ to, subject, body, connectionId = null, actor = 'api' }) {
  const office = await loadProposals();
  let result;
  try {
    result = await office.createProposal({
      input: {
        kind: 'email',
        channel: 'email',
        recipients: [to],
        subject,
        body,
        attachments: [],
        meta: {
          source: 'gmail.send',
          connectionId: connectionId || null,
          direct: false
        }
      },
      actor: String(actor || 'api').slice(0, 80),
      forceApproval: true
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'OFFICE_ERROR', `No se pudo crear la propuesta de correo: ${redactString(error?.message || error)}`);
  }
  if (!result?.proposal?.id) {
    throw new HttpError(502, 'OFFICE_ERROR', 'La Oficina no devolvió una propuesta válida para el correo.');
  }
  return { proposal: result.proposal, result };
}

/**
 * Registra el override en el ledger. Se llama ANTES de `sendGmail`; si falla,
 * no se envía nada.
 * @param {{to:string, subject:string, connectionId?:string|null, actor?:string, requestId?:string|null}} input
 */
export async function auditDirectOverride({ to, subject, connectionId = null, actor = 'api', requestId = null }) {
  const ledger = await loadLedger();
  try {
    let entry = null;
    await store.mutate((data) => {
      entry = ledger.appendLedger(data, {
        actor: String(actor || 'api').slice(0, 80),
        action: 'email.direct_override',
        payload: {
          route: '/api/gmail/send',
          to,
          subject,
          connectionId: connectionId || null,
          requestId: requestId || null,
          direct: true
        }
      });
    }, { label: 'gmail-direct-override' });
    return entry;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', `No se pudo auditar el envío directo: ${redactString(error?.message || error)}`);
  }
}

export default { ENFORCE_OUTBOUND, allowDirectSend, allowAutonomousOutbound, outboundSettingsView, createOutboundEmailProposal, auditDirectOverride };

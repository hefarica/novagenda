/**
 * Ejecutores de canal aprobados por la Oficina.
 *
 * Sustituyen a los ejecutores nativos de email/WhatsApp/Telegram **solo en el
 * registro de la Oficina** (misma API pública `registerExecutor`), añadiendo el
 * envío de adjuntos que los nativos no soportaban. También registran el canal
 * `simulator` para que las propuestas de prueba se puedan aprobar y ejecutar sin
 * enviar nada a terceros reales.
 *
 * Seguridad: estos ejecutores solo se invocan desde
 * `/api/office/proposals/:id/execute` después de una aprobación firmada. No son
 * una vía de envío directo.
 */
import { registerExecutor } from '../office/executors.mjs';
import { store } from '../store.mjs';
import { resolveDocument } from './documents.mjs';
import { ChannelError } from './http.mjs';
import { recordOutbound } from './state.mjs';
import { makeMessage, uniqueDedupeKey } from './message.mjs';
import { hasAccounts as hasSmtpAccounts } from './smtp.mjs';

const CHANNEL_EXECUTORS = Object.freeze(['email', 'whatsapp', 'telegram', 'simulator']);
let installed = false;

function adapterOf(registry, channel) {
  const adapter = registry.get(channel);
  if (!adapter) throw new ChannelError('UNKNOWN_CHANNEL', `Canal desconocido: ${channel}.`, { channel });
  return adapter;
}

async function availableFor(registry, channel) {
  if (channel === 'simulator') return true;
  const adapter = registry.get(channel);
  if (!adapter) return false;
  try {
    const status = adapter.status();
    if (channel === 'email') {
      if (hasSmtpAccounts()) return true;
      const googleConnections = Array.isArray(store.get().googleConnections) ? store.get().googleConnections.length : 0;
      return googleConnections > 0 || (status.enabled === true && status.configured === true);
    }
    return status.enabled === true && status.configured === true;
  } catch {
    return false;
  }
}

function recipientsOf(proposal) {
  const recipients = Array.isArray(proposal?.recipients) ? proposal.recipients.filter((value) => String(value || '').trim()) : [];
  if (!recipients.length) {
    throw new ChannelError('RECIPIENTS_REQUIRED', 'La propuesta aprobada no tiene destinatarios.', { channel: proposal?.channel });
  }
  return recipients;
}

async function resolveAttachments(proposal) {
  const tokens = Array.isArray(proposal?.attachments) ? proposal.attachments : [];
  const docs = [];
  for (const token of tokens) {
    const doc = await resolveDocument(token);
    docs.push(doc);
  }
  return docs;
}

async function executeFor(registry, channel, proposal) {
  const adapter = adapterOf(registry, channel);
  const recipients = recipientsOf(proposal);
  const body = String(proposal.body || '');
  const docs = await resolveAttachments(proposal);
  const artifacts = [];

  for (const to of recipients) {
    if (docs.length) {
      for (const doc of docs) {
        if (typeof adapter.sendDocument !== 'function') {
          throw new ChannelError('CHANNEL_NO_DOCUMENTS', `El canal ${channel} no soporta adjuntos.`, { channel });
        }
        const sent = await adapter.sendDocument({
          to,
          filename: doc.filename,
          mimeType: doc.mimeType,
          buffer: doc.buffer,
          caption: body,
          subject: proposal.subject || undefined
        });
        artifacts.push({
          type: 'channel',
          channel,
          to,
          id: sent?.id || null,
          filename: doc.filename,
          mimeType: doc.mimeType,
          bytes: doc.size
        });
        await recordOutbound(makeMessage({
          channel,
          direction: 'outbound',
          userId: to,
          text: body,
          dedupeKey: uniqueDedupeKey(channel, 'aprobado'),
          status: 'sent',
          meta: {
            approved: true,
            proposalId: proposal.id,
            document: true,
            filename: doc.filename,
            mimeType: doc.mimeType,
            size: doc.size,
            messageId: sent?.id || undefined
          }
        })).catch(() => {});
      }
      continue;
    }
    const sent = await adapter.send({
      to,
      text: body,
      meta: { approved: true, subject: proposal.subject || undefined, thread: proposal.meta?.thread || null }
    });
    artifacts.push({ type: 'channel', channel, to, id: sent?.id || null });
    await recordOutbound(makeMessage({
      channel,
      direction: 'outbound',
      userId: to,
      text: body,
      dedupeKey: uniqueDedupeKey(channel, 'aprobado'),
      status: 'sent',
      meta: { approved: true, proposalId: proposal.id, messageId: sent?.id || undefined }
    })).catch(() => {});
  }

  return {
    ok: true,
    executor: `channel-${channel}`,
    detail: docs.length
      ? `Enviado${recipients.length > 1 ? 's' : ''} ${recipients.length} mensaje(s) con ${docs.length} adjunto(s) por ${channel}.`
      : `Enviado${recipients.length > 1 ? 's' : ''} ${recipients.length} mensaje(s) por ${channel}.`,
    artifacts
  };
}

/**
 * Registra los ejecutores de canal una sola vez. Se llama al crear el runtime de
 * canales, antes de que la Oficina instale los suyos (que no pisan inyecciones).
 * @param {{registry:any}} options
 */
export function installChannelExecutors({ registry } = {}) {
  if (installed || !registry) return { installed: false, reason: installed ? 'already' : 'sin-registry' };
  installed = true;
  for (const channel of CHANNEL_EXECUTORS) {
    registerExecutor(channel, {
      name: `channel-${channel}-approved`,
      available: () => availableFor(registry, channel),
      execute: (proposal) => executeFor(registry, channel, proposal)
    });
  }
  return { installed: true, channels: [...CHANNEL_EXECUTORS] };
}

/** Solo pruebas: permite reinstalar tras reiniciar módulos. */
export function resetChannelExecutorsForTests() {
  installed = false;
}



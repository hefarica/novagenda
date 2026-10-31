/**
 * Propuesta de respuesta a un correo IMAP.
 *
 * Flujo: lee el mensaje (solo lectura) → redacta con el perfil de estilo del
 * jefe (o plantilla formal si no hay muestras) → crea una propuesta N2 en la
 * Oficina. Nada se envía hasta que el jefe la apruebe; al ejecutarse sale por
 * SMTP o Gmail según la configuración.
 */
import { getImapMessage } from './imap.mjs';
import { composeEmail } from '../style/compose.mjs';
import { createOutboundService } from './outbound.mjs';
import { installChannelExecutors } from './executors.mjs';
import { ChannelError } from './http.mjs';

function firstName(name, email) {
  const value = String(name || '').trim();
  if (value) return value.split(/\s+/)[0];
  const local = String(email || '').split('@')[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}

function naturalFallbackDraft({ message, instructions, name }) {
  const context = String(message.subject || '').trim();
  const followUp = instructions
    ? 'He tomado nota de lo que me indicas y lo estoy revisando. Te confirmaré apenas tenga una respuesta concreta.'
    : 'Ya lo estoy revisando y te confirmaré apenas tenga novedades.';
  return [
    `Estimado ${name}:`,
    '',
    `Gracias por escribirme. Recibí tu mensaje${context ? ` sobre «${context}»` : ''}. ${followUp}`,
    '',
    'Quedo atento a cualquier detalle adicional.',
    '',
    'Cordialmente,',
    'Héctor Fabio Riascos C.'
  ].join('\n');
}

function looksNatural(text) {
  const body = String(text || '');
  if (!body.trim()) return false;
  return !/(Instrucciones del jefe|Asunto:|Remitente:|Recibido:|Mensaje:)/i.test(body);
}

function enforceSignature(text) {
  const trimmed = String(text || '').trim();
  if (/Héctor Fabio Riascos C\.?\s*$/i.test(trimmed)) return trimmed;
  const withoutShort = trimmed.replace(/\n+Héctor\s*$/i, '');
  return `${withoutShort}\n\nHéctor Fabio Riascos C.`.trim();
}

export async function buildReplyProposal(id, uid, { instructions = '', registry, preview = false, body: providedBody = null, subject: providedSubject = null } = {}) {
  const message = await getImapMessage(id, uid);
  if (!message?.from?.email) {
    throw new ChannelError('IMAP_NO_SENDER', 'El mensaje no tiene remitente utilizable.', { status: 400 });
  }
  const name = firstName(message.from.name, message.from.email);
  const subject = /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || 'tu mensaje'}`;
  const intent = instructions
    ? `Responder a ${name} sobre «${message.subject}». Instrucciones del jefe: ${instructions}`
    : `Responder a ${name} sobre «${message.subject}»: acusar recibo, decir que lo estás revisando y que le confirmarás pronto. Sin inventar datos.`;

  let body = naturalFallbackDraft({ message, instructions, name });
  let engine = 'deterministic';
  let score = null;
  if (providedBody !== null && providedBody !== undefined && String(providedBody).trim()) {
    body = String(providedBody).slice(0, 8000);
    engine = 'editado';
  } else try {
    const draft = await composeEmail({
      register: 'colega',
      intent,
      recipient: { name: message.from.name || name, email: message.from.email },
      facts: { asunto: message.subject },
      thread: [message.text || message.excerpt || ''],
      opening: `Estimado ${name}:`
    }, { useLlm: true });
    if (draft.engine === 'llm' && looksNatural(draft.draft)) {
      body = draft.draft;
      engine = 'llm';
      score = typeof draft.score === 'number' ? draft.score : null;
    }
  } catch {
    /* se queda la respuesta natural determinista */
  }
  body = enforceSignature(body);
  const finalSubject = providedSubject && String(providedSubject).trim()
    ? String(providedSubject).trim().slice(0, 250)
    : subject;

  if (preview) {
    return {
      preview: true,
      message: {
        uid: message.uid,
        from: message.from,
        subject: message.subject,
        date: message.date
      },
      draft: { subject: finalSubject, body, engine, score }
    };
  }

  const runtimeRegistry = registry;
  if (!runtimeRegistry) throw new ChannelError('CHANNEL_RUNTIME', 'Registro de canales no disponible.', { status: 500 });
  installChannelExecutors({ registry: runtimeRegistry });
  const service = createOutboundService({ registry: runtimeRegistry });
  const result = await service.createSendProposal({
    channel: 'email',
    recipients: [message.from.email],
    subject: finalSubject,
    body,
    threadHeaders: {
      inReplyTo: message.messageId || null,
      references: [message.references, message.messageId].filter(Boolean).join(' ').trim() || null
    }
  });
  return {
    message: {
      uid: message.uid,
      from: message.from,
      subject: message.subject,
      date: message.date
    },
    draft: { subject: finalSubject, body, engine, score },
    status: result.status,
    approvalRequired: result.approvalRequired !== false,
    approvalUrl: result.approvalUrl || null,
    proposal: result.proposal,
    result
  };
}




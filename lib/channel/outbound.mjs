/**
 * Salidas de canal como propuestas de la Oficina.
 *
 * Regla de oro (t30): **a terceros = propuesta; al dueño = directo**.
 *
 * Por defecto NO envía nada: convierte una petición de envío (`/send`,
 * `/send-document`) en una propuesta **pending** de la Oficina, incluso en modo
 * total/autónomo (forceApproval). El envío real ocurre al ejecutarla aprobada
 * mediante los ejecutores de canal (`lib/channel/executors.mjs`), que también
 * saben adjuntar documentos.
 *
 * Excepción explícita: si `settings.office.allowAutonomousOutbound === true`, el
 * modo es total/autónomo, el riesgo es ≤2 y el destinatario es un contacto
 * conocido, se aprueba y ejecuta automáticamente. Antes del envío se registra
 * `outbound.autonomous` en el ledger. N3 nunca se auto-ejecuta.
 *
 * El simulador se admite como canal de propuesta (canal local de pruebas); su
 * ejecutor entrega en la bandeja simulada en vez de a un tercero real.
 */
import { createProposal, approveProposal, executeProposal } from '../office/index.mjs';
import { appendLedger } from '../office/ledger.mjs';
import { store } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';
import { text } from '../validate.mjs';
import { resolveDocument } from './documents.mjs';
import { evaluateOutboundAcl, aclMeta, aclDecisionView, auditAclEnforcement, forceN3ForAcl } from './acl.mjs';
import { approvalDefaultTarget } from './approvals.mjs';
import { sanitizeText } from './message.mjs';
import { expandRecipients } from '../identity/resolve.mjs';

/**
 * Expande nombres a todos sus correos (2 personas × 2 correos → 4 destinos).
 * Solo aplica al canal de correo: WhatsApp/Telegram usan teléfonos o chat ids.
 * Si un nombre es ambiguo o tiene poca confianza, no adivina: pide confirmación.
 */
function resolveEmailRecipients(value, channel) {
  if (channel !== 'email') return value;
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const data = store.get();
  const emails = [];
  const unresolved = [];
  for (const entry of raw) {
    const item = String(entry ?? '').trim();
    if (!item) continue;
    if (item.includes('@') || item.startsWith('+')) {
      emails.push(item);
      continue;
    }
    const expanded = expandRecipients({ query: item }, { data });
    if (expanded.requiresConfirmation || !expanded.people.length) {
      unresolved.push({
        query: item,
        candidates: expanded.people.map((person) => ({ name: person.name, emails: person.emails, confidence: person.confidence }))
      });
      continue;
    }
    for (const person of expanded.people) {
      for (const email of person.emails) emails.push(email);
    }
  }
  if (unresolved.length) {
    throw new HttpError(409, 'IDENTITY_CONFIRMATION_REQUIRED',
      `No pude confirmar a quién escribir: ${unresolved.map((row) => row.query).join(', ')}. Dime el correo exacto o el nombre completo.`,
      { details: { unresolved } });
  }
  return emails;
}

export const PROPOSAL_CHANNELS = Object.freeze(['email', 'whatsapp', 'telegram', 'simulator']);
const MAX_RECIPIENTS = 20;
const MAX_ATTACHMENTS = 10;

function channelOf(value) {
  const channel = String(value || '').trim().toLowerCase();
  if (!channel) throw new ValidationError('channel', 'REQUIRED', 'Falta el canal.');
  if (!PROPOSAL_CHANNELS.includes(channel)) {
    throw new ValidationError('channel', 'CHANNEL_NO_PROPOSAL', `El canal ${channel} no acepta propuestas de salida; usa WhatsApp, Telegram, correo o el simulador.`);
  }
  return channel;
}

function normalizeRecipients(value) {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  if (!raw.length) {
    throw new ValidationError('recipients', 'REQUIRED', 'Indica al menos un destinatario (to/recipients).');
  }
  if (raw.length > MAX_RECIPIENTS) {
    throw new ValidationError('recipients', 'TOO_LONG', `Máximo ${MAX_RECIPIENTS} destinatarios por propuesta.`);
  }
  return raw.map((item, index) => text(String(item), {
    field: `recipients[${index}]`, max: 200, allowEmpty: false
  }));
}

function normalizeSubject(value) {
  return text(value, { field: 'subject', max: 300, defaultValue: '' });
}

function confirmedValue(value) {
  return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true'
    || String(value || '').trim().toLowerCase() === '1'
    || String(value || '').trim().toLowerCase() === 'si'
    || String(value || '').trim().toLowerCase() === 'sí';
}

function normalizeBody(value) {
  return sanitizeText(text(value, { field: 'body', required: true, max: 20_000, allowEmpty: false }), 20_000);
}

async function normalizeAttachments(value) {
  const raw = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  if (raw.length > MAX_ATTACHMENTS) throw new ValidationError('attachments', 'TOO_LONG', `Máximo ${MAX_ATTACHMENTS} adjuntos.`);
  const refs = [];
  const docs = [];
  for (const [index, item] of raw.entries()) {
    const token = text(String(item), { field: `attachments[${index}]`, max: 200, allowEmpty: false });
    const doc = await resolveDocument(token);
    refs.push(doc.id || doc.filename);
    docs.push({
      id: doc.id || null,
      filename: doc.filename,
      mimeType: doc.mimeType,
      size: doc.size,
      type: doc.type
    });
  }
  return { refs, docs };
}

function publicProposalSummary(proposal, extra = {}) {
  return {
    id: proposal.id,
    level: proposal.level,
    risk: proposal.risk || null,
    flags: Array.isArray(proposal.flags) ? [...proposal.flags] : [],
    status: proposal.status,
    channel: proposal.channel,
    recipients: proposal.recipients,
    subject: proposal.subject,
    body: proposal.body,
    attachments: proposal.attachments,
    meta: proposal.meta || null,
    createdAt: proposal.createdAt,
    policy: proposal.policy || null,
    card: proposal.card || null,
    ...extra
  };
}

/** Flag explícito de autonomía; por defecto false. */
export function allowAutonomousOutbound(data = store.get()) {
  return data?.settings?.office?.allowAutonomousOutbound === true;
}

function autonomousEligible(proposal) {
  if (!allowAutonomousOutbound()) return false;
  if (proposal?.meta?.acl?.requiresConfirmation === true) return false;
  const mode = String(proposal?.modeAtCreation || '').toLowerCase();
  if (!['total', 'autonomo'].includes(mode)) return false;
  if (proposal?.level === 'N3') return false;
  const riskScore = Number(proposal?.risk?.score);
  if (!Number.isFinite(riskScore) || riskScore > 2) return false;
  if (proposal?.knownContact !== true) return false;
  return Array.isArray(proposal?.recipients) && proposal.recipients.length > 0;
}

async function auditAutonomous(proposal) {
  try {
    await store.mutate((data) => {
      appendLedger(data, {
        actor: 'policy:autonomous',
        action: 'outbound.autonomous',
        payload: {
          proposalId: proposal.id,
          channel: proposal.channel,
          recipients: Array.isArray(proposal.recipients) ? proposal.recipients.length : 0,
          level: proposal.level,
          riskScore: Number(proposal.risk?.score) || 0,
          knownContact: proposal.knownContact === true,
          mode: proposal.modeAtCreation || null
        }
      });
    }, { label: 'channels-outbound-autonomous' });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'No se pudo auditar la autonomía en el ledger; no se ha enviado nada.');
  }
}

function responseFor(proposal, { auto = false, executed = false, message = '', acl = null } = {}) {
  return {
    status: executed ? 'executed' : 'pending_approval',
    approvalRequired: !executed,
    message: message || (executed
      ? 'Enviado automáticamente con autonomía explícita (riesgo bajo y contacto conocido).'
      : proposal?.status === 'held'
        ? 'Propuesta retenida en modo sombra; no se ha enviado nada. Pasa a otro modo y apruébala.'
        : 'Pendiente de aprobación en la Oficina. No se ha enviado nada.'),
    approvalUrl: proposal?.id ? `/api/office/proposals/${encodeURIComponent(proposal.id)}` : null,
    proposal: publicProposalSummary(proposal || {}),
    auto: auto === true,
    executed: executed === true,
    ...(acl ? { acl } : {})
  };
}

async function createOfficeProposal(input, actor) {
  try {
    return await createProposal({ input, actor, useLlm: false, forceApproval: true });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'La Oficina no respondió; no se ha enviado nada.');
  }
}

async function executeAutonomous(proposal, { acl = null } = {}) {
  await auditAutonomous(proposal);
  try {
    await approveProposal({
      id: proposal.id,
      by: 'policy:autonomous',
      note: 'Autonomía explícita: modo total/autónomo, riesgo bajo y contacto conocido.'
    });
    const executed = await executeProposal({ id: proposal.id, actor: 'policy:autonomous', auto: true });
    return responseFor(executed.proposal, { auto: true, executed: true, acl });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'No se pudo completar la autonomía; no se ha enviado nada.');
  }
}

/**
 * @param {{registry:any}} options
 */
export function createOutboundService({ registry } = {}) {
  if (!registry) throw new TypeError('createOutboundService requiere el registro de canales.');

  function assertAdapter(channel) {
    if (!registry.get(channel)) throw new ValidationError('channel', 'UNKNOWN_CHANNEL', `Canal desconocido: ${channel}.`);
  }

  function sanitizeThreadHeaders(value) {
    if (!value || typeof value !== 'object') return null;
    const clean = (text) => String(text ?? '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, 998);
    const inReplyTo = clean(value.inReplyTo || value['in-reply-to'] || '');
    const references = clean(value.references || '');
    if (!inReplyTo && !references) return null;
    return { ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) };
  }

  async function createSendProposal(input = {}) {
    const channel = channelOf(input.channel);
    assertAdapter(channel);
    const recipients = normalizeRecipients(resolveEmailRecipients(input.recipients ?? input.to, channel));
    const subject = normalizeSubject(input.subject);
    const body = normalizeBody(input.body ?? input.text);
    const { refs, docs } = await normalizeAttachments(input.attachments);
    const aclDocIds = refs.length ? refs : (input.docId ? [String(input.docId)] : []);
    const acl = await evaluateOutboundAcl({
      docIds: aclDocIds,
      label: input.label ?? null,
      channel,
      recipients,
      confirmedReserved: confirmedValue(input.confirmedReserved),
      kind: 'proposal'
    });
    if (acl.blocked) {
      await auditAclEnforcement(acl, { channel, recipients });
      throw new HttpError(403, 'ACL_DENIED', acl.reason, {
        details: { reason: acl.reason, level: acl.level, label: acl.label, docIds: acl.docIds }
      });
    }
    if (acl.requiresConfirmation || acl.level === 'N3') {
      await auditAclEnforcement(acl, { channel, recipients });
    }
    const threadHeaders = sanitizeThreadHeaders(input.threadHeaders);
    const proposalInput = {
      kind: 'channel-send',
      channel,
      recipients,
      subject,
      body,
      attachments: refs,
      meta: {
        source: 'channels-api',
        requestedChannel: channel,
        acl: aclMeta(acl),
        attachmentDocs: docs,
        ...(threadHeaders ? { thread: threadHeaders } : {})
      }
    };
    const result = await createOfficeProposal(proposalInput, 'channels-api');
    let proposal = result.proposal;
    if (acl.level === 'N3') proposal = await forceN3ForAcl(proposal.id, acl);
    const aclView = aclDecisionView(acl);
    if (autonomousEligible(proposal)) return executeAutonomous(proposal, { acl: aclView });
    return responseFor(proposal, { acl: aclView });
  }

  async function createDocumentProposal(input = {}) {
    const channel = channelOf(input.channel);
    assertAdapter(channel);
    const docId = text(input.docId, { field: 'docId', required: true, max: 160, allowEmpty: false });
    const doc = await resolveDocument(docId);
    const provided = input.to !== undefined && input.to !== null && String(input.to).trim() !== ''
      ? input.to
      : approvalDefaultTarget(channel);
    const recipients = normalizeRecipients(resolveEmailRecipients(provided, channel));
    const subject = normalizeSubject(input.subject || `Documento: ${doc.filename}`);
    const caption = input.caption === undefined || input.caption === null || String(input.caption).trim() === ''
      ? `Adjunto: ${doc.filename}`
      : sanitizeText(String(input.caption), 800);
    const attachmentRef = doc.id || doc.filename;
    const acl = await evaluateOutboundAcl({
      docIds: [doc.id || docId],
      label: input.label ?? null,
      channel,
      recipients,
      confirmedReserved: confirmedValue(input.confirmedReserved),
      kind: 'document'
    });
    if (acl.blocked) {
      await auditAclEnforcement(acl, { channel, recipients });
      throw new HttpError(403, 'ACL_DENIED', acl.reason, {
        details: { reason: acl.reason, level: acl.level, label: acl.label, docIds: acl.docIds }
      });
    }
    if (acl.requiresConfirmation || acl.level === 'N3') {
      await auditAclEnforcement(acl, { channel, recipients });
    }
    const threadHeaders = sanitizeThreadHeaders(input.threadHeaders);
    const proposalInput = {
      kind: 'document-send',
      channel,
      recipients,
      subject,
      body: caption,
      attachments: [attachmentRef],
      meta: {
        source: 'channels-api',
        requestedChannel: channel,
        acl: aclMeta(acl),
        ...(input.connectionId ? { connectionId: String(input.connectionId).slice(0, 80) } : {}),
        attachmentDocs: [{ id: doc.id || null, filename: doc.filename, mimeType: doc.mimeType, size: doc.size, type: doc.type }]
      }
    };
    const result = await createOfficeProposal(proposalInput, 'channels-api');
    let proposal = result.proposal;
    if (acl.level === 'N3') proposal = await forceN3ForAcl(proposal.id, acl);
    const aclView = aclDecisionView(acl);
    if (autonomousEligible(proposal)) return executeAutonomous(proposal, { acl: aclView });
    return {
      ...responseFor(proposal, { acl: aclView }),
      doc: { id: doc.id || null, filename: doc.filename, mimeType: doc.mimeType, size: doc.size, type: doc.type, origin: doc.origin }
    };
  }

  return { createSendProposal, createDocumentProposal };
}

/** Error tipado para canales que no admiten propuestas de salida. */
export function channelNoProposal(channel) {
  return new HttpError(400, 'CHANNEL_NO_PROPOSAL', `El canal ${channel} no admite propuestas de salida.`, { field: 'channel' });
}


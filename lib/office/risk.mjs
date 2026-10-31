/**
 * Motor de riesgo determinista de la Oficina.
 *
 * Señales: dinero, plazo, término legal, destinatarios externos, ≥4
 * destinatarios, contactos nuevos, adjuntos y riesgo intrínseco del canal.
 * El resultado es explicable: puntaje 0–10 + flags con código, etiqueta, peso y
 * detalle. No usa LLM ni red.
 */
import { normalizeRecipient, isExternalRecipient } from './contacts.mjs';
import { collectOwnDomains, collectKnownContacts } from './contacts.mjs';

export const MAX_RISK_SCORE = 10;

const MONEY_RE = /\b(pago|pagos|factura|facturas|transferencia|transferencias|cobro|cobros|monto|importe|presupuesto|honorarios|precio|precios|coste|costos|costo|invoice|payment|wire|refund|reembolso|salario|nomina|nómina|anticipo|señal|deposito|depósito)\b/i;
const CURRENCY_RE = /(?:US\$|\$|€|£|COP|USD|EUR|MXN)\s?\d[\d.,]*/i;
const DEADLINE_RE = /\b(urgente|urgentemente|hoy|mañana|manana|antes del|antes de|vence|vencimiento|plazo|deadline|asap|inmediato|inmediata|esta semana|fin de semana|hoy mismo)\b/i;
const LEGAL_RE = /\b(legal|legales|contrato|contratos|nda|confidencial|confidencialidad|juridico|jurídico|juridica|jurídica|terminos|términos|condiciones|demanda|abogado|abogada|clausula|cláusula|gdpr|rgpd|compliance|cumplimiento normativo)\b/i;

const CHANNEL_RISK = Object.freeze({
  email: 1,
  whatsapp: 2,
  telegram: 2,
  webhook: 3,
  document: 0,
  note: 0,
  read: 0,
  none: 0,
  internal: 0
});

const EXTERNAL_CHANNELS = new Set(['email', 'whatsapp', 'telegram', 'webhook']);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function uniqueRecipients(recipients) {
  const seen = new Set();
  const out = [];
  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const normalized = normalizeRecipient(recipient);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    out.push(normalized);
  }
  return out;
}

function deadlineSoon(meta) {
  const candidates = [meta?.deadline, meta?.due, meta?.dueAt];
  for (const candidate of candidates) {
    if (candidate === true) return true;
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms) && ms - Date.now() <= 72 * 60 * 60 * 1000) return true;
  }
  return false;
}

/**
 * @param {{kind?:string,channel?:string,recipients?:string[],subject?:string,body?:string,attachments?:any[],meta?:object}} input
 * @param {{knownContacts?:Set<string>, ownDomains?:Set<string>, data?:any}} [options]
 * @returns {{
 *   score:number,maxScore:number,
 *   flags:{code:string,label:string,weight:number,detail:string}[],
 *   signals:object,readOnly:boolean,externalChannel:boolean,
 *   externalRecipients:number,newContacts:number,recipientCount:number,
 *   knownContact:boolean,channel:string
 * }}
 */
export function assessRisk(input = {}, options = {}) {
  const data = options.data;
  const channel = String(input.channel || 'none').toLowerCase();
  const kind = String(input.kind || '').toLowerCase();
  const text = normalizeText([
    input.subject,
    input.body,
    input.meta?.notes,
    input.meta?.reason
  ].filter(Boolean).join('\n'));
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const recipients = uniqueRecipients(input.recipients);
  const knownContacts = options.knownContacts || (data ? collectKnownContacts(data) : new Set());
  const ownDomains = options.ownDomains || (data ? collectOwnDomains(data) : new Set());
  const flags = [];

  const readOnly = channel === 'read' || kind === 'read' || input.meta?.readOnly === true;

  const moneySignal = MONEY_RE.test(text) || CURRENCY_RE.test(text) || Number(input.meta?.amount) > 0 || input.meta?.money === true;
  if (moneySignal) {
    flags.push({ code: 'MONEY', label: 'Dinero', weight: 3, detail: 'El texto o los metadatos mencionan pagos, facturas, montos o presupuestos.' });
  }

  const legalSignal = LEGAL_RE.test(text) || input.meta?.legal === true;
  if (legalSignal) {
    flags.push({ code: 'LEGAL', label: 'Término legal', weight: 4, detail: 'Aparecen contratos, NDA, confidencialidad, términos legales o cumplimiento.' });
  }

  const deadlineSignal = DEADLINE_RE.test(text) || deadlineSoon(input.meta) || input.meta?.urgent === true;
  if (deadlineSignal) {
    flags.push({ code: 'DEADLINE', label: 'Plazo', weight: 2, detail: 'Hay una urgencia, fecha límite o vencimiento próximo.' });
  }

  const externalRecipients = recipients.filter((recipient) => isExternalRecipient(data, recipient.raw, ownDomains)).length;
  if (externalRecipients > 0) {
    flags.push({ code: 'EXTERNAL_RECIPIENT', label: 'Destinatario externo', weight: 2, detail: `${externalRecipients} destinatario(s) fuera del dominio propio.` });
  }

  const newContacts = recipients.filter((recipient) => !knownContacts.has(recipient.key)).length;
  if (newContacts > 0) {
    flags.push({ code: 'NEW_CONTACT', label: 'Contacto nuevo', weight: 2, detail: `${newContacts} destinatario(s) no estaban en la libreta de contactos.` });
  }

  if (recipients.length >= 4) {
    flags.push({ code: 'MANY_RECIPIENTS', label: 'Muchos destinatarios', weight: 2, detail: `${recipients.length} destinatarios en un mismo envío (≥4).` });
  }

  if (attachments.length > 0) {
    flags.push({ code: 'ATTACHMENTS', label: 'Adjuntos', weight: 1, detail: `${attachments.length} adjunto(s) incluido(s).` });
  }

  const externalChannel = EXTERNAL_CHANNELS.has(channel);
  const channelWeight = CHANNEL_RISK[channel] ?? (externalChannel ? 2 : 0);
  if (externalChannel) {
    flags.push({ code: 'EXTERNAL_CHANNEL', label: 'Canal externo', weight: channelWeight, detail: `El canal ${channel} puede salir de la oficina.` });
  }

  const rawScore = flags.reduce((total, flag) => total + flag.weight, 0);
  const score = Math.max(0, Math.min(MAX_RISK_SCORE, rawScore));
  const knownContact = recipients.length === 0 || recipients.every((recipient) => knownContacts.has(recipient.key));

  return {
    score,
    maxScore: MAX_RISK_SCORE,
    flags,
    signals: {
      money: moneySignal,
      legal: legalSignal,
      deadline: deadlineSignal,
      externalRecipients,
      newContacts,
      recipientCount: recipients.length,
      attachments: attachments.length,
      channel,
      channelWeight,
      externalChannel,
      readOnly
    },
    readOnly,
    externalChannel,
    externalRecipients,
    newContacts,
    recipientCount: recipients.length,
    knownContact,
    channel
  };
}

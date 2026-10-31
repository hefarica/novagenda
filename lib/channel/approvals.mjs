/**
 * Aprobaciones y entregables por canales.
 *
 * Puente entre la Oficina (`lib/office/**`, t13) y los canales (WhatsApp,
 * Telegram, correo y simulador):
 *
 *   - envía una tarjeta compacta de una propuesta N2/N3 al dueño;
 *   - escucha sus respuestas («ok», «no», «corrige: …», 1/2/3 y botones) y las
 *     aplica al gate de la Oficina (approve/reject/corrección);
 *   - solo acepta respuestas de la lista blanca de dueño (chat/número/correo);
 *   - audita en el ledger de la Oficina cualquier intento no autorizado;
 *   - avisa de propuestas nuevas al crearlas y recuerda a los 15 min (máx. 2);
 *   - envía documentos generados (`lib/docs`) como adjuntos por el mismo canal.
 *
 * Nunca ejecuta propuestas: aprobar/rechazar mueve el gate, la ejecución sigue
 * siendo responsabilidad de `/api/office/proposals/:id/execute` (una sola vez).
 */
import { store } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';
import {
  getProposal, listProposals, approveProposal, rejectProposal, appendLedger, parseDecision
} from '../office/index.mjs';
import {
  getChannelConfig, updateChannelState, recordOutbound, recordAudit, plainClone
} from './state.mjs';
import { makeMessage, sanitizeText, uniqueDedupeKey } from './message.mjs';
import { textToHtml, htmlDocument, escapeHtml } from './mime.mjs';
import { describeError } from './http.mjs';
import { getSecret } from '../security/vault.mjs';
import { boolean, enumValue, integer, isPlainObject, text } from '../validate.mjs';
import { log, logError } from '../http/logger.mjs';

const APPROVAL_CHANNELS = Object.freeze(['telegram', 'whatsapp', 'email', 'simulator', 'generic']);
const APPROVAL_ACTIONS = Object.freeze(['approve', 'reject', 'view']);
const PROPOSAL_ID_RE = /\b(OF-\d{3,})\b/i;
const DEFAULT_CONFIG = Object.freeze({
  preferredChannel: null,
  notifyOnCreate: true,
  reminderMinutes: 15,
  maxReminders: 2,
  simulatorTarget: 'demo-owner',
  owners: Object.freeze({ telegram: [], whatsapp: [], email: [], generic: [], simulator: [] })
});
const REMINDER_GRACE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Estado de aprobaciones (dentro de channelState)                     */
/* ------------------------------------------------------------------ */

function ensureApprovals(state) {
  if (!isPlainObject(state.approvals)) state.approvals = {};
  const approvals = state.approvals;
  if (!Number.isFinite(Number(approvals.version))) approvals.version = 1;
  if (!isPlainObject(approvals.config)) approvals.config = {};
  const config = approvals.config;
  if (!isPlainObject(config.owners)) config.owners = {};
  for (const channel of APPROVAL_CHANNELS) {
    if (!Array.isArray(config.owners[channel])) config.owners[channel] = [];
  }
  if (config.preferredChannel === undefined) config.preferredChannel = DEFAULT_CONFIG.preferredChannel;
  if (config.notifyOnCreate === undefined) config.notifyOnCreate = DEFAULT_CONFIG.notifyOnCreate;
  if (!Number.isFinite(Number(config.reminderMinutes))) config.reminderMinutes = DEFAULT_CONFIG.reminderMinutes;
  if (!Number.isFinite(Number(config.maxReminders))) config.maxReminders = DEFAULT_CONFIG.maxReminders;
  if (typeof config.simulatorTarget !== 'string' || !config.simulatorTarget.trim()) config.simulatorTarget = DEFAULT_CONFIG.simulatorTarget;
  if (!isPlainObject(approvals.contexts)) approvals.contexts = {};
  if (!isPlainObject(approvals.notified)) approvals.notified = {};
  if (!Number.isFinite(Number(approvals.baselineAt))) approvals.baselineAt = null;
  if (!isPlainObject(approvals.stats)) {
    approvals.stats = { sent: 0, approved: 0, rejected: 0, corrected: 0, denied: 0, reminders: 0, notified: 0, failures: 0 };
  }
  return approvals;
}

function approvalsView() {
  const state = store.get().channelState;
  if (!isPlainObject(state)) return ensureApprovals({});
  return ensureApprovals(state);
}

async function updateApprovals(fn, label = 'aprobaciones') {
  return updateChannelState((state) => fn(ensureApprovals(state), state), label);
}

function bump(approvals, key, delta = 1) {
  approvals.stats[key] = Math.max(0, Number(approvals.stats[key] || 0) + delta);
}

/* ------------------------------------------------------------------ */
/* Dueño: listas blancas y destinos                                    */
/* ------------------------------------------------------------------ */

function normalizeOwnerId(channel, value) {
  const raw = String(value ?? '').trim();
  if (channel === 'whatsapp') return raw.replace(/\D/g, '');
  if (channel === 'email') return raw.toLowerCase();
  return raw;
}

function explicitOwners(config, channel) {
  return (config.owners?.[channel] || []).map((item) => normalizeOwnerId(channel, item)).filter(Boolean);
}

function channelWhitelist(channel) {
  try {
    if (channel === 'telegram') {
      const cfg = getChannelConfig('telegram');
      const list = Array.isArray(cfg.allowedChatIds) ? [...cfg.allowedChatIds] : [];
      const defaultChat = getSecret('channels.telegram.defaultChatId');
      if (defaultChat) list.push(defaultChat);
      return list.map((item) => normalizeOwnerId(channel, item)).filter(Boolean);
    }
    if (channel === 'whatsapp') {
      const cfg = getChannelConfig('whatsapp');
      const list = Array.isArray(cfg.allowedNumbers) ? [...cfg.allowedNumbers] : [];
      const defaultTo = getSecret('channels.whatsapp.defaultTo');
      if (defaultTo) list.push(defaultTo);
      return list.map((item) => normalizeOwnerId(channel, item)).filter(Boolean);
    }
    if (channel === 'email') {
      const cfg = getChannelConfig('email');
      const list = Array.isArray(cfg.allowFrom) ? [...cfg.allowFrom] : [];
      const to = getSecret('channels.email.to');
      if (to) list.push(to);
      return list;
    }
  } catch { /* canal aún no cargado */ }
  return [];
}

/** Lista blanca efectiva (configuración explícita + lista del canal). */
function ownerIds(config, channel) {
  return [...new Set([...explicitOwners(config, channel), ...channelWhitelist(channel)])];
}

function isAuthorized(config, channel, userId) {
  const normalized = normalizeOwnerId(channel, userId);
  if (!normalized) return false;
  if (channel === 'simulator') {
    const owners = explicitOwners(config, channel);
    return owners.length === 0 ? true : owners.includes(normalized);
  }
  return ownerIds(config, channel).includes(normalized);
}

function defaultTarget(config, channel) {
  try {
    if (channel === 'telegram') {
      const defaultChat = getSecret('channels.telegram.defaultChatId');
      if (defaultChat) return normalizeOwnerId(channel, defaultChat);
      const cfg = getChannelConfig('telegram');
      return (Array.isArray(cfg.allowedChatIds) ? cfg.allowedChatIds : []).map((item) => normalizeOwnerId(channel, item))[0] || null;
    }
    if (channel === 'whatsapp') {
      const defaultTo = getSecret('channels.whatsapp.defaultTo');
      if (defaultTo) return normalizeOwnerId(channel, defaultTo);
      const cfg = getChannelConfig('whatsapp');
      return (Array.isArray(cfg.allowedNumbers) ? cfg.allowedNumbers : []).map((item) => normalizeOwnerId(channel, item))[0] || null;
    }
    if (channel === 'email') {
      const to = getSecret('channels.email.to');
      if (to) return normalizeOwnerId(channel, to);
      const cfg = getChannelConfig('email');
      return (Array.isArray(cfg.allowFrom) ? cfg.allowFrom : []).map((item) => normalizeOwnerId(channel, item))[0] || null;
    }
    if (channel === 'simulator') return normalizeOwnerId(channel, config.simulatorTarget || 'demo-owner');
    if (channel === 'generic') return explicitOwners(config, 'generic')[0] || null;
  } catch { /* ignore */ }
  return null;
}

function resolveReplyTo(channel, target, config) {
  if (channel !== 'email') return null;
  try {
    return getChannelConfig('email').account || getSecret('channels.email.to') || target;
  } catch {
    void config;
    return target;
  }
}

/* ------------------------------------------------------------------ */
/* Tarjeta                                                             */
/* ------------------------------------------------------------------ */

function publicBase(config) {
  void config;
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const port = Number(process.env.PORT || 3000);
  return `http://127.0.0.1:${port}`;
}

/** Texto ASCII para asuntos de correo (evita RFC 2047 y conserva el id). */
function asciiHeaderText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/-{2,}/g, '-')
    .trim();
}

function maskIdentity(channel, value) {
  const normalized = normalizeOwnerId(channel, value);
  if (!normalized) return 'desconocido';
  if (channel === 'email') {
    const [user, domain] = normalized.split('@');
    return `${String(user).slice(0, 2)}•••@${domain || '…'}`;
  }
  return normalized.length > 4 ? `••••${normalized.slice(-4)}` : '••••';
}

/**
 * Construye tarjeta de aprobación por canal.
 * @param {any} proposal
 * @param {string} channel
 */
export function buildApprovalCard(proposal, channel = 'simulator') {
  const id = String(proposal.id || '');
  const level = proposal.level || 'N2';
  const risk = proposal.risk || {};
  const flags = (proposal.flags || proposal.risk?.flags || []).map((flag) => (typeof flag === 'string' ? flag : flag.code));
  const recipients = Array.isArray(proposal.recipients) ? proposal.recipients : [];
  const subject = proposal.subject || '(sin asunto)';
  const reason = proposal.policy?.reason || proposal.card?.summary || 'Política de la oficina';
  const voice = Number(proposal.voice || 0);
  const opinions = Array.isArray(proposal.opinions) ? proposal.opinions : [];
  const bodyExcerpt = sanitizeText(proposal.body || '', 420);
  const link = `${publicBase()}/#oficina?proposal=${encodeURIComponent(id)}`;
  const instruction = channel === 'telegram'
    ? 'Pulsa un botón o responde «ok ' + id + '», «no ' + id + '» o «corrige: …».'
    : channel === 'email'
      ? 'Responde a este correo con OK, NO o CORRIGE: <texto>. No cambies el asunto.'
      : 'Responde 1 = aprobar · 2 = rechazar · 3 = corregir (luego «corrige: texto»). También «ok ' + id + '» / «no ' + id + '».';
  const text = [
    `🏛️ APROBACIÓN PENDIENTE · ${level} · ${id}`,
    `Salida: ${String(proposal.channel || 'interno').toUpperCase()} · Destinatarios: ${recipients.length ? recipients.join(', ') : 'interno'}`,
    `Asunto: ${subject}`,
    `Riesgo: ${Number(risk.score || 0)}/10 · Señales: ${flags.length ? flags.join(', ') : 'ninguna'}`,
    `Motivo: ${reason}`,
    `Voz del equipo: ${voice.toFixed(2)} (${opinions.length} opiniones)`,
    bodyExcerpt ? `Contenido:\n${bodyExcerpt}` : '',
    `Detalle: ${link}`,
    '',
    instruction
  ].filter(Boolean).join('\n');

  const rows = [
    [
      { text: '✅ Aprobar', callback_data: `ap:${id}:approve` },
      { text: '❌ Rechazar', callback_data: `ap:${id}:reject` }
    ],
    [{ text: '📄 Ver', callback_data: `ap:${id}:view` }]
  ];
  const htmlBody = [
    `<h2 style="margin:0 0 6px 0;font-size:18px">Aprobación ${escapeHtml(level)} · ${escapeHtml(id)}</h2>`,
    `<p style="margin:0 0 10px 0;color:#57606a">${escapeHtml(subject)}</p>`,
    `<table style="width:100%;border-collapse:collapse;font-size:14px">`,
    `<tr><td style="padding:4px 0;color:#57606a">Salida</td><td>${escapeHtml(String(proposal.channel || 'interno').toUpperCase())}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#57606a">Destinatarios</td><td>${escapeHtml(recipients.length ? recipients.join(', ') : 'interno')}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#57606a">Riesgo</td><td>${Number(risk.score || 0)}/10 · ${escapeHtml(flags.length ? flags.join(', ') : 'sin señales')}</td></tr>`,
    `<tr><td style="padding:4px 0;color:#57606a">Motivo</td><td>${escapeHtml(reason)}</td></tr>`,
    `</table>`,
    bodyExcerpt ? `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #d0d7de;color:#57606a">${textToHtml(bodyExcerpt)}</blockquote>` : '',
    `<p style="margin:12px 0 4px 0"><strong>${escapeHtml(instruction)}</strong></p>`,
    `<p style="margin:0;font-size:12px"><a href="${escapeHtml(link)}">Abrir en la Oficina</a> · ${escapeHtml(id)}</p>`
  ].join('\n');

  return {
    proposalId: id,
    level,
    title: `Aprobación ${level} · ${id}`,
    subject: `[${id}] Aprobacion ${level} - ${asciiHeaderText(subject)}`,
    text,
    html: htmlDocument(htmlBody, { title: `Aprobación ${id}` }),
    actions: ['approve', 'reject', 'view'],
    inlineKeyboard: rows,
    link
  };
}

/* ------------------------------------------------------------------ */
/* Utilidades de propuestas                                            */
/* ------------------------------------------------------------------ */

function normalizeProposalId(value) {
  return text(value, { field: 'proposalId', required: true, max: 40, allowEmpty: false, pattern: /^OF-\d{3,}$/i }).toUpperCase();
}

function pendingProposals() {
  const pending = listProposals({ status: 'pending', limit: 500 }).items;
  const held = listProposals({ status: 'held', limit: 500 }).items;
  return [...pending, ...held].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function proposalSafe(id) {
  try { return getProposal(id); } catch (error) { if (error?.status === 404) return null; throw error; }
}

function contextKey(channel, userId, proposalId = null) {
  const base = `${channel}:${normalizeOwnerId(channel, userId)}`;
  return proposalId ? `${base}:${proposalId}` : base;
}

function contextsForUser(approvals, channel, userId) {
  const normalized = normalizeOwnerId(channel, userId);
  return Object.values(approvals.contexts).filter((context) => context.channel === channel && normalizeOwnerId(channel, context.userId) === normalized);
}

function contextsForProposal(approvals, proposalId) {
  return Object.values(approvals.contexts).filter((context) => context.proposalId === proposalId);
}

async function removeContextsForProposal(proposalId) {
  await updateApprovals((approvals) => {
    for (const [key, context] of Object.entries(approvals.contexts)) {
      if (context.proposalId === proposalId) delete approvals.contexts[key];
    }
  }, `aprobaciones-limpiar:${proposalId}`);
}

/**
 * Marca los contextos de una propuesta como decididos (se conservan para poder
 * responder «esa gestión ya se decidió» si el dueño repite la respuesta).
 */
async function markContextsDecided(proposalId, status) {
  await updateApprovals((approvals) => {
    const at = new Date().toISOString();
    for (const context of Object.values(approvals.contexts)) {
      if (context.proposalId === proposalId) {
        context.decidedAt = at;
        context.decidedStatus = status;
      }
    }
    // Poda de contextos decididos antiguos (>7 días) para no crecer sin control.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [key, context] of Object.entries(approvals.contexts)) {
      if (context.decidedAt && Date.parse(context.decidedAt) < cutoff) delete approvals.contexts[key];
    }
  }, `aprobaciones-decididas:${proposalId}`);
}

/* ------------------------------------------------------------------ */
/* Servicio                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{registry:any}} options
 */
/**
 * Cambia `settings.office.allowAutonomousOutbound` con auditoría previa.
 *
 * Es la vía que usa el centro de aprobaciones para que el toggle no quede sin
 * rastro. La entrada `office.settings` se escribe ANTES de persistir el flag;
 * si el ledger falla no se modifica nada. Se mantiene una sola entrada por
 * cambio real y el `source` identifica esta ruta.
 *
 * @param {boolean} value
 * @param {{source?:string, by?:string}} [options]
 */
export async function setAllowAutonomousOutboundAudited(value, options = {}) {
  const enabled = value === true;
  const source = String(options.source || 'channels.approvals.config');
  const by = String(options.by || 'user').slice(0, 80);
  const current = store.get()?.settings?.office?.allowAutonomousOutbound === true;
  if (current === enabled) return { changed: false, value: enabled, source };
  // Inyección solo para pruebas: permite verificar el fail-closed sin tocar el store.
  if (process.env.CHANNELS_TEST_FAIL_OFFICE_LEDGER === '1') {
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'Fallo inyectado del ledger de Oficina; el flag no cambió.');
  }
  try {
    let changed = false;
    await store.mutate((data) => {
      const settings = isPlainObject(data.settings) ? data.settings : {};
      const office = isPlainObject(settings.office) ? settings.office : {};
      if ((office.allowAutonomousOutbound === true) === enabled) return;
      // Auditoría ANTES de persistir el cambio. Si appendLedger lanza, la
      // asignación de abajo no se ejecuta y store.mutate no persiste.
      appendLedger(data, {
        actor: by,
        action: 'office.settings',
        payload: { by, source, changes: { allowAutonomousOutbound: enabled } }
      });
      data.settings = { ...settings, office: { ...office, allowAutonomousOutbound: enabled } };
      changed = true;
    }, { label: 'office-settings-autonomous' });
    return { changed, value: enabled, source };
  } catch (error) {
    if (error instanceof HttpError && error.code === 'OFFICE_UNAVAILABLE') throw error;
    throw new HttpError(503, 'OFFICE_UNAVAILABLE', 'No se pudo auditar el cambio en el ledger; el flag no cambió.');
  }
}

export function createApprovalService({ registry } = {}) {
  if (!registry) throw new TypeError('createApprovalService requiere el registro de canales.');
  let watcher = null;
  let stopped = false;
  let ticking = false;

  function adapterFor(channel) {
    const adapter = registry.get(channel);
    if (!adapter) throw new ValidationError('channel', 'INVALID_VALUE', `Canal desconocido: ${channel}.`);
    return adapter;
  }

  function config() {
    return approvalsView().config;
  }

  function publicPreferred(preferred) {
    if (!preferred) return null;
    return {
      channel: preferred.channel,
      to: preferred.channel === 'simulator' ? preferred.to : maskIdentity(preferred.channel, preferred.to)
    };
  }

  function resolvePreferredTarget(approvalsConfig = config()) {
    const candidates = [];
    if (approvalsConfig.preferredChannel) candidates.push(approvalsConfig.preferredChannel);
    for (const channel of ['telegram', 'whatsapp', 'email', 'simulator']) {
      if (!candidates.includes(channel)) candidates.push(channel);
    }
    for (const channel of candidates) {
      const adapter = registry.get(channel);
      if (!adapter) continue;
      try {
        const status = adapter.status();
        const ready = channel === 'simulator' || (status.enabled === true && (status.configured === true || channel === 'simulator'));
        if (!ready) continue;
        const target = defaultTarget(approvalsConfig, channel);
        if (target) return { channel, to: target };
      } catch { /* adaptador no disponible */ }
    }
    return null;
  }

  function resolveSendTarget(channel, provided, approvalsConfig) {
    if (channel === 'simulator') {
      const target = normalizeOwnerId(channel, provided || defaultTarget(approvalsConfig, channel));
      const owners = explicitOwners(approvalsConfig, channel);
      if (owners.length && !owners.includes(target)) {
        throw new HttpError(403, 'NOT_OWNER', 'Ese simulador no pertenece a la lista blanca del dueño.', { details: { channel, target } });
      }
      return target || 'demo-owner';
    }
    const target = normalizeOwnerId(channel, provided || defaultTarget(approvalsConfig, channel));
    if (!target) {
      throw new HttpError(409, 'NO_TARGET', `No hay destino configurado para ${channel}. Guarda el destinatario del dueño en el canal.`, {
        details: { channel, listField: channel === 'telegram' ? 'defaultChatId' : channel === 'whatsapp' ? 'defaultTo' : channel === 'email' ? 'email.to' : `approvals.owners.${channel}` }
      });
    }
    const owners = ownerIds(approvalsConfig, channel);
    const listField = channel === 'telegram' ? 'allowedChatIds'
      : channel === 'whatsapp' ? 'allowedNumbers'
        : channel === 'email' ? 'allowFrom'
          : `approvals.owners.${channel}`;
    if (!owners.length) {
      throw new HttpError(403, 'OWNER_NOT_CONFIGURED', `No hay lista blanca de dueño para ${channel}. Configura ${listField} (o approvals.owners) antes de usar aprobaciones.`, {
        details: { channel, listField, configHint: 'Centro de integraciones → canal → destinatarios autorizados' }
      });
    }
    if (!owners.includes(target)) {
      throw new HttpError(403, 'NOT_OWNER', 'El destino no está en la lista blanca del dueño.', { details: { channel, listField } });
    }
    return target;
  }

  async function recordSentCard(channel, target, card, proposalId, messageId, extraMeta = {}) {
    try {
      await recordOutbound(makeMessage({
        channel,
        direction: 'outbound',
        userId: target,
        text: card.text,
        dedupeKey: uniqueDedupeKey(channel, 'approval'),
        status: 'sent',
        meta: {
          approval: true,
          proposalId,
          card: true,
          messageId: messageId || undefined,
          actions: card.actions,
          ...extraMeta
        }
      }));
    } catch (error) {
      log('warn', `Aprobaciones: no se pudo registrar la tarjeta en la bandeja (${describeError(error)}).`);
    }
  }

  /**
   * Envía la tarjeta de una propuesta por un canal.
   * @param {{proposalId:string, channel:string, to?:string}} input
   */
  async function sendCard({ proposalId, channel, to, auto = false } = {}) {
    const id = normalizeProposalId(proposalId);
    const channelId = enumValue(channel, APPROVAL_CHANNELS, { field: 'channel', required: true });
    const proposal = proposalSafe(id);
    if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
    if (!['pending', 'held'].includes(proposal.status)) {
      throw new HttpError(409, 'ALREADY_DECIDED', `Esa gestión ya se decidió (estado ${proposal.status}). No se envía de nuevo.`, {
        details: { proposalId: id, status: proposal.status }
      });
    }
    const adapter = adapterFor(channelId);
    if (channelId !== 'simulator') {
      const status = adapter.status();
      if (status.enabled !== true) {
        throw new HttpError(409, 'CHANNEL_NOT_READY', `El canal ${channelId} no está activo. Actívalo en el centro de integraciones.`, { details: { channel: channelId } });
      }
      // El correo necesita permiso de lectura además de envío para poder recibir
      // la respuesta del dueño; sin él la tarjeta no serviría de nada.
      if (channelId === 'email' && status.configured !== true) {
        throw new HttpError(409, 'CHANNEL_NOT_READY', 'Gmail no tiene permiso de lectura: conecta la cuenta con «Conectar Gmail (lectura y envío)» antes de enviar la tarjeta.', { details: { channel: 'email', oauthStart: '/api/channels/email/oauth/start' } });
      }
    }
    const approvalsConfig = config();
    const target = resolveSendTarget(channelId, to, approvalsConfig);
    const card = buildApprovalCard(proposal, channelId);
    const meta = {
      approval: true,
      proposalId: id,
      level: proposal.level,
      actions: card.actions,
      inlineKeyboard: card.inlineKeyboard,
      html: channelId === 'email' ? card.html : null,
      subject: channelId === 'email' ? card.subject : null,
      replyTo: resolveReplyTo(channelId, target, approvalsConfig)
    };
    let sent;
    try {
      sent = await adapter.send({ to: target, text: card.text, meta });
    } catch (error) {
      await updateApprovals((approvals) => {
        approvals.lastError = { at: new Date().toISOString(), channel: channelId, proposalId: id, message: sanitizeText(describeError(error), 300) };
        bump(approvals, 'failures');
      }, 'aprobaciones-error-envio');
      throw error;
    }
    const messageId = sent?.id || null;
    const context = {
      proposalId: id,
      channel: channelId,
      userId: target,
      sentAt: new Date().toISOString(),
      lastReminderAt: null,
      reminders: 0,
      messageId,
      source: auto ? 'auto' : 'manual'
    };
    await updateApprovals((approvals) => {
      approvals.contexts[contextKey(channelId, target, id)] = context;
      approvals.notified[id] = { at: context.sentAt, channel: channelId, userId: target, messageId };
      bump(approvals, 'sent');
      if (auto) bump(approvals, 'notified');
      approvals.lastError = null;
    }, `aprobaciones-enviada:${id}`);
    await recordAudit({ channel: channelId, action: auto ? 'aprobación-notificada' : 'aprobación-enviada', outcome: 'ok', detail: `${id} → ${maskIdentity(channelId, target)}` }, { activity: true });
    await recordSentCard(channelId, target, card, id, messageId, { auto });
    return {
      ok: true,
      proposalId: id,
      channel: channelId,
      to: target,
      messageId,
      card: { title: card.title, subject: card.subject, text: card.text, actions: card.actions, link: card.link },
      context: plainClone(context)
    };
  }

  async function sendReminderMessage(context, proposal) {
    const channel = context.channel;
    const adapter = adapterFor(channel);
    const card = buildApprovalCard(proposal, channel);
    const reminderText = [
      `⏰ RECORDATORIO · ${proposal.level} · ${proposal.id}`,
      proposal.subject || '(sin asunto)',
      `Riesgo ${Number(proposal.risk?.score || 0)}/10 · sigue pendiente de tu decisión.`,
      `Detalle: ${publicBase()}/#oficina?proposal=${encodeURIComponent(proposal.id)}`,
      '',
      channel === 'telegram'
        ? `Responde «ok ${proposal.id}», «no ${proposal.id}» o pulsa un botón.`
        : channel === 'email'
          ? 'Responde a este correo con OK, NO o CORRIGE: <texto>.'
          : 'Responde 1 = aprobar · 2 = rechazar · 3 = corregir.'
    ].join('\n');
    const sent = await adapter.send({
      to: context.userId,
      text: reminderText,
      meta: {
        approval: true,
        reminder: true,
        proposalId: proposal.id,
        inlineKeyboard: channel === 'telegram' ? card.inlineKeyboard : null,
        subject: channel === 'email' ? `[${proposal.id}] Recordatorio de aprobacion` : null,
        replyTo: resolveReplyTo(channel, context.userId, config()),
        html: channel === 'email' ? htmlDocument(textToHtml(reminderText), { title: 'Recordatorio de aprobación' }) : null
      }
    });
    try {
      await recordOutbound(makeMessage({
        channel,
        direction: 'outbound',
        userId: context.userId,
        text: reminderText,
        dedupeKey: uniqueDedupeKey(channel, 'approval-reminder'),
        status: 'sent',
        meta: { approval: true, reminder: true, proposalId: proposal.id, messageId: sent?.id || undefined }
      }));
    } catch { /* ignore */ }
    return sent?.id || null;
  }

  /**
   * Recuerda una propuesta pendiente (endpoint manual o watcher).
   * @param {{proposalId:string, channel?:string, to?:string, force?:boolean}} input
   */
  async function remind({ proposalId, channel = null, to = null, force = false } = {}) {
    const id = normalizeProposalId(proposalId);
    const proposal = proposalSafe(id);
    if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${id} no encontrada.`);
    if (!['pending', 'held'].includes(proposal.status)) {
      throw new HttpError(409, 'ALREADY_DECIDED', `Esa gestión ya se decidió (estado ${proposal.status}). No hay nada que recordar.`, { details: { proposalId: id, status: proposal.status } });
    }
    const approvals = approvalsView();
    let context = null;
    if (channel) {
      const channelId = enumValue(channel, APPROVAL_CHANNELS, { field: 'channel', required: true });
      const target = normalizeOwnerId(channelId, to || '');
      context = contextsForProposal(approvals, id).find((item) => item.channel === channelId && (!target || normalizeOwnerId(channelId, item.userId) === target)) || null;
    } else {
      context = contextsForProposal(approvals, id)[0] || null;
    }
    if (!context) {
      throw new HttpError(409, 'NOT_SENT', 'Primero envía la tarjeta de aprobación por un canal.', { details: { proposalId: id } });
    }
    const maxReminders = Math.min(2, Number(approvals.config.maxReminders ?? 2));
    if (Number(context.reminders || 0) >= maxReminders) {
      throw new HttpError(409, 'MAX_REMINDERS', `Ya se enviaron ${maxReminders} recordatorios; no se enviarán más.`, { details: { proposalId: id, reminders: context.reminders } });
    }
    // El endpoint manual es una acción explícita del dueño: envía ya. El ritmo de
    // 15/30 min lo aplica el watcher automático. `force` se acepta por
    // compatibilidad pero ya no es necesario.
    void force;
    const messageId = await sendReminderMessage(context, proposal);
    const updated = { ...context, reminders: Number(context.reminders || 0) + 1, lastReminderAt: new Date().toISOString(), messageId };
    await updateApprovals((state) => {
      state.contexts[contextKey(context.channel, context.userId, context.proposalId)] = updated;
      bump(state, 'reminders');
    }, `aprobaciones-recordatorio:${id}`);
    await recordAudit({ channel: context.channel, action: 'aprobación-recordatorio', outcome: 'ok', detail: `${id} (${updated.reminders}/${maxReminders})` });
    return { ok: true, proposalId: id, channel: context.channel, to: context.userId, reminders: updated.reminders, messageId, context: plainClone(updated) };
  }

  /* ----------------------------- Entrada ----------------------------- */

  function extractProposalId(message) {
    const textValue = String(message?.text || '');
    const subject = String(message?.meta?.subject || '');
    return (PROPOSAL_ID_RE.exec(textValue)?.[1] || PROPOSAL_ID_RE.exec(subject)?.[1] || '').toUpperCase() || null;
  }

  function detectAction(message, approvals, explicitId) {
    const callback = message?.meta?.approval;
    if (callback && typeof callback === 'object') {
      const action = String(callback.action || '').toLowerCase();
      if (!['approve', 'reject', 'view'].includes(action)) return null;
      return { action, correction: null, explicitId: callback.proposalId ? String(callback.proposalId).toUpperCase() : explicitId };
    }
    const rawText = sanitizeText(message?.text || '', 2000);
    const parsed = parseDecision(rawText);
    if (parsed.decision === 'approve') return { action: 'approve', correction: null, explicitId };
    if (parsed.decision === 'reject') return { action: 'reject', correction: null, explicitId };
    if (parsed.decision === 'correct') return { action: 'correct', correction: parsed.correction, explicitId };
    if (/^\s*(ver|detalle)\b/i.test(rawText) && explicitId) return { action: 'view', correction: null, explicitId };
    if (/^\s*[123]\s*$/.test(rawText)) {
      const channel = message.channel;
      const contexts = contextsForUser(approvals, channel, message.userId);
      if (!explicitId && !contexts.length) return null;
      if (rawText === '1') return { action: 'approve', correction: null, explicitId };
      if (rawText === '2') return { action: 'reject', correction: null, explicitId };
      return { action: 'correct', correction: null, explicitId };
    }
    return null;
  }

  async function deny({ channel, userId, proposalId, action, reason }) {
    const actor = `canal:${channel}:${sanitizeText(userId, 40)}`.slice(0, 80);
    try {
      await store.mutate((data) => {
        appendLedger(data, {
          actor,
          action: 'proposal.approval_denied',
          payload: {
            proposalId: proposalId || null,
            channel,
            userId: sanitizeText(userId, 80),
            decision: action || 'unknown',
            reason: reason || 'remitente no autorizado'
          }
        });
      }, { label: 'office-approval-denied' });
    } catch (error) {
      logError('aprobaciones:ledger-denegado', error);
    }
    await updateApprovals((approvals) => { bump(approvals, 'denied'); });
    await recordAudit({ channel, action: 'aprobación-denegada', outcome: 'denied', detail: `${proposalId || 'sin id'} · ${maskIdentity(channel, userId)}` }, { activity: true });
    return {
      handled: true,
      decision: 'denied',
      proposalId: proposalId || null,
      reply: `⛔ No autorizado: ${maskIdentity(channel, userId)} no está en la lista blanca del dueño. Esta decisión no se aplica y ha quedado auditada.`
    };
  }

  function decidedReply(proposal) {
    return {
      handled: true,
      decision: 'already-decided',
      proposalId: proposal.id,
      reply: `ℹ️ Esa gestión ya se decidió (${proposal.id}: ${proposal.status}). No se ejecuta dos veces.`
    };
  }

  /**
   * Procesa un mensaje entrante si es una respuesta de aprobación.
   * @returns {Promise<{handled:boolean, reply:string, decision?:string, proposalId?:string}|null>}
   */
  async function handleInbound(message) {
    if (!message || !message.channel) return null;
    const channel = String(message.channel);
    if (!APPROVAL_CHANNELS.includes(channel)) return null;
    const approvals = approvalsView();
    const explicitId = extractProposalId(message);
    const authorized = isAuthorized(approvals.config, channel, message.userId);
    const approvalAttempt = message.meta?.approvalAttempt === true;
    // Un intento marcado como aprobación por el adaptador se audita siempre que
    // no venga del dueño, aunque el parser no reconozca la acción exacta.
    if (approvalAttempt && !authorized) {
      return deny({ channel, userId: message.userId, proposalId: explicitId, action: 'approval-attempt', reason: 'remitente no autorizado (intento de aprobación)' });
    }
    const detected = detectAction(message, approvals, explicitId);
    if (!detected) return null;

    const pending = pendingProposals();

    // Sin id explícito: se usa el contexto activo del usuario, solo si es único.
    let proposalId = detected.explicitId || null;
    if (!proposalId) {
      const contexts = contextsForUser(approvals, channel, message.userId)
        .filter((context) => proposalSafe(context.proposalId));
      const pendingContexts = contexts.filter((context) => {
        const proposal = proposalSafe(context.proposalId);
        return proposal && ['pending', 'held'].includes(proposal.status);
      });
      if (pendingContexts.length === 1) proposalId = pendingContexts[0].proposalId;
      else if (pendingContexts.length === 0) {
        // Si ya se decidió (por este canal o por la UI), se responde sin volver a
        // ejecutar nada. Se conserva el contexto para no perder el hilo.
        const known = contextsForUser(approvals, channel, message.userId)
          .sort((a, b) => Date.parse(b.decidedAt || b.sentAt || 0) - Date.parse(a.decidedAt || a.sentAt || 0));
        for (const context of known) {
          const previous = proposalSafe(context.proposalId);
          if (previous && !['pending', 'held'].includes(previous.status)) return decidedReply(previous);
        }
      }
      else if (pendingContexts.length > 1) {
        if (!authorized) return deny({ channel, userId: message.userId, proposalId: null, action: detected.action, reason: 'respuesta ambigua de remitente no autorizado' });
        const list = pendingContexts.slice(0, 5).map((context) => context.proposalId).join(', ');
        return {
          handled: true,
          decision: 'ambiguous',
          proposalId: null,
          reply: `Hay ${pendingContexts.length} propuestas pendientes para ti (${list}). Responde con el id, por ejemplo «ok ${pendingContexts[0].proposalId}».`
        };
      }
    }

    if (!proposalId) {
      if (!pending.length) return null; // deja que el asistente normal responda
      if (!authorized) return deny({ channel, userId: message.userId, proposalId: null, action: detected.action, reason: 'remitente no autorizado' });
      return {
        handled: true,
        decision: 'needs-id',
        proposalId: null,
        reply: `Tienes ${pending.length} propuesta(s) pendiente(s). Indica el id: por ejemplo «ok ${pending[0].id}» o «no ${pending[0].id}».`
      };
    }

    const proposal = proposalSafe(proposalId);
    if (!proposal) {
      if (!authorized) return deny({ channel, userId: message.userId, proposalId, action: detected.action, reason: 'remitente no autorizado' });
      return { handled: true, decision: 'not-found', proposalId, reply: `No encontré la propuesta ${proposalId}.` };
    }
    // La autorización se comprueba ANTES de revelar el estado de la propuesta.
    if (!authorized) return deny({ channel, userId: message.userId, proposalId, action: detected.action, reason: 'remitente no autorizado' });
    if (!['pending', 'held'].includes(proposal.status)) {
      return decidedReply(proposal);
    }

    if (detected.action === 'view') {
      const card = buildApprovalCard(proposal, channel);
      return { handled: true, decision: 'view', proposalId, reply: card.text };
    }

    if (detected.action === 'correct' && !detected.correction) {
      return {
        handled: true,
        decision: 'needs-correction',
        proposalId,
        reply: `Escribe la corrección con el formato «corrige: <texto>» para ${proposalId}.`
      };
    }

    try {
      if (detected.action === 'approve') {
        const result = await approveProposal({ id: proposalId, by: 'jefe', note: `vía ${channel}` });
        const item = result.proposal;
        const codeLine = result.code
          ? `\n🔐 Código N3 (único, caduca ${new Date(result.approval?.expiresAt || Date.now()).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}): ${result.code}\nÚsalo en «Ejecutar» de la Oficina.`
          : '';
        await markContextsDecided(proposalId, 'approved');
        await updateApprovals((state) => { bump(state, 'approved'); }, `aprobaciones-aprobada:${proposalId}`);
        return {
          handled: true,
          decision: 'approved',
          proposalId,
          reply: `✅ ${proposalId} aprobada (${item.level} · ${String(item.channel).toUpperCase()}).${codeLine}\nLa ejecución sigue siendo un paso aparte y única.`
        };
      }
      if (detected.action === 'reject') {
        await rejectProposal({ id: proposalId, by: 'jefe', reason: `rechazada vía ${channel}` });
        await markContextsDecided(proposalId, 'rejected');
        await updateApprovals((state) => { bump(state, 'rejected'); }, `aprobaciones-rechazada:${proposalId}`);
        return { handled: true, decision: 'rejected', proposalId, reply: `❌ ${proposalId} rechazada. No se enviará nada.` };
      }
      if (detected.action === 'correct') {
        const correction = sanitizeText(detected.correction, 500);
        await rejectProposal({ id: proposalId, by: 'jefe', reason: `corrección vía ${channel}: ${correction}` });
        await store.mutate((data) => {
          appendLedger(data, {
            actor: `canal:${channel}`.slice(0, 80),
            action: 'proposal.correction',
            payload: { proposalId, correction, channel, by: 'jefe' }
          });
        }, { label: 'office-proposal-correction' });
        await markContextsDecided(proposalId, 'rejected-correction');
        await updateApprovals((state) => { bump(state, 'corrected'); }, `aprobaciones-corregida:${proposalId}`);
        return {
          handled: true,
          decision: 'corrected',
          proposalId,
          correction,
          reply: `📝 Corrección registrada para ${proposalId}: «${correction}». La propuesta queda rechazada para que se ajuste y se vuelva a proponer.`
        };
      }
    } catch (error) {
      if (error?.status === 409) {
        const current = proposalSafe(proposalId);
        if (current) {
          await markContextsDecided(current.id, current.status);
          return decidedReply(current);
        }
      }
      logError('aprobaciones:decisión', error, { proposalId, channel });
      await updateApprovals((state) => {
        bump(state, 'failures');
        state.lastError = { at: new Date().toISOString(), proposalId, channel, message: sanitizeText(describeError(error), 300) };
      }, 'aprobaciones-error-decision');
      return {
        handled: true,
        decision: 'error',
        proposalId,
        reply: `⚠️ No pude aplicar la decisión a ${proposalId}: ${sanitizeText(error?.message || 'error', 160)}`
      };
    }
    return null;
  }

  /* ----------------------------- Consulta ---------------------------- */

  function pending() {
    const approvals = approvalsView();
    const items = pendingProposals().map((proposal) => {
      const sent = contextsForProposal(approvals, proposal.id).map((context) => ({
        channel: context.channel,
        userId: maskIdentity(context.channel, context.userId),
        sentAt: context.sentAt,
        reminders: Number(context.reminders || 0),
        source: context.source || 'manual'
      }));
      return {
        id: proposal.id,
        level: proposal.level,
        status: proposal.status,
        riskScore: proposal.risk?.score ?? 0,
        flags: proposal.flags || [],
        subject: proposal.subject || '',
        recipients: proposal.recipients || [],
        channel: proposal.channel,
        createdAt: proposal.createdAt,
        policy: proposal.policy || null,
        card: proposal.card || null,
        sent,
        notified: !!approvals.notified[proposal.id],
        link: `${publicBase()}/#oficina?proposal=${encodeURIComponent(proposal.id)}`
      };
    });
    const preferred = resolvePreferredTarget(approvals.config);
    return {
      ok: true,
      items,
      count: items.length,
      total: items.length,
      preferred: publicPreferred(preferred),
      config: approvalsConfigView(approvals.config)
    };
  }

  function approvalsConfigView(configValue = config()) {
    const owners = {};
    const ownerCounts = {};
    for (const channel of APPROVAL_CHANNELS) {
      const values = ownerIds(configValue, channel);
      ownerCounts[channel] = values.length;
      // En canales reales se muestran enmascarados: la lista puede incluir
      // destinos que viven en la bóveda (defaultChatId/defaultTo/email.to).
      owners[channel] = channel === 'simulator' ? values : values.map((value) => maskIdentity(channel, value));
    }
    return {
      preferredChannel: configValue.preferredChannel || null,
      notifyOnCreate: configValue.notifyOnCreate !== false,
      reminderMinutes: Number(configValue.reminderMinutes) || 15,
      maxReminders: Math.min(2, Number(configValue.maxReminders ?? 2)),
      simulatorTarget: configValue.simulatorTarget || 'demo-owner',
      allowAutonomousOutbound: store.get()?.settings?.office?.allowAutonomousOutbound === true,
      owners,
      ownerCounts
    };
  }

  function status() {
    const approvals = approvalsView();
    return {
      ok: true,
      config: approvalsConfigView(approvals.config),
      preferred: publicPreferred(resolvePreferredTarget(approvals.config)),
      pending: pendingProposals().length,
      contexts: Object.keys(approvals.contexts).length,
      notified: Object.keys(approvals.notified).length,
      baselineAt: approvals.baselineAt ? new Date(Number(approvals.baselineAt)).toISOString() : null,
      watcher: !!watcher,
      reminderMinutes: Number(approvals.config.reminderMinutes) || 15,
      maxReminders: Math.min(2, Number(approvals.config.maxReminders ?? 2)),
      stats: { ...(approvals.stats || {}) },
      lastError: plainClone(approvals.lastError || null)
    };
  }

  async function configure(body) {
    if (!isPlainObject(body)) throw new ValidationError('body', 'INVALID_BODY', 'Se espera un objeto de configuración.');
    const allowed = new Set(['preferredChannel', 'notifyOnCreate', 'reminderMinutes', 'maxReminders', 'simulatorTarget', 'owners', 'allowAutonomousOutbound']);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo de configuración no permitido: ${key}.`);
    }
    let parsedOwners = null;
    let parsedAutonomous = null;
    if (body.allowAutonomousOutbound !== undefined) {
      parsedAutonomous = boolean(body.allowAutonomousOutbound, { field: 'allowAutonomousOutbound' });
    }
    if (body.owners !== undefined) {
      if (!isPlainObject(body.owners)) throw new ValidationError('owners', 'INVALID_BODY', 'owners debe ser un objeto por canal.');
      parsedOwners = {};
      for (const [channel, list] of Object.entries(body.owners)) {
        if (!APPROVAL_CHANNELS.includes(channel)) throw new ValidationError(`owners.${channel}`, 'INVALID_VALUE', `Canal de aprobaciones inválido: ${channel}.`);
        if (!Array.isArray(list)) throw new ValidationError(`owners.${channel}`, 'INVALID_BODY', 'La lista de dueños debe ser un array.');
        if (list.length > 20) throw new ValidationError(`owners.${channel}`, 'TOO_LONG', 'Máximo 20 dueños por canal.');
        parsedOwners[channel] = list.map((item, index) => text(String(item), { field: `owners.${channel}[${index}]`, max: 200, allowEmpty: false }));
      }
    }
    // El flag se delega al setter auditado ANTES de tocar owners/preferred; si
    // el ledger falla, no se cambia ningún ajuste de aprobaciones.
    if (parsedAutonomous !== null) {
      await setAllowAutonomousOutboundAudited(parsedAutonomous, { source: 'channels.approvals.config', by: 'user' });
    }
    await updateApprovals((approvals) => {
      if (body.preferredChannel !== undefined) {
        approvals.config.preferredChannel = body.preferredChannel === null || body.preferredChannel === ''
          ? null
          : enumValue(body.preferredChannel, APPROVAL_CHANNELS, { field: 'preferredChannel' });
      }
      if (body.notifyOnCreate !== undefined) approvals.config.notifyOnCreate = boolean(body.notifyOnCreate, { field: 'notifyOnCreate' });
      if (body.reminderMinutes !== undefined) approvals.config.reminderMinutes = integer(body.reminderMinutes, { field: 'reminderMinutes', min: 1, max: 120 });
      if (body.maxReminders !== undefined) approvals.config.maxReminders = integer(body.maxReminders, { field: 'maxReminders', min: 0, max: 2 });
      if (body.simulatorTarget !== undefined) approvals.config.simulatorTarget = text(body.simulatorTarget, { field: 'simulatorTarget', max: 120, allowEmpty: false });
      if (parsedOwners) {
        for (const [channel, list] of Object.entries(parsedOwners)) approvals.config.owners[channel] = list;
      }
    }, 'aprobaciones-config');
    await recordAudit({ channel: 'aprobaciones', action: 'configuración', outcome: 'ok', detail: Object.keys(body).join(', ') });
    return { ok: true, ...status() };
  }

  /* ------------------------- Avisos automáticos ---------------------- */

  async function autoNotify({ now = Date.now() } = {}) {
    const approvals = approvalsView();
    if (approvals.config.notifyOnCreate === false) return { notified: 0, skipped: 0 };
    const baseline = Number(approvals.baselineAt) || now - REMINDER_GRACE_MS;
    let notified = 0;
    let skipped = 0;
    for (const proposal of pendingProposals()) {
      if (!['N2', 'N3'].includes(proposal.level)) continue;
      const notifiedEntry = approvals.notified[proposal.id];
      if (notifiedEntry && !notifiedEntry.error) continue;
      if (Number(notifiedEntry?.attempts || 0) >= 3) { skipped += 1; continue; }
      const createdAt = Date.parse(proposal.createdAt || '');
      if (Number.isFinite(createdAt) && createdAt < baseline - 1_000) { skipped += 1; continue; }
      const preferred = resolvePreferredTarget(approvals.config);
      if (!preferred) {
        await updateApprovals((state) => {
          const attempts = Number(state.notified[proposal.id]?.attempts || 0) + 1;
          state.notified[proposal.id] = { at: new Date().toISOString(), error: 'sin-canal', attempts };
          state.lastError = { at: new Date().toISOString(), proposalId: proposal.id, message: 'Sin canal preferido disponible para avisar.' };
        }, 'aprobaciones-sin-canal');
        skipped += 1;
        continue;
      }
      try {
        await sendCard({ proposalId: proposal.id, channel: preferred.channel, to: preferred.to, auto: true });
        notified += 1;
      } catch (error) {
        // Si la propuesta se decidió entre la lectura y el envío, no es un fallo.
        if (error?.status === 409 && error?.code === 'ALREADY_DECIDED') { skipped += 1; continue; }
        logError('aprobaciones:auto-aviso', error, { proposalId: proposal.id });
        await updateApprovals((state) => {
          const attempts = Number(state.notified[proposal.id]?.attempts || 0) + 1;
          state.notified[proposal.id] = { at: new Date().toISOString(), error: sanitizeText(describeError(error), 200), attempts };
          bump(state, 'failures');
        }, 'aprobaciones-auto-error');
        skipped += 1;
      }
    }
    return { notified, skipped };
  }

  async function remindersTick({ now = Date.now() } = {}) {
    const approvals = approvalsView();
    const intervalMin = Math.max(1, Number(approvals.config.reminderMinutes || 15));
    const maxReminders = Math.min(2, Number(approvals.config.maxReminders ?? 2));
    let reminders = 0;
    let skipped = 0;
    for (const [key, context] of Object.entries(approvals.contexts)) {
      const proposal = proposalSafe(context.proposalId);
      if (!proposal || !['pending', 'held'].includes(proposal.status)) {
        continue;
      }
      if (Number(context.reminders || 0) >= maxReminders) { skipped += 1; continue; }
      const anchor = Math.max(Date.parse(context.lastReminderAt || '') || 0, Date.parse(context.sentAt || '') || 0);
      if (!anchor || now - anchor < intervalMin * 60_000) continue;
      try {
        const messageId = await sendReminderMessage(context, proposal);
        const updated = { ...context, reminders: Number(context.reminders || 0) + 1, lastReminderAt: new Date().toISOString(), messageId };
        await updateApprovals((state) => {
          state.contexts[key] = updated;
          bump(state, 'reminders');
        }, `aprobaciones-recordatorio-auto:${context.proposalId}`);
        reminders += 1;
      } catch (error) {
        logError('aprobaciones:recordatorio', error, { proposalId: context.proposalId });
        await updateApprovals((state) => {
          state.contexts[key] = { ...context, reminderErrors: Number(context.reminderErrors || 0) + 1 };
          state.lastError = { at: new Date().toISOString(), proposalId: context.proposalId, message: sanitizeText(describeError(error), 300) };
        }, 'aprobaciones-recordatorio-error');
        skipped += 1;
      }
    }
    return { reminders, skipped };
  }

  async function tick(options = {}) {
    if (ticking) return { ok: true, skipped: 'in-progress', at: new Date().toISOString(), notified: 0, reminders: 0 };
    ticking = true;
    const now = Number(options.now) || Date.now();
    try {
      if (!Number.isFinite(Number(approvalsView().baselineAt))) {
        await updateApprovals((approvals) => {
          if (!Number.isFinite(Number(approvals.baselineAt))) approvals.baselineAt = now - REMINDER_GRACE_MS;
        }, 'aprobaciones-baseline');
      }
      const auto = options.autoNotify === false ? { notified: 0, skipped: 0 } : await autoNotify({ now });
      const reminders = options.remind === false ? { reminders: 0, skipped: 0 } : await remindersTick({ now });
      return { ok: true, at: new Date(now).toISOString(), ...auto, ...reminders };
    } finally {
      ticking = false;
    }
  }

  function startWatcher({ intervalMs = null } = {}) {
    const flag = String(process.env.CHANNELS_APPROVALS_AUTOSTART || '').trim().toLowerCase();
    if (['off', 'false', '0', 'no'].includes(flag)) return { started: false, reason: 'CHANNELS_APPROVALS_AUTOSTART=off' };
    if (watcher) return { started: true, already: true };
    stopped = false;
    const configuredMs = Number(intervalMs || process.env.CHANNELS_APPROVALS_TICK_MS) || 10_000;
    watcher = setInterval(() => {
      if (stopped) return;
      tick().catch((error) => logError('aprobaciones:tick', error));
    }, Math.max(5_000, configuredMs));
    if (typeof watcher.unref === 'function') watcher.unref();
    void tick().catch((error) => logError('aprobaciones:tick-inicial', error));
    return { started: true };
  }

  function stopWatcher() {
    stopped = true;
    if (watcher) clearInterval(watcher);
    watcher = null;
    return { stopped: true };
  }

  async function sendDocument() {
    throw new HttpError(410, 'CHANNEL_PROPOSAL_REQUIRED', 'Los documentos se envían con una propuesta aprobada; usa /api/channels/send-document.');
  }

  return {
    handleInbound,
    sendCard,
    remind,
    sendDocument,
    pending,
    status,
    configure,
    tick,
    startWatcher,
    stopWatcher,
    buildCard: (proposalId, channel = 'simulator') => {
      const proposal = proposalSafe(normalizeProposalId(proposalId));
      if (!proposal) throw new HttpError(404, 'NOT_FOUND', `Propuesta ${proposalId} no encontrada.`);
      return buildApprovalCard(proposal, channel);
    },
    ownerIds: (channel) => ownerIds(approvalsView().config, channel)
  };
}

/** Canales con salida a terceros sujetos a lista blanca de dueño. */
export const OWNER_GUARDED_CHANNELS = Object.freeze(['whatsapp', 'telegram', 'email']);

/** Campo de configuración que contiene la lista blanca del canal. */
export function ownerListField(channel) {
  if (channel === 'telegram') return 'allowedChatIds';
  if (channel === 'whatsapp') return 'allowedNumbers';
  if (channel === 'email') return 'allowFrom';
  return `approvals.owners.${channel}`;
}

/**
 * ¿El destino es el dueño configurado? El simulador queda exento (local).
 * @param {string} channel
 * @param {unknown} userId
 */
export function isOwnerTarget(channel, userId) {
  const id = String(channel || '').toLowerCase();
  if (id === 'simulator') return true;
  if (!OWNER_GUARDED_CHANNELS.includes(id)) return true;
  if (userId === undefined || userId === null || String(userId).trim() === '') return true;
  return isAuthorized(approvalsView().config, id, userId);
}

/** Destino por defecto del dueño para un canal (o null). */
export function approvalDefaultTarget(channel) {
  return defaultTarget(approvalsView().config, String(channel || '').toLowerCase());
}

/**
 * ¿El texto parece una respuesta de aprobación? Se usa en los adaptadores para
 * dejar pasar intentos de remitentes no autorizados y que el gate los audite y
 * responda «no autorizado» (en vez de descartarlos en silencio).
 * @param {unknown} text
 * @param {string} [subject]
 */
export function looksLikeApprovalResponse(text, subject = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (PROPOSAL_ID_RE.test(raw) || PROPOSAL_ID_RE.test(String(subject || ''))) return true;
  if (/^\s*(ver|detalle)\b/i.test(raw)) return true;
  if (/^\s*[123]\s*$/.test(raw)) return true;
  return parseDecision(raw).decision !== 'unknown';
}

/** Estado global de aprobaciones para la UI (sin crear el servicio). */
export function approvalsStatusView() {
  const approvals = approvalsView();
  return {
    pending: pendingProposals().length,
    contexts: Object.keys(approvals.contexts).length,
    notified: Object.keys(approvals.notified).length,
    baselineAt: approvals.baselineAt,
    stats: approvals.stats
  };
}

/**
 * Fachada de canales de Agenda Copilot P95.
 *
 * Punto único que usa el resto de la app (y los módulos heredados de
 * `core.mjs`). Mantiene los exports históricos —`channelStatus`, `sendWhatsApp`,
 * `sendTelegram`, `setTelegramWebhook`, `verifyWhatsAppSignature`,
 * `notifyChannels`— y añade la API del centro de integraciones:
 *
 *   listChannels()            estado de todos los canales (sin secretos)
 *   getChannel(id)            estado detallado de un canal/instancia
 *   configureChannel(id,b)    guarda credenciales en caliente (sin reiniciar)
 *   testChannel(id,b)         prueba real de credenciales
 *   simulateChannel(b)        conversación local por el simulador
 *   channelInbox(opts)        bandeja normalizada (entrante + saliente)
 *   ensureChannelsStarted()   arranca watchdog de Telegram long polling y Gmail
 *   stopChannels()            detiene los bucles (pruebas/cierre)
 *
 * Los adaptadores viven en `lib/channel/*` y se registran aquí; el pipeline
 * (`lib/channel/pipeline.mjs`) aplica dedupe, rate limit, asistente y respuesta.
 */
import { createChannelRegistry } from './channel/registry.mjs';
import { getMode } from './features/registry.mjs';
import { guardAdapter } from './guard/loop.mjs';
import { createPipeline } from './channel/pipeline.mjs';
import { createSimulatorAdapter } from './channel/simulator.mjs';
import { createTelegramAdapter } from './channel/telegram.mjs';
import { createWhatsAppAdapter } from './channel/whatsapp.mjs';
import { createEmailAdapter } from './channel/email.mjs';
import { createApprovalService, approvalsStatusView } from './channel/approvals.mjs';
import { registerDocumentProvider, resolveDocument, documentsStatus } from './channel/documents.mjs';
import {
  createGenericAdapter, listWebhookInstances, webhookInstanceStatus, webhookInstanceExists,
  configureInstance, webhookHealth
} from './channel/webhook.mjs';
import { recordAudit, recordOutbound } from './channel/state.mjs';
import { makeMessage, sanitizeText, uniqueDedupeKey } from './channel/message.mjs';
import { limiterStats } from './channel/ratelimit.mjs';
import { getSecret } from './security/vault.mjs';
import { webhookStrictMode } from './http/middleware.mjs';
import { log, logError } from './http/logger.mjs';
import { Errors, ValidationError } from './http/errors.mjs';
import { verifyHmacSha256 } from './security/compare.mjs';

const LEGACY_LABEL = 'Agenda Copilot';

/* ------------------------------------------------------------------ */
/* Runtime singleton                                                   */
/* ------------------------------------------------------------------ */

/** @type {null | {registry:any, pipeline:any, adapters:Record<string,any>, started:boolean, startedAt:string|null}} */
let runtime = null;

export function getChannelRuntime() {
  if (runtime) return runtime;
  const registry = createChannelRegistry();
  const pipeline = createPipeline({ registry });
  const adapters = {
    simulator: createSimulatorAdapter(),
    telegram: createTelegramAdapter(),
    whatsapp: createWhatsAppAdapter(),
    email: createEmailAdapter(),
    generic: createGenericAdapter()
  };
  for (const adapter of Object.values(adapters)) {
    guardAdapter(adapter, { getMode: () => getMode('loop_guard') });
    registry.register(adapter);
  }
  adapters.whatsapp.setDispatcher(pipeline.receive);
  adapters.generic.setDispatcher(pipeline.receive);
  const approvals = createApprovalService({ registry });
  pipeline.setApprovalHandler(approvals.handleInbound);
  runtime = { registry, pipeline, adapters, approvals, started: false, startedAt: null };
  return runtime;
}

function isWebhookId(id) {
  return id === 'generic' || /^webhook:[a-z0-9][a-z0-9_-]{1,30}$/.test(String(id || ''));
}

/**
 * Adaptador para un id (los webhooks comparten el adaptador `generic`).
 * @param {string} id
 */
export function getChannelAdapter(id) {
  const { registry } = getChannelRuntime();
  if (isWebhookId(id)) return registry.get('generic');
  return registry.get(String(id || ''));
}

/**
 * Arranca los bucles de recepción (idempotente).
 * Telegram long polling y Gmail polling son `setTimeout` con `unref()`: no
 * impiden que el proceso termine y se pueden desactivar con
 * `CHANNELS_AUTOSTART=off` (pruebas).
 * @param {{force?:boolean}} [options]
 */
export function ensureChannelsStarted(options = {}) {
  const current = getChannelRuntime();
  const autostart = String(process.env.CHANNELS_AUTOSTART || '').trim().toLowerCase();
  const disabled = autostart === 'off' || autostart === 'false' || autostart === '0' || autostart === 'no';
  if (!options.force && disabled) return { started: false, reason: 'CHANNELS_AUTOSTART=off' };
  try {
    current.adapters.telegram.start({ onMessage: current.pipeline.receive });
    current.adapters.email.start({ onMessage: current.pipeline.receive });
    const approvalsWatch = current.approvals.startWatcher();
    current.started = true;
    current.startedAt = current.startedAt || new Date().toISOString();
    return { started: true, channels: current.registry.ids(), approvals: approvalsWatch, at: current.startedAt };
  } catch (error) {
    logError('channels:start', error);
    return { started: false, reason: 'error', error: error?.message || 'error' };
  }
}

/** Detiene los bucles de recepción (pruebas o apagado). */
export function stopChannels() {
  const current = getChannelRuntime();
  try { current.adapters.telegram.stop(); } catch { /* ignore */ }
  try { current.adapters.email.stop(); } catch { /* ignore */ }
  try { current.approvals.stopWatcher(); } catch { /* ignore */ }
  current.started = false;
  return { stopped: true };
}

/** Resumen de salud del subsistema de canales (sin secretos). */
export function channelsHealth() {
  const current = getChannelRuntime();
  const autostart = String(process.env.CHANNELS_AUTOSTART || '').trim().toLowerCase();
  return {
    ok: true,
    started: current.started,
    startedAt: current.startedAt,
    autostart: !['off', 'false', '0', 'no'].includes(autostart),
    webhookStrict: webhookStrictMode(),
    channels: current.registry.ids(),
    approvals: approvalsStatusView(),
    limits: limiterStats().limits,
    activeLimitBuckets: limiterStats().active
  };
}

/* ------------------------------------------------------------------ */
/* Centro de integraciones                                             */
/* ------------------------------------------------------------------ */

function sortChannels(items) {
  const order = { simulator: 0, telegram: 1, whatsapp: 2, email: 3, generic: 4 };
  return items.sort((a, b) => {
    const ia = order[a.id] ?? 50;
    const ib = order[b.id] ?? 50;
    if (ia !== ib) return ia - ib;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Estado de todos los canales + instancias de webhook.
 * @returns {{items:object[], count:number, total:number, generatedAt:string}}
 */
export function listChannels() {
  const current = getChannelRuntime();
  const items = current.registry.statuses();
  const known = new Set(items.map((item) => item.id));
  for (const instance of listWebhookInstances()) {
    if (!known.has(instance.id)) {
      items.push(instance);
      known.add(instance.id);
    }
  }
  sortChannels(items);
  return { items, count: items.length, total: items.length, generatedAt: new Date().toISOString() };
}

/**
 * Estado detallado de un canal (o instancia de webhook).
 * @param {string} id
 */
export function getChannel(id) {
  const current = getChannelRuntime();
  if (isWebhookId(id) && id !== 'generic') {
    if (!webhookInstanceExists(id)) throw Errors.notFound(`Canal ${id}`);
    const instance = webhookInstanceStatus(id);
    if (!instance) throw Errors.notFound(`Canal ${id}`);
    return instance;
  }
  const adapter = current.registry.get(id);
  if (!adapter) throw Errors.notFound(`Canal ${id}`);
  return adapter.status();
}

/**
 * Guarda configuración/credenciales en caliente.
 * @param {string} id
 * @param {unknown} body
 */
export async function configureChannel(id, body) {
  const current = getChannelRuntime();
  let result;
  if (id !== 'generic' && isWebhookId(id)) {
    result = await configureInstance(id, body);
  } else if (id === 'generic') {
    result = await configureInstance('generic', body);
  } else {
    const adapter = current.registry.get(id);
    if (!adapter) throw Errors.notFound(`Canal ${id}`);
    result = await adapter.configure(body);
  }
  // Cambios en canales con bucle propio se aplican al instante.
  if (id === 'telegram') current.adapters.telegram.start({ onMessage: current.pipeline.receive });
  if (id === 'email') current.adapters.email.start({ onMessage: current.pipeline.receive });
  await recordAudit({
    channel: id,
    action: 'configurado',
    outcome: 'ok',
    detail: Array.isArray(result?.changed) ? result.changed.join(', ') : 'configuración'
  }, { activity: true });
  return {
    ok: true,
    channel: id,
    detail: result?.detail || 'Configuración guardada y aplicada sin reiniciar.',
    changed: result?.changed || [],
    generatedToken: result?.generatedToken || undefined,
    item: getChannel(id)
  };
}

/**
 * Prueba real de credenciales con el proveedor (o el simulador).
 * @param {string} id
 * @param {{to?:string, text?:string, chatId?:string}} [body]
 */
export async function testChannel(id, body = {}) {
  const current = getChannelRuntime();
  let result;
  try {
    if (isWebhookId(id)) {
      result = await current.adapters.generic.test({ ...body, id });
    } else {
      const adapter = current.registry.get(id);
      if (!adapter) throw Errors.notFound(`Canal ${id}`);
      result = await adapter.test(body || {});
    }
  } catch (error) {
    await recordAudit({ channel: id, action: 'prueba', outcome: 'error', detail: error?.message }, { activity: false });
    throw error;
  }
  await recordAudit({ channel: id, action: 'prueba', outcome: 'ok', detail: result?.detail }, { activity: true });
  return { ...result, item: getChannel(id) };
}

/**
 * Conversación por el simulador local (sin credenciales ni red).
 * @param {{text:string, userId?:string}} input
 */
export async function simulateChannel(input) {
  const current = getChannelRuntime();
  const text = String(input?.text ?? '').trim();
  if (!text) throw new ValidationError('text', 'REQUIRED', 'Falta el texto a simular.');
  if (text.length > 4000) throw new ValidationError('text', 'TOO_LONG', 'El texto supera los 4000 caracteres.');
  const result = await current.pipeline.simulate({
    text,
    userId: sanitizeText(input?.userId || 'demo', 80) || 'demo',
    meta: { client: 'api' }
  });
  return {
    ok: true,
    reply: result.reply,
    outbound: result.outbound,
    channel: 'simulator',
    userId: result.userId,
    duplicate: result.duplicate,
    messageId: result.outboundMessage?.id || result.message?.id || null,
    replyOptions: result.replyOptions,
    approval: result.approval || null
  };
}

/**
 * Bandeja local normalizada.
 * @param {{limit?:number, channel?:string, direction?:string}} [options]
 */
export function channelInbox(options = {}) {
  const current = getChannelRuntime();
  return current.pipeline.inbox(options);
}

/** Entrada de webhook genérico (payload ya autenticado). */
export async function channelWebhookInbound(id, payload) {
  const current = getChannelRuntime();
  return current.adapters.generic.processWebhook(payload, { instance: id });
}

/** Payload de WhatsApp ya verificado por firma. */
export async function handleWhatsAppWebhook(payload) {
  const current = getChannelRuntime();
  return current.adapters.whatsapp.processWebhook(payload);
}

/** Payload de Telegram (modo webhook) o update individual. */
export async function handleTelegramWebhook(payload) {
  const current = getChannelRuntime();
  return current.adapters.telegram.processWebhook(payload);
}

/** Fuerza una pasada de getUpdates (diagnóstico/pruebas). */
export async function telegramPollNow(options = {}) {
  const current = getChannelRuntime();
  return current.adapters.telegram.pollNow({ timeoutSec: options.timeoutSec || 2 });
}

/** Fuerza una revisión de Gmail (diagnóstico/pruebas). */
export async function emailPollNow() {
  const current = getChannelRuntime();
  return current.adapters.email.poll();
}

/** Borra el webhook registrado en Telegram (limpieza de conflictos 409). */
export async function telegramDeleteWebhook() {
  const current = getChannelRuntime();
  return current.adapters.telegram.deleteWebhook();
}

/** Inicia el OAuth de lectura de Gmail; devuelve la URL de consentimiento. */
export async function emailOAuthStart(origin) {
  const current = getChannelRuntime();
  return current.adapters.email.oauthStartUrl(origin);
}

/** Completa el OAuth de lectura de Gmail. */
export async function emailOAuthFinish(input) {
  const current = getChannelRuntime();
  return current.adapters.email.finishOAuth(input);
}

/** Estado agregado de las instancias de webhook. */
export function webhooksHealth() {
  return webhookHealth();
}

/* ------------------------------------------------------------------ */
/* Aprobaciones y entregables (t18)                                    */
/* ------------------------------------------------------------------ */

/** Propuestas N2/N3 pendientes + tarjetas enviadas y recordatorios. */
export function approvalsPending() {
  return getChannelRuntime().approvals.pending();
}

/** Estado del subsistema de aprobaciones (config, dueños, watcher, stats). */
export function approvalsStatus() {
  return getChannelRuntime().approvals.status();
}

/** Guarda la configuración de aprobaciones (canal preferido, dueños, recordatorios). */
export async function configureApprovals(body) {
  return getChannelRuntime().approvals.configure(body);
}

/** Envía la tarjeta de una propuesta por un canal. */
export async function sendApproval(proposalId, input = {}) {
  return getChannelRuntime().approvals.sendCard({ proposalId, channel: input.channel, to: input.to });
}

/** Envía un recordatorio de una propuesta ya notificada. */
export async function remindApproval(proposalId, input = {}) {
  return getChannelRuntime().approvals.remind({ proposalId, channel: input.channel || null, to: input.to || null, force: input.force === true });
}

/** Envía un documento generado como adjunto por el canal indicado. */
export async function sendChannelDocument(input = {}) {
  return getChannelRuntime().approvals.sendDocument(input);
}

/** Ejecuta un tick determinista de avisos/recordatorios (pruebas y diagnóstico). */
export async function runApprovalsTick(options = {}) {
  return getChannelRuntime().approvals.tick(options);
}

/** Arranca/detiene el watcher de aprobaciones (por defecto lo hace ensureChannelsStarted). */
export function startApprovalWatcher(options = {}) {
  return getChannelRuntime().approvals.startWatcher(options);
}

export function stopApprovalWatcher() {
  return getChannelRuntime().approvals.stopWatcher();
}

/** Resuelve un documento (docId) a bytes/nombre/mime sin enviarlo. */
export async function resolveChannelDocument(docId) {
  return resolveDocument(docId);
}

/** Diagnóstico del subsistema de documentos para la UI. */
export function documentsHealth() {
  return documentsStatus();
}

/** Permite a otros módulos registrar una fuente de documentos. */
export { registerDocumentProvider };

/* ------------------------------------------------------------------ */
/* Compatibilidad heredada (core.mjs / scheduler t8)                   */
/* ------------------------------------------------------------------ */

function envFlag(name) {
  return String(getSecret(name) || '').toLowerCase() === 'true';
}

/**
 * Estado heredado que consumen `/api/health` y `/api/bootstrap`:
 * `{whatsapp:{configured,phoneNumberId}, telegram:{configured}, email:{configured,to}}`.
 * Se mantiene EXACTAMENTE con esa forma para no romper contratos; el detalle
 * completo está en `GET /api/channels`.
 */
export function channelStatus() {
  const waEnabled = envFlag('channels.whatsapp.enabled');
  const waPhone = getSecret('channels.whatsapp.phoneNumberId');
  const waToken = getSecret('channels.whatsapp.accessToken');
  return {
    whatsapp: {
      configured: waEnabled && !!waPhone && !!waToken,
      phoneNumberId: waPhone ? 'configurado' : null
    },
    telegram: {
      configured: envFlag('channels.telegram.enabled') && !!getSecret('channels.telegram.botToken')
    },
    email: {
      configured: envFlag('channels.email.enabled'),
      to: getSecret('channels.email.to') || null
    }
  };
}

/**
 * Envío de WhatsApp (compatibilidad con `POST /api/whatsapp/test`).
 * @param {string|undefined} to
 * @param {string} text
 * @param {{proactive?:boolean}} [options]
 */
export async function sendWhatsApp(to, text, { proactive = false } = {}) {
  if (!envFlag('channels.whatsapp.enabled')) throw new Error('WhatsApp está desactivado.');
  const current = getChannelRuntime();
  const result = await current.adapters.whatsapp.send({ to, text, meta: { proactive } });
  return {
    messaging_product: 'whatsapp',
    to: result.to,
    messages: [{ id: result.id }],
    ...(result.template ? { template: { name: result.template, language: result.language } } : {})
  };
}

/**
 * Envío de Telegram (compatibilidad con `POST /api/telegram/test`).
 * @param {string|undefined} chatId
 * @param {string} text
 */
export async function sendTelegram(chatId, text) {
  if (!envFlag('channels.telegram.enabled')) throw new Error('Telegram está desactivado.');
  const current = getChannelRuntime();
  const result = await current.adapters.telegram.send({ to: chatId, text });
  return { ok: true, result: { message_id: result.id, chat: { id: result.to } } };
}

/** Registra el webhook de Telegram (compatibilidad con `/api/telegram/set-webhook`). */
export async function setTelegramWebhook(appUrl) {
  const current = getChannelRuntime();
  return current.adapters.telegram.setWebhook(appUrl || process.env.APP_URL);
}

/**
 * Verificación HMAC del webhook de WhatsApp (compatibilidad heredada).
 * Sin secreto configurado devuelve `true` (modo local permisivo del contrato).
 * @param {Buffer|string} rawBody
 * @param {string|undefined} signature
 */
export function verifyWhatsAppSignature(rawBody, signature) {
  const secret = getSecret('channels.whatsapp.appSecret');
  if (!secret) return true;
  return verifyHmacSha256(rawBody, signature, secret);
}

/**
 * Envía un aviso proactivo por todos los canales activos (lo usa el scheduler).
 *
 * Nunca lanza: devuelve un resultado por canal para que un fallo de WhatsApp no
 * impida el recordatorio por Telegram o correo.
 *
 * @param {string} text
 * @param {{whatsappTo?:string, telegramChat?:string, emailTo?:string, subject?:string, channels?:string[]}} [options]
 * @returns {Promise<{channel:string, ok:boolean, id:string|null, error:string|null}[]>}
 */
export async function notifyChannels(text, options = {}) {
  const current = getChannelRuntime();
  const message = sanitizeText(text, 4000);
  const subject = options.subject || `${LEGACY_LABEL} — recordatorio`;
  const wanted = Array.isArray(options.channels) && options.channels.length
    ? new Set(options.channels)
    : new Set(['whatsapp', 'telegram', 'email']);
  const results = [];

  const record = async (channel, to, result, error) => {
    try {
      await recordOutbound(makeMessage({
        channel,
        direction: 'outbound',
        userId: String(to || channel),
        text: message,
        dedupeKey: uniqueDedupeKey(channel, 'notify'),
        status: error ? 'failed' : 'sent',
        meta: { proactive: true, subject: channel === 'email' ? subject : undefined },
        error: error ? String(error.message || error) : null,
        errorCode: error?.code || null
      }));
    } catch { /* store en solo lectura: el envío ya ocurrió */ }
  };

  if (wanted.has('whatsapp') && envFlag('channels.whatsapp.enabled')) {
    const to = options.whatsappTo || getSecret('channels.whatsapp.defaultTo');
    if (to) {
      try {
        const sent = await current.adapters.whatsapp.send({ to, text: message, meta: { proactive: true } });
        results.push({ channel: 'whatsapp', ok: true, id: sent.id || null, error: null });
        await record('whatsapp', to, sent, null);
      } catch (error) {
        logError('channels:notify:whatsapp', error);
        results.push({ channel: 'whatsapp', ok: false, id: null, error: error?.message || 'error' });
        await record('whatsapp', to, null, error);
      }
    }
  }

  if (wanted.has('telegram') && envFlag('channels.telegram.enabled')) {
    const chatId = options.telegramChat || getSecret('channels.telegram.defaultChatId');
    if (chatId) {
      try {
        const sent = await current.adapters.telegram.send({ to: chatId, text: message });
        results.push({ channel: 'telegram', ok: true, id: sent.id || null, error: null });
        await record('telegram', chatId, sent, null);
      } catch (error) {
        logError('channels:notify:telegram', error);
        results.push({ channel: 'telegram', ok: false, id: null, error: error?.message || 'error' });
        await record('telegram', chatId, null, error);
      }
    }
  }

  if (wanted.has('email') && envFlag('channels.email.enabled')) {
    const to = options.emailTo || getSecret('channels.email.to');
    if (to) {
      try {
        const sent = await current.adapters.email.send({ to, text: message, meta: { subject } });
        results.push({ channel: 'email', ok: true, id: sent.id || null, error: null });
        await record('email', to, sent, null);
      } catch (error) {
        logError('channels:notify:email', error);
        results.push({ channel: 'email', ok: false, id: null, error: error?.message || 'error' });
        await record('email', to, null, error);
      }
    }
  }

  return results;
}

/**
 * Envía un aviso proactivo por un canal concreto (útil para el scheduler y
 * pruebas de integración). Nunca lanza.
 * @param {string} channel
 * @param {{to?:string, text:string, subject?:string, meta?:object}} input
 */
export async function notifyChannel(channel, input = {}) {
  const current = getChannelRuntime();
  const adapter = isWebhookId(channel) ? current.adapters.generic : current.registry.get(channel);
  if (!adapter) return { channel, ok: false, id: null, error: 'canal desconocido' };
  const text = sanitizeText(input.text, 8000);
  const instanceMeta = isWebhookId(channel) && channel !== 'generic' ? { instance: channel, webhookId: channel } : {};
  try {
    const sent = await adapter.send({
      to: input.to,
      text,
      meta: { ...(input.meta || {}), ...instanceMeta, subject: input.subject, proactive: true },
      message: { meta: { ...instanceMeta } }
    });
    return { channel, ok: sent?.skipped !== true, id: sent?.id || null, error: null, skipped: sent?.skipped === true };
  } catch (error) {
    log('warn', `Canal ${channel}: envío proactivo falló (${error?.message || 'error'}).`);
    return { channel, ok: false, id: null, error: error?.message || 'error' };
  }
}

/**
 * Diagnóstico de una instancia de webhook (compatibilidad con la UI).
 * @param {string} id
 */
export function webhookStatus(id = 'generic') {
  return webhookInstanceStatus(isWebhookId(id) ? id : `webhook:${id}`);
}


/** Campos de configuración de un canal (para la UI). */
export function channelConfig(id) {
  const current = getChannelRuntime();
  if (isWebhookId(id)) return current.adapters.generic.configFields || [];
  return current.registry.get(id)?.configFields || [];
}


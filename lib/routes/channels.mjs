/**
 * Módulo de rutas del centro de integraciones de canales.
 *
 * Prioridad 200: puede sobrescribir las rutas heredadas de `core.mjs` cuando
 * aporta valor (webhooks de WhatsApp/Telegram con idempotencia real). El resto
 * de contratos existentes no se toca.
 *
 * Rutas propias (documentadas en docs/CANALES.md):
 *   GET  /api/channels                          estado de todos los canales
 *   GET  /api/channels/health                   salud del subsistema
 *   GET  /api/channels/inbox                    bandeja normalizada
 *   GET  /api/channels/messages                 alias de inbox
 *   GET  /api/channels/:id                      estado detallado
 *   POST /api/channels/:id/config               guardar credenciales/ajustes
 *   POST /api/channels/:id/test                 probar credenciales (solo contra el dueño)
 *   POST /api/channels/:id/send                 crear propuesta de salida a terceros
 *   POST /api/channels/send-document            crear propuesta con adjunto
 *   POST /api/channels/:id/enable               activar/desactivar
 *   POST /api/channels/simulate                 conversar sin credenciales
 *   POST /api/channels/inbound/:id              webhook genérico con token
 *   POST /api/channels/telegram/poll            pasada manual de getUpdates
 *   POST /api/channels/email/poll               revisión manual de Gmail
 *   GET  /api/channels/email/oauth/start        consentimiento Gmail (lectura)
 *   GET  /api/channels/email/oauth/callback     callback OAuth de Gmail
 *   POST /api/whatsapp/webhook                  webhook de Meta (idempotente)
 *   POST /api/telegram/webhook                  webhook de Telegram (idempotente)
 *   POST /api/webhooks/generic                  alias del webhook genérico
 */
import {
  listChannels, getChannel, configureChannel, testChannel, simulateChannel, channelInbox,
  channelWebhookInbound, handleWhatsAppWebhook, handleTelegramWebhook, telegramPollNow,
  emailPollNow, emailOAuthStart, emailOAuthFinish, ensureChannelsStarted, channelsHealth,
  telegramDeleteWebhook, approvalsPending, approvalsStatus, configureApprovals,
  sendApproval, remindApproval, documentsHealth, resolveChannelDocument,
  sendWhatsApp, sendTelegram, getChannelRuntime
} from '../channels.mjs';
import { verifyInboundToken } from '../channel/webhook.mjs';
import { consume, LIMITS, limitError } from '../channel/ratelimit.mjs';
import { isHttpError, HttpError, Errors, ValidationError } from '../http/errors.mjs';
import { isPlainObject, boolean, text } from '../validate.mjs';
import { isOwnerTarget, ownerListField } from '../channel/approvals.mjs';
import { createOutboundService } from '../channel/outbound.mjs';
import { installChannelExecutors } from '../channel/executors.mjs';
import { verifyTelegramWebhook, verifyWhatsAppWebhook } from '../http/middleware.mjs';
import { log, logError } from '../http/logger.mjs';
import { store } from '../store.mjs';
import { hostConfig } from '../security/session.mjs';

export const name = 'channels';
export const priority = 200;

function assertTestOwner(channel, target) {
  if (target === undefined || target === null || String(target).trim() === '') return;
  if (isOwnerTarget(channel, target)) return;
  throw Errors.forbidden('NOT_OWNER', `Solo puedes probar ${channel} contra el dueño configurado. Para terceros crea una propuesta en /api/channels/${channel}/send.`, {
    channel,
    listField: ownerListField(channel),
    hint: 'Configura la lista blanca del canal o usa el flujo de aprobación.'
  });
}

// El subsistema de canales arranca al montar el módulo (Telegram long polling y
// watchdog de Gmail). Es idempotente, usa timers `unref()` y se puede desactivar
// con CHANNELS_AUTOSTART=off (pruebas). Nunca impide que la app arranque.
try {
  ensureChannelsStarted();
} catch (error) {
  log('warn', `Canales: no se pudieron arrancar los bucles (${error?.message || 'error'}).`);
}

// Los ejecutores de canal con adjuntos viven en lib/channel/executors.mjs. Se
// instalan al montar el módulo para que las propuestas pendientes puedan
// ejecutarse aunque la app se reinicie sin pasar antes por /send.
let outboundService = null;
function outboundFor() {
  const runtime = getChannelRuntime();
  installChannelExecutors({ registry: runtime.registry });
  if (!outboundService) outboundService = createOutboundService({ registry: runtime.registry });
  return outboundService;
}
try {
  installChannelExecutors({ registry: getChannelRuntime().registry });
} catch (error) {
  log('warn', `Canales: no se pudieron registrar los ejecutores con adjuntos (${error?.message || 'error'}).`);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function appOrigin(ctx) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(ctx.req.headers['x-forwarded-proto'] || (ctx.req.socket?.encrypted ? 'https' : 'http'))
    .split(',')[0].trim();
  const host = String(ctx.req.headers.host || `${hostConfig().host}:${process.env.PORT || 3000}`);
  return `${proto}://${host}`;
}

/**
 * Convierte errores de canal/validación en la forma de error del contrato.
 * @param {unknown} error
 * @returns {never}
 */
function rethrow(error) {
  if (isHttpError(error)) throw error;
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    const status = Number(error.status) || 502;
    const details = error.details ?? null;
    throw new HttpError(status, error.code, error.message || 'Error de canal.', { details });
  }
  throw error;
}

/**
 * Aplica rate limit y lanza 429 acorde al contrato.
 * @param {string} key
 * @param {{max:number, windowMs:number}} rule
 * @param {string} scope
 */
function limit(key, rule, scope) {
  const result = consume(key, rule);
  if (result.ok) return;
  const error = limitError(scope, result);
  throw Errors.tooManyRequests(result.retryAfterSec);
}

function parseLimit(ctx, fallback = 50) {
  const raw = ctx.query.get('limit');
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 200);
}

function intakeId(ctx) {
  const id = String(ctx.params.id || '').trim();
  if (!id) throw new ValidationError('id', 'REQUIRED', 'Falta el id del canal.');
  return id;
}

/** Parsea y valida el flag `enabled` de /enable. */
async function readEnabled(ctx) {
  const body = await ctx.body();
  if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {enabled: true|false}.');
  if (body.enabled === undefined) throw new ValidationError('enabled', 'REQUIRED', 'Falta el campo enabled.');
  return boolean(body.enabled, { field: 'enabled', required: true });
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

export const routes = [
  /* ------------------- aprobaciones y entregables ------------------ */
  {
    method: 'GET',
    path: '/api/channels/approvals/pending',
    name: 'channels.approvals.pending',
    handler: async () => approvalsPending()
  },
  {
    method: 'GET',
    path: '/api/channels/approvals/status',
    name: 'channels.approvals.status',
    handler: async () => approvalsStatus()
  },
  {
    method: 'POST',
    path: '/api/channels/approvals/config',
    name: 'channels.approvals.config',
    handler: async (ctx) => {
      const body = await ctx.body();
      try {
        return await configureApprovals(body);
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/approvals/:id/send',
    name: 'channels.approvals.send',
    handler: async (ctx) => {
      const body = await ctx.body();
      if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {channel, to?}.');
      try {
        return await sendApproval(ctx.params.id, { channel: body.channel, to: body.to });
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/approvals/:id/remind',
    name: 'channels.approvals.remind',
    handler: async (ctx) => {
      const body = await ctx.body();
      if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {channel?, to?, force?}.');
      try {
        return await remindApproval(ctx.params.id, { channel: body.channel, to: body.to, force: body.force === true });
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/:id/send',
    name: 'channels.send',
    handler: async (ctx) => {
      const body = await ctx.body();
      if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {to|recipients, body, subject?, attachments?}. No se envía: crea una propuesta.');
      try {
        return ctx.json(202, await outboundFor().createSendProposal({ ...body, channel: ctx.params.id }));
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/send-document',
    name: 'channels.send-document',
    maxBodyBytes: 12_000_000,
    handler: async (ctx) => {
      const body = await ctx.body();
      if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {docId|filename+base64, channel, to?}.');
      try {
        return ctx.json(202, await outboundFor().createDocumentProposal(body));
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'GET',
    path: '/api/channels/documents/status',
    name: 'channels.documents.status',
    handler: async () => ({ ok: true, ...documentsHealth() })
  },
  {
    method: 'GET',
    path: '/api/channels/documents/:docId',
    name: 'channels.documents.get',
    handler: async (ctx) => {
      try {
        const doc = await resolveChannelDocument(ctx.params.docId);
        return {
          item: { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, size: doc.size, type: doc.type, origin: doc.origin, downloadUrl: doc.downloadUrl }
        };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'GET',
    path: '/api/channels',
    name: 'channels.list',
    handler: async () => listChannels()
  },
  {
    method: 'GET',
    path: '/api/channels/health',
    name: 'channels.health',
    handler: async () => channelsHealth()
  },
  {
    method: 'GET',
    path: '/api/channels/inbox',
    name: 'channels.inbox',
    handler: async (ctx) => channelInbox({
      limit: parseLimit(ctx),
      channel: ctx.query.get('channel') || undefined,
      direction: ctx.query.get('direction') || undefined
    })
  },
  {
    method: 'GET',
    path: '/api/channels/messages',
    name: 'channels.messages',
    handler: async (ctx) => channelInbox({
      limit: parseLimit(ctx),
      channel: ctx.query.get('channel') || undefined,
      direction: ctx.query.get('direction') || undefined
    })
  },
  {
    method: 'POST',
    path: '/api/channels/simulate',
    name: 'channels.simulate',
    handler: async (ctx) => {
      limit(`simulate:${ctx.ip}`, LIMITS.simulatePerIp, 'el simulador');
      const body = await ctx.body();
      if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {text, userId?}.');
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new ValidationError('text', 'REQUIRED', 'Falta el texto a simular.');
      }
      try {
        const result = await simulateChannel({ text: body.text, userId: body.userId });
        return { ok: true, ...result };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'GET',
    path: '/api/channels/email/oauth/start',
    name: 'channels.email.oauth.start',
    handler: async (ctx) => {
      try {
        const url = await emailOAuthStart(appOrigin(ctx));
        return ctx.redirect(url, 302);
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'GET',
    path: '/api/channels/email/oauth/callback',
    name: 'channels.email.oauth.callback',
    auth: 'none',
    webhook: true,
    handler: async (ctx) => {
      const oauthError = ctx.query.get('error');
      if (oauthError) {
        return ctx.redirect(`/?channel=email&error=${encodeURIComponent(oauthError)}`, 302);
      }
      const code = ctx.query.get('code');
      const state = ctx.query.get('state');
      if (!code || !state) {
        throw new ValidationError('code', 'REQUIRED', 'Google no devolvió code/state en el callback.');
      }
      try {
        const result = await emailOAuthFinish({ code, state, origin: appOrigin(ctx) });
        log('info', `Gmail conectado (${result?.email || 'cuenta'}) para lectura.`);
        return ctx.redirect('/?channel=email&connected=1', 302);
      } catch (error) {
        if (error?.code === 'OAUTH_STATE_INVALID') {
          throw new HttpError(400, 'OAUTH_STATE_INVALID', 'El state de OAuth es inválido o caducó. Inicia la conexión de nuevo.', { details: error.details });
        }
        rethrow(error);
      }
    }
  },
  {
    method: 'GET',
    path: '/api/channels/:id',
    name: 'channels.get',
    handler: async (ctx) => {
      const id = intakeId(ctx);
      try {
        return { item: getChannel(id) };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/:id/config',
    name: 'channels.configure',
    handler: async (ctx) => {
      const id = intakeId(ctx);
      const body = await ctx.body();
      try {
        const result = await configureChannel(id, body);
        // El token generado se muestra UNA vez y debe llegar legible; el resto
        // del payload ya viene enmascarado por los adaptadores.
        if (result.generatedToken) return ctx.json(200, result, {}, { redact: false });
        return result;
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/:id/test',
    name: 'channels.test',
    handler: async (ctx) => {
      const id = intakeId(ctx);
      const body = await ctx.body();
      assertTestOwner(id, body?.to ?? body?.chatId);
      try {
        return await testChannel(id, body);
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/:id/enable',
    name: 'channels.enable',
    handler: async (ctx) => {
      const id = intakeId(ctx);
      const enabled = await readEnabled(ctx);
      if (id === 'simulator') {
        throw new HttpError(400, 'NOT_CONFIGURABLE', 'El simulador siempre está disponible y no se puede desactivar.');
      }
      try {
        return await configureChannel(id, { enabled });
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/telegram/poll',
    name: 'channels.telegram.poll',
    handler: async (ctx) => {
      const body = await ctx.body().catch(() => ({}));
      const timeoutSec = body && body.timeoutSec ? Number(body.timeoutSec) : 2;
      try {
        return { ok: true, ...(await telegramPollNow({ timeoutSec })) };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/telegram/delete-webhook',
    name: 'channels.telegram.delete-webhook',
    handler: async () => {
      try {
        return { ok: true, ...(await telegramDeleteWebhook()) };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/email/poll',
    name: 'channels.email.poll',
    handler: async () => {
      try {
        const result = await emailPollNow();
        return { ok: result.ok !== false, ...result };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/channels/inbound/:id',
    name: 'channels.inbound',
    auth: 'none',
    webhook: true,
    csrf: false,
    handler: async (ctx) => {
      const id = intakeId(ctx);
      limit(`webhook:${ctx.ip}`, LIMITS.webhookPerIp, 'los webhooks');
      verifyInboundToken(id, ctx.req, ctx.query);
      const payload = await ctx.body();
      try {
        const result = await channelWebhookInbound(id, payload);
        return {
          received: true,
          channel: id,
          duplicate: !!result?.duplicate,
          accepted: result?.accepted !== false,
          reply: result?.reply || null,
          userId: result?.userId || null,
          outbound: result?.outbound || []
        };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/webhooks/generic',
    name: 'webhooks.generic',
    auth: 'none',
    webhook: true,
    csrf: false,
    handler: async (ctx) => {
      limit(`webhook:${ctx.ip}`, LIMITS.webhookPerIp, 'los webhooks');
      verifyInboundToken('generic', ctx.req, ctx.query);
      const payload = await ctx.body();
      try {
        const result = await channelWebhookInbound('generic', payload);
        return {
          received: true,
          signal: {
            channel: 'generic',
            userId: result?.userId || null,
            reply: result?.reply || null,
            duplicate: !!result?.duplicate,
            at: new Date().toISOString()
          }
        };
      } catch (error) {
        rethrow(error);
      }
    }
  },
  /* ------------------- webhooks de proveedores ------------------- */
  {
    method: 'POST',
    path: '/api/docs/:id/send-email',
    name: 'channels.docs.send-email-proposal',
    handler: async (ctx) => {
      const body = await ctx.body();
      if (!isPlainObject(body)) throw Errors.invalidBody('Se espera {to, subject, body, connectionId?}; el envío será una propuesta.');
      const emailStatus = getChannelRuntime().adapters.email.status();
      const hasGoogle = Array.isArray(store.get().googleConnections) && store.get().googleConnections.length > 0;
      if (emailStatus.configured !== true && !hasGoogle) {
        throw new HttpError(503, 'EMAIL_NOT_CONFIGURED', 'Gmail no está conectado; no se ha enviado nada. Conecta la cuenta y vuelve a intentarlo.');
      }
      try {
        return ctx.json(202, await outboundFor().createDocumentProposal({
          docId: ctx.params.id,
          channel: 'email',
          to: body.to,
          subject: body.subject,
          caption: body.body,
          connectionId: body.connectionId,
          label: body.label,
          confirmedReserved: body.confirmedReserved === true
        }));
      } catch (error) {
        rethrow(error);
      }
    }
  },
  {
    method: 'POST',
    path: '/api/whatsapp/test',
    name: 'channels.legacy.whatsapp-test',
    handler: async (ctx) => {
      const body = await ctx.body();
      const to = text(body.to, { field: 'to', max: 40, defaultValue: null });
      assertTestOwner('whatsapp', to);
      const message = text(body.text, { field: 'text', max: 4000, defaultValue: 'Prueba Agenda Copilot' });
      return ctx.json(200, await sendWhatsApp(to, message));
    }
  },
  {
    method: 'POST',
    path: '/api/telegram/test',
    name: 'channels.legacy.telegram-test',
    handler: async (ctx) => {
      const body = await ctx.body();
      const chatId = text(body.chatId, { field: 'chatId', max: 64, defaultValue: null });
      assertTestOwner('telegram', chatId);
      const message = text(body.text, { field: 'text', max: 4000, defaultValue: 'Prueba Agenda Copilot' });
      return ctx.json(200, await sendTelegram(chatId, message));
    }
  },
  {
    method: 'POST',
    path: '/api/whatsapp/webhook',
    name: 'whatsapp.webhook',
    auth: 'none',
    webhook: true,
    csrf: false,
    rawBody: true,
    handler: async (ctx) => {
      const raw = await ctx.rawBody();
      try {
        verifyWhatsAppWebhook(ctx.req, raw, ctx);
      } catch (error) {
        rethrow(error);
      }
      let payload = null;
      try {
        payload = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        payload = null;
      }
      if (!payload) throw Errors.invalidJson('Payload de WhatsApp inválido.');
      // Procesamiento asíncrono: Meta exige 200 inmediato y reintenta si no.
      void handleWhatsAppWebhook(payload).catch((error) => logError('whatsapp:webhook', error, { requestId: ctx.requestId }));
      return ctx.json(200, { received: true });
    }
  },
  {
    method: 'POST',
    path: '/api/telegram/webhook',
    name: 'telegram.webhook',
    auth: 'none',
    webhook: true,
    csrf: false,
    handler: async (ctx) => {
      try {
        verifyTelegramWebhook(ctx.req, ctx);
      } catch (error) {
        rethrow(error);
      }
      const payload = await ctx.body();
      void handleTelegramWebhook(payload).catch((error) => logError('telegram:webhook', error, { requestId: ctx.requestId }));
      return ctx.json(200, { received: true });
    }
  }
];

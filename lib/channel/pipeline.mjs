/**
 * Pipeline de conversación de canales.
 *
 * Orquesta, en este orden:
 *
 *   1. validación del canal y del texto,
 *   2. rate limit por usuario/canal (ventana deslizante),
 *   3. reserva idempotente (`dedupeKey`) + guardado del entrante — si la clave
 *      ya se procesó, NO se llama al asistente (una entrega repetida de WhatsApp
 *      o Telegram no duplica citas),
 *   4. indicador “escribiendo…” (si el adaptador lo soporta),
 *   5. agente conversacional (`handleAgentChat`): mantiene los comandos
 *      históricos, pero para lenguaje libre usa el LLM con la persona de Chief
 *      of Staff; si el LLM no está disponible, cae al parser local,
 *   6. respuesta por el mismo canal, con botones 1/2/3 si la respuesta ofrece
 *      alternativas y el adaptador los soporta,
 *   7. registro del saliente y limpieza/registro de `lastError`.
 *
 * El pipeline no conoce credenciales: los adaptadores resuelven sus secretos.
 */
import { handleAgentChat } from '../agent/agent.mjs';
import { log, logError } from '../http/logger.mjs';
import { redactString } from '../security/redact.mjs';
import {
  makeMessage, sanitizeText, extractNumberedOptions, uniqueDedupeKey, optionButtonText, MAX_TEXT
} from './message.mjs';
import {
  claimInbound, recordOutbound, recordIgnored, setChannelError, clearChannelError,
  inboxMessages, getChannelConfig
} from './state.mjs';
import { consume, limitError, LIMITS } from './ratelimit.mjs';
import { ChannelError, describeError } from './http.mjs';

/**
 * Respuesta por defecto de un canal: agente con persona de Chief of Staff.
 * Mantiene los comandos históricos y añade conversación natural + LLM.
 */
async function defaultAssistant(text, { channel, userId, meta } = {}) {
  return handleAgentChat({
    text,
    channel,
    userId,
    voice: meta?.voice === true,
    deadlineMs: 22_000
  });
}

/**
 * @param {{registry:any, assistant?:typeof defaultAssistant}} options
 */
export function createPipeline({ registry, assistant = defaultAssistant, approvalHandler = null } = {}) {
  if (!registry) throw new TypeError('createPipeline requiere un registro de canales.');
  let onApproval = typeof approvalHandler === 'function' ? approvalHandler : null;

  function adapterOrThrow(channel) {
    const adapter = registry.get(channel);
    if (!adapter) throw new ChannelError('UNKNOWN_CHANNEL', `Canal desconocido: ${channel}.`, { channel });
    return adapter;
  }

  function enforceInboundLimits(channel, userId) {
    // El simulador va por HTTP local y ya tiene su propio límite por IP en la
    // ruta; aplicar aquí el límite por usuario duplicaría el contador.
    if (channel === 'simulator') return;
    const perChannel = consume(`in:${channel}`, LIMITS.inboundPerChannel);
    if (!perChannel.ok) {
      const error = limitError(`el canal ${channel}`, perChannel);
      throw new ChannelError('TOO_MANY_REQUESTS', error.message, { channel, status: 429, retryAfterMs: perChannel.retryAfterSec * 1000, details: error.details });
    }
    const perUser = consume(`in:${channel}:${userId}`, LIMITS.inboundPerUser);
    if (!perUser.ok) {
      const error = limitError(`el usuario ${userId}`, perUser);
      throw new ChannelError('TOO_MANY_REQUESTS', error.message, { channel, status: 429, retryAfterMs: perUser.retryAfterSec * 1000, details: error.details });
    }
  }

  function enforceOutboundLimit(channel) {
    const result = consume(`out:${channel}`, LIMITS.outboundPerChannel);
    if (!result.ok) {
      const error = limitError(`la salida de ${channel}`, result);
      throw new ChannelError('TOO_MANY_REQUESTS', error.message, { channel, status: 429, retryAfterMs: result.retryAfterSec * 1000, details: error.details });
    }
  }

  /**
   * @param {{to?:string, text:string, meta:object, message:object}} input
   * @returns {Promise<{ok:boolean, id:string|null, skipped:boolean, error:string|null, errorCode:string|null, detail:unknown}>}
   */
  async function sendReply(adapter, { to, text, meta, message }) {
    if (!text) return { ok: false, id: null, skipped: true, error: 'respuesta vacía', errorCode: 'EMPTY_REPLY', detail: null };
    enforceOutboundLimit(adapter.id);
    try {
      const result = await adapter.send({ to, text, meta, message });
      return {
        ok: result?.skipped !== true,
        skipped: result?.skipped === true,
        id: result?.id ? String(result.id) : null,
        error: null,
        errorCode: null,
        detail: result?.detail ?? null
      };
    } catch (error) {
      return {
        ok: false,
        skipped: false,
        id: null,
        error: describeError(error),
        errorCode: error?.code || 'CHANNEL_ERROR',
        detail: error?.details ?? null
      };
    }
  }

  /**
   * Procesa un mensaje entrante de cualquier canal.
   *
   * @param {{
   *   channel:string, userId:string, text:string, dedupeKey?:string, id?:string,
   *   timestamp?:string, meta?:object, source?:string, allowEmpty?:boolean,
   *   replyContext?:object|null
   * }} input
   * @returns {Promise<{
   *   accepted:boolean, duplicate:boolean, reason?:string, channel:string, userId:string,
   *   reply:string|null, replyOptions:string[], outbound:object[], message:object|null,
   *   outboundMessage:object|null
   * }>}
   */
  async function receive(input) {
    const channel = String(input?.channel || '');
    const adapter = adapterOrThrow(channel);
    const userId = sanitizeText(input?.userId ?? 'anon', 120) || 'anon';
    const text = sanitizeText(input?.text ?? '');
    if (!text && input?.allowEmpty !== true) {
      throw new ChannelError('EMPTY_MESSAGE', 'El mensaje no contiene texto que procesar.', { channel });
    }

    const status = adapter.status();
    if (adapter.alwaysAvailable !== true && status.enabled !== true) {
      return {
        accepted: false,
        duplicate: false,
        reason: 'disabled',
        channel,
        userId,
        reply: null,
        replyOptions: [],
        outbound: [],
        message: null,
        outboundMessage: null
      };
    }

    enforceInboundLimits(channel, userId);

    const inbound = makeMessage({
      channel,
      direction: 'inbound',
      userId,
      text,
      dedupeKey: input.dedupeKey || uniqueDedupeKey(channel),
      id: input.id,
      timestamp: input.timestamp,
      meta: {
        ...(input.meta || {}),
        ...(input.replyContext ? { reply: input.replyContext } : {}),
        ...(input.source ? { source: sanitizeText(input.source, 60) } : {})
      }
    });

    const claim = await claimInbound(inbound);
    if (claim.duplicate) {
      return {
        accepted: false,
        duplicate: true,
        reason: 'duplicate',
        channel,
        userId,
        reply: null,
        replyOptions: [],
        outbound: [],
        message: claim.message,
        outboundMessage: null
      };
    }

    if (typeof adapter.typing === 'function') {
      try {
        await adapter.typing(userId);
      } catch { /* el indicador es cosmético */ }
    }

    let replyText = '';
    let replyOptions = [];
    let assistantFailed = false;
    let approvalResult = null;

    // Las respuestas de aprobación de la Oficina se resuelven antes del asistente
    // (el mensaje ya está deduplicado, así que un reintento no decide dos veces).
    if (onApproval) {
      try {
        approvalResult = await onApproval(claim.message);
      } catch (error) {
        logError(`canal:aprobacion:${channel}`, error, { userId });
        await setChannelError(channel, error, { source: 'approval' });
        approvalResult = {
          handled: true,
          decision: 'error',
          reply: '⚠️ No pude procesar la decisión de la Oficina. Revisa la propuesta en la app e inténtalo de nuevo.'
        };
      }
    }

    if (approvalResult?.handled) {
      replyText = sanitizeText(approvalResult.reply || '', MAX_TEXT);
    } else {
      try {
        const answer = await assistant(text, { channel, userId, meta: input.meta || {} });
        replyText = sanitizeText(answer?.reply || '', MAX_TEXT);
        if (typeof adapter.decorateReply === 'function') {
          replyText = sanitizeText(adapter.decorateReply(replyText, { answer, userId, text }) || replyText, MAX_TEXT);
        }
        const useButtons = adapter.capabilities?.buttons === true && getChannelConfig(channel).useButtons !== false;
        if (useButtons) replyOptions = extractNumberedOptions(replyText);
      } catch (error) {
        assistantFailed = true;
        logError(`canal:asistente:${channel}`, error, { userId });
        await setChannelError(channel, error, { source: 'assistant' });
        replyText = '⚠️ No pude procesar tu mensaje en este momento. Inténtalo de nuevo en unos segundos.';
      }
    }

    if (!replyText && !assistantFailed) {
      replyText = '✅ Listo.';
    }

    const outboundResult = await sendReply(adapter, {
      to: userId,
      text: replyText,
      meta: {
        buttons: replyOptions,
        buttonLabels: replyOptions.map((option) => optionButtonText(option, replyText)),
        replyContext: inbound.meta?.reply || null,
        inboundId: inbound.id,
        ...(approvalResult?.handled ? { approval: { proposalId: approvalResult.proposalId || null, decision: approvalResult.decision || null } } : {})
      },
      message: inbound
    });

    const outboundMessage = makeMessage({
      channel,
      direction: 'outbound',
      userId,
      text: replyText,
      replyTo: inbound.id,
      status: outboundResult.ok ? 'sent' : outboundResult.skipped ? 'skipped' : 'failed',
      dedupeKey: `${inbound.dedupeKey}:reply`,
      meta: {
        inboundId: inbound.id,
        outboundId: outboundResult.id || undefined,
        buttons: replyOptions,
        via: outboundResult.detail?.via || undefined
      },
      error: outboundResult.error,
      errorCode: outboundResult.errorCode
    });
    try {
      await recordOutbound(outboundMessage);
    } catch (error) {
      log('warn', `No se pudo registrar el saliente de ${channel}: ${redactString(error?.message || 'error')}`);
    }
    if (outboundResult.ok) {
      try { await clearChannelError(channel); } catch { /* ignore */ }
    } else if (!outboundResult.skipped) {
      try { await setChannelError(channel, new ChannelError(outboundResult.errorCode || 'SEND_FAILED', outboundResult.error || 'Fallo de envío'), { source: 'outbound' }); } catch { /* ignore */ }
    }

    return {
      accepted: true,
      duplicate: false,
      channel,
      userId,
      reply: replyText,
      replyOptions,
      approval: approvalResult,
      outbound: [{
        channel,
        ok: outboundResult.ok,
        skipped: outboundResult.skipped,
        id: outboundResult.id,
        error: outboundResult.error
      }],
      message: claim.message,
      outboundMessage
    };
  }

  /**
   * Simulador: conversación local sin credenciales ni red.
   * @param {{text:string, userId?:string, channel?:string, meta?:object}} input
   */
  async function simulate(input) {
    return receive({
      channel: 'simulator',
      userId: input.userId || 'demo',
      text: input.text,
      dedupeKey: uniqueDedupeKey('simulator', 'sim'),
      meta: { ...(input.meta || {}), simulated: true },
      source: 'simulador'
    });
  }

  /**
   * Bandeja local (entrantes + salientes), más reciente primero.
   * @param {{limit?:number, channel?:string|null, direction?:string|null}} [options]
   */
  function inbox(options = {}) {
    return inboxMessages(options);
  }

  /**
   * Ignora un mensaje sin llamar al asistente (remitente no autorizado).
   * @param {object} message
   * @param {string} reason
   */
  async function ignore(message, reason) {
    const normalized = makeMessage({ ...message, status: 'skipped' });
    await recordIgnored(normalized, reason);
    return normalized;
  }

  function setApprovalHandler(handler) {
    onApproval = typeof handler === 'function' ? handler : null;
    return { ok: true, configured: !!onApproval };
  }

  return { receive, simulate, inbox, ignore, setApprovalHandler };
}

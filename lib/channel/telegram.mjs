/**
 * Adaptador Telegram Bot API.
 *
 * Recepción por **long polling** (`getUpdates`) para funcionar en local sin
 * HTTPS/túnel, con modo **webhook** opcional. Detalles que importan:
 *
 *   - `offset` persistido en `store.channelState.channels.telegram.offset`; tras
 *     cada lote se guarda `último update_id + 1` para no releer.
 *   - `dedupeKey = telegram:update:<update_id>` → si el proceso muere antes de
 *     guardar el offset, la reentrega no duplica la cita (pipeline).
 *   - Token validado con `getMe` al guardarlo desde la UI (y en `test`).
 *   - «escribiendo…» con `sendChatAction` antes de responder.
 *   - Botones inline `1/2/3` cuando el asistente ofrece alternativas; al pulsar,
 *     se responde el callback como si el usuario hubiera escrito el número.
 *   - Lista blanca opcional de chats (`allowedChatIds` + `defaultChatId`): sin
 *     lista, cualquiera que encuentre el bot podría escribir a la agenda, así que
 *     el estado lo advierte.
 *   - Reintentos con backoff y error visible (`lastError`) sin bloquear el bucle.
 */
import {
  ChannelError, backoffMs, buildUrl, describeError, providerErrorMessage, requestForm, requestJson, telegramApiBase
} from './http.mjs';
import { buildConfigView, applyConfigFields, readRawField } from './config.mjs';
import {
  getChannelConfig, getChannelSection, recordIgnored, saveTelegramState, setChannelError, clearChannelError, patchChannelConfig,
  plainClone
} from './state.mjs';
import { makeMessage, sanitizeText } from './message.mjs';
import { looksLikeApprovalResponse } from './approvals.mjs';
import { getSecret, secretStatus } from '../security/vault.mjs';
import { log, logError } from '../http/logger.mjs';
import {
  transcribeAudioBuffer, isTelegramAudioMessage, MAX_AUDIO_BYTES, warmTranscription
} from './transcribe.mjs';

const MAX_TEXT = 4000;

/** @type {import('./config.mjs').FieldSpec[]} */
const CONFIG_FIELDS = Object.freeze([
  {
    key: 'enabled', label: 'Canal activo', type: 'boolean', default: false,
    vault: 'channels.telegram.enabled',
    help: 'Con el token guardado, activa el canal para recibir y responder mensajes.'
  },
  {
    key: 'botToken', label: 'Token del bot', type: 'secret', required: true,
    vault: 'channels.telegram.botToken', maxLength: 256,
    help: 'Lo entrega @BotFather al crear el bot (/newbot). Se valida con getMe y queda cifrado.'
  },
  {
    key: 'defaultChatId', label: 'Chat ID por defecto', type: 'secret',
    vault: 'channels.telegram.defaultChatId', maxLength: 64,
    help: 'Chat donde se envían avisos proactivos y las pruebas. Escríbele al bot y usa el chat.id que aparece en getUpdates.'
  },
  {
    key: 'webhookSecret', label: 'Secreto del webhook', type: 'secret',
    vault: 'channels.telegram.webhookSecret', maxLength: 256,
    help: 'Solo para el modo webhook: Telegram lo envía en x-telegram-bot-api-secret-token.'
  },
  {
    key: 'mode', label: 'Modo de recepción', type: 'enum', options: ['polling', 'webhook'],
    default: 'polling',
    help: 'polling funciona en local sin HTTPS; webhook exige URL pública (túnel).'
  },
  {
    key: 'pollTimeoutSec', label: 'Timeout de long polling (s)', type: 'number', min: 1, max: 50, default: 25,
    help: 'Segundos que Telegram mantiene abierta la petición getUpdates.'
  },
  {
    key: 'useButtons', label: 'Botones inline 1/2/3', type: 'boolean', default: true,
    help: 'Si el asistente ofrece alternativas, se muestran como botones.'
  },
  {
    key: 'allowedChatIds', label: 'Chats autorizados', type: 'list',
    help: 'Lista blanca de chat IDs. Vacía = cualquier chat puede escribir (solo recomendable en pruebas).'
  },
  {
    key: 'publicUrl', label: 'URL pública para webhook', type: 'url', maxLength: 500,
    help: 'Solo modo webhook. Ej.: https://mi-tunel.trycloudflare.com (scripts/tunnel.ps1).'
  }
]);

const CAPABILITIES = Object.freeze({
  inbound: true, outbound: true, proactive: true,
  buttons: true, typing: true, threads: false, templates: false,
  documents: true, approvals: true, voice: true
});

const INSTRUCTIONS = Object.freeze([
  'Abre Telegram y habla con @BotFather: /newbot, elige nombre y usuario. Copia el token (123456:ABC…).',
  'Pega el token en «Token del bot» y pulsa Probar: se valida con getMe y el canal queda configurado.',
  'Escríbele cualquier cosa al bot (por ejemplo HOY). El mensaje aparecerá en la bandeja; copia el Chat ID.',
  'Guarda el Chat ID por defecto y activa el canal. Ya puedes escribirle HOY, CAPTURA … o responder 1/2/3.',
  'También entiende notas de voz: se descargan, se transcriben localmente con Whisper y pasan al mismo asistente. No se suben a la nube.',
  'Modo local: deja «polling» (no necesitas HTTPS ni túnel). Modo webhook: publica la app con cloudflared y guarda la URL.'
]);

function telegramToken() {
  return getSecret('channels.telegram.botToken');
}

function telegramEnabled() {
  return String(getSecret('channels.telegram.enabled') || '').toLowerCase() === 'true';
}

function telegramMode() {
  const mode = getChannelConfig('telegram').mode;
  return mode === 'webhook' ? 'webhook' : 'polling';
}

function telegramConfig() {
  return getChannelConfig('telegram');
}

function botApi(method) {
  const token = telegramToken();
  if (!token) {
    throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Falta el token del bot de Telegram.', { channel: 'telegram', status: 409 });
  }
  return `${telegramApiBase()}/bot${token}/${method}`;
}

function translateError(error, response) {
  const status = response?.status || 0;
  const description = response ? providerErrorMessage(response) : '';
  if (status === 401 || status === 404) {
    return new ChannelError('TELEGRAM_UNAUTHORIZED', 'Telegram rechazó el token del bot. Revisa el token de @BotFather.', {
      channel: 'telegram', status, details: { telegram: description }
    });
  }
  if (status === 409) {
    return new ChannelError('TELEGRAM_WEBHOOK_CONFLICT', 'Hay un webhook activo en Telegram; getUpdates no funciona hasta borrarlo. Cambia a modo webhook o pulsa «modo polling» para borrarlo.', {
      channel: 'telegram', status, details: { telegram: description }
    });
  }
  if (status === 429) {
    return new ChannelError('TELEGRAM_RATE_LIMIT', 'Telegram limitó las peticiones del bot. Se reintentará con espera.', {
      channel: 'telegram', status, retryAfterMs: 5_000, details: { telegram: description }
    });
  }
  return new ChannelError('TELEGRAM_ERROR', `Telegram respondió ${status || 'sin estado'}: ${description || 'error'}`, {
    channel: 'telegram', status, details: { telegram: description }
  });
}

async function callApi(method, payload = {}, { timeoutMs = 15_000, retries = 1, idempotent = false, signal = null } = {}) {
  const url = botApi(method);
  const response = await requestJson(url, {
    method: payload && Object.keys(payload).length ? 'POST' : 'GET',
    body: payload && Object.keys(payload).length ? payload : undefined,
    timeoutMs,
    retries,
    idempotent,
    signal,
    channel: 'telegram'
  });
  if (!response.ok || (response.json && response.json.ok === false)) throw translateError(null, response);
  return response.json || {};
}

function splitText(text) {
  const clean = sanitizeText(text, 12_000);
  if (clean.length <= MAX_TEXT) return [clean];
  const chunks = [];
  let current = '';
  for (const line of clean.split('\n')) {
    if ((current ? `${current}\n${line}` : line).length > MAX_TEXT) {
      if (current) chunks.push(current);
      current = line.slice(0, MAX_TEXT);
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 4);
}

function inlineKeyboard(options, labels) {
  const buttons = (options || []).filter((option) => /^[123]$/.test(String(option))).map((option, index) => ({
    text: sanitizeText(labels?.[index] || `Opción ${option}`, 60),
    callback_data: String(option)
  }));
  if (!buttons.length) return null;
  return { inline_keyboard: [buttons] };
}

function allowedChatIds() {
  const config = telegramConfig();
  const allow = Array.isArray(config.allowedChatIds) ? config.allowedChatIds.map(String) : [];
  const defaultChat = getSecret('channels.telegram.defaultChatId');
  if (defaultChat) allow.push(String(defaultChat));
  return [...new Set(allow)];
}

function isAllowedChat(chatId) {
  const allow = allowedChatIds();
  if (!allow.length) return true;
  return allow.includes(String(chatId));
}

export function createTelegramAdapter() {
  let onMessage = null;
  let timer = null;
  let running = false;
  let stopped = false;
  let started = false;
  let controller = null;
  let attempts = 0;
  let pollsSincePersist = 0;
  let lastPollAt = null;

  function status() {
    const token = telegramToken();
    const config = telegramConfig();
    const section = getChannelSection('telegram');
    const mode = telegramMode();
    const enabled = telegramEnabled();
    const chatId = getSecret('channels.telegram.defaultChatId');
    const publicUrl = config.publicUrl || String(process.env.APP_URL || '').trim() || null;
    const webhookReady = mode === 'webhook' && !!publicUrl && !!getSecret('channels.telegram.webhookSecret');
    const warnings = [];
    if (token && enabled && !allowedChatIds().length) {
      warnings.push('No hay lista de chats autorizados: cualquier persona que encuentre el bot podría escribir a tu agenda. Configura «Chats autorizados».');
    }
    if (mode === 'webhook' && !publicUrl) warnings.push('Modo webhook sin URL pública: guarda «URL pública» o cambia a polling.');
    if (mode === 'webhook' && !getSecret('channels.telegram.webhookSecret')) {
      warnings.push('Modo webhook sin secreto: cualquiera podría POSTear al webhook en modo local. Configura «Secreto del webhook».');
    }
    if (!token) warnings.push('Sin token: el bot no puede recibir ni enviar mensajes.');
    if (section.lastError) warnings.push(`Último error: ${section.lastError.message}`);

    const configured = !!token;
    const ready = configured && enabled && (mode === 'polling' || webhookReady || !enabled);
    let detail;
    if (!token) {
      detail = 'No configurado: pega el token de @BotFather y pulsa Probar.';
    } else if (!enabled) {
      detail = 'Credenciales guardadas. Activa el canal para recibir mensajes.';
    } else if (mode === 'polling') {
      detail = 'Activo por long polling (sin HTTPS). Telegram entrega los mensajes a este proceso.';
    } else {
      detail = webhookReady
        ? 'Activo por webhook. Telegram publica cada mensaje en la app.'
        : 'Modo webhook incompleto: falta URL pública o secreto.';
    }

    return {
      id: 'telegram',
      label: 'Telegram',
      kind: 'messaging',
      alwaysAvailable: false,
      configured,
      enabled,
      ready,
      detail,
      instructions: [...INSTRUCTIONS],
      warnings,
      capabilities: {
        inbound: true, outbound: true, proactive: true,
        buttons: true, typing: true, threads: false, templates: false,
        voice: true
      },
      config: buildConfigView(CONFIG_FIELDS, config),
      runtime: {
        mode,
        inboundUrl: '/api/telegram/webhook',
        polling: {
          active: !!timer && !stopped && enabled && !!token && mode === 'polling',
          running,
          lastPollAt,
          persistedOffset: Number(section.offset) || 0
        },
        botUsername: section.botUsername || null,
        botId: section.botId || null,
        defaultChatId: chatId ? `••••${String(chatId).slice(-4)}` : null,
        webhookUrl: mode === 'webhook' && publicUrl ? `${publicUrl.replace(/\/$/, '')}/api/telegram/webhook` : null,
        webhookSecretConfigured: !!getSecret('channels.telegram.webhookSecret'),
        allowedChats: allowedChatIds().length,
        lastError: plainClone(section.lastError),
        lastInboundAt: section.lastInboundAt || null,
        lastOutboundAt: section.lastOutboundAt || null,
        stats: { ...(section.stats || {}) }
      },
      stats: { ...(section.stats || {}) },
      lastError: plainClone(section.lastError),
      webhookUrl: mode === 'webhook' && publicUrl ? `${publicUrl.replace(/\/$/, '')}/api/telegram/webhook` : null
    };
  }

  async function getMe() {
    const json = await callApi('getMe', {}, { timeoutMs: 10_000, retries: 1 });
    const bot = json.result || {};
    if (bot.id || bot.username) {
      await saveTelegramState({ botId: bot.id ?? null, botUsername: bot.username || null });
    }
    return bot;
  }

  /** Valida un token candidato SIN guardarlo (config atómica). */
  async function getMeWithToken(candidate) {
    const response = await requestJson(`${telegramApiBase()}/bot${candidate}/getMe`, {
      timeoutMs: 10_000, retries: 1, idempotent: true, channel: 'telegram'
    });
    if (!response.ok || response.json?.ok === false) throw translateError(null, response);
    return response.json?.result || {};
  }

  async function setWebhook(publicUrl) {
    const base = String(publicUrl || telegramConfig().publicUrl || process.env.APP_URL || '').trim().replace(/\/$/, '');
    if (!base) throw new ChannelError('TELEGRAM_NO_PUBLIC_URL', 'Falta la URL pública para registrar el webhook.', { channel: 'telegram' });
    const secret = getSecret('channels.telegram.webhookSecret');
    const payload = {
      url: `${base}/api/telegram/webhook`,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false
    };
    if (secret) payload.secret_token = secret;
    const json = await callApi('setWebhook', payload, { timeoutMs: 15_000, retries: 0 });
    await saveTelegramState({ webhookUrl: payload.url, webhookAt: new Date().toISOString() });
    return { ok: json.ok !== false, url: payload.url, secretConfigured: !!secret };
  }

  async function deleteWebhook() {
    const json = await callApi('deleteWebhook', { drop_pending_updates: false }, { timeoutMs: 10_000, retries: 0 });
    await saveTelegramState({ webhookUrl: null, webhookAt: null });
    return { ok: json.ok !== false };
  }

  async function sendChatAction(chatId) {
    if (!telegramToken() || !chatId) return;
    try {
      await callApi('sendChatAction', { chat_id: String(chatId), action: 'typing' }, { timeoutMs: 5_000, retries: 0 });
    } catch { /* cosmético */ }
  }

  async function sendMessage(chatId, text, { buttons = [], buttonLabels = [], inlineKeyboard: customKeyboard = null } = {}) {
    const token = telegramToken();
    if (!token) throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Falta el token del bot de Telegram.', { channel: 'telegram' });
    const target = String(chatId || getSecret('channels.telegram.defaultChatId') || '');
    if (!target) {
      throw new ChannelError('TELEGRAM_NO_CHAT', 'Falta el chat ID de Telegram: escríbele al bot y configura «Chat ID por defecto».', { channel: 'telegram' });
    }
    const chunks = splitText(text);
    let firstId = null;
    const keyboard = inlineKeyboard(buttons, buttonLabels);
    const replyMarkup = customKeyboard && customKeyboard.length
      ? { inline_keyboard: customKeyboard }
      : keyboard;
    for (const [index, chunk] of chunks.entries()) {
      const payload = { chat_id: target, text: chunk, disable_web_page_preview: true };
      if (index === 0 && replyMarkup) payload.reply_markup = replyMarkup;
      const json = await callApi('sendMessage', payload, { timeoutMs: 15_000, retries: 1 });
      if (firstId === null) firstId = json?.result?.message_id ?? null;
    }
    return { id: firstId, to: target, via: 'telegram', chunks: chunks.length };
  }

  async function downloadTelegramAudio(fileId) {
    if (!fileId) throw new Error('El audio no tiene file_id.');
    const json = await callApi('getFile', { file_id: fileId }, { timeoutMs: 15_000, retries: 1 });
    const filePath = json?.result?.file_path;
    if (!filePath) {
      throw new Error('Telegram no devolvió la ruta del audio.');
    }
    const token = telegramToken();
    if (!token) throw new Error('Falta el token de Telegram.');
    const url = `${telegramApiBase()}/file/bot${token}/${String(filePath).replace(/^\/+/, '')}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`No se pudo descargar el audio (${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_AUDIO_BYTES) {
      throw new Error('El audio supera el límite de 20 MB.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new Error('El audio supera el límite de 20 MB.');
    }
    return buffer;
  }

  function audioErrorText(error) {
    const code = String(error?.code || '');
    if (code === 'AUDIO_TOO_LONG') return 'dura más de 5 minutos';
    if (code === 'AUDIO_TOO_LARGE') return 'supera los 20 MB';
    if (code === 'AUDIO_NO_SPEECH') return 'no detecté voz';
    if (code === 'AUDIO_TIMEOUT') return 'tardó demasiado en procesarse';
    if (code === 'AUDIO_TRANSCRIBE_FAILED' || code === 'AUDIO_BAD_OUTPUT') {
      return 'el transcriptor local no pudo procesarlo';
    }
    return 'no se pudo procesar';
  }

  async function processUpdate(update) {
    if (!update || typeof update !== 'object') return { handled: false };
    if (update.callback_query) return handleCallbackQuery(update.callback_query);
    const message = update.message;
    if (!message || !message.chat) return { handled: false, reason: 'sin mensaje' };
    const chatId = String(message.chat.id);
    const updateId = update.update_id;
    const base = {
      channel: 'telegram',
      userId: chatId,
      dedupeKey: `update:${updateId}`,
      id: `tg:${updateId}`,
      timestamp: message.date ? new Date(message.date * 1000).toISOString() : undefined,
      meta: {
        chatId,
        messageId: message.message_id ?? null,
        updateId,
        username: message.from?.username || null,
        chatType: message.chat?.type || null
      },
      source: 'telegram'
    };
    let text = message.text ?? message.caption ?? '';
    const audio = isTelegramAudioMessage(message);
    if (!isAllowedChat(chatId)) {
      // Si parece una respuesta de aprobación, se deja pasar al pipeline para que
      // el gate la rechace y la audite (en vez de descartarla en silencio).
      if (text && looksLikeApprovalResponse(text) && typeof onMessage === 'function') {
        await onMessage({ ...base, text, meta: { ...base.meta, approvalAttempt: true } });
        return { handled: true, denied: true };
      }
      const ignored = makeMessage({ ...base, text, status: 'skipped' });
      await recordIgnored(ignored, 'chat no autorizado');
      log('warn', `Telegram: mensaje ignorado de chat no autorizado (${chatId.slice(-3)}…).`);
      return { handled: true, ignored: true };
    }
    if (!text.trim() && audio) {
      await sendChatAction(chatId);
      try {
        const buffer = await downloadTelegramAudio(audio.file_id);
        const transcription = await transcribeAudioBuffer(buffer, {
          mimeType: audio.mime_type || (audio.kind === 'voice' ? 'audio/ogg' : ''),
          durationSec: audio.duration || 0
        });
        text = transcription.text;
        base.meta = {
          ...base.meta,
          voice: true,
          audioKind: audio.kind,
          transcription: {
            language: transcription.language,
            model: transcription.model,
            duration: transcription.duration,
            elapsedMs: transcription.elapsedMs
          }
        };
        log('info', `Telegram: nota de voz transcrita (${transcription.duration}s, ${transcription.elapsedMs}ms).`);
      } catch (error) {
        logError('telegram:transcribe', error);
        await sendMessage(chatId, `No pude entender la nota de voz: ${audioErrorText(error)}. Escríbeme el mensaje o vuelve a enviarla.`).catch(() => {});
        return { handled: true, ignored: true, transcriptionFailed: true };
      }
    }
    if (!text.trim()) {
      await sendMessage(chatId, 'Entiendo mensajes de texto y notas de voz: escribe HOY, CAPTURA … o 1/2/3, o mándame un audio.').catch(() => {});
      return { handled: true, ignored: true };
    }
    if (typeof onMessage !== 'function') return { handled: false, reason: 'pipeline no conectado' };
    await onMessage({ ...base, text });
    return { handled: true };
  }

  async function handleCallbackQuery(callback) {
    const chatId = String(callback?.message?.chat?.id || '');
    const id = callback?.id;
    if (!id) return { handled: false };
    const data = sanitizeText(callback.data || '', 100);
    const approval = /^ap:(OF-\d{3,}):(approve|reject|view)$/i.exec(data);
    await callApi('answerCallbackQuery', {
      callback_query_id: id,
      text: approval ? 'Procesando decisión…' : 'Opción recibida'
    }, { timeoutMs: 5_000, retries: 0 }).catch(() => {});
    if (!/^[123]$/.test(data) && !approval) return { handled: true, ignored: true };
    if (!isAllowedChat(chatId)) {
      if (approval && typeof onMessage === 'function') {
        await onMessage({
          channel: 'telegram',
          userId: chatId,
          text: data,
          dedupeKey: `callback:${id}`,
          id: `tg:cb:${id}`,
          meta: { chatId, callback: true, approvalAttempt: true, approval: { proposalId: approval[1].toUpperCase(), action: approval[2].toLowerCase() } },
          source: 'telegram'
        });
        return { handled: true, denied: true };
      }
      return { handled: true, ignored: true };
    }
    if (callback.message?.message_id) {
      await callApi('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] }
      }, { timeoutMs: 5_000, retries: 0 }).catch(() => {});
    }
    if (typeof onMessage !== 'function') return { handled: false, reason: 'pipeline no conectado' };
    await onMessage({
      channel: 'telegram',
      userId: chatId,
      text: approval ? data : data,
      dedupeKey: `callback:${id}`,
      id: `tg:cb:${id}`,
      meta: {
        chatId,
        callback: true,
        messageId: callback.message?.message_id ?? null,
        ...(approval ? { approval: { proposalId: approval[1].toUpperCase(), action: approval[2].toLowerCase() } } : {})
      },
      source: 'telegram'
    });
    return { handled: true };
  }

  async function pollOnce({ timeoutSec } = {}) {
    const section = getChannelSection('telegram');
    const offset = Number(section.offset) || 0;
    const timeout = Math.max(1, Math.min(Number(timeoutSec) || Number(telegramConfig().pollTimeoutSec) || 25, 50));
    controller = new AbortController();
    const response = await requestJson(buildUrl(`${telegramApiBase()}`, `/bot${telegramToken()}/getUpdates`, {
      timeout,
      offset: offset || undefined,
      allowed_updates: ['message', 'callback_query']
    }), {
      timeoutMs: (timeout + 15) * 1000,
      retries: 1,
      idempotent: true,
      signal: controller.signal,
      channel: 'telegram'
    });
    if (!response.ok || response.json?.ok === false) throw translateError(null, response);
    const updates = Array.isArray(response.json?.result) ? response.json.result : [];
    let newOffset = offset;
    let processed = 0;
    for (const update of updates) {
      if (update && Number.isFinite(Number(update.update_id))) {
        newOffset = Math.max(newOffset, Number(update.update_id) + 1);
      }
      try {
        const result = await processUpdate(update);
        if (result.handled) processed += 1;
      } catch (error) {
        logError('telegram:update', error, { updateId: update?.update_id });
        await setChannelError('telegram', error, { source: 'update' });
      }
    }
    lastPollAt = new Date().toISOString();
    pollsSincePersist += 1;
    if (newOffset !== offset || updates.length || pollsSincePersist >= 10) {
      pollsSincePersist = 0;
      await saveTelegramState({
        offset: newOffset,
        lastPollAt,
        ...(updates.length ? { lastError: null } : {})
      });
    }
    if (updates.length) {
      try { await clearChannelError('telegram'); } catch { /* ignore */ }
    }
    return { updates: updates.length, processed, offset: newOffset };
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    if (stopped || running) return;
    if (!telegramEnabled() || !telegramToken() || telegramMode() !== 'polling') {
      schedule(15_000);
      return;
    }
    running = true;
    try {
      await pollOnce();
      attempts = 0;
      schedule(250);
    } catch (error) {
      if (error?.code === 'ABORTED') return;
      attempts += 1;
      await setChannelError('telegram', error, { source: 'polling' });
      const delay = error?.code === 'TELEGRAM_UNAUTHORIZED'
        ? 120_000
        : error?.code === 'TELEGRAM_WEBHOOK_CONFLICT'
          ? 60_000
          : backoffMs(attempts, { baseMs: 1_000, maxMs: 30_000, retryAfterMs: error?.retryAfterMs });
      schedule(delay);
    } finally {
      running = false;
    }
  }

  function start({ onMessage: handler } = {}) {
    if (typeof handler === 'function') onMessage = handler;
    if (started) {
      schedule(0);
      return;
    }
    started = true;
    stopped = false;
    schedule(0);
    if (process.env.NODE_ENV !== 'test' && telegramEnabled() && telegramToken()) {
      warmTranscription().catch((error) => log('warn', `Telegram: no se pudo precalentar Whisper (${error.message}).`));
    }
  }

  function stop() {
    stopped = true;
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
    try { controller?.abort(); } catch { /* ignore */ }
    controller = null;
  }

  async function configure(body) {
    const beforeMode = telegramMode();
    // Validación atómica: si llega un token nuevo se comprueba con getMe ANTES
    // de tocar la bóveda. Si falla, la configuración anterior queda intacta.
    const candidateToken = readRawField(body, 'botToken');
    let bot = null;
    if (typeof candidateToken === 'string' && candidateToken.trim()) {
      try {
        bot = await getMeWithToken(candidateToken.trim());
      } catch (error) {
        await setChannelError('telegram', error, { source: 'config' });
        throw new ChannelError('TELEGRAM_INVALID_TOKEN', `Telegram rechazó el token: ${describeError(error)}`, {
          channel: 'telegram', status: 502, details: { hint: 'Copia de nuevo el token de @BotFather (/token).' }
        });
      }
    }
    const result = await applyConfigFields({
      channel: 'telegram', fields: CONFIG_FIELDS, body, settings: telegramConfig()
    });
    if (bot && (bot.id || bot.username)) {
      await saveTelegramState({ botId: bot.id ?? null, botUsername: bot.username || null });
    }
    if (Object.keys(result.settingsPatch).length) {
      await patchChannelConfig('telegram', result.settingsPatch);
    }

    // Transición de modo / activación: polling necesita no tener webhook activo.
    const mode = telegramMode();
    if (telegramToken() && telegramEnabled()) {
      if (mode === 'polling' && (result.changed.includes('mode') || beforeMode === 'webhook')) {
        try { await deleteWebhook(); } catch (error) { log('warn', `Telegram: no se pudo borrar el webhook (${describeError(error)}).`); }
      }
      if (mode === 'webhook' && result.changed.includes('mode')) {
        try { await setWebhook(telegramConfig().publicUrl || process.env.APP_URL); } catch (error) {
          log('warn', `Telegram: no se pudo registrar el webhook (${describeError(error)}).`);
        }
      }
    }
    await clearChannelError('telegram').catch(() => {});
    if (telegramEnabled()) schedule(0);
    return {
      ok: true,
      changed: result.changed,
      cleared: result.cleared,
      detail: telegramEnabled()
        ? 'Configuración guardada y aplicada sin reiniciar.'
        : 'Configuración guardada. Activa el canal para empezar a recibir mensajes.',
      bot: bot ? { id: bot.id, username: bot.username } : null
    };
  }

  async function test({ text: probe, to } = {}) {
    const token = telegramToken();
    if (!token) {
      throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Telegram no está configurado: falta el token del bot.', {
        channel: 'telegram', status: 409, details: { instructions: INSTRUCTIONS }
      });
    }
    const bot = await getMe();
    const chatId = to || getSecret('channels.telegram.defaultChatId');
    if (!chatId) {
      return {
        ok: true,
        channel: 'telegram',
        detail: `Token válido (@${bot.username || bot.id}). Configura el Chat ID para probar el envío.`,
        result: { bot: { id: bot.id, username: bot.username }, sent: false }
      };
    }
    const sent = await sendMessage(chatId, probe || '✅ Agenda Copilot: prueba de Telegram correcta.');
    return {
      ok: true,
      channel: 'telegram',
      detail: `Mensaje de prueba enviado a Telegram (@${bot.username || bot.id}).`,
      result: { bot: { id: bot.id, username: bot.username }, messageId: sent.id, sent: true }
    };
  }

  async function send({ to, text, meta = {} }) {
    return sendMessage(to, text, {
      buttons: meta.buttons || [],
      buttonLabels: meta.buttonLabels || [],
      inlineKeyboard: meta.inlineKeyboard || null
    });
  }

  async function sendDocument({ to, filename, buffer, mimeType = 'application/octet-stream', caption = '' } = {}) {
    const token = telegramToken();
    if (!token) throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Falta el token del bot de Telegram.', { channel: 'telegram', status: 409 });
    const target = String(to || getSecret('channels.telegram.defaultChatId') || '');
    if (!target) throw new ChannelError('TELEGRAM_NO_CHAT', 'Falta el chat ID de Telegram.', { channel: 'telegram' });
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ChannelError('DOC_EMPTY', 'El documento no tiene contenido.', { channel: 'telegram' });
    const form = new FormData();
    form.append('chat_id', target);
    if (caption) form.append('caption', sanitizeText(caption, 1000));
    form.append('document', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'documento');
    const response = await requestForm(`${telegramApiBase()}/bot${token}/sendDocument`, form, { timeoutMs: 90_000, channel: 'telegram' });
    if (!response.ok || response.json?.ok === false) throw translateError(null, response);
    return {
      id: response.json?.result?.message_id ?? null,
      to: target,
      via: 'telegram',
      filename,
      size: buffer.length,
      mimeType
    };
  }

  async function processWebhook(payload) {
    const update = payload?.update_id !== undefined ? payload : payload?.result;
    if (!update || typeof update !== 'object') throw new ChannelError('TELEGRAM_INVALID_PAYLOAD', 'Payload de Telegram sin update válido.', { channel: 'telegram' });
    return processUpdate(update);
  }

  async function pollNow({ timeoutSec = 2 } = {}) {
    if (!telegramToken()) throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Falta el token del bot de Telegram.', { channel: 'telegram', status: 409 });
    return pollOnce({ timeoutSec });
  }

  async function saveBotIdentity() {
    const section = getChannelSection('telegram');
    if (section.botUsername) return { username: section.botUsername, cached: true };
    const bot = await getMe();
    return { username: bot.username || null, cached: false };
  }

  return {
    id: 'telegram',
    label: 'Telegram',
    kind: 'messaging',
    alwaysAvailable: false,
    capabilities: CAPABILITIES,
    configFields: CONFIG_FIELDS,
    instructions: INSTRUCTIONS,
    status,
    configure,
    test,
    send,
    sendDocument,
    typing: sendChatAction,
    start,
    stop,
    processWebhook,
    pollNow,
    getMe,
    setWebhook,
    deleteWebhook,
    saveBotIdentity
  };
}

/** Estado de un secreto de Telegram (para diagnóstico de la UI). */
export function telegramSecretState(name) {
  return secretStatus(`channels.telegram.${name}`);
}

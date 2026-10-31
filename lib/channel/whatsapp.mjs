/**
 * Adaptador WhatsApp Cloud API (Meta / Graph API).
 *
 * Qué cubre:
 *   - Envío de texto libre dentro de la ventana de 24 h y **plantilla** cuando
 *     la ventana está cerrada (proactivos y recordatorios).
 *   - Webhook: verificación de firma `x-hub-signature-256` (la hace la ruta con
 *     `verifyWhatsAppWebhook`; aquí se procesa el payload ya validado), estados
 *     de entrega e idempotencia por `message.id`.
 *   - Marca de «leído» best-effort y “escribiendo” no soportado por Meta.
 *   - Validación de credenciales sin enviar mensajes: `GET /{phoneNumberId}`.
 *
 * Ventana de 24 h: Meta solo permite texto libre dentro de las 24 h siguientes
 * al último mensaje del usuario. `conversationWindowOpen()` se apoya en
 * `channelState.windows` que el pipeline refresca en cada entrante.
 */
import {
  ChannelError, buildUrl, describeError, providerErrorMessage, requestForm, requestJson, whatsappGraphBase
} from './http.mjs';
import { buildConfigView, applyConfigFields, readRawField } from './config.mjs';
import {
  conversationWindowOpen, countOpenWindows, getChannelConfig, getChannelSection,
  patchChannelConfig, recordDeliveryStatus, recordIgnored, setChannelError, clearChannelError, plainClone
} from './state.mjs';
import { makeMessage, sanitizeText } from './message.mjs';
import { looksLikeApprovalResponse } from './approvals.mjs';
import { getSecret } from '../security/vault.mjs';
import { log } from '../http/logger.mjs';

const WINDOW_HOURS = 24;
const MAX_TEXT = 4000;

/** @type {import('./config.mjs').FieldSpec[]} */
const CONFIG_FIELDS = Object.freeze([
  {
    key: 'enabled', label: 'Canal activo', type: 'boolean', default: false,
    vault: 'channels.whatsapp.enabled',
    help: 'Actívalo cuando el número y el token estén verificados.'
  },
  {
    key: 'phoneNumberId', label: 'Phone Number ID', type: 'string', required: true,
    vault: 'channels.whatsapp.phoneNumberId', maxLength: 64,
    help: 'Meta > WhatsApp > API Setup: el ID numérico del número de teléfono (no el número).'
  },
  {
    key: 'accessToken', label: 'Access Token', type: 'secret', required: true,
    vault: 'channels.whatsapp.accessToken', maxLength: 1024,
    help: 'Token permanente de la app de Meta (System User o token temporal de prueba).'
  },
  {
    key: 'verifyToken', label: 'Verify Token del webhook', type: 'secret',
    vault: 'channels.whatsapp.verifyToken', maxLength: 512,
    help: 'Cadena que tú inventas; Meta la usa en el handshake GET del webhook.'
  },
  {
    key: 'appSecret', label: 'App Secret (firma HMAC)', type: 'secret',
    vault: 'channels.whatsapp.appSecret', maxLength: 512,
    help: 'Meta > App settings > Basic. Obligatorio en producción: firma cada webhook.'
  },
  {
    key: 'defaultTo', label: 'Destinatario por defecto', type: 'secret',
    vault: 'channels.whatsapp.defaultTo', maxLength: 40,
    help: 'Número con código de país (solo dígitos), p. ej. 573001112233.'
  },
  {
    key: 'templateName', label: 'Plantilla para proactivos', type: 'string',
    vault: 'channels.whatsapp.templateName', maxLength: 120,
    help: 'Plantilla aprobada por Meta para escribir fuera de la ventana de 24 h.'
  },
  {
    key: 'publicUrl', label: 'URL pública (túnel)', type: 'url', maxLength: 500,
    help: 'URL del túnel para mostrar el webhook (scripts/tunnel.ps1). También puede venir de APP_URL.'
  },
  {
    key: 'templateLanguage', label: 'Idioma de la plantilla', type: 'string',
    vault: 'channels.whatsapp.templateLanguage', maxLength: 12, default: 'es_CO',
    help: 'Código de idioma exacto de la plantilla aprobada (es_CO, es_ES, en_US…).'
  },
  {
    key: 'allowedNumbers', label: 'Números autorizados', type: 'list',
    help: 'Lista blanca (solo dígitos). Vacía = cualquier número que escriba al bot puede usar la agenda.'
  },
  {
    key: 'apiVersion', label: 'Versión de Graph API', type: 'string', maxLength: 12, default: 'v25.0',
    help: 'Versión de la API de WhatsApp Cloud (por defecto v25.0).'
  },
  {
    key: 'useButtons', label: 'Botones 1/2/3', type: 'boolean', default: false,
    help: 'WhatsApp no admite botones inline arbitrarios; el texto con «Responde 1, 2 o 3» funciona sin esto.'
  }
]);

const INSTRUCTIONS = Object.freeze([
  'Crea una app en developers.facebook.com (tipo Business) y añade el producto WhatsApp.',
  'En WhatsApp > API Setup copia el Phone Number ID y genera un Access Token permanente (System User).',
  'En App settings > Basic copia el App Secret (firma HMAC) e inventa un Verify Token.',
  'Publica la app con túnel (scripts/tunnel.ps1) y configura el webhook: URL https://TU-TUNEL/api/whatsapp/webhook, Verify Token igual al guardado, y suscribe el campo «messages».',
  'Guarda Phone Number ID, token, App Secret, Verify Token y destinatario por defecto, y pulsa Probar: se validan las credenciales sin enviar nada.',
  'Fuera de la ventana de 24 h solo se puede escribir con plantilla aprobada: créala en Meta > WhatsApp > Message Templates y guarda su nombre e idioma.'
]);
const CAPABILITIES = Object.freeze({
  inbound: true, outbound: true, proactive: true,
  buttons: false, typing: false, threads: false, templates: true,
  documents: true, approvals: true
});

function waEnabled() {
  return String(getSecret('channels.whatsapp.enabled') || '').toLowerCase() === 'true';
}

function waConfig() {
  return getChannelConfig('whatsapp');
}

function waVersion() {
  const configured = String(waConfig().apiVersion || '').trim();
  return /^v\d{1,2}\.\d{1,2}$/.test(configured) ? configured : String(process.env.WA_API_VERSION || 'v25.0');
}

function waCredentials() {
  return {
    phoneNumberId: getSecret('channels.whatsapp.phoneNumberId'),
    accessToken: getSecret('channels.whatsapp.accessToken')
  };
}

function graphUrl(path, query) {
  return buildUrl(`${whatsappGraphBase()}/${waVersion()}`, path, query);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) throw new ChannelError('WA_INVALID_RECIPIENT', 'Falta el número de WhatsApp de destino (solo dígitos con código de país).', { channel: 'whatsapp' });
  if (digits.length < 7 || digits.length > 20) {
    throw new ChannelError('WA_INVALID_RECIPIENT', 'El número de WhatsApp debe tener entre 7 y 20 dígitos con código de país.', { channel: 'whatsapp' });
  }
  return digits;
}

function translateError(response) {
  const status = response?.status || 0;
  const description = providerErrorMessage(response, ['error.message', 'error.error_data.details']);
  const code = response?.json?.error?.code;
  if (status === 401 || status === 403) {
    return new ChannelError('WA_UNAUTHORIZED', `WhatsApp rechazó las credenciales: ${description}. Revisa el Access Token y el Phone Number ID.`, {
      channel: 'whatsapp', status, details: { provider: description, metaCode: code ?? null }
    });
  }
  if (status === 429) {
    return new ChannelError('WA_RATE_LIMIT', 'Meta limitó el envío de WhatsApp. Se reintentará con espera.', {
      channel: 'whatsapp', status, retryAfterMs: 5_000, details: { provider: description }
    });
  }
  return new ChannelError('WA_PROVIDER_ERROR', `WhatsApp respondió ${status || 'sin estado'}: ${description}`, {
    channel: 'whatsapp', status, details: { provider: description, metaCode: code ?? null }
  });
}

function templateConfigured() {
  return !!getSecret('channels.whatsapp.templateName');
}

function allowedNumbers() {
  const list = Array.isArray(waConfig().allowedNumbers) ? waConfig().allowedNumbers.map((item) => String(item).replace(/\D/g, '')).filter(Boolean) : [];
  const fallback = String(getSecret('channels.whatsapp.defaultTo') || '').replace(/\D/g, '');
  if (fallback) list.push(fallback);
  return [...new Set(list)];
}

function isAllowedNumber(number) {
  const allow = allowedNumbers();
  if (!allow.length) return true;
  const digits = String(number || '').replace(/\D/g, '');
  return allow.some((candidate) => candidate === digits);
}

export function createWhatsAppAdapter() {
  let onMessage = null;

  async function getPhoneNumberWith(phoneNumberId, accessToken) {
    const response = await requestJson(graphUrl(`/${encodeURIComponent(phoneNumberId)}`, {
      fields: 'display_phone_number,verified_name,quality_rating'
    }), {
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: 15_000,
      retries: 1,
      idempotent: true,
      channel: 'whatsapp'
    });
    if (!response.ok) throw translateError(response);
    return response.json || {};
  }

  async function getPhoneNumber() {
    const { phoneNumberId, accessToken } = waCredentials();
    if (!phoneNumberId || !accessToken) {
      throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'WhatsApp no está configurado: faltan Phone Number ID y/o Access Token.', {
        channel: 'whatsapp', status: 409, details: { instructions: INSTRUCTIONS }
      });
    }
    const response = await requestJson(graphUrl(`/${encodeURIComponent(phoneNumberId)}`, {
      fields: 'display_phone_number,verified_name,quality_rating'
    }), {
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: 15_000,
      retries: 1,
      idempotent: true,
      channel: 'whatsapp'
    });
    if (!response.ok) throw translateError(response);
    return response.json || {};
  }

  function status() {
    const { phoneNumberId, accessToken } = waCredentials();
    const config = waConfig();
    const section = getChannelSection('whatsapp');
    const enabled = waEnabled();
    const configured = !!phoneNumberId && !!accessToken;
    const defaultTo = getSecret('channels.whatsapp.defaultTo');
    const secretConfigured = !!getSecret('channels.whatsapp.appSecret');
    const verifyConfigured = !!getSecret('channels.whatsapp.verifyToken');
    const warnings = [];
    if (configured && !secretConfigured) {
      warnings.push('Sin App Secret: en modo local el webhook acepta payloads sin firma. En producción o con auth activa se rechaza (503).');
    }
    if (configured && !verifyConfigured) warnings.push('Sin Verify Token: Meta no podrá completar el handshake del webhook.');
    if (!templateConfigured()) warnings.push('Sin plantilla: no se podrán enviar recordatorios proactivos fuera de la ventana de 24 h.');
    if (configured && enabled && !publicWebhookUrl()) warnings.push('Sin URL pública/túnel: Meta no podrá entregar el webhook (usa scripts/tunnel.ps1 y guarda la URL).');
    if (!allowedNumbers().length) warnings.push('Sin lista de números autorizados: cualquier número que escriba al WhatsApp puede usar la agenda.');
    if (section.lastError) warnings.push(`Último error: ${section.lastError.message}`);
    const detail = !configured
      ? 'No configurado: faltan Phone Number ID y Access Token de Meta.'
      : !enabled
        ? 'Credenciales guardadas. Activa el canal para responder mensajes.'
        : 'Activo: recibe webhooks de Meta y responde por WhatsApp Cloud API.';

    return {
      id: 'whatsapp',
      label: 'WhatsApp Cloud API',
      kind: 'messaging',
      alwaysAvailable: false,
      configured,
      enabled,
      ready: configured && enabled,
      detail,
      instructions: [...INSTRUCTIONS],
      warnings,
      capabilities: { ...CAPABILITIES },
      config: buildConfigView(CONFIG_FIELDS, config),
      runtime: {
        apiVersion: waVersion(),
        inboundUrl: '/api/whatsapp/webhook',
        webhookUrl: publicWebhookUrl(),
        phoneNumberId: phoneNumberId ? `••••${String(phoneNumberId).slice(-4)}` : null,
        phone: section.phoneNumber || null,
        verifiedName: section.verifiedName || null,
        defaultTo: defaultTo ? `••••${String(defaultTo).slice(-4)}` : null,
        appSecretConfigured: secretConfigured,
        verifyTokenConfigured: verifyConfigured,
        template: templateConfigured()
          ? { name: getSecret('channels.whatsapp.templateName'), language: getSecret('channels.whatsapp.templateLanguage') || 'es_CO' }
          : null,
        windowHours: WINDOW_HOURS,
        openWindows: countOpenWindows('whatsapp', WINDOW_HOURS),
        deliveryStatuses: Object.keys(section.statuses || {}).length,
        lastError: plainClone(section.lastError),
        lastInboundAt: section.lastInboundAt || null,
        lastOutboundAt: section.lastOutboundAt || null,
        stats: { ...(section.stats || {}) }
      },
      stats: { ...(section.stats || {}) },
      lastError: plainClone(section.lastError),
      webhookUrl: publicWebhookUrl()
    };
  }

  function publicWebhookUrl() {
    const base = String(waConfig().publicUrl || process.env.APP_URL || '').trim().replace(/\/$/, '');
    return base ? `${base}/api/whatsapp/webhook` : null;
  }

  async function sendTemplate(to, text) {
    const { phoneNumberId, accessToken } = waCredentials();
    const name = getSecret('channels.whatsapp.templateName');
    const language = getSecret('channels.whatsapp.templateLanguage') || 'es_CO';
    if (!name) {
      throw new ChannelError('WA_TEMPLATE_MISSING', 'La ventana de 24 h de WhatsApp está cerrada y no hay plantilla configurada. Crea una plantilla aprobada y guarda su nombre e idioma.', {
        channel: 'whatsapp', status: 409, details: { windowHours: WINDOW_HOURS }
      });
    }
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: [{ type: 'body', parameters: [{ type: 'text', text: sanitizeText(text, 900) || 'Recordatorio' }] }]
      }
    };
    const response = await requestJson(graphUrl(`/${encodeURIComponent(phoneNumberId)}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: payload,
      timeoutMs: 20_000,
      retries: 1,
      channel: 'whatsapp'
    });
    if (!response.ok) throw translateError(response);
    const id = response.json?.messages?.[0]?.id || null;
    return { id, to, via: 'whatsapp', template: name, language };
  }

  async function send({ to, text, meta = {} }) {
    const { phoneNumberId, accessToken } = waCredentials();
    if (!phoneNumberId || !accessToken) {
      throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'WhatsApp no está configurado: faltan Phone Number ID y/o Access Token.', {
        channel: 'whatsapp', status: 409, details: { instructions: INSTRUCTIONS }
      });
    }
    const target = normalizePhone(to || getSecret('channels.whatsapp.defaultTo'));
    const content = sanitizeText(text, MAX_TEXT);
    const forceTemplate = meta.proactive === true || meta.template === true;
    const windowOpen = conversationWindowOpen('whatsapp', target, WINDOW_HOURS);
    if (forceTemplate || (!windowOpen && !meta.force)) {
      return sendTemplate(target, content);
    }
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: target,
      type: 'text',
      text: { preview_url: false, body: content }
    };
    const response = await requestJson(graphUrl(`/${encodeURIComponent(phoneNumberId)}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: payload,
      timeoutMs: 20_000,
      retries: 1,
      channel: 'whatsapp'
    });
    if (!response.ok) throw translateError(response);
    return { id: response.json?.messages?.[0]?.id || null, to: target, via: 'whatsapp' };
  }

  async function sendDocument({ to, filename, buffer, mimeType = 'application/octet-stream', caption = '' } = {}) {
    const { phoneNumberId, accessToken } = waCredentials();
    if (!phoneNumberId || !accessToken) {
      throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'WhatsApp no está configurado: faltan Phone Number ID y/o Access Token.', { channel: 'whatsapp', status: 409 });
    }
    const target = normalizePhone(to || getSecret('channels.whatsapp.defaultTo'));
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ChannelError('DOC_EMPTY', 'El documento no tiene contenido.', { channel: 'whatsapp' });
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType || 'application/octet-stream');
    form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'documento');
    const upload = await requestForm(graphUrl(`/${encodeURIComponent(phoneNumberId)}/media`), form, {
      timeoutMs: 90_000,
      channel: 'whatsapp',
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!upload.ok) throw translateError(upload);
    const mediaId = upload.json?.id;
    if (!mediaId) throw new ChannelError('WA_MEDIA_FAILED', 'Meta no devolvió el id del documento subido.', { channel: 'whatsapp', status: 502 });
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: target,
      type: 'document',
      document: {
        id: mediaId,
        filename: sanitizeText(filename || 'documento', 200),
        ...(caption ? { caption: sanitizeText(caption, 1024) } : {})
      }
    };
    const response = await requestJson(graphUrl(`/${encodeURIComponent(phoneNumberId)}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: payload,
      timeoutMs: 30_000,
      retries: 1,
      channel: 'whatsapp'
    });
    if (!response.ok) throw translateError(response);
    return {
      id: response.json?.messages?.[0]?.id || null,
      to: target,
      via: 'whatsapp',
      filename,
      size: buffer.length,
      mimeType,
      mediaId
    };
  }

  async function markRead(messageId) {
    const { phoneNumberId, accessToken } = waCredentials();
    if (!phoneNumberId || !accessToken || !messageId) return { ok: false };
    try {
      const response = await requestJson(graphUrl(`/${encodeURIComponent(phoneNumberId)}/messages`), {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
        body: { messaging_product: 'whatsapp', status: 'read', message_id: String(messageId) },
        timeoutMs: 8_000,
        retries: 0,
        channel: 'whatsapp'
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }

  async function configure(body) {
    // Validación atómica: si llegan credenciales nuevas se validan con GET del
    // número antes de guardarlas. Si fallan, la configuración anterior intacta.
    const rawToken = readRawField(body, 'accessToken');
    const rawPhone = readRawField(body, 'phoneNumberId');
    const current = waCredentials();
    const candidateToken = typeof rawToken === 'string' && rawToken.trim() ? rawToken.trim() : current.accessToken;
    const candidatePhone = typeof rawPhone === 'string' && rawPhone.trim() ? rawPhone.trim() : current.phoneNumberId;
    const credentialsChanged = (typeof rawToken === 'string' && rawToken.trim() && rawToken.trim() !== current.accessToken)
      || (typeof rawPhone === 'string' && rawPhone.trim() && rawPhone.trim() !== current.phoneNumberId);
    let info = null;
    if (credentialsChanged && candidateToken && candidatePhone) {
      try {
        info = await getPhoneNumberWith(candidatePhone, candidateToken);
      } catch (error) {
        await setChannelError('whatsapp', error, { source: 'config' });
        throw error;
      }
    }
    const result = await applyConfigFields({
      channel: 'whatsapp', fields: CONFIG_FIELDS, body, settings: waConfig()
    });
    if (Object.keys(result.settingsPatch).length) {
      await patchChannelConfig('whatsapp', result.settingsPatch);
    }
    if (info) {
      await patchChannelConfig('whatsapp', {
        phoneNumber: info.display_phone_number || null,
        verifiedName: info.verified_name || null
      });
    }
    await clearChannelError('whatsapp').catch(() => {});
    return {
      ok: true,
      changed: result.changed,
      cleared: result.cleared,
      detail: waEnabled()
        ? 'Configuración guardada y aplicada sin reiniciar.'
        : 'Configuración guardada. Activa el canal cuando quieras responder.'
    };
  }

  async function test({ to, text } = {}) {
    const info = await getPhoneNumber();
    const target = to || getSecret('channels.whatsapp.defaultTo');
    if (!target) {
      return {
        ok: true,
        channel: 'whatsapp',
        detail: `Credenciales válidas para ${info.display_phone_number || info.verified_name || 'el número'}. Configura el destinatario por defecto para probar el envío.`,
        result: { credentials: true, sent: false, phone: info.display_phone_number || null }
      };
    }
    try {
      const sent = await send({ to: target, text: text || '✅ Agenda Copilot: prueba de WhatsApp correcta.' });
      return {
        ok: true,
        channel: 'whatsapp',
        detail: `Credenciales válidas y mensaje de prueba enviado a ${String(target).replace(/\d(?=\d{2})/g, '•')}.`,
        result: { credentials: true, sent: true, messageId: sent.id, phone: info.display_phone_number || null }
      };
    } catch (error) {
      if (error?.code === 'WA_TEMPLATE_MISSING') {
        return {
          ok: true,
          channel: 'whatsapp',
          detail: 'Credenciales válidas. El envío de texto libre requiere la ventana de 24 h abierta (o una plantilla aprobada); no se ha enviado nada.',
          result: { credentials: true, sent: false, reason: 'WA_WINDOW_CLOSED', windowHours: WINDOW_HOURS }
        };
      }
      throw error;
    }
  }

  async function processWebhook(payload) {
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];
    let processed = 0;
    let ignored = 0;
    let statuses = 0;
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};
        for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
          statuses += 1;
          const errorMessage = Array.isArray(status.errors) && status.errors[0]?.message
            ? status.errors[0].message
            : null;
          await recordDeliveryStatus('whatsapp', status.id, {
            status: status.status,
            recipient: status.recipient_id,
            error: errorMessage
          }).catch(() => {});
          if (status.status === 'failed') {
            log('warn', `WhatsApp: entrega fallida (${errorMessage || 'sin detalle'}).`);
          }
        }
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const message of messages) {
          const from = String(message.from || '');
          const timestamp = message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString();
          const base = {
            channel: 'whatsapp',
            userId: from || 'whatsapp',
            dedupeKey: `msg:${message.id}`,
            id: `wa:${message.id}`,
            timestamp,
            meta: {
              whatsappId: message.id,
              type: message.type,
              profileName: value.contacts?.[0]?.profile?.name || null
            },
            source: 'whatsapp'
          };
          const text = extractMessageText(message);
          if (!text) {
            await recordIgnored(makeMessage({ ...base, text: '', status: 'skipped' }), `tipo no soportado: ${message.type}`);
            ignored += 1;
            continue;
          }
          if (!isAllowedNumber(from)) {
            // Intento de aprobación desde un número no autorizado: se deja pasar
            // al gate para rechazarlo y auditarlo.
            if (looksLikeApprovalResponse(text) && typeof onMessage === 'function') {
              await onMessage({ ...base, text, meta: { ...base.meta, approvalAttempt: true } });
              processed += 1;
              continue;
            }
            await recordIgnored(makeMessage({ ...base, text, status: 'skipped' }), 'número no autorizado');
            ignored += 1;
            continue;
          }
          if (typeof onMessage !== 'function') {
            ignored += 1;
            continue;
          }
          await markRead(message.id).catch(() => {});
          await onMessage({ ...base, text });
          processed += 1;
        }
      }
    }
    return { processed, ignored, statuses };
  }

  return {
    id: 'whatsapp',
    label: 'WhatsApp Cloud API',
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
    processWebhook,
    setDispatcher(handler) { onMessage = handler; },
    getPhoneNumber,
    markRead
  };
}

/**
 * Texto útil de un mensaje de WhatsApp (texto, respuesta de botón o interactivo).
 * @param {any} message
 * @returns {string}
 */
function extractMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'text' && message.text?.body) return sanitizeText(message.text.body);
  if (message.type === 'button' && message.button?.text) return sanitizeText(message.button.text);
  if (message.type === 'interactive') {
    const interactive = message.interactive || {};
    if (interactive.button_reply?.title) return sanitizeText(interactive.button_reply.title);
    if (interactive.list_reply?.title) return sanitizeText(interactive.list_reply.title);
    if (interactive.button_reply?.id) return sanitizeText(interactive.button_reply.id);
  }
  if (message.type === 'order' || message.type === 'image' || message.type === 'audio' || message.type === 'document' || message.type === 'video') {
    return '';
  }
  if (typeof message.text?.body === 'string') return sanitizeText(message.text.body);
  return '';
}

/** Diagnóstico seguro para la UI. */
export function whatsappDebug() {
  return {
    version: waVersion(),
    configured: !!waCredentials().phoneNumberId && !!waCredentials().accessToken,
    windowHours: WINDOW_HOURS,
    template: templateConfigured(),
    describeError
  };
}

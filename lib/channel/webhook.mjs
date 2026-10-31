/**
 * Webhook genérico: cualquier herramienta puede hablar con la agenda.
 *
 * Entrada:
 *   `POST /api/channels/inbound/:id` (o `/api/webhooks/generic` para el canal
 *   `generic`) con token en `Authorization: Bearer`, `X-Webhook-Secret`,
 *   `X-Channel-Token` o `?token=`. Se compara en tiempo constante y se aplica
 *   rate limit. El cuerpo es JSON libre: se busca `text`/`message`/`content` y
 *   un identificador (`id`/`messageId`/`uuid`) para deduplicar.
 *
 * Salida opcional:
 *   `outboundUrl` + `preset` (`generic`, `slack`, `discord`, `n8n`, `zapier`)
 *   reciben la respuesta del asistente. Slack usa `{text}`, Discord `{content}`
 *   y el resto un JSON estable con `{event, id, user, text, reply, replyAt}`.
 *
 * Varias instancias:
 *   `generic` usa la bóveda (`webhooks.generic.secret`). Cualquier otro id
 *   `webhook:<nombre>` se crea desde la UI/API y su token se guarda **cifrado**
 *   en `channelState.channels['webhook:<nombre>'].token`. Crear una instancia
 *   sin token devuelve uno generado una sola vez en la respuesta.
 *
 * Añadir un canal nuevo completo (con su propia API) no requiere tocar este
 * archivo: ver docs/CANALES.md §«Añadir un canal en 30 líneas».
 */
import crypto from 'node:crypto';
import { ChannelError, describeError, requestJson } from './http.mjs';
import { buildConfigView, normalizeFieldValue } from './config.mjs';
import {
  encryptedTokenMeta, getChannelConfig, getChannelSection, patchChannelConfig,
  recordAudit, updateChannelState, plainClone
} from './state.mjs';
import { sanitizeText, extractPayloadId, extractPayloadText, extractPayloadUser } from './message.mjs';
import { deleteSecret, getSecret, setSecret } from '../security/vault.mjs';
import { webhookStrictMode } from '../http/middleware.mjs';
import { safeEqual } from '../security/compare.mjs';
import { registerSecretValue } from '../security/redact.mjs';
import { encryptJSON, decryptJSON, store } from '../store.mjs';
import { ValidationError } from '../http/errors.mjs';


const PRESETS = Object.freeze(['generic', 'slack', 'discord', 'n8n', 'zapier']);
const METHODS = Object.freeze(['POST', 'PUT']);

const INSTANCE_FIELDS = Object.freeze([
  { key: 'label', label: 'Nombre visible', type: 'string', maxLength: 80 },
  { key: 'enabled', label: 'Canal activo', type: 'boolean', default: true },
  { key: 'outboundUrl', label: 'URL de salida', type: 'url', maxLength: 500, help: 'Si se define, la respuesta se envía ahí (Slack/Discord/n8n/Zapier).' },
  { key: 'method', label: 'Método HTTP', type: 'enum', options: [...METHODS], default: 'POST' },
  { key: 'preset', label: 'Formato de salida', type: 'enum', options: [...PRESETS], default: 'generic', help: 'Slack usa {text}; Discord {content}; el resto JSON genérico.' },
  { key: 'outboundHeaders', label: 'Cabeceras de salida', type: 'list', help: 'Formato «Nombre: valor». Prohibido Host/Content-Length.' },
  { key: 'outboundTokenHeader', label: 'Cabecera del token de salida', type: 'string', maxLength: 40, default: 'Authorization', help: 'Si es Authorization se envía como Bearer.' },
  { key: 'useButtons', label: 'Botones 1/2/3', type: 'boolean', default: false }
]);

const INSTRUCTIONS = Object.freeze([
  'Abre el Centro de integraciones y crea un webhook con un nombre (por ejemplo n8n o slack).',
  'Copia el token que se muestra una sola vez y guárdalo en la herramienta externa.',
  'Configura la URL de salida si quieres que la respuesta del asistente vuelva a Slack/Discord/n8n/Zapier; si no, la respuesta viaja en el JSON HTTP.',
  'Prueba: curl -X POST http://127.0.0.1:3000/api/channels/inbound/generic -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d "{\"text\":\"HOY\",\"id\":\"demo-1\",\"user\":\"yo\"}".',
  'Repite el mismo id y comprobarás que no se duplica la acción: la idempotencia vive en el pipeline.'
]);

const CAPABILITIES = Object.freeze({
  inbound: true, outbound: true, proactive: true,
  buttons: false, typing: false, threads: false, templates: false
});

/** Extrae `Clave: valor` de la lista de cabeceras configurada. */
function parseHeaders(list) {
  const headers = {};
  for (const entry of Array.isArray(list) ? list : []) {
    const match = /^([A-Za-z0-9-]{1,40}):\s*(.+)$/.exec(String(entry).trim());
    if (!match) continue;
    const name = match[1];
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) continue;
    headers[name] = match[2].trim().slice(0, 500);
  }
  return headers;
}

function instanceIdOf(raw) {
  const value = String(raw || '').trim();
  if (value === 'generic') return 'generic';
  const match = /^webhook:([a-z0-9][a-z0-9_-]{1,30})$/.exec(value);
  return match ? value : null;
}

function webhookSection(id) {
  return getChannelSection(`webhook:${id}`);
}

function configKey(id) {
  return `webhook:${id}`;
}

function sectionToken(id) {
  const box = webhookSection(id).token;
  if (!box || !box.data) return null;
  try {
    const value = decryptJSON(box);
    return typeof value === 'string' ? value : value?.token || null;
  } catch {
    return null;
  }
}

async function saveSectionToken(id, token, { label = 'token' } = {}) {
  const box = encryptJSON(String(token));
  const updatedAt = new Date().toISOString();
  const hint = token ? `••••${String(token).slice(-4)}` : '••••';
  return updateChannelState((state) => {
    const channel = `webhook:${id}`;
    if (!state.channels[channel] || typeof state.channels[channel] !== 'object') state.channels[channel] = {};
    state.channels[channel].token = { ...box, updatedAt, hint };
    state.channels[channel].label = label;
    if (!state.channels[channel].createdAt) state.channels[channel].createdAt = updatedAt;
  }, `canal-webhook-token:${id}`);
}

async function saveOutboundToken(id, token) {
  const box = encryptJSON(String(token));
  const updatedAt = new Date().toISOString();
  const hint = token ? `••••${String(token).slice(-4)}` : null;
  return updateChannelState((state) => {
    const channel = `webhook:${id}`;
    if (!state.channels[channel] || typeof state.channels[channel] !== 'object') state.channels[channel] = {};
    state.channels[channel].outboundToken = box ? { ...box, updatedAt, hint } : null;
  }, `canal-webhook-salida-token:${id}`);
}

function outboundTokenOf(id) {
  const box = webhookSection(id).outboundToken;
  if (!box || !box.data) return null;
  try {
    const value = decryptJSON(box);
    return typeof value === 'string' ? value : value?.token || null;
  } catch {
    return null;
  }
}

/** Token de entrada configurado para la instancia (o null). */
export function inboundToken(id) {
  const instance = instanceIdOf(id);
  if (!instance) return null;
  if (instance === 'generic') {
    return getSecret('webhooks.generic.secret') || sectionToken('generic');
  }
  return sectionToken(instance.slice('webhook:'.length));
}

function extractProvidedToken(req, query) {
  const authorization = String(req?.headers?.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
  return bearer
    || String(req?.headers['x-webhook-secret'] || '')
    || String(req?.headers['x-channel-token'] || '')
    || String(query?.get ? query.get('token') || '' : query?.token || '');
}

/**
 * Verifica el token de entrada.
 * - Sin token configurado: modo local → se acepta con advertencia; modo estricto
 *   (producción o HOST≠loopback) → 503 WEBHOOK_SECRET_MISSING.
 * - Token configurado e inválido → 401 WEBHOOK_SIGNATURE_INVALID.
 * @param {string} id
 * @param {import('node:http').IncomingMessage} req
 * @param {URLSearchParams} [query]
 */
export function verifyInboundToken(id, req, query) {
  const instance = instanceIdOf(id);
  if (!instance) throw new ChannelError('UNKNOWN_CHANNEL', `Webhook desconocido: ${id}.`, { channel: 'generic', status: 404 });
  // La existencia se comprueba ANTES del token: una instancia inexistente es 404,
  // no un 503 que confundiría al integrador.
  if (instance !== 'generic' && !getChannelSection(`webhook:${instance.slice('webhook:'.length)}`).createdAt) {
    throw new ChannelError('UNKNOWN_CHANNEL', `Webhook no configurado: ${id}. Créalo antes con POST /api/channels/${id}/config.`, { channel: 'generic', status: 404 });
  }
  const expected = inboundToken(instance);
  if (!expected) {
    // `generic` conserva la compatibilidad del contrato (modo local permisivo).
    // Las instancias creadas desde la UI son opt-in y SIEMPRE exigen token.
    if (instance !== 'generic' || webhookStrictMode()) {
      throw new ChannelError('WEBHOOK_SECRET_MISSING', instance === 'generic'
        ? 'Falta el token del webhook; en producción o con autenticación activa está deshabilitado.'
        : 'La instancia de webhook no tiene token: genera uno en su configuración antes de usarla.', {
        channel: 'generic', status: 503, details: { field: 'token', instance }
      });
    }
    return { verified: false, warning: 'Webhook sin token configurado (permitido solo en modo local para «generic»).' };
  }
  const provided = String(extractProvidedToken(req, query) || '').trim();
  if (!provided || !safeEqual(provided, expected)) {
    throw new ChannelError('WEBHOOK_SIGNATURE_INVALID', 'Token de webhook inválido.', {
      channel: 'generic', status: 401, details: { field: 'token' }
    });
  }
  return { verified: true };
}

function buildPayload(instance, { reply, text, userId, message, at }) {
  const config = getChannelConfig(configKey(instance));
  const preset = PRESETS.includes(config.preset) ? config.preset : 'generic';
  const base = {
    event: 'agenda.message',
    channel: 'webhook',
    instance,
    id: message?.id || null,
    user: userId,
    text,
    reply,
    replyAt: at,
    timestamp: message?.timestamp || at
  };
  if (preset === 'slack') return { text: reply || text };
  if (preset === 'discord') return { content: reply || text };
  return { ...base, preset };
}

/**
 * Envía la respuesta a la URL de salida configurada (si existe).
 * @param {string} instance
 * @param {{text:string, reply:string, userId:string, message?:object}} input
 */
export async function deliverOutbound(instance, input) {
  const config = getChannelConfig(configKey(instance));
  const url = String(config.outboundUrl || '').trim();
  if (!url) return { skipped: true, reason: 'no-outbound-url' };
  const method = METHODS.includes(config.method) ? config.method : 'POST';
  const headers = { 'content-type': 'application/json', ...parseHeaders(config.outboundHeaders) };
  const outboundToken = outboundTokenOf(instance);
  if (outboundToken) {
    const headerName = String(config.outboundTokenHeader || 'Authorization').trim() || 'Authorization';
    headers[headerName] = /^authorization$/i.test(headerName) ? `Bearer ${outboundToken}` : outboundToken;
  }
  const body = buildPayload(instance, { ...input, at: new Date().toISOString() });
  const response = await requestJson(url, {
    method, headers, body, timeoutMs: 20_000, retries: 2, channel: `webhook:${instance}`
  });
  if (!response.ok) {
    throw new ChannelError('WEBHOOK_OUTBOUND_FAILED', `La URL de salida respondió ${response.status}.`, {
      channel: `webhook:${instance}`, status: 502
    });
  }
  return { ok: true, status: response.status, via: `webhook:${instance}`, preset: config.preset || 'generic' };
}

function instanceStatus(id) {
  const normalized = instanceIdOf(id);
  if (!normalized) return null;
  const instance = normalized.slice('webhook:'.length);
  const config = getChannelConfig(configKey(instance));
  const section = webhookSection(instance);
  const token = inboundToken(normalized);
  const tokenMeta = encryptedTokenMeta(`webhook:${instance}`);
  const enabled = config.enabled !== false;
  const warnings = [];
  if (!token) warnings.push('Sin token de entrada: en modo estricto el webhook responde 503.');
  if (!config.outboundUrl) warnings.push('Sin URL de salida: la respuesta solo viaja en la respuesta HTTP.');
  if (section.lastError) warnings.push(`Último error: ${section.lastError.message}`);
  const publicId = instance === 'generic' ? 'generic' : normalized;
  return {
    id: publicId,
    label: config.label || (instance === 'generic' ? 'Webhook genérico' : `Webhook ${instance}`),
    kind: 'webhook',
    alwaysAvailable: false,
    configured: !!token || instance === 'generic',
    enabled,
    ready: enabled && (!!token || instance === 'generic'),
    detail: enabled
      ? (config.outboundUrl ? `Recibe JSON y responde a ${config.preset || 'generic'} (${config.outboundUrl}).` : 'Recibe JSON y devuelve la respuesta en el cuerpo HTTP.')
      : 'Deshabilitado: el webhook responde 403.',
    instructions: [...INSTRUCTIONS],
    warnings,
    capabilities: { ...CAPABILITIES },
    config: buildConfigView(INSTANCE_FIELDS, config),
    runtime: {
      tokenConfigured: !!token,
      tokenHint: tokenMeta?.hint || null,
      tokenSource: instance === 'generic' && getSecret('webhooks.generic.secret') ? 'vault' : token ? 'channelState' : null,
      outboundUrl: config.outboundUrl || null,
      outboundTokenConfigured: !!outboundTokenOf(instance),
      preset: config.preset || 'generic',
      method: config.method || 'POST',
      inboundUrl: `/api/channels/inbound/${instance}`,
      lastInboundAt: section.lastInboundAt || null,
      lastOutboundAt: section.lastOutboundAt || null,
      lastError: plainClone(section.lastError),
      stats: { ...(section.stats || {}) },
      createdAt: section.createdAt || null
    },
    stats: { ...(section.stats || {}) },
    lastError: plainClone(section.lastError),
    webhookUrl: `/api/channels/inbound/${instance}`
  };
}

/** Todas las instancias de webhook configuradas (generic + personalizadas). */
export function listWebhookInstances() {
  const ids = new Set(['generic']);
  // Recorre canales y configuraciones buscando instancias webhook:<nombre>.
  try {
    const channelState = store.get().channelState || {};
    for (const key of Object.keys(channelState.channels || {})) {
      if (key.startsWith('webhook:')) ids.add(key.slice('webhook:'.length));
    }
    for (const key of Object.keys(channelState.config || {})) {
      if (key.startsWith('webhook:')) ids.add(key.slice('webhook:'.length));
    }
  } catch { /* store no disponible */ }
  return [...ids]
    .sort((a, b) => (a === 'generic' ? -1 : b === 'generic' ? 1 : a.localeCompare(b)))
    .map((instance) => instanceStatus(`webhook:${instance}`))
    .filter(Boolean);
}

export function createGenericAdapter() {
  let onMessage = null;

  return {
    id: 'generic',
    label: 'Webhook genérico',
    kind: 'webhook',
    alwaysAvailable: false,
    capabilities: CAPABILITIES,
    configFields: INSTANCE_FIELDS,
    instructions: INSTRUCTIONS,

    status() {
      const config = getChannelConfig(configKey('generic'));
      const section = getChannelSection('generic');
      const token = inboundToken('generic');
      const instances = listWebhookInstances();
      const warnings = [];
      if (!token) warnings.push('Sin token de entrada: en modo local se acepta con advertencia; en producción/auth responde 503.');
      if (section.lastError) warnings.push(`Último error: ${section.lastError.message}`);
      return {
        id: 'generic',
        label: 'Webhook genérico',
        kind: 'webhook',
        alwaysAvailable: false,
        configured: !!token,
        enabled: config.enabled !== false,
        ready: (!!token || !webhookStrictMode()) && config.enabled !== false,
        detail: config.enabled === false
          ? 'Deshabilitado: el webhook responde 403.'
          : 'Endpoint universal para Slack/Discord/n8n/Zapier y scripts propios.',
        instructions: [...INSTRUCTIONS],
        warnings,
        capabilities: { ...CAPABILITIES },
        config: buildConfigView(INSTANCE_FIELDS, config),
        runtime: {
          tokenConfigured: !!token,
          tokenHint: encryptedTokenMeta('generic')?.hint || null,
          outboundUrl: config.outboundUrl || null,
          preset: config.preset || 'generic',
          inboundUrl: '/api/channels/inbound/generic',
          alias: '/api/webhooks/generic',
          instances: instances.map((item) => ({
            id: item.id, label: item.label, enabled: item.enabled,
            tokenConfigured: item.runtime.tokenConfigured,
            outboundUrl: item.runtime.outboundUrl,
            lastInboundAt: item.runtime.lastInboundAt
          })),
          lastError: plainClone(section.lastError),
          stats: { ...(section.stats || {}) }
        },
        stats: { ...(section.stats || {}) },
        lastError: plainClone(section.lastError),
        webhookUrl: '/api/channels/inbound/generic'
      };
    },

    async configure(body) {
      return configureInstance('generic', body);
    },

    async test({ text, id } = {}) {
      const instance = instanceIdOf(id || 'generic');
      if (!instance || !webhookInstanceExists(instance)) throw new ChannelError('UNKNOWN_CHANNEL', `Webhook desconocido: ${id}.`, { channel: 'generic', status: 404 });
      const name = instance.slice('webhook:'.length);
      const config = getChannelConfig(configKey(name));
      const token = inboundToken(instance);
      if (!token && webhookStrictMode()) {
        throw new ChannelError('WEBHOOK_SECRET_MISSING', 'El webhook no tiene token configurado.', { channel: 'generic', status: 503 });
      }
      const delivered = await deliverOutbound(name, {
        text: text || '✅ Agenda Copilot: prueba de webhook correcta.',
        reply: text || '✅ Agenda Copilot: prueba de webhook correcta.',
        userId: 'prueba'
      });
      return {
        ok: true,
        channel: 'generic',
        detail: delivered.skipped
          ? 'Token correcto. No hay URL de salida: la respuesta viaja en el cuerpo HTTP.'
          : `Prueba enviada a la URL de salida (${config.outboundUrl}).`,
        result: delivered
      };
    },

    async send({ to, text, meta = {}, message } = {}) {
      const instance = String(message?.meta?.webhookId || meta.instance || 'generic');
      const name = instanceIdOf(instance) ? instance.slice('webhook:'.length) : 'generic';
      const delivered = await deliverOutbound(name, {
        text: sanitizeText(to || '', 200),
        reply: sanitizeText(text, 8000),
        userId: String(to || 'webhook'),
        message
      });
      if (delivered.skipped) return { skipped: true, reason: delivered.reason, via: `webhook:${name}` };
      return { id: null, ...delivered };
    },

    async processWebhook(payload, { instance = 'generic' } = {}) {
      const name = String(instance).startsWith('webhook:') ? String(instance).slice('webhook:'.length) : 'generic';
      const normalized = `webhook:${name}`;
      if (name !== 'generic' && !getChannelSection(`webhook:${name}`).createdAt) {
        throw new ChannelError('UNKNOWN_CHANNEL', `Webhook no configurado: ${instance}. Créalo antes con POST /api/channels/${instance}/config.`, { channel: 'generic', status: 404 });
      }
      const config = getChannelConfig(configKey(name));
      if (config.enabled === false) {
        throw new ChannelError('CHANNEL_DISABLED', 'El webhook está deshabilitado.', { channel: 'generic', status: 403 });
      }
      const text = extractPayloadText(payload);
      if (!text) {
        throw new ChannelError('EMPTY_MESSAGE', 'El payload no contiene texto (usa text/message/content/body).', {
          channel: 'generic', status: 400, details: { field: 'text' }
        });
      }
      const rawUser = extractPayloadUser(payload, 'webhook');
      const externalId = extractPayloadId(payload) || crypto.randomUUID();
      if (typeof onMessage !== 'function') throw new ChannelError('CHANNEL_NOT_STARTED', 'El pipeline de canales no está iniciado.', { channel: 'generic', status: 503 });
      const result = await onMessage({
        channel: 'generic',
        userId: `${name}:${rawUser}`,
        text,
        dedupeKey: `${name}:${externalId}`,
        id: `wh:${name}:${externalId}`,
        meta: {
          webhookId: normalized,
          instance: name,
          rawUser,
          externalId,
          payloadKeys: Object.keys(payload || {}).slice(0, 12)
        },
        source: `webhook:${name}`
      });
      return { ...result, instance: normalized };
    },

    setDispatcher(handler) { onMessage = handler; },
    instanceStatus,
    listInstances: listWebhookInstances
  };
}

/**
 * Configura (o crea) una instancia de webhook.
 * @param {string} id `generic` o `webhook:<nombre>`
 * @param {unknown} body
 */
export async function configureInstance(id, body) {
  const instance = instanceIdOf(id);
  if (!instance) throw new ValidationError('id', 'INVALID_VALUE', `Id de webhook inválido: ${id}. Usa «generic» o «webhook:nombre».`);
  const name = instance.slice('webhook:'.length);
  const isNew = instance !== 'generic' && !getChannelSection(`webhook:${name}`).createdAt;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body', 'INVALID_BODY', 'Se espera un objeto JSON de configuración.');
  }
  const flat = { ...body };
  const fields = flat.fields;
  delete flat.fields;
  if (fields !== undefined) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new ValidationError('fields', 'INVALID_BODY', 'fields debe ser un objeto.');
    for (const [key, value] of Object.entries(fields)) {
      if (flat[key] !== undefined) throw new ValidationError(key, 'DUPLICATE_FIELD', `El campo ${key} llegó dos veces.`);
      flat[key] = value;
    }
  }
  if (!Object.keys(flat).length) throw new ValidationError('body', 'EMPTY_PATCH', 'No se envió ningún campo de configuración.');

  const allowed = new Set([...INSTANCE_FIELDS.map((field) => field.key), 'token', 'outboundToken']);
  for (const key of Object.keys(flat)) {
    if (!allowed.has(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo de configuración no permitido: ${key}.`);
  }

  // Se valida TODO antes de escribir nada (config atómica).
  const patch = {};
  for (const field of INSTANCE_FIELDS) {
    if (flat[field.key] === undefined) continue;
    patch[field.key] = normalizeFieldValue(field, flat[field.key]);
  }
  let newToken = null;
  let clearToken = false;
  if (flat.token !== undefined) {
    if (flat.token === null || String(flat.token).trim() === '') {
      clearToken = true;
    } else {
      newToken = String(flat.token).trim();
      if (newToken.length < 12) throw new ValidationError('token', 'TOO_SHORT', 'El token debe tener al menos 12 caracteres.');
      if (newToken.length > 200) throw new ValidationError('token', 'TOO_LONG', 'El token admite hasta 200 caracteres.');
    }
  }
  let newOutboundToken = null;
  let clearOutboundToken = false;
  if (flat.outboundToken !== undefined) {
    if (flat.outboundToken === null || String(flat.outboundToken).trim() === '') clearOutboundToken = true;
    else {
      newOutboundToken = String(flat.outboundToken).trim();
      if (newOutboundToken.length > 500) throw new ValidationError('outboundToken', 'TOO_LONG', 'El token de salida admite hasta 500 caracteres.');
    }
  }
  if (Object.keys(patch).length) await patchChannelConfig(`webhook:${name}`, patch);

  let generatedToken = null;
  let tokenRotated = false;
  if (clearToken) {
    if (instance === 'generic') await deleteSecret('webhooks.generic.secret').catch(() => {});
    await saveSectionToken(name, '');
    tokenRotated = true;
  } else if (newToken) {
    if (instance === 'generic') await setSecret('webhooks.generic.secret', newToken);
    await saveSectionToken(name, newToken);
    registerSecretValue(newToken);
    tokenRotated = true;
  }
  if (clearOutboundToken) {
    await saveOutboundToken(name, '');
  } else if (newOutboundToken) {
    await saveOutboundToken(name, newOutboundToken);
    registerSecretValue(newOutboundToken);
  }

  // Instancia nueva sin token: se genera uno y se muestra UNA sola vez.
  if (isNew && !inboundToken(instance)) {
    generatedToken = crypto.randomBytes(24).toString('hex');
    await saveSectionToken(name, generatedToken, { label: patch.label || name });
    registerSecretValue(generatedToken);
    tokenRotated = true;
  }
  if (isNew && !getChannelConfig(configKey(name)).label) {
    await patchChannelConfig(`webhook:${name}`, { label: patch.label || `Webhook ${name}`, enabled: patch.enabled !== false });
  }

  await recordAudit({
    channel: `webhook:${name}`,
    action: isNew ? 'creado' : 'configurado',
    outcome: 'ok',
    detail: Object.keys(patch).join(', ') || (tokenRotated ? 'token' : 'sin cambios')
  }, { activity: true });

  const changedKeys = Object.keys(patch);
  if (tokenRotated) changedKeys.push('token');
  if (newOutboundToken !== null || clearOutboundToken) changedKeys.push('outboundToken');
  return {
    ok: true,
    created: isNew,
    instance,
    changed: changedKeys,
    tokenRotated,
    generatedToken,
    detail: generatedToken
      ? 'Webhook creado. Guarda el token: no se volverá a mostrar.'
      : 'Configuración guardada y aplicada sin reiniciar.'
  };
}

/** ¿Existe la instancia? (`generic` siempre; las demás requieren creación). */
export function webhookInstanceExists(id) {
  const normalized = instanceIdOf(id);
  if (!normalized) return false;
  if (normalized === 'generic') return true;
  const name = normalized.slice('webhook:'.length);
  return !!getChannelSection(`webhook:${name}`).createdAt;
}

/** Estado de una instancia concreta (para GET /api/channels/:id). */
export function webhookInstanceStatus(id) {
  return instanceStatus(id);
}

/** Prueba manual del webhook sin pasar por el pipeline (diagnóstico). */
export async function webhookHealth() {
  const instances = listWebhookInstances();
  return {
    ok: true,
    instances: instances.map((item) => ({
      id: item.id,
      enabled: item.enabled,
      tokenConfigured: item.runtime.tokenConfigured,
      outboundUrl: item.runtime.outboundUrl,
      lastInboundAt: item.runtime.lastInboundAt,
      lastError: item.lastError
    }))
  };
}

/** Log de errores de salida con redacción. */
export function logWebhookError(error) {
  if (error) {
    // El logger ya redacta secretos; aquí solo se evita lanzar desde el adaptador.
    console.warn(`Webhook: ${describeError(error)}`);
  }
}

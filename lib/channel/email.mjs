/**
 * Adaptador de correo (Gmail).
 *
 * Salida:
 *   - Si hay una cuenta Google conectada en la app (Integraciones > Google), se
 *     usa el `sendGmail` existente (misma ruta que el resto de notificaciones).
 *   - Para respuestas a un correo entrante se usa el token de lectura del canal
 *     y se responde **en el mismo hilo** (`threadId` + `In-Reply-To`/`References`).
 *
 * Entrada:
 *   - Polling de Gmail con `users.messages.list?q=is:unread -in:spam -in:trash`
 *     y `users.messages.get?format=full`.
 *   - Lista blanca de remitentes (`allowFrom`); por defecto, el propio correo de
 *     notificaciones. Cualquier otro remitente se registra como ignorado: un
 *     buzón público no debe poder mover tu agenda.
 *   - Se ignoran autorespondedores (`Auto-Submitted`, `Precedence: bulk|list`)
 *     para no crear bucles de correo.
 *   - Idempotencia doble: `channelState.channels.email.seen` + dedupeKey del
 *     pipeline. Si hay permiso de escritura, además se marca como leído.
 *
 * Credenciales:
 *   - `channels.email.enabled` y `channels.email.to` viven en la bóveda.
 *   - El token OAuth de lectura (gmail.modify + gmail.send) se guarda **cifrado**
 *     en `channelState.channels.email.token` (AES-256-GCM).
 *   - El flujo OAuth del canal usa las mismas credenciales de app que Google
 *     Calendar (`google.clientId` / `google.clientSecret`), pero un consentimiento
 *     aparte con permiso de lectura. Nunca se pide la contraseña de Gmail.
 */
import crypto from 'node:crypto';
import {
  ChannelError, buildUrl, describeError, gmailApiBase, googleAuthBase, googleTokenUrl,
  googleUserinfoUrl, providerErrorMessage, requestJson
} from './http.mjs';
import { buildConfigView, applyConfigFields } from './config.mjs';
import { looksLikeApprovalResponse } from './approvals.mjs';
import {
  encryptedTokenMeta, emailSeen, getChannelConfig, getChannelSection, markEmailSeen,
  patchChannelConfig, saveEncryptedToken, saveOAuthState, consumeOAuthState, deleteOAuthState,
  setChannelError, clearChannelError, recordIgnored, plainClone, updateChannelState
} from './state.mjs';
import { makeMessage, sanitizeText } from './message.mjs';
import { decryptJSON, store } from '../store.mjs';
import { getSecret } from '../security/vault.mjs';
import { sendGmail } from '../google.mjs';
import { buildMimeMessage } from './mime.mjs';
import { hasAccounts, sendWithAccount } from './smtp.mjs';
import { log } from '../http/logger.mjs';

const INBOX_QUERY = 'is:unread -in:spam -in:trash';
const SCOPES = Object.freeze([
  'openid',
  'email',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send'
]);

/** @type {import('./config.mjs').FieldSpec[]} */
const CONFIG_FIELDS = Object.freeze([
  {
    key: 'enabled', label: 'Canal activo', type: 'boolean', default: false,
    vault: 'channels.email.enabled',
    help: 'Activa la entrada y salida de correo. La salida puntual usa la cuenta Google conectada.'
  },
  {
    key: 'to', label: 'Correo de notificaciones', type: 'secret', required: true,
    vault: 'channels.email.to', maxLength: 254,
    help: 'Destinatario por defecto de los avisos. También es el remitente autorizado por defecto.'
  },
  {
    key: 'pollIntervalMin', label: 'Frecuencia de revisión (min)', type: 'number', min: 1, max: 60, default: 5,
    help: 'Cada cuánto se consulta Gmail en busca de no leídos.'
  },
  {
    key: 'maxPerPoll', label: 'Máximo de correos por revisión', type: 'number', min: 1, max: 10, default: 5,
    help: 'Límite de mensajes procesados en cada pasada.'
  },
  {
    key: 'allowFrom', label: 'Remitentes autorizados', type: 'list',
    help: 'Correos que pueden dar órdenes a la agenda. Vacío = solo el correo de notificaciones.'
  },
  {
    key: 'replyEnabled', label: 'Responder automáticamente', type: 'boolean', default: true,
    help: 'Responde en el mismo hilo con el resultado del asistente.'
  },
  {
    key: 'markRead', label: 'Marcar como leído', type: 'boolean', default: true,
    help: 'Requiere permiso gmail.modify. Si no, la idempotencia se apoya en la lista de vistos.'
  },
  {
    key: 'publicUrl', label: 'URL pública para OAuth', type: 'url', maxLength: 500,
    help: 'URL base del túnel para el redirect_uri de Google. Si se omite se usa APP_URL.'
  }
]);

const INSTRUCTIONS = Object.freeze([
  'En Google Cloud Console crea (o reutiliza) un proyecto y habilita la Gmail API.',
  'Crea credenciales OAuth de tipo «Aplicación web» con redirect URI: http(s)://TU-DOMINIO/api/channels/email/oauth/callback (o http://127.0.0.1:3000/… en local).',
  'Guarda google.clientId y google.clientSecret en Integraciones > Secretos (grupo Google).',
  'Pulsa «Conectar Gmail (lectura y envío)»: se pide consentimiento con gmail.modify + gmail.send y el token queda cifrado en la app.',
  'Guarda el correo de notificaciones y los remitentes autorizados, y activa el canal. La revisión de no leídos empieza sin reiniciar.',
  'Si prefieres no conectar lectura, la salida sigue funcionando con la cuenta Google ya conectada (gmail.send).'
]);
const CAPABILITIES = Object.freeze({
  inbound: true, outbound: true, proactive: true,
  buttons: false, typing: false, threads: true, templates: false,
  documents: true, approvals: true
});

function emailEnabled() {
  return String(getSecret('channels.email.enabled') || '').toLowerCase() === 'true';
}

function emailConfig() {
  return getChannelConfig('email');
}

function emailTo() {
  return getSecret('channels.email.to');
}

function googleClient() {
  return {
    id: getSecret('google.clientId'),
    secret: getSecret('google.clientSecret')
  };
}

function baseOrigin(origin) {
  const configured = String(origin || emailConfig().publicUrl || process.env.APP_URL || '').trim().replace(/\/$/, '');
  return configured;
}

function redirectUri(origin) {
  const base = baseOrigin(origin);
  if (!base) throw new ChannelError('EMAIL_NO_PUBLIC_URL', 'Falta la URL pública (APP_URL o «URL pública para OAuth») para construir el redirect_uri de Google.', { channel: 'email', status: 409 });
  return `${base}/api/channels/email/oauth/callback`;
}

function emailAddress(value) {
  const match = /<([^>]+)>/.exec(String(value || ''));
  const candidate = (match ? match[1] : String(value || '')).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

function hasScope(scope, wanted) {
  const value = String(scope || '');
  return value.includes(wanted);
}

/**
 * Busca una conexión Google con permiso de lectura de Gmail.
 * @returns {{connection:any, token:any}|null}
 */
function googleReaderCandidate() {
  const connections = Array.isArray(store.get().googleConnections) ? store.get().googleConnections : [];
  for (const connection of connections) {
    try {
      const token = decryptJSON(connection.token);
      const scope = token?.scope || '';
      if (hasScope(scope, 'gmail.modify') || hasScope(scope, 'gmail.readonly') || scope.includes('https://mail.google.com/')) {
        return { connection, token };
      }
    } catch { /* token ilegible: se ignora */ }
  }
  return null;
}

async function refreshGoogleToken(token) {
  const client = googleClient();
  if (!client.id || !client.secret) {
    throw new ChannelError('GOOGLE_NOT_CONFIGURED', 'Falta google.clientId / google.clientSecret para refrescar el token de Gmail.', {
      channel: 'email', status: 409, details: { instructions: INSTRUCTIONS }
    });
  }
  if (!token.refresh_token) {
    throw new ChannelError('GOOGLE_RECONNECT', 'La conexión de Gmail necesita volver a autorizarse (sin refresh_token).', {
      channel: 'email', status: 409, details: { instructions: INSTRUCTIONS }
    });
  }
  const response = await requestJson(googleTokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token'
    }),
    timeoutMs: 15_000,
    retries: 1,
    idempotent: true,
    channel: 'email'
  });
  if (!response.ok) {
    throw new ChannelError('GOOGLE_TOKEN_REFRESH', `Google no refrescó el token de Gmail: ${providerErrorMessage(response)}`, {
      channel: 'email', status: 502
    });
  }
  return {
    ...token,
    ...response.json,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + (Number(response.json?.expires_in) || 3600) * 1000
  };
}

/**
 * Token de acceso vigente para Gmail.
 * Prioriza el token de lectura del canal; si no hay, usa una conexión Google con
 * permiso de lectura; si no, error accionable.
 * @returns {Promise<{accessToken:string, token:any, kind:'reader'|'google', email:string|null}>}
 */
async function emailAccess() {
  const readerBox = getChannelSection('email').token;
  if (readerBox && readerBox.data) {
    let token = decryptJSON(readerBox);
    if (!token?.access_token) {
      throw new ChannelError('GOOGLE_RECONNECT', 'El token de Gmail del canal no es válido. Vuelve a conectar la cuenta.', { channel: 'email', status: 409 });
    }
    if (!token.expires_at || token.expires_at < Date.now() + 60_000) {
      token = await refreshGoogleToken(token);
      await saveEncryptedToken('email', token);
    }
    return { accessToken: token.access_token, token, kind: 'reader', email: token.email || getChannelSection('email').account || null };
  }
  const candidate = googleReaderCandidate();
  if (candidate) {
    let token = candidate.token;
    if (!token.expires_at || token.expires_at < Date.now() + 60_000) {
      token = await refreshGoogleToken(token);
    }
    return { accessToken: token.access_token, token, kind: 'google', email: candidate.connection.email || null };
  }
  throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Gmail no tiene permiso de lectura: conecta la cuenta con «Conectar Gmail (lectura y envío)» o añade el permiso gmail.modify a la cuenta Google.', {
    channel: 'email', status: 409,
    details: {
      instructions: INSTRUCTIONS,
      oauthStart: '/api/channels/email/oauth/start'
    }
  });
}

async function gmailGet(path, query, { parse = 'json' } = {}) {
  const access = await emailAccess();
  const response = await requestJson(buildUrl(gmailApiBase(), path, query), {
    headers: { authorization: `Bearer ${access.accessToken}` },
    timeoutMs: 20_000,
    retries: 1,
    idempotent: true,
    parse: parse === 'text' ? 'text' : 'json',
    channel: 'email'
  });
  if (!response.ok) {
    if (response.status === 403) {
      throw new ChannelError('GMAIL_SCOPE_MISSING', 'Google denegó la lectura de Gmail: falta el permiso gmail.modify. Conecta la cuenta con «Conectar Gmail (lectura y envío)».', {
        channel: 'email', status: 409, details: { oauthStart: '/api/channels/email/oauth/start' }
      });
    }
    if (response.status === 401) {
      throw new ChannelError('GMAIL_UNAUTHORIZED', 'Gmail rechazó el token. Vuelve a conectar la cuenta.', { channel: 'email', status: 409 });
    }
    throw new ChannelError('GMAIL_ERROR', `Gmail respondió ${response.status}: ${providerErrorMessage(response)}`, { channel: 'email', status: 502 });
  }
  return { access, response };
}

function decodeBase64Url(data) {
  try {
    return Buffer.from(String(data || ''), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function headerMap(payload) {
  const map = {};
  for (const header of Array.isArray(payload?.headers) ? payload.headers : []) {
    if (header && header.name) map[String(header.name).toLowerCase()] = String(header.value || '');
  }
  return map;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    const raw = decodeBase64Url(payload.body.data);
    return payload.mimeType === 'text/html' ? stripHtml(raw) : raw;
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const plain = [];
  const html = [];
  for (const part of parts) {
    const mime = String(part.mimeType || '');
    if (mime.startsWith('multipart/')) {
      const nested = extractBody(part);
      if (nested) plain.push(nested);
      continue;
    }
    if (!part.body?.data) continue;
    if (mime === 'text/plain') plain.push(decodeBase64Url(part.body.data));
    else if (mime === 'text/html') html.push(stripHtml(decodeBase64Url(part.body.data)));
  }
  if (plain.length) return plain.join('\n').trim();
  if (html.length) return html.join('\n').trim();
  return '';
}

/**
 * Elimina la parte citada del correo (historial) para no reinyectar contexto.
 * @param {string} text
 */
export function stripQuotedReply(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/i.test(line)) break;
    if (/^-{2,}\s*(Original Message|Mensaje original)\s*-{2,}/i.test(line)) break;
    if (/^\s*_{5,}\s*$/.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function encodeSubject(value) {
  const subject = sanitizeText(value || 'Agenda Copilot', 200) || 'Agenda Copilot';
  return /[^\x00-\x7F]/.test(subject) ? `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=` : subject;
}

function buildRawEmail({ to, subject, body, inReplyTo, references }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'X-Agenda-Copilot: auto-reply'
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('', String(body || ''));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

async function gmailSendMime({ accessToken, raw, threadId }) {
  // Gmail espera el mensaje RFC 5322 codificado en base64url.
  const payload = { raw: Buffer.from(String(raw), 'utf8').toString('base64url') };
  if (threadId) payload.threadId = threadId;
  const response = await requestJson(buildUrl(gmailApiBase(), '/users/me/messages/send'), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: payload,
    timeoutMs: 25_000,
    retries: 1,
    channel: 'email'
  });
  if (!response.ok) {
    throw new ChannelError('GMAIL_SEND_FAILED', `Gmail no envió el correo: ${providerErrorMessage(response)}`, { channel: 'email', status: 502 });
  }
  return { id: response.json?.id || null, threadId: response.json?.threadId || threadId || null };
}

/**
 * Acceso para envíos ricos/adjuntos: usa el token de lectura del canal o, si
 * no existe, una cuenta Google conectada con permiso de envío.
 */
async function sendAccess() {
  try {
    return await emailAccess();
  } catch (error) {
    if (error?.code !== 'CHANNEL_NOT_CONFIGURED') throw error;
  }
  const connections = Array.isArray(store.get().googleConnections) ? store.get().googleConnections : [];
  const connection = connections[0];
  if (!connection) {
    throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Gmail no está conectado: conecta una cuenta Google para enviar correo.', {
      channel: 'email', status: 409, details: { oauthStart: '/api/channels/email/oauth/start' }
    });
  }
  let token = decryptJSON(connection.token);
  if (!token?.access_token) throw new ChannelError('GOOGLE_RECONNECT', 'La cuenta Google necesita reconectarse.', { channel: 'email', status: 409 });
  if (!token.expires_at || token.expires_at < Date.now() + 60_000) token = await refreshGoogleToken(token);
  return { accessToken: token.access_token, token, kind: 'google-send', email: connection.email || null };
}

/**
 * Busca el hilo de Gmail de un correo leído por IMAP usando su Message-ID.
 * Devuelve `threadId` o null si no hay coincidencia.
 */
export async function gmailThreadIdForMessage(accessToken, messageIdHeader, { timeoutMs = 15_000 } = {}) {
  const rfcId = String(messageIdHeader || '').trim();
  if (!accessToken || !rfcId) return null;
  const response = await requestJson(
    buildUrl(gmailApiBase(), '/users/me/messages', { q: `rfc822msgid:${rfcId}`, maxResults: 1 }),
    {
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs,
      retries: 1,
      idempotent: true
    }
  );
  if (!response?.ok) throw new Error(`Gmail no respondió al buscar el hilo (${response?.status || 'sin estado'}).`);
  return response?.json?.messages?.[0]?.threadId || null;
}

async function gmailSendRaw({ accessToken, to, subject, body, threadId, inReplyTo, references }) {
  const payload = { raw: buildRawEmail({ to, subject, body, inReplyTo, references }) };
  if (threadId) payload.threadId = threadId;
  const response = await requestJson(buildUrl(gmailApiBase(), '/users/me/messages/send'), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: payload,
    timeoutMs: 20_000,
    retries: 1,
    channel: 'email'
  });
  if (!response.ok) {
    throw new ChannelError('GMAIL_SEND_FAILED', `Gmail no envió el correo: ${providerErrorMessage(response)}`, { channel: 'email', status: 502 });
  }
  return { id: response.json?.id || null, threadId: response.json?.threadId || threadId || null };
}

export function createEmailAdapter() {
  let onMessage = null;
  let timer = null;
  let started = false;
  let stopped = false;
  let polling = false;
  let lastPollAt = null;

  function section() {
    return getChannelSection('email');
  }

  function status() {
    const config = emailConfig();
    const readerMeta = encryptedTokenMeta('email');
    const google = googleReaderCandidate();
    const configured = !!readerMeta || !!google;
    const enabled = emailEnabled();
    const to = emailTo();
    const client = googleClient();
    const allowFrom = allowFromList();
    const warnings = [];
    if (!client.id || !client.secret) warnings.push('Sin google.clientId/clientSecret no se puede conectar Gmail para lectura (la salida con la cuenta Google existente sigue funcionando).');
    if (client.id && client.secret && !baseOrigin()) warnings.push('Sin APP_URL/«URL pública para OAuth»: Google no podrá redirigir al callback de Gmail.');
    if (enabled && !configured) warnings.push('Canal activo pero Gmail sin permiso de lectura: no llegará correo nuevo.');
    if (!to) warnings.push('Sin correo de notificaciones: no hay destinatario por defecto.');
    if (!configured) warnings.push('Sin permiso de lectura de Gmail: conecta la cuenta para recibir órdenes por correo.');
    if (configured && enabled && !allowFrom.length) warnings.push('Sin remitentes autorizados: no se procesará ningún correo entrante (guarda «Remitentes autorizados»).');
    if (section().lastError) warnings.push(`Último error: ${section().lastError.message}`);
    const detail = !configured
      ? 'Sin lectura de Gmail. La salida funciona con la cuenta Google conectada; conecta Gmail para recibir correo.'
      : !enabled
        ? 'Credenciales listas. Activa el canal para revisar el correo entrante.'
        : `Activo: revisa Gmail cada ${config.pollIntervalMin || 5} min y responde en el mismo hilo.`;

    return {
      id: 'email',
      label: 'Correo (Gmail)',
      kind: 'email',
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
        inboundUrl: null,
        webhookUrl: null,
        account: section().account || config.account || google?.connection?.email || null,
        readerConnected: !!readerMeta,
        readerHint: readerMeta?.hint || null,
        readerUpdatedAt: readerMeta?.updatedAt || null,
        googleConnection: google?.connection?.email || null,
        googleClientConfigured: !!(client.id && client.secret),
        oauthStart: '/api/channels/email/oauth/start',
        redirectUri: (() => { try { return redirectUri(); } catch { return null; } })(),
        pollIntervalMin: Number(config.pollIntervalMin) || 5,
        allowFrom,
        defaultTo: to ? maskEmail(to) : null,
        replyEnabled: config.replyEnabled !== false,
        markRead: config.markRead !== false,
        polling: { active: !!timer, running: polling, lastPollAt: lastPollAt || section().lastPollAt || null },
        seenMessages: Object.keys(section().seen || {}).length,
        lastError: plainClone(section().lastError),
        lastInboundAt: section().lastInboundAt || null,
        lastOutboundAt: section().lastOutboundAt || null,
        stats: { ...(section().stats || {}) }
      },
      stats: { ...(section().stats || {}) },
      lastError: plainClone(section().lastError),
      webhookUrl: null
    };
  }

  function allowFromList() {
    const configured = Array.isArray(emailConfig().allowFrom) ? emailConfig().allowFrom.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [];
    const fallback = String(emailTo() || '').trim().toLowerCase();
    if (fallback && !configured.includes(fallback)) return [fallback, ...configured];
    return configured;
  }

  function maskEmail(value) {
    const [user, domain] = String(value || '').split('@');
    if (!user || !domain) return null;
    return `${user.slice(0, 2)}•••@${domain}`;
  }

  function isAllowedSender(address) {
    if (!address) return false;
    const allow = allowFromList();
    if (!allow.length) return false;
    return allow.includes(address.toLowerCase());
  }

  function isAutoReply(headers) {
    const autoSubmitted = String(headers['auto-submitted'] || '').toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') return true;
    const precedence = String(headers.precedence || '').toLowerCase();
    if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;
    if (String(headers['x-autoreply'] || headers['x-autorespond'] || '').length) return true;
    const subject = String(headers.subject || '');
    return /^(auto(matic)?[\s-]?reply|respuesta autom[áa]tica|out of office|fuera de la oficina)/i.test(subject);
  }

  async function oauthStartUrl(origin) {
    const client = googleClient();
    if (!client.id || !client.secret) {
      throw new ChannelError('GOOGLE_NOT_CONFIGURED', 'Faltan google.clientId / google.clientSecret. Guárdalos en Integraciones > Secretos (grupo Google) y vuelve a intentarlo.', {
        channel: 'email', status: 409, details: { instructions: INSTRUCTIONS }
      });
    }
    const state = `${crypto.randomBytes(24).toString('hex')}`;
    const uri = redirectUri(origin);
    await saveOAuthState(state, { redirectUri: uri, createdAt: Date.now() });
    const url = new URL(googleAuthBase());
    url.searchParams.set('client_id', client.id);
    url.searchParams.set('redirect_uri', uri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent select_account');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async function finishOAuth({ code, state, origin } = {}) {
    if (!code) throw new ChannelError('OAUTH_CODE_MISSING', 'Google no devolvió el código de autorización.', { channel: 'email', status: 400 });
    if (!state) throw new ChannelError('OAUTH_STATE_INVALID', 'Falta el state de OAuth.', { channel: 'email', status: 400 });
    const saved = consumeOAuthState(state);
    if (!saved) {
      throw new ChannelError('OAUTH_STATE_INVALID', 'El state de OAuth es inválido o caducó (10 min). Inicia la conexión de nuevo.', {
        channel: 'email', status: 400, details: { oauthStart: '/api/channels/email/oauth/start' }
      });
    }
    const client = googleClient();
    const uri = saved.redirectUri || redirectUri(origin);
    const response = await requestJson(googleTokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: uri,
        grant_type: 'authorization_code'
      }),
      timeoutMs: 20_000,
      retries: 0,
      channel: 'email'
    });
    if (!response.ok) {
      throw new ChannelError('GOOGLE_OAUTH_FAILED', `Google rechazó el código de autorización: ${providerErrorMessage(response)}`, { channel: 'email', status: 502 });
    }
    const token = response.json || {};
    const profile = await requestJson(googleUserinfoUrl(), {
      headers: { authorization: `Bearer ${token.access_token}` },
      timeoutMs: 15_000,
      retries: 1,
      idempotent: true,
      channel: 'email'
    }).catch(() => ({ ok: false, json: null }));
    const email = profile?.json?.email || null;
    const stored = {
      access_token: token.access_token,
      refresh_token: token.refresh_token || null,
      expires_at: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      scope: token.scope || SCOPES.join(' '),
      email,
      createdAt: new Date().toISOString()
    };
    await saveEncryptedToken('email', stored);
    await patchChannelConfig('email', { account: email, oauthConnectedAt: new Date().toISOString() });
    await updateChannelState((state) => {
      const channel = state.channels.email || (state.channels.email = {});
      channel.account = email;
      channel.oauthConnectedAt = new Date().toISOString();
    }, 'canal-email-cuenta');
    await deleteOAuthState(state);
    await clearChannelError('email');
    log('info', `Gmail conectado para lectura: ${email || 'cuenta sin correo visible'}`);
    return { ok: true, email, account: email };
  }

  async function profile() {
    const { access, response } = await gmailGet('/users/me/profile');
    return {
      emailAddress: response.json?.emailAddress || access.email || null,
      messagesTotal: response.json?.messagesTotal ?? null,
      threadsTotal: response.json?.threadsTotal ?? null
    };
  }

  async function markRead(messageId) {
    if (emailConfig().markRead === false) return { ok: false, skipped: true };
    try {
      const access = await emailAccess();
      const response = await requestJson(buildUrl(gmailApiBase(), `/users/me/messages/${encodeURIComponent(messageId)}/modify`), {
        method: 'POST',
        headers: { authorization: `Bearer ${access.accessToken}` },
        body: { removeLabelIds: ['UNREAD'] },
        timeoutMs: 15_000,
        retries: 1,
        channel: 'email'
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      log('warn', `Gmail: no se pudo marcar como leído (${describeError(error)}).`);
      return { ok: false };
    }
  }

  async function send({ to, text, meta = {}, message } = {}) {
    const body = sanitizeText(text, 20_000);
    const reply = meta.replyContext || message?.meta?.reply || null;
    const destination = emailAddress(to || reply?.fromEmail || emailTo());
    if (!destination) {
      throw new ChannelError('EMAIL_INVALID_RECIPIENT', 'Correo de destino inválido: guarda «Correo de notificaciones» o conecta una cuenta Google.', { channel: 'email' });
    }
    if (reply && emailConfig().replyEnabled === false) {
      return { skipped: true, reason: 'reply-disabled', via: 'email' };
    }
    const needsRich = !!meta.html || !!meta.replyTo || meta.forceMime === true;
    const subject = meta.subject
      || (reply?.subject ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : 'Agenda Copilot');
    const references = reply ? [reply.references, reply.messageIdHeader].filter(Boolean).join(' ').trim() : null;

    // Cuenta SMTP propia: envío real sin Google (prioridad si está configurada).
    if (hasAccounts() && (!reply || meta.accountId)) {
      const thread = meta.thread && typeof meta.thread === 'object' ? meta.thread : {};
      const sent = await sendWithAccount(meta.accountId || null, {
        to: destination,
        subject,
        text: body,
        html: meta.html || null,
        inReplyTo: thread.inReplyTo || null,
        references: thread.references || null,
        attachments: Array.isArray(meta.attachments) ? meta.attachments : []
      });
      return { id: sent.messageId, to: destination, via: 'smtp', account: sent.account };
    }

    // Correo con HTML/Reply-To: MIME multipart.
    if (needsRich) {
      const access = await sendAccess();
      const raw = buildMimeMessage({
        to: destination,
        subject,
        text: body,
        html: meta.html || null,
        replyTo: meta.replyTo || null,
        inReplyTo: reply?.messageIdHeader || null,
        references: references || null
      });
      const richThreadId = reply && !reply.threadId && reply.messageIdHeader
        ? await gmailThreadIdForMessage(access.accessToken, reply.messageIdHeader).catch(() => null)
        : reply?.threadId || null;
      const sent = await gmailSendMime({ accessToken: access.accessToken, raw, threadId: richThreadId });
      if (reply && sent.id) void markRead(sent.id).catch(() => {});
      return { id: sent.id, threadId: sent.threadId, to: destination, via: reply ? 'gmail-thread-rich' : 'gmail-rich' };
    }

    // Respuesta a un correo entrante: mismo hilo con el token del canal.
    if (reply && (reply.threadId || reply.messageIdHeader)) {
      const access = await emailAccess();
      const threadId = reply.threadId || (reply.messageIdHeader
        ? await gmailThreadIdForMessage(access.accessToken, reply.messageIdHeader).catch(() => null)
        : null);
      const sent = await gmailSendRaw({
        accessToken: access.accessToken,
        to: destination,
        subject,
        body,
        threadId,
        inReplyTo: reply.messageIdHeader || null,
        references: references || null
      });
      void markRead(sent.id).catch(() => {});
      return { id: sent.id, threadId: sent.threadId, to: destination, via: 'gmail-thread' };
    }

    // Salida general: se prefiere el sendGmail existente (cuenta Google conectada).
    if (Array.isArray(store.get().googleConnections) && store.get().googleConnections.length) {
      const result = await sendGmail({ to: destination, subject: meta.subject || 'Agenda Copilot', body });
      return { id: result?.id || null, to: destination, via: 'gmail' };
    }
    const access = await emailAccess();
    const sent = await gmailSendRaw({
      accessToken: access.accessToken,
      to: destination,
      subject: meta.subject || 'Agenda Copilot',
      body
    });
    return { id: sent.id, threadId: sent.threadId, to: destination, via: 'gmail-reader' };
  }

  async function sendDocument({ to, filename, buffer, mimeType = 'application/octet-stream', caption = '', subject = null } = {}) {
    const destination = emailAddress(to || emailTo());
    if (!destination) throw new ChannelError('EMAIL_INVALID_RECIPIENT', 'Correo de destino inválido.', { channel: 'email' });
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ChannelError('DOC_EMPTY', 'El documento no tiene contenido.', { channel: 'email' });
    const raw = buildMimeMessage({
      to: destination,
      subject: subject || `Documento: ${filename}`,
      text: caption || `Adjunto el documento ${filename}.`,
      attachments: [{ filename, mimeType, buffer }]
    });
    if (hasAccounts()) {
      const smtp = await sendWithAccount(null, {
        to: destination,
        subject: subject || `Documento: ${filename}`,
        text: caption || `Adjunto el documento ${filename}.`,
        attachments: [{ filename, mimeType, buffer }]
      });
      return { id: smtp.messageId, to: destination, via: 'smtp-attachment', filename, size: buffer.length, mimeType, account: smtp.account };
    }
    const access = await sendAccess();
    const sent = await gmailSendMime({ accessToken: access.accessToken, raw, threadId: null });
    return { id: sent.id, threadId: sent.threadId, to: destination, via: 'gmail-attachment', filename, size: buffer.length, mimeType };
  }

  async function test({ to, text } = {}) {
    const info = await profile();
    const destination = emailAddress(to || emailTo());
    if (!destination) {
      return {
        ok: true,
        channel: 'email',
        detail: `Gmail responde correctamente (${info.emailAddress || 'cuenta conectada'}). Guarda el correo de notificaciones para probar un envío.`,
        result: { credentials: true, sent: false, account: info.emailAddress }
      };
    }
    const sent = await send({ to: destination, text: text || '✅ Agenda Copilot: prueba de correo correcta.', meta: { subject: 'Prueba Agenda Copilot' } });
    return {
      ok: true,
      channel: 'email',
      detail: `Correo de prueba enviado a ${maskEmail(destination)}.`,
      result: { credentials: true, sent: true, messageId: sent.id, via: sent.via, account: info.emailAddress }
    };
  }

  async function poll() {
    if (!emailEnabled()) return { ok: false, skipped: true, reason: 'disabled' };
    if (polling) return { ok: false, skipped: true, reason: 'in-progress' };
    polling = true;
    let processed = 0;
    let ignored = 0;
    let scanned = 0;
    try {
      const max = Math.max(1, Math.min(Number(emailConfig().maxPerPoll) || 5, 10));
      const { response } = await gmailGet('/users/me/messages', { q: INBOX_QUERY, maxResults: max });
      const messages = Array.isArray(response.json?.messages) ? response.json.messages : [];
      scanned = messages.length;
      for (const reference of messages) {
        const messageId = String(reference?.id || '');
        if (!messageId) continue;
        if (emailSeen(messageId)) {
          await markRead(messageId).catch(() => {});
          continue;
        }
        let detail;
        try {
          const { response: full } = await gmailGet(`/users/me/messages/${encodeURIComponent(messageId)}`, { format: 'full' });
          detail = full.json;
        } catch (error) {
          log('warn', `Gmail: no se pudo leer ${messageId.slice(0, 8)}… (${describeError(error)}).`);
          ignored += 1;
          continue;
        }
        const payload = detail?.payload || {};
        const headers = headerMap(payload);
        const from = emailAddress(headers.from);
        const subject = sanitizeText(headers.subject || '(sin asunto)', 200);
        const ownAccount = String(section().account || '').toLowerCase();
        const base = {
          channel: 'email',
          userId: from || 'email',
          dedupeKey: `gmail:${messageId}`,
          id: `mail:${messageId}`,
          timestamp: detail?.internalDate
            ? new Date(Number(detail.internalDate)).toISOString()
            : (Number.isFinite(Date.parse(headers.date)) ? new Date(headers.date).toISOString() : new Date().toISOString()),
          meta: {
            emailId: messageId,
            threadId: detail?.threadId || null,
            subject,
            fromEmail: from,
            account: ownAccount || null
          },
          replyContext: {
            threadId: detail?.threadId || null,
            messageIdHeader: headers['message-id'] || null,
            references: headers.references || null,
            subject,
            fromEmail: from
          },
          source: 'email'
        };

        if (!from) {
          await markEmailSeen(messageId);
          ignored += 1;
          continue;
        }
        // Respuestas automáticas del propio canal (cabecera marcadora) y
        // autorespondedores: nunca se procesan (evita bucles de correo).
        if (/auto-reply/i.test(String(headers['x-agenda-copilot'] || ''))) {
          await markEmailSeen(messageId);
          if (emailConfig().markRead !== false) await markRead(messageId);
          ignored += 1;
          continue;
        }
        if (isAutoReply(headers)) {
          await markEmailSeen(messageId);
          await markRead(messageId).catch(() => {});
          ignored += 1;
          continue;
        }
        const rawBody = extractBody(payload) || detail?.snippet || '';
        const text = sanitizeText(stripQuotedReply(rawBody), 4000);
        if (!isAllowedSender(from)) {
          // Un intento de aprobación de un remitente no autorizado se deja pasar
          // al gate para rechazarlo y auditarlo.
          if (looksLikeApprovalResponse(text, subject) && typeof onMessage === 'function') {
            await onMessage({ ...base, text: text || 'ver', meta: { ...base.meta, approvalAttempt: true } });
            await markEmailSeen(messageId);
            if (emailConfig().markRead !== false) await markRead(messageId);
            processed += 1;
            continue;
          }
          await recordIgnored(makeMessage({ ...base, text: subject, status: 'skipped' }), 'remitente no autorizado');
          await markEmailSeen(messageId);
          if (emailConfig().markRead !== false) await markRead(messageId);
          ignored += 1;
          continue;
        }
        if (!text) {
          await markEmailSeen(messageId);
          ignored += 1;
          continue;
        }
        if (typeof onMessage !== 'function') {
          ignored += 1;
          continue;
        }
        await onMessage({ ...base, text });
        await markEmailSeen(messageId);
        if (emailConfig().markRead !== false) await markRead(messageId);
        processed += 1;
      }
      lastPollAt = new Date().toISOString();
      await patchChannelConfig('email', { lastPollAt });
      await clearChannelError('email');
      return { ok: true, scanned, processed, ignored, at: lastPollAt };
    } catch (error) {
      await setChannelError('email', error, { source: 'polling' });
      throw error;
    } finally {
      polling = false;
    }
  }

  async function configure(body) {
    const result = await applyConfigFields({
      channel: 'email', fields: CONFIG_FIELDS, body, settings: emailConfig()
    });
    if (Object.keys(result.settingsPatch).length) {
      await patchChannelConfig('email', result.settingsPatch);
    }
    await clearChannelError('email').catch(() => {});
    if (emailEnabled()) schedule(0);
    return {
      ok: true,
      changed: result.changed,
      cleared: result.cleared,
      detail: emailEnabled()
        ? 'Configuración guardada y aplicada sin reiniciar.'
        : 'Configuración guardada. Activa el canal para revisar el correo entrante.'
    };
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    if (stopped) return;
    if (!emailEnabled()) { schedule(30_000); return; }
    const intervalMin = Math.max(1, Math.min(Number(emailConfig().pollIntervalMin) || 5, 60));
    const last = Date.parse(lastPollAt || section().lastPollAt || '');
    if (Number.isFinite(last) && Date.now() - last < intervalMin * 60_000) {
      schedule(15_000);
      return;
    }
    try {
      await poll();
    } catch (error) {
      log('warn', `Gmail: revisión fallida (${describeError(error)}).`);
    }
    schedule(30_000);
  }

  function start({ onMessage: handler } = {}) {
    if (typeof handler === 'function') onMessage = handler;
    started = true;
    stopped = false;
    schedule(0);
  }

  function stop() {
    stopped = true;
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    id: 'email',
    label: 'Correo (Gmail)',
    kind: 'email',
    alwaysAvailable: false,
    capabilities: CAPABILITIES,
    configFields: CONFIG_FIELDS,
    instructions: INSTRUCTIONS,
    status,
    configure,
    test,
    send,
    sendDocument,
    start,
    stop,
    poll,
    profile,
    oauthStartUrl,
    finishOAuth,
    setDispatcher(handler) { onMessage = handler; },
    get started() { return started; }
  };
}






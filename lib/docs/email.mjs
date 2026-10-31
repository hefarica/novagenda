/**
 * Envío de un documento como adjunto de correo mediante la API de Gmail.
 *
 * - Construye un MIME `multipart/mixed` real (texto + adjunto base64).
 * - Usa la cuenta Google ya conectada (`googleConnections`) con permiso
 *   `gmail.send`, o el token de lectura/escritura del canal de correo
 *   (`channelState.channels.email.token`).
 * - Si no hay cuenta conectada devuelve `503 EMAIL_NOT_CONFIGURED`; si Gmail
 *   rechaza el envío devuelve `502 EMAIL_SEND_FAILED`. **Nunca** se responde
 *   `sent: true` sin un `messageId` real de Gmail.
 * - El documento sigue estando disponible para descarga después del intento.
 */
import crypto from 'node:crypto';
import { HttpError } from '../http/errors.mjs';
import { store, decryptJSON, encryptJSON, addActivity } from '../store.mjs';

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const NETWORK_TIMEOUT_MS = 25_000;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

function sanitizeHeader(value, max = 400) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function encodeSubject(value) {
  const subject = sanitizeHeader(value, 200);
  if (!/[^\x20-\x7e]/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function asciiFilename(filename) {
  return String(filename || 'documento')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\\r\n]/g, '_')
    .slice(0, 180) || 'documento';
}

function rfc5987(value) {
  return encodeURIComponent(String(value || 'documento')).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base64Lines(buffer, width = 76) {
  const encoded = Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(String(buffer), 'utf8').toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += width) lines.push(encoded.slice(index, index + width));
  return lines.join('\r\n');
}

function normalizeBody(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').split('\n').join('\r\n');
}

/**
 * Construye el mensaje MIME completo (exportado para pruebas).
 * @param {{to:string|string[], subject:string, body:string, from?:string, date?:Date, attachment:{filename:string, mimeType:string, data:Buffer}}} input
 * @returns {string}
 */
export function buildMimeMessage(input) {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to]).map((email) => sanitizeHeader(email, 254)).filter(Boolean);
  if (!recipients.length) throw new Error('El mensaje necesita al menos un destinatario.');
  const attachment = input.attachment || {};
  const data = Buffer.isBuffer(attachment.data) ? attachment.data : Buffer.from(attachment.data || '');
  if (!data.length) throw new Error('El adjunto está vacío.');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('El adjunto supera el máximo permitido.');
  const boundary = `=_agenda_${crypto.randomBytes(12).toString('hex')}`;
  const filename = sanitizeHeader(attachment.filename || 'documento', 180);
  const mimeType = sanitizeHeader(attachment.mimeType || 'application/octet-stream', 150);
  const lines = [];
  if (input.from) lines.push(`From: ${sanitizeHeader(input.from, 254)}`);
  lines.push(`To: ${recipients.join(', ')}`);
  lines.push(`Subject: ${encodeSubject(input.subject)}`);
  lines.push(`Date: ${(input.date instanceof Date ? input.date : new Date()).toUTCString()}`);
  lines.push(`Message-ID: <${crypto.randomUUID()}@agenda-copilot.local>`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push('Este es un mensaje multipart en formato MIME.');
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(base64Lines(normalizeBody(input.body)));
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: ${mimeType}; name="${asciiFilename(filename)}"`);
  lines.push(`Content-Disposition: attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${rfc5987(filename)}`);
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(base64Lines(data));
  lines.push('');
  lines.push(`--${boundary}--`);
  lines.push('');
  return lines.join('\r\n');
}

function hasSendScope(scope) {
  if (!scope) return true;
  const scopes = String(scope).split(/\s+/);
  return scopes.includes('https://www.googleapis.com/auth/gmail.send')
    || scopes.includes('https://www.googleapis.com/auth/gmail.modify')
    || scopes.includes('https://mail.google.com/');
}

function safeDecrypt(box) {
  try {
    const value = decryptJSON(box);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reúne los tokens de Gmail disponibles.
 * @param {any} data
 * @param {string} [connectionId]
 */
function tokenCandidates(data, connectionId) {
  const requested = String(connectionId || '').trim();
  const candidates = [];
  const googleConnections = Array.isArray(data.googleConnections) ? data.googleConnections : [];
  for (const connection of googleConnections) {
    if (requested && requested !== 'email' && connection.id !== requested) continue;
    if (requested === 'email') continue;
    const token = safeDecrypt(connection.token);
    if (!token || !token.access_token) continue;
    if (!hasSendScope(token.scope)) continue;
    candidates.push({
      kind: 'google',
      connectionId: connection.id,
      email: connection.email || '',
      token,
      source: 'googleConnections'
    });
  }
  if (!requested || requested === 'email') {
    const channel = data.channelState?.channels?.email;
    if (channel && channel.token) {
      const token = safeDecrypt(channel.token);
      if (token && token.access_token) {
        candidates.push({
          kind: 'reader',
          connectionId: 'email',
          email: token.email || channel.account || '',
          token,
          source: 'channelState.email'
        });
      }
    }
  }
  return candidates;
}

function notConfigured(message, details = {}) {
  return new HttpError(503, 'EMAIL_NOT_CONFIGURED', message, {
    details: {
      hint: 'Conecta una cuenta Google con permiso gmail.send (o el canal de correo) y vuelve a intentarlo.',
      ...details
    }
  });
}

async function persistRefreshedToken(candidate, token) {
  try {
    await store.mutate((data) => {
      if (candidate.kind === 'google') {
        const target = (data.googleConnections || []).find((connection) => connection.id === candidate.connectionId);
        if (target) {
          target.token = encryptJSON(token);
          target.reconnectRequired = false;
        }
        return;
      }
      if (!data.channelState) data.channelState = { version: 1, channels: {} };
      if (!data.channelState.channels) data.channelState.channels = {};
      if (!data.channelState.channels.email) data.channelState.channels.email = { stats: {} };
      data.channelState.channels.email.token = encryptJSON(token);
    });
  } catch {
    // Si el store es de solo lectura el envío puede continuar con el token en memoria.
  }
}

async function refreshAccess(candidate, { force = false } = {}) {
  let token = { ...candidate.token };
  if (!force && token.expires_at && Number(token.expires_at) > Date.now() + 60_000 && token.access_token) {
    return { token, accessToken: token.access_token };
  }
  if (!token.refresh_token) {
    throw notConfigured(`La cuenta de Gmail ${candidate.email || ''} necesita reconectarse (sin refresh token).`.trim(), {
      reason: 'no_refresh_token',
      connectionId: candidate.connectionId
    });
  }
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw notConfigured('Falta GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET para refrescar el token de Gmail.', {
      reason: 'oauth_not_configured'
    });
  }
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: token.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token'
      }),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
    });
  } catch (error) {
    throw new HttpError(502, 'EMAIL_SEND_FAILED', `No se pudo contactar Google para refrescar el token: ${error.message}`);
  }
  const text = await response.text().catch(() => '');
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!response.ok || !json.access_token) {
    throw new HttpError(502, 'EMAIL_SEND_FAILED', `Google no refrescó el token (${response.status}): ${json.error_description || json.error || 'respuesta inválida'}`);
  }
  token = {
    ...token,
    access_token: json.access_token,
    expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || token.scope,
    refresh_token: token.refresh_token
  };
  await persistRefreshedToken(candidate, token);
  return { token, accessToken: token.access_token };
}

async function gmailSend(accessToken, raw) {
  let response;
  try {
    response = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
    });
  } catch (error) {
    throw new HttpError(502, 'EMAIL_SEND_FAILED', `No se pudo contactar Gmail: ${error.message}`);
  }
  const text = await response.text().catch(() => '');
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  return { response, json };
}

/**
 * Envía un documento por correo con adjunto MIME.
 * @param {{document:{id:string, filename:string, mimeType:string, buffer:Buffer}, to:string[], subject:string, body:string, connectionId?:string, now?:Date}} input
 * @returns {Promise<any>}
 */
export async function sendDocumentEmail(input) {
  const document = input.document || {};
  if (!Buffer.isBuffer(document.buffer) || !document.buffer.length) {
    throw new HttpError(400, 'VALIDATION', 'El documento no tiene contenido para adjuntar.', { field: 'id' });
  }
  const to = Array.isArray(input.to) ? input.to : [input.to];
  if (!to.length) throw new HttpError(400, 'VALIDATION', 'Indica al menos un destinatario.', { field: 'to' });
  const data = store.get();
  const requested = String(input.connectionId || '').trim();
  const candidates = tokenCandidates(data, requested);
  if (!candidates.length) {
    if (requested && requested !== 'email') {
      const exists = (data.googleConnections || []).some((connection) => connection.id === requested);
      if (exists) {
        throw notConfigured('La cuenta Google conectada no tiene permiso gmail.send (o su token no es legible).', {
          reason: 'gmail_send_scope_missing',
          connectionId: requested
        });
      }
      throw new HttpError(404, 'EMAIL_CONNECTION_NOT_FOUND', `No existe la conexión Google "${requested}".`, { field: 'connectionId' });
    }
    throw notConfigured('No hay una cuenta de Gmail conectada en Agenda Copilot.', { reason: 'no_gmail_connection' });
  }
  const candidate = candidates[0];
  let access = await refreshAccess(candidate);
  const now = input.now instanceof Date ? input.now : new Date();
  const mime = buildMimeMessage({
    to,
    subject: input.subject,
    body: input.body,
    from: candidate.email || undefined,
    date: now,
    attachment: {
      filename: document.filename || 'documento',
      mimeType: document.mimeType || 'application/octet-stream',
      data: document.buffer
    }
  });
  const raw = Buffer.from(mime, 'utf8').toString('base64url');
  let { response, json } = await gmailSend(access.accessToken, raw);
  if (response.status === 401) {
    access = await refreshAccess(candidate, { force: true });
    ({ response, json } = await gmailSend(access.accessToken, raw));
  }
  if (!response.ok) {
    const providerMessage = json?.error?.message || json?.error_description || json?.error || `HTTP ${response.status}`;
    throw new HttpError(502, 'EMAIL_SEND_FAILED', `Gmail rechazó el envío (${response.status}): ${String(providerMessage).slice(0, 300)}`, {
      details: { status: response.status, connectionId: candidate.connectionId }
    });
  }
  const messageId = json.id || json.messageId || null;
  if (!messageId) {
    throw new HttpError(502, 'EMAIL_SEND_FAILED', 'Gmail no devolvió un identificador de mensaje; no se puede confirmar el envío.');
  }
  try {
    await store.mutate(() => {
      addActivity('email', `Documento enviado a ${to.join(', ')}: ${input.subject}`);
    });
  } catch {
    // La actividad es informativa; no invalida un envío confirmado.
  }
  return {
    sent: true,
    transport: 'gmail',
    messageId,
    threadId: json.threadId || null,
    from: candidate.email || null,
    to,
    subject: sanitizeHeader(input.subject, 200),
    sentAt: now.toISOString(),
    connectionId: candidate.connectionId,
    attachment: {
      filename: document.filename || 'documento',
      mimeType: document.mimeType || 'application/octet-stream',
      bytes: document.buffer.length
    }
  };
}

export default { buildMimeMessage, sendDocumentEmail };

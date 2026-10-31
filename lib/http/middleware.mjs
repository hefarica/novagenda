/**
 * Middlewares transversales: request-id, origen (CSRF), local-only y secretos
 * de webhooks. Todos los helpers respetan la redacción de secretos.
 */
import crypto from 'node:crypto';
import { HttpError } from './errors.mjs';
import { hostConfig, peerIsLoopback } from '../security/session.mjs';
import { getSecret } from '../security/vault.mjs';
import { safeEqual, verifyHmacSha256 } from '../security/compare.mjs';

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function ensureRequestId(req) {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

/**
 * IP para logs. No se usa para decisiones de seguridad (eso es el socket).
 * @param {import('node:http').IncomingMessage} req
 */
export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || '');
}

/**
 * Solo verdadero si el socket es loopback y no viene proxied desde una IP
 * externa (evita que un proxy inverso exponga rutas local-only).
 * @param {import('node:http').IncomingMessage} req
 */
export function isLoopbackPeer(req) {
  if (!peerIsLoopback(req)) return false;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!forwarded) return true;
  return forwarded === '::1' || forwarded === '::ffff:127.0.0.1' || forwarded.startsWith('127.');
}

/**
 * Bloquea peticiones mutantes con `Origin` de otro host (defensa CSRF extra
 * además de SameSite=Strict).
 * @param {import('node:http').IncomingMessage} req
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(String(origin)).host.toLowerCase();
  } catch {
    throw new HttpError(403, 'BAD_ORIGIN', 'Cabecera Origin inválida.');
  }
  const requestHost = String(req.headers.host || '').toLowerCase();
  if (originHost === requestHost) return;
  const appUrl = String(process.env.APP_URL || '').trim();
  if (appUrl) {
    try {
      if (new URL(appUrl).host.toLowerCase() === originHost) return;
    } catch { /* APP_URL inválida: se ignora */ }
  }
  throw new HttpError(403, 'BAD_ORIGIN', 'Origen cruzado bloqueado.');
}

/** ¿Los webhooks deben exigir secreto sí o sí? */
export function webhookStrictMode() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' || hostConfig().required;
}

/**
 * Exige que el secreto esté configurado en modo estricto.
 * @param {string} secretName
 * @param {string} envLabel
 * @returns {string|null} secreto o null (solo en modo local permisivo)
 */
export function requireWebhookSecret(secretName, envLabel) {
  const secret = getSecret(secretName);
  if (secret) return secret;
  if (webhookStrictMode()) {
    throw new HttpError(503, 'WEBHOOK_SECRET_MISSING', `Falta configurar ${envLabel}; el webhook está deshabilitado hasta entonces.`);
  }
  return null;
}

/**
 * Verifica el token secreto de Telegram.
 * @param {import('node:http').IncomingMessage} req
 * @param {{log?:{warn:(m?:unknown)=>void}}} [ctx]
 */
export function verifyTelegramWebhook(req, ctx) {
  const secret = requireWebhookSecret('channels.telegram.webhookSecret', 'TELEGRAM_WEBHOOK_SECRET');
  if (!secret) {
    ctx?.log?.warn('Webhook Telegram sin secreto configurado (permitido solo en modo local).');
    return { verified: false };
  }
  const provided = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!provided || !safeEqual(provided, secret)) {
    throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Token secreto de Telegram inválido.');
  }
  return { verified: true };
}

/**
 * Verifica `x-hub-signature-256` de WhatsApp Cloud API.
 * @param {import('node:http').IncomingMessage} req
 * @param {Buffer} rawBody
 * @param {{log?:{warn:(m?:unknown)=>void}}} [ctx]
 */
export function verifyWhatsAppWebhook(req, rawBody, ctx) {
  const secret = requireWebhookSecret('channels.whatsapp.appSecret', 'WA_APP_SECRET');
  if (!secret) {
    ctx?.log?.warn('Webhook WhatsApp sin WA_APP_SECRET (permitido solo en modo local).');
    return { verified: false };
  }
  const header = String(req.headers['x-hub-signature-256'] || '');
  if (!verifyHmacSha256(rawBody, header, secret)) {
    throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Firma de WhatsApp inválida.');
  }
  return { verified: true };
}

/**
 * Verificación del handshake GET de WhatsApp (`hub.verify_token`).
 * @param {string|null} provided
 */
export function verifyWhatsAppHandshake(provided) {
  const expected = getSecret('channels.whatsapp.verifyToken');
  if (!expected) {
    if (webhookStrictMode()) throw new HttpError(503, 'WEBHOOK_SECRET_MISSING', 'Falta configurar WA_VERIFY_TOKEN.');
    return false;
  }
  return safeEqual(String(provided || ''), expected);
}

/**
 * Webhook genérico: `Authorization: Bearer <WEBHOOK_SECRET>` o `X-Webhook-Secret`.
 * @param {import('node:http').IncomingMessage} req
 * @param {{log?:{warn:(m?:unknown)=>void}}} [ctx]
 */
export function verifyGenericWebhook(req, ctx) {
  const secret = requireWebhookSecret('webhooks.generic.secret', 'WEBHOOK_SECRET');
  if (!secret) {
    ctx?.log?.warn('Webhook genérico sin secreto configurado (permitido solo en modo local).');
    return { verified: false };
  }
  const authorization = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
  const provided = bearer || String(req.headers['x-webhook-secret'] || '');
  if (!provided || !safeEqual(provided.trim(), secret)) {
    throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Secreto de webhook inválido.');
  }
  return { verified: true };
}

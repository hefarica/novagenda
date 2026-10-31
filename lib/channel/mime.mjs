/**
 * Construcción de mensajes MIME para el canal de correo.
 *
 * Sin dependencias: genera el mensaje RFC 5322/MIME que Gmail acepta en
 * `users.messages.send` (raw base64url). Soporta:
 *   - texto plano,
 *   - alternativa text/plain + text/html (tarjetas de aprobación),
 *   - adjuntos en base64 (multipart/mixed),
 *   - cabeceras de hilo (In-Reply-To, References) y Reply-To.
 *
 * El nombre del adjunto se escribe con `filename*` (RFC 2231) cuando tiene
 * caracteres no ASCII, conservando un fallback ASCII para clientes antiguos.
 */
import crypto from 'node:crypto';

/** Quita CR/LF de valores de cabecera (anti header-injection). */
function headerValue(value) {
  return String(value ?? '').replace(/[\r\n\u0000]+/g, ' ').trim();
}

/**
 * Codifica una cabecera con caracteres no ASCII (RFC 2047).
 * @param {unknown} value
 */
export function encodeHeader(value) {
  const clean = headerValue(value);
  return /[^\x00-\x7F]/.test(clean) ? `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=` : clean;
}

/** Fallback ASCII para nombres de archivo. */
function asciiFilename(filename) {
  const base = String(filename || 'documento').replace(/[\\/:*?"<>|]+/g, '_');
  const ascii = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]+/g, '_');
  return ascii || 'documento';
}

/**
 * Base64 en líneas de 76 caracteres (RFC 2045).
 * @param {Buffer|string} value
 */
export function base64Lines(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** Escapa HTML (exportado para las tarjetas de aprobación). */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convierte texto plano sencillo en HTML mínimo (párrafos + enlaces).
 * @param {string} text
 */
export function textToHtml(text) {
  const linked = escapeHtml(text).replace(
    /\b(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#1f6feb">$1</a>'
  );
  return linked
    .split(/\r?\n\r?\n/)
    .map((block) => `<p style="margin:0 0 10px 0">${block.replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Envuelve HTML en un documento mínimo con estilo sobrio. */
export function htmlDocument(bodyHtml, { title = 'Agenda Copilot P95' } = {}) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#f5f6f8;font-family:Segoe UI,Arial,sans-serif;color:#1f2328">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #d8dee4;border-radius:10px;padding:20px 24px">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#57606a;margin-bottom:8px">${escapeHtml(title)}</div>
    ${bodyHtml}
  </div>
</body></html>`;
}

/**
 * @typedef {object} AttachmentInput
 * @property {string} filename
 * @property {string} [mimeType]
 * @property {Buffer} buffer
 */

/**
 * Construye un mensaje MIME completo.
 *
 * @param {{
 *   to: string|string[],
 *   subject?: string,
 *   text?: string,
 *   html?: string|null,
 *   attachments?: AttachmentInput[],
 *   replyTo?: string|null,
 *   inReplyTo?: string|null,
 *   references?: string|null,
 *   from?: string|null,
 *   marker?: boolean,
 *   extraHeaders?: Record<string,string>
 * }} input
 * @returns {string} mensaje MIME con CRLF
 */
export function buildMimeMessage(input = {}) {
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  const to = recipients.map(headerValue).filter(Boolean).join(', ');
  if (!to) throw new Error('Falta el destinatario del correo.');
  const text = String(input.text ?? '');
  const html = input.html ? String(input.html) : null;
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeHeader(input.subject || 'Agenda Copilot')}`,
    'MIME-Version: 1.0'
  ];
  if (input.from) headers.push(`From: ${headerValue(input.from)}`);
  if (input.replyTo) headers.push(`Reply-To: ${headerValue(input.replyTo)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${headerValue(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${headerValue(input.references)}`);
  if (input.marker !== false) headers.push('X-Agenda-Copilot: auto-reply');
  for (const [name, value] of Object.entries(input.extraHeaders || {})) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(name)) continue;
    headers.push(`${name}: ${headerValue(value)}`);
  }

  const bodyParts = [];
  if (html) {
    const altBoundary = `alt_${crypto.randomBytes(12).toString('hex')}`;
    bodyParts.push({
      type: 'multipart/alternative',
      boundary: altBoundary,
      content: [
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(text || ''),
        `--${altBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(html),
        `--${altBoundary}--`
      ].join('\r\n')
    });
  } else {
    bodyParts.push({
      type: 'text/plain; charset=UTF-8',
      content: ['Content-Transfer-Encoding: base64', '', base64Lines(text)].join('\r\n')
    });
  }

  if (attachments.length) {
    const mixedBoundary = `mix_${crypto.randomBytes(12).toString('hex')}`;
    const chunks = [];
    for (const attachment of attachments) {
      if (!attachment?.buffer) continue;
      const filename = headerValue(attachment.filename || 'documento');
      const mimeType = headerValue(attachment.mimeType || 'application/octet-stream');
      const lines = [
        `--${mixedBoundary}`,
        `Content-Type: ${mimeType}; name="${asciiFilename(filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        '',
        base64Lines(attachment.buffer)
      ];
      chunks.push(lines.join('\r\n'));
    }
    if (chunks.length) {
      // La primera parte es el cuerpo (alternative o text), luego adjuntos.
      const firstPart = [
        `--${mixedBoundary}`,
        bodyParts[0].type.startsWith('multipart/')
          ? `Content-Type: ${bodyParts[0].type}; boundary="${bodyParts[0].boundary}"`
          : `Content-Type: ${bodyParts[0].type}`,
        '',
        bodyParts[0].content
      ].join('\r\n');
      chunks.unshift(firstPart);
      headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
      return `${headers.join('\r\n')}\r\n\r\n${chunks.join('\r\n')}\r\n--${mixedBoundary}--\r\n`;
    }
  }

  headers.push(`Content-Type: ${bodyParts[0].type.startsWith('multipart/') ? `${bodyParts[0].type}; boundary="${bodyParts[0].boundary}"` : bodyParts[0].type}`);
  return `${headers.join('\r\n')}\r\n\r\n${bodyParts[0].content}\r\n`;
}

/**
 * Codifica el mensaje para Gmail (`raw` base64url).
 * @param {object} input mismo contrato que buildMimeMessage
 */
export function buildMimeRaw(input) {
  return Buffer.from(buildMimeMessage(input), 'utf8').toString('base64url');
}

export default { buildMimeMessage, buildMimeRaw, encodeHeader, textToHtml, htmlDocument, base64Lines, escapeHtml };

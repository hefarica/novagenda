/**
 * Cuentas SMTP propias: envío real de correo sin depender de Google.
 *
 * Sin dependencias: habla SMTP por `node:net`/`node:tls`.
 * - Puerto 465: TLS implícito.
 * - Puerto 587/25: STARTTLS obligatorio salvo `allowInsecure` (solo para
 *   servidores locales de prueba, nunca en producción).
 * - AUTH PLAIN o AUTH LOGIN según lo anuncie el servidor.
 * - Adjuntos vía MIME (mismo constructor que usa Gmail).
 *
 * La contraseña se guarda cifrada con el vault del store (AES-256-GCM) y
 * nunca se devuelve en las vistas públicas.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { decryptJSON, encryptJSON, nextId, store } from '../store.mjs';
import { ChannelError } from './http.mjs';
import { buildMimeMessage, encodeHeader } from './mime.mjs';

export const MAX_ACCOUNTS = 5;
const TIMEOUT_MS = 15_000;

function bad(field, message) {
  return new ChannelError('SMTP_INVALID', message, { field });
}

function cleanText(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text) throw bad(field, `Falta ${field}.`);
  if (text.length > max) throw bad(field, `${field} supera ${max} caracteres.`);
  if (/[\r\n\u0000]/.test(text)) throw bad(field, `${field} contiene caracteres inválidos.`);
  return text;
}

function emailAddress(value, field = 'fromEmail') {
  const text = String(value ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length > 254) throw bad(field, 'Correo inválido.');
  return text;
}

function normalizeAccount(input = {}, { requirePassword = true } = {}) {
  const host = cleanText(input.host, 'host', 253).toLowerCase();
  const port = Number(input.port ?? (input.secure === false ? 587 : 465));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('port', 'Puerto SMTP inválido.');
  const secure = input.secure !== false;
  const user = cleanText(input.user, 'user', 254);
  const password = input.password === undefined ? '' : String(input.password);
  if (requirePassword && !password.trim()) throw bad('password', 'Falta la contraseña o clave de aplicación.');
  if (password.length > 400) throw bad('password', 'La contraseña es demasiado larga.');
  const fromEmail = emailAddress(input.fromEmail || user, 'fromEmail');
  const fromName = input.fromName ? cleanText(input.fromName, 'fromName', 120) : '';
  const label = input.label ? cleanText(input.label, 'label', 80) : fromEmail;
  const allowInsecure = input.allowInsecure === true;
  if (allowInsecure && !/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) {
    throw bad('host', 'Sin cifrar solo se permite contra localhost (servidor de prueba).');
  }
  return {
    label, host, port, secure, user, password, fromEmail, fromName, allowInsecure,
    enabled: input.enabled !== false
  };
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    label: account.label,
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    fromEmail: account.fromEmail,
    fromName: account.fromName || '',
    allowInsecure: !!account.allowInsecure,
    enabled: account.enabled !== false,
    hasPassword: !!account.password,
    createdAt: account.createdAt || null,
    lastSendAt: account.lastSendAt || null,
    lastError: account.lastError || null
  };
}

export function listAccounts() {
  const data = store.get();
  return (Array.isArray(data.emailAccounts) ? data.emailAccounts : []).map(publicAccount);
}

export function accountById(id) {
  const data = store.get();
  return (data.emailAccounts || []).find((account) => account.id === id) || null;
}

export function defaultAccount() {
  const accounts = listAccounts().filter((account) => account.enabled);
  return accounts[0] || null;
}

export function hasAccounts() {
  return listAccounts().some((account) => account.enabled);
}

export async function createAccount(input = {}) {
  const normalized = normalizeAccount(input, { requirePassword: true });
  const password = encryptJSON({ password: normalized.password });
  return store.mutate((data) => {
    if (!Array.isArray(data.emailAccounts)) data.emailAccounts = [];
    if (data.emailAccounts.length >= MAX_ACCOUNTS) {
      throw new ChannelError('SMTP_LIMIT', `Máximo ${MAX_ACCOUNTS} cuentas SMTP.`);
    }
    if (data.emailAccounts.some((account) => account.fromEmail === normalized.fromEmail)) {
      throw new ChannelError('SMTP_DUPLICATE', 'Esa cuenta ya está registrada.');
    }
    const account = {
      id: nextId('MAIL', data.emailAccounts),
      label: normalized.label,
      host: normalized.host,
      port: normalized.port,
      secure: normalized.secure,
      user: normalized.user,
      fromEmail: normalized.fromEmail,
      fromName: normalized.fromName,
      allowInsecure: normalized.allowInsecure,
      enabled: normalized.enabled,
      password,
      createdAt: new Date().toISOString(),
      lastSendAt: null,
      lastError: null
    };
    data.emailAccounts.push(account);
    return publicAccount(account);
  });
}

export async function updateAccount(id, patch = {}) {
  return store.mutate((data) => {
    const account = (data.emailAccounts || []).find((item) => item.id === id);
    if (!account) throw new ChannelError('SMTP_NOT_FOUND', 'Cuenta SMTP no encontrada.', { status: 404 });
    const merged = {
      host: patch.host ?? account.host,
      port: patch.port ?? account.port,
      secure: patch.secure ?? account.secure,
      user: patch.user ?? account.user,
      fromEmail: patch.fromEmail ?? account.fromEmail,
      fromName: patch.fromName ?? account.fromName,
      allowInsecure: patch.allowInsecure ?? account.allowInsecure,
      label: patch.label ?? account.label,
      enabled: patch.enabled ?? account.enabled,
      password: patch.password === undefined ? undefined : String(patch.password)
    };
    const normalized = normalizeAccount(merged, { requirePassword: false });
    account.label = normalized.label;
    account.host = normalized.host;
    account.port = normalized.port;
    account.secure = normalized.secure;
    account.user = normalized.user;
    account.fromEmail = normalized.fromEmail;
    account.fromName = normalized.fromName;
    account.allowInsecure = normalized.allowInsecure;
    account.enabled = normalized.enabled;
    if (normalized.password) account.password = encryptJSON({ password: normalized.password });
    return publicAccount(account);
  });
}

export async function deleteAccount(id) {
  return store.mutate((data) => {
    const list = data.emailAccounts || [];
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) throw new ChannelError('SMTP_NOT_FOUND', 'Cuenta SMTP no encontrada.', { status: 404 });
    const [removed] = list.splice(index, 1);
    return publicAccount(removed);
  });
}

/* ------------------------------------------------------------------ */
/* Cliente SMTP                                                        */
/* ------------------------------------------------------------------ */

function fail(message, code = 'SMTP_ERROR') {
  return new ChannelError(code, message);
}

class Session {
  constructor(socket) {
    this.socket = socket;
    this.lines = [];
    this.pending = [];
    this.error = null;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Tiempo de espera SMTP agotado')));
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        if (this.pending.length) this.pending.shift().resolve(line);
        else this.lines.push(line);
      }
    });
    socket.on('error', (error) => this.abort(error));
    socket.on('close', () => this.abort(new Error('La conexión SMTP se cerró.')));
  }

  abort(error) {
    if (this.error) return;
    this.error = error;
    while (this.pending.length) this.pending.shift().reject(error);
  }

  readLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async readResponse() {
    const lines = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (line.length < 4 || line[3] !== '-') break;
    }
    const last = lines[lines.length - 1] || '';
    const code = Number(last.slice(0, 3));
    return { code, text: lines.join('\n') };
  }

  async command(line, expected = [250]) {
    this.socket.write(`${line}\r\n`);
    const response = await this.readResponse();
    if (!expected.includes(response.code)) {
      throw fail(`SMTP respondió ${response.code}: ${response.text.split('\n').slice(-1)[0]}`);
    }
    return response;
  }

  async data(message) {
    this.socket.write(`${message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.\r\n`);
    const response = await this.readResponse();
    if (response.code !== 250) throw fail(`SMTP rechazó el mensaje (${response.code}): ${response.text}`);
    return response;
  }

  close() {
    try { this.socket.write('QUIT\r\n'); } catch { /* ignorado */ }
    try { this.socket.destroy(); } catch { /* ignorado */ }
  }
}

function openSocket({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(fail('Tiempo de espera al conectar con el SMTP.')); }, TIMEOUT_MS);
    const done = (error) => { clearTimeout(timer); socket.off('error', done); if (error) reject(error); };
    socket.once('error', done);
    socket.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); socket.off('error', done); resolve(socket); });
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host }, () => resolve(secured));
    secured.once('error', reject);
  });
}

async function authenticate(session, account, capabilities, password) {
  const supported = capabilities.toUpperCase();
  if (/AUTH[^\n]*PLAIN/.test(supported) || !/AUTH/.test(supported)) {
    const token = Buffer.from(`\u0000${account.user}\u0000${password}`, 'utf8').toString('base64');
    return session.command(`AUTH PLAIN ${token}`, [235]);
  }
  if (/AUTH[^\n]*LOGIN/.test(supported)) {
    await session.command('AUTH LOGIN', [334]);
    await session.command(Buffer.from(account.user, 'utf8').toString('base64'), [334]);
    return session.command(Buffer.from(password, 'utf8').toString('base64'), [235]);
  }
  throw fail('El servidor SMTP no ofrece un método de autenticación compatible.', 'SMTP_AUTH_UNSUPPORTED');
}

/**
 * Envía un mensaje por SMTP.
 * @param {object} account cuenta ya descifrada (con password en claro)
 * @param {{to:string|string[], cc?:string[], subject?:string, text:string, html?:string|null,
 *          attachments?:Array<{filename:string,mimeType?:string,buffer:Buffer}>}} message
 */
export async function sendMail(account, message = {}) {
  if (!account) throw fail('Cuenta SMTP requerida.', 'SMTP_ACCOUNT_REQUIRED');
  const to = (Array.isArray(message.to) ? message.to : [message.to]).map((value) => String(value || '').trim()).filter(Boolean);
  if (!to.length) throw fail('Falta el destinatario.', 'SMTP_RECIPIENT_REQUIRED');
  for (const address of to) emailAddress(address, 'to');
  const cc = (Array.isArray(message.cc) ? message.cc : []).map((value) => String(value || '').trim()).filter(Boolean);
  const subject = cleanText(message.subject || 'Agenda Copilot', 'subject', 250);
  const text = String(message.text ?? '');
  const fromHeader = account.fromName
    ? `${encodeHeader(account.fromName)} <${account.fromEmail}>`
    : account.fromEmail;
  const domain = account.fromEmail.split('@')[1] || 'agenda.local';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const raw = buildMimeMessage({
    from: fromHeader,
    to,
    subject,
    text,
    html: message.html || null,
    inReplyTo: message.inReplyTo || null,
    references: message.references || null,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    extraHeaders: {
      Date: new Date().toUTCString(),
      'Message-ID': messageId
    }
  });

  let socket;
  let session;
  try {
    socket = await openSocket(account);
    session = new Session(socket);
    const greeting = await session.readResponse();
    if (greeting.code !== 220) throw fail(`El servidor SMTP no saludó correctamente (${greeting.code}).`);

    let ehlo = await session.command('EHLO agenda-copilot.local', [250]);
    if (!account.secure) {
      const plainCapabilities = ehlo.text;
      if (/STARTTLS/i.test(plainCapabilities)) {
        await session.command('STARTTLS', [220]);
        const secured = await upgradeTls(socket, account.host);
        session = new Session(secured);
        socket = secured;
        ehlo = await session.command('EHLO agenda-copilot.local', [250]);
      } else if (!account.allowInsecure) {
        throw fail('El servidor no ofrece STARTTLS; el envío se cancela para no mandar credenciales en claro.', 'SMTP_TLS_REQUIRED');
      }
    }

    const capabilities = ehlo.text;
    if (/AUTH/i.test(capabilities) || account.user) {
      await authenticate(session, account, capabilities, account.password);
    }

    await session.command(`MAIL FROM:<${account.fromEmail}>`, [250]);
    for (const address of [...to, ...cc]) {
      await session.command(`RCPT TO:<${address}>`, [250, 251]);
    }
    await session.command('DATA', [354]);
    await session.data(raw);
    session.close();
    return { messageId, accepted: [...to, ...cc], to, cc };
  } catch (error) {
    if (session) session.close();
    else if (socket) { try { socket.destroy(); } catch { /* ignorado */ } }
    if (error instanceof ChannelError) throw error;
    throw fail(`No pude enviar el correo: ${error.message}`, 'SMTP_SEND_FAILED');
  }
}

function accountForSending(id) {
  const data = store.get();
  const accounts = data.emailAccounts || [];
  const account = id
    ? accounts.find((item) => item.id === id)
    : accounts.find((item) => item.enabled !== false);
  if (!account) return null;
  if (!account.password) throw fail('La cuenta SMTP no tiene contraseña guardada.', 'SMTP_PASSWORD_MISSING');
  const { password } = decryptJSON(account.password);
  return { ...account, password };
}

/** Envía con la cuenta indicada (o la primera activa) y anota el resultado. */
export async function sendWithAccount(id, message) {
  const account = accountForSending(id);
  if (!account) throw fail('No hay ninguna cuenta SMTP configurada.', 'SMTP_NOT_CONFIGURED');
  try {
    const result = await sendMail(account, message);
    await store.mutate((data) => {
      const target = (data.emailAccounts || []).find((item) => item.id === account.id);
      if (target) {
        target.lastSendAt = new Date().toISOString();
        target.lastError = null;
      }
    });
    return { ...result, via: 'smtp', account: account.fromEmail, accountId: account.id };
  } catch (error) {
    await store.mutate((data) => {
      const target = (data.emailAccounts || []).find((item) => item.id === account.id);
      if (target) target.lastError = { at: new Date().toISOString(), message: String(error.message || error).slice(0, 300) };
    }).catch(() => {});
    throw error;
  }
}

/** Prueba de conexión + envío opcional a un destinatario. */
export async function testAccount(id, { to = null } = {}) {
  const account = accountForSending(id);
  if (!account) throw fail('No hay ninguna cuenta SMTP configurada.', 'SMTP_NOT_CONFIGURED');
  const destination = to || account.fromEmail;
  const result = await sendWithAccount(id, {
    to: destination,
    subject: 'Prueba de correo · Agenda Copilot',
    text: `Cuenta SMTP «${account.label}» funcionando.\n\nEste mensaje se envió desde la app sin pasar por Google.\n`
  });
  return { account: publicAccount(account), ...result };
}



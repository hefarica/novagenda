/**
 * Bandejas IMAP propias: lectura de correo de cualquier proveedor sin Google.
 *
 * Sin dependencias: IMAP4rev1 sobre TLS (`node:tls`).
 * - LOGIN con usuario/contraseña (clave de aplicación).
 * - SELECT INBOX y UID FETCH de los últimos mensajes o no leídos.
 * - Parser MIME mínimo: text/plain preferido, HTML como respaldo, base64 y
 *   quoted-printable, asunto RFC 2047, charset UTF-8/Latin-1/Windows-1252.
 *
 * Solo lectura: no borra, no marca como leído de forma irreversible (usa
 * BODY.PEEK) y no mueve mensajes. La contraseña se guarda cifrada.
 */
import fs from 'node:fs';
import tls from 'node:tls';
import { decryptJSON, encryptJSON, nextId, store } from '../store.mjs';
import { ChannelError } from './http.mjs';

const TIMEOUT_MS = 20_000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_BYTES = 2_000_000;

function bad(field, message) {
  return new ChannelError('IMAP_INVALID', message, { status: 400, details: { field } });
}

function clean(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text) throw bad(field, `Falta ${field}.`);
  if (text.length > max) throw bad(field, `${field} supera ${max} caracteres.`);
  if (/[\r\n\u0000]/.test(text)) throw bad(field, `${field} contiene caracteres inválidos.`);
  return text;
}

function email(value, field = 'email') {
  const text = String(value ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length > 254) throw bad(field, 'Correo inválido.');
  return text;
}

function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalize(input = {}, { requirePassword = true } = {}) {
  const host = clean(input.host, 'host', 253).toLowerCase();
  const port = Number(input.port ?? 993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('port', 'Puerto IMAP inválido.');
  if (input.secure === false) throw bad('secure', 'Por ahora IMAP exige TLS directo (993).');
  const user = clean(input.user, 'user', 254);
  const password = input.password === undefined ? '' : String(input.password);
  if (requirePassword && !password.trim()) throw bad('password', 'Falta la contraseña o clave de aplicación.');
  if (password.length > 400) throw bad('password', 'La contraseña es demasiado larga.');
  const address = email(input.email || user, 'email');
  return {
    label: input.label ? clean(input.label, 'label', 80) : address,
    host, port, secure: true, user, password, email: address
  };
}

function publicAccount(account) {
  return {
    id: account.id,
    label: account.label,
    host: account.host,
    port: account.port,
    secure: true,
    user: account.user,
    email: account.email,
    hasPassword: !!account.password,
    createdAt: account.createdAt || null,
    lastCheckAt: account.lastCheckAt || null,
    lastUid: account.lastUid || null,
    newCount: Number(account.newCount) || 0,
    autoDraft: account.autoDraft === true,
    lastError: account.lastError || null
  };
}

export function listImapAccounts() {
  const data = store.get();
  return (Array.isArray(data.imapAccounts) ? data.imapAccounts : []).map(publicAccount);
}

export function imapAccountById(id) {
  return (store.get().imapAccounts || []).find((account) => account.id === id) || null;
}

export async function createImapAccount(input = {}) {
  const normalized = normalize(input);
  const password = encryptJSON({ password: normalized.password });
  return store.mutate((data) => {
    if (!Array.isArray(data.imapAccounts)) data.imapAccounts = [];
    if (data.imapAccounts.length >= 5) throw new ChannelError('IMAP_LIMIT', 'Máximo 5 bandejas IMAP.', { status: 400 });
    if (data.imapAccounts.some((account) => account.email === normalized.email)) {
      throw new ChannelError('IMAP_DUPLICATE', 'Esa bandeja ya está registrada.', { status: 400 });
    }
    const account = {
      id: nextId('IMAP', data.imapAccounts),
      label: normalized.label,
      host: normalized.host,
      port: normalized.port,
      secure: true,
      user: normalized.user,
      email: normalized.email,
      password,
      createdAt: new Date().toISOString(),
      lastCheckAt: null,
      lastError: null
    };
    data.imapAccounts.push(account);
    return publicAccount(account);
  });
}

export async function deleteImapAccount(id) {
  return store.mutate((data) => {
    const list = data.imapAccounts || [];
    const index = list.findIndex((account) => account.id === id);
    if (index === -1) throw new ChannelError('IMAP_NOT_FOUND', 'Bandeja IMAP no encontrada.', { status: 404 });
    const [removed] = list.splice(index, 1);
    return publicAccount(removed);
  });
}

/* ------------------------------------------------------------------ */
/* Lector de respuestas con literales                                 */
/* ------------------------------------------------------------------ */

class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const waiters = this.waiters;
      this.waiters = [];
      for (const waiter of waiters) waiter();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('La conexión IMAP se cerró.')));
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async ensure(predicate) {
    const start = Date.now();
    while (!predicate()) {
      if (this.error) throw this.error;
      if (Date.now() - start > TIMEOUT_MS) throw new Error('Tiempo de espera IMAP agotado.');
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 250);
      });
    }
  }

  async readLine() {
    let index = -1;
    await this.ensure(() => {
      index = this.buffer.indexOf('\r\n');
      return index >= 0;
    });
    const line = this.buffer.subarray(0, index).toString('utf8');
    this.buffer = this.buffer.subarray(index + 2);
    return line;
  }

  async readBytes(length) {
    await this.ensure(() => this.buffer.length >= length);
    const chunk = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(chunk);
  }
}

function openSocket(account) {
  return new Promise((resolve, reject) => {
    const options = { host: account.host, port: account.port, servername: account.host };
    if (process.env.IMAP_CA_FILE) {
      try { options.ca = [fs.readFileSync(process.env.IMAP_CA_FILE)]; } catch { /* sin CA extra */ }
    }
    const socket = tls.connect(options);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Tiempo de espera al conectar con IMAP.')); }, TIMEOUT_MS);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket); });
  });
}

class Imap {
  constructor(socket) {
    this.socket = socket;
    this.reader = new Reader(socket);
    this.seq = 0;
  }

  async command(command) {
    this.seq += 1;
    const tag = `A${String(this.seq).padStart(3, '0')}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const lines = [];
    const literals = [];
    for (;;) {
      const line = await this.reader.readLine();
      lines.push(line);
      const marker = /\{(\d+)\}$/.exec(line);
      if (marker) {
        const data = await this.reader.readBytes(Number(marker[1]));
        literals.push(data);
        const rest = await this.reader.readLine();
        lines.push(rest);
      }
      if (line.startsWith(`${tag} `)) break;
    }
    const status = lines[lines.length - 1] || '';
    if (!/ OK/i.test(status)) {
      throw new ChannelError('IMAP_ERROR', `IMAP rechazó ${command.split(' ')[0]}: ${status.slice(0, 200)}`);
    }
    return { lines, literals };
  }

  async login(account, password) {
    await this.reader.readLine(); // * OK
    await this.command(`LOGIN ${quote(account.user)} ${quote(password)}`);
    await this.command('SELECT "INBOX"');
  }

  async search(uids) {
    const { lines } = await this.command('UID SEARCH ALL');
    const line = lines.find((entry) => /^\* SEARCH/i.test(entry)) || '';
    const all = line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number);
    return uids ? all : all;
  }

  async fetch(uid) {
    const { literals } = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    return literals[0] || null;
  }

  close() {
    try { this.socket.write('A999 LOGOUT\r\n'); } catch { /* ignorado */ }
    try { this.socket.destroy(); } catch { /* ignorado */ }
  }
}

/* ------------------------------------------------------------------ */
/* Parser MIME mínimo                                                  */
/* ------------------------------------------------------------------ */

function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBytes(buffer, encoding, charset) {
  let data = buffer;
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    const text = buffer.toString('ascii').replace(/\s+/g, '');
    try { data = Buffer.from(text, 'base64'); } catch { data = buffer; }
  } else if (enc === 'quoted-printable') {
    data = Buffer.from(decodeQuotedPrintable(buffer.toString('latin1')), 'latin1');
  }
  const label = String(charset || 'utf-8').toLowerCase();
  if (/^(iso-8859-1|latin1|latin-1)$/.test(label)) return data.toString('latin1');
  if (/^(windows-1252|cp1252)$/.test(label)) return data.toString('latin1');
  if (/^(us-ascii|ascii)$/.test(label)) return data.toString('ascii');
  return data.toString('utf8');
}

function decodeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, mode, data) => {
    try {
      const buffer = mode.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeQuotedPrintable(data.replace(/_/g, ' ')), 'latin1');
      return decodeBytes(buffer, null, charset);
    } catch {
      return data;
    }
  }).replace(/\s+/g, ' ').trim();
}

function splitHeaders(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const index = text.indexOf('\n\n');
  const head = index >= 0 ? text.slice(0, index) : text;
  const body = index >= 0 ? text.slice(index + 2) : '';
  const headers = {};
  let current = null;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (match) {
      current = match[1].toLowerCase();
      headers[current] = match[2];
    }
  }
  return { headers, body };
}

function contentType(value) {
  const text = String(value || 'text/plain');
  const [mime, ...params] = text.split(';');
  const out = { mime: mime.trim().toLowerCase(), charset: 'utf-8', boundary: null };
  for (const param of params) {
    const match = /^\s*([a-z0-9-]+)\s*=\s*"?([^";]+)"?/i.exec(param);
    if (!match) continue;
    if (match[1].toLowerCase() === 'charset') out.charset = match[2].trim();
    if (match[1].toLowerCase() === 'boundary') out.boundary = match[2].trim();
  }
  return out;
}

function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(raw) {
  const { headers, body } = splitHeaders(raw);
  const type = contentType(headers['content-type']);
  const encoding = headers['content-transfer-encoding'];
  if (type.mime.startsWith('multipart/') && type.boundary) {
    const parts = body.split(`--${type.boundary}`);
    const plains = [];
    const htmls = [];
    for (const part of parts) {
      if (!part.trim() || /^--/.test(part.trim())) continue;
      const parsed = extractBody(part.replace(/^\n/, ''));
      if (parsed.kind === 'html') htmls.push(parsed.html);
      else if (parsed.text) plains.push(parsed.text);
    }
    return {
      text: (plains.join('\n\n') || htmls.map(htmlToText).join('\n\n')).trim(),
      html: htmls.join('\n').trim() || null,
      kind: 'multipart'
    };
  }
  const decoded = decodeBytes(Buffer.from(body, 'utf8'), encoding, type.charset);
  if (type.mime === 'text/html') return { text: htmlToText(decoded), html: decoded, kind: 'html' };
  return { text: decoded.trim(), html: null, kind: 'plain' };
}

function parseAddress(value) {
  const text = decodeHeader(value);
  const match = /([^<]*?)\s*<([^>]+)>/.exec(text);
  if (match) return { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2].trim().toLowerCase() };
  return { name: '', email: text.trim().toLowerCase() };
}

export function parseMessage(buffer, uid = null) {
  const raw = buffer.toString('utf8');
  const { headers } = splitHeaders(raw);
  const body = extractBody(raw);
  const text = body.text || (body.html ? htmlToText(body.html) : '');
  return {
    uid,
    from: parseAddress(headers.from),
    to: decodeHeader(headers.to || ''),
    subject: decodeHeader(headers.subject || '(sin asunto)'),
    date: headers.date || null,
    messageId: headers['message-id'] || null,
    references: headers.references ? decodeHeader(headers.references) : null,
    text: text.slice(0, 20_000),
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 180),
    hasHtml: !!body.html
  };
}

function accountFor(id) {
  const account = imapAccountById(id);
  if (!account) throw new ChannelError('IMAP_NOT_FOUND', 'Bandeja IMAP no encontrada.', { status: 404 });
  if (!account.password) throw new ChannelError('IMAP_PASSWORD_MISSING', 'La bandeja no tiene contraseña guardada.');
  const { password } = decryptJSON(account.password);
  return { ...account, password };
}

async function run(account, fn) {
  let client = null;
  let socket = null;
  try {
    socket = await openSocket(account);
    client = new Imap(socket);
    await client.login(account, account.password);
    return await fn(client);
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError('IMAP_FAILED', `No pude leer la bandeja: ${error.message}`);
  } finally {
    if (client) client.close();
    else if (socket) { try { socket.destroy(); } catch { /* ignorado */ } }
  }
}

/** Prueba de conexión: devuelve el asunto del mensaje más reciente. */
export async function testImapAccount(id) {
  const account = accountFor(id);
  const result = await run(account, async (client) => {
    const uids = await client.search();
    const last = uids.slice(-1)[0];
    const raw = last ? await client.fetch(last) : null;
    return { messages: uids.length, last: raw ? parseMessage(raw, last) : null };
  });
  await store.mutate((data) => {
    const target = (data.imapAccounts || []).find((item) => item.id === account.id);
    if (target) {
      target.lastCheckAt = new Date().toISOString();
      target.lastError = null;
    }
  }).catch(() => {});
  return {
    account: publicAccount(account),
    messages: result.messages,
    lastSubject: result.last?.subject || null,
    lastFrom: result.last?.from?.email || null
  };
}

/** Últimos mensajes de la bandeja (solo lectura). */
export async function fetchImapMessages(id, { limit = 5 } = {}) {
  const account = accountFor(id);
  const count = Math.max(1, Math.min(Number(limit) || 5, MAX_MESSAGES));
  const messages = await run(account, async (client) => {
    const uids = await client.search();
    const selected = uids.slice(-count).reverse();
    const out = [];
    for (const uid of selected) {
      const raw = await client.fetch(uid);
      if (!raw || raw.length > MAX_MESSAGE_BYTES) continue;
      out.push(parseMessage(raw, uid));
    }
    return out;
  });
  await store.mutate((data) => {
    const target = (data.imapAccounts || []).find((item) => item.id === account.id);
    if (target) {
      target.lastCheckAt = new Date().toISOString();
      target.lastError = null;
      target.newCount = 0;
      const newest = messages.reduce((max, item) => Math.max(max, Number(item.uid) || 0), 0);
      if (newest) target.lastUid = Math.max(Number(target.lastUid) || 0, newest);
    }
  }).catch(() => {});
  return { account: publicAccount(account), messages };
}

/** Comprueba si hay correo nuevo: actualiza lastUid y newCount sin leer cuerpos. */
export async function checkImapAccount(id) {
  const account = accountFor(id);
  try {
    const result = await run(account, async (client) => {
      const uids = await client.search();
      const newest = uids.length ? uids[uids.length - 1] : null;
      return { uids, newest };
    });
    let outcome;
    await store.mutate((data) => {
      const target = (data.imapAccounts || []).find((item) => item.id === account.id);
      if (!target) return;
      const previous = Number(target.lastUid) || null;
      const newest = result.newest;
      const newUids = previous ? result.uids.filter((uid) => uid > previous) : [];
      const count = newUids.length;
      target.lastCheckAt = new Date().toISOString();
      target.lastError = null;
      target.newCount = count;
      target.pendingUids = newUids.slice(-20);
      if (newest) target.lastUid = newest;
      outcome = { newCount: count, total: result.uids.length, lastUid: newest, newUids };
    });
    return outcome || { newCount: 0, total: result.uids.length, lastUid: result.newest, newUids: [] };
  } catch (error) {
    await recordImapError(id, error);
    throw error;
  }
}
/** Activa o desactiva que la oficina redacte respuestas automáticamente. */
export async function setImapAutoDraft(id, enabled) {
  return store.mutate((data) => {
    const account = (data.imapAccounts || []).find((item) => item.id === id);
    if (!account) throw new ChannelError('IMAP_NOT_FOUND', 'Bandeja IMAP no encontrada.', { status: 404 });
    account.autoDraft = enabled === true;
    return publicAccount(account);
  });
}

/** Marca UIDs como ya redactados para no duplicar propuestas. */
export async function markAutoDrafted(id, uids = []) {
  await store.mutate((data) => {
    const account = (data.imapAccounts || []).find((item) => item.id === id);
    if (!account) return;
    const previous = Array.isArray(account.autoDrafted) ? account.autoDrafted : [];
    const marked = uids.map(Number).filter(Number.isInteger);
    account.autoDrafted = [...new Set([...previous, ...marked])].slice(-150);
    account.pendingUids = (Array.isArray(account.pendingUids) ? account.pendingUids : []).filter((uid) => !marked.includes(Number(uid)));
  });
  return true;
}
/** Lee un mensaje concreto por su UID (solo lectura). */
export async function getImapMessage(id, uid) {
  const account = accountFor(id);
  const target = Number(uid);
  if (!Number.isInteger(target) || target < 1) {
    throw new ChannelError('IMAP_UID_INVALID', 'UID de mensaje inválido.', { status: 400 });
  }
  return run(account, async (client) => {
    const raw = await client.fetch(target);
    if (!raw) throw new ChannelError('IMAP_NOT_FOUND', `No encontré el mensaje ${target}.`, { status: 404 });
    if (raw.length > MAX_MESSAGE_BYTES) throw new ChannelError('IMAP_TOO_LARGE', 'El mensaje es demasiado grande para leerlo.', { status: 413 });
    return parseMessage(raw, target);
  });
}
/** Envuelve errores de lectura para anotar el último fallo sin romper la UI. */
export async function recordImapError(id, error) {
  await store.mutate((data) => {
    const target = (data.imapAccounts || []).find((item) => item.id === id);
    if (target) target.lastError = { at: new Date().toISOString(), message: String(error?.message || error).slice(0, 300) };
  }).catch(() => {});
}








#!/usr/bin/env node
/**
 * Autocheck de canales (sin credenciales reales ni red externa).
 *
 * Levanta DOS servidores en 127.0.0.1 con puerto efímero:
 *   1. un mock de Telegram / WhatsApp Graph / Gmail / OAuth / outbox,
 *   2. la app real (`createApp`) con un DATA_DIR temporal.
 *
 * Después ejerce la API como lo haría la UI y comprueba las aceptaciones:
 * simulador conversacional, Telegram long polling + dedupe por update_id,
 * WhatsApp HMAC + idempotencia por message.id + ventana 24 h con plantilla,
 * correo entrante con respuesta en el mismo hilo, webhook genérico con token,
 * rate limit, secretos cifrados y ausencia de fugas.
 *
 * Uso:
 *   node lib/channel/selfcheck.mjs
 *   KEEP_DATA=1 node lib/channel/selfcheck.mjs   # conserva el DATA_DIR temporal
 *
 * Sale con código 0 si todo pasa. No toca data/agenda-data.json ni .env reales.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const results = { pass: 0, fail: 0, failures: [] };
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log(`\n▶ ${title}`);
}

function check(name, condition, detail = '') {
  if (condition) {
    results.pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    results.fail += 1;
    results.failures.push({ section: currentSection, name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* reintentar */ }
    await sleep(intervalMs);
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* ------------------------------------------------------------------ */
/* Mock de proveedores                                                 */
/* ------------------------------------------------------------------ */

const TG_TOKEN = '111:mock-token';
const WA_TOKEN = 'WA_TOKEN_OK';
const GOOGLE_ACCESS = 'ya29.mock';

const mock = {
  telegram: {
    updates: [],
    updatesCalls: 0,
    sent: [],
    callbacksAnswered: [],
    documents: [],
    actions: [],
    deleteWebhook: 0,
    setWebhook: null,
    getMe: 0
  },
  whatsapp: { sends: [], reads: [], phoneGets: 0, documents: [], mediaUploads: 0 },
  gmail: { list: [{ id: 'm1' }], messages: {}, sends: [], modify: [], listCalls: 0 },
  outbox: [],
  oauth: { tokenCalls: 0 }
};

function gmailMessage({ id = 'm1', threadId = 'thread-1', subject = 'HOY', from = 'Owner <owner@example.com>', body = 'HOY', extraHeaders = {} } = {}) {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: 'owner@example.com' },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: `<msg-1@example.com>` },
    { name: 'References', value: '<root@example.com>' },
    { name: 'Date', value: new Date().toUTCString() },
    ...Object.entries(extraHeaders).map(([name, value]) => ({ name, value }))
  ];
  return {
    id,
    threadId,
    internalDate: String(Date.now()),
    snippet: body,
    payload: {
      mimeType: 'multipart/alternative',
      headers,
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(body, 'utf8').toString('base64url') } }]
    }
  };
}

mock.gmail.messages.m1 = gmailMessage();

async function mockHandler(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const body = await readBody(req);

  // ---- OAuth ---------------------------------------------------------
  if (pathname === '/oauth/token') {
    const params = new URLSearchParams(body);
    const grant = params.get('grant_type');
    if ((grant === 'authorization_code' && params.get('code') === 'mock-code') || grant === 'refresh_token') {
      mock.oauth.tokenCalls += 1;
      return sendJson(res, 200, {
        access_token: GOOGLE_ACCESS,
        refresh_token: 'refresh-mock',
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send'
      });
    }
    return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Código inválido' });
  }
  if (pathname === '/oauth/userinfo') {
    if (!String(req.headers.authorization || '').includes(GOOGLE_ACCESS)) return sendJson(res, 401, { error: 'invalid_token' });
    return sendJson(res, 200, { email: 'owner@example.com' });
  }
  if (pathname === '/oauth/auth') return sendJson(res, 200, { ok: true });

  // ---- Outbox (salida del webhook genérico) --------------------------
  if (pathname === '/outbox') {
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = null; }
    mock.outbox.push({ at: Date.now(), body: parsed, headers: req.headers });
    return sendJson(res, 200, { ok: true });
  }

  // ---- Telegram ------------------------------------------------------
  const telegram = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(pathname);
  if (telegram) {
    const [, token, method] = telegram;
    if (token !== TG_TOKEN) {
      return sendJson(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    if (method === 'getMe') {
      mock.telegram.getMe += 1;
      return sendJson(res, 200, { ok: true, result: { id: 111, is_bot: true, username: 'agenda_mock_bot', first_name: 'Agenda' } });
    }
    if (method === 'getUpdates') {
      mock.telegram.updatesCalls += 1;
      const batch = mock.telegram.updates.splice(0, mock.telegram.updates.length);
      return sendJson(res, 200, { ok: true, result: batch });
    }
    if (method === 'sendMessage') {
      const payload = JSON.parse(body || '{}');
      if (!payload.chat_id || !payload.text) return sendJson(res, 400, { ok: false, error_code: 400, description: 'chat_id y text son obligatorios' });
      mock.telegram.sent.push(payload);
      return sendJson(res, 200, { ok: true, result: { message_id: 1000 + mock.telegram.sent.length, chat: { id: payload.chat_id }, text: payload.text } });
    }
    if (method === 'sendDocument') {
      const filename = /filename="([^"]+)"/.exec(body)?.[1] || null;
      mock.telegram.documents.push({ filename, bytes: Buffer.byteLength(body, 'utf8') });
      return sendJson(res, 200, { ok: true, result: { message_id: 2000 + mock.telegram.documents.length, document: { file_name: filename } } });
    }
    if (method === 'sendChatAction') {
      mock.telegram.actions.push(JSON.parse(body || '{}'));
      return sendJson(res, 200, { ok: true, result: true });
    }
    if (method === 'answerCallbackQuery') {
      mock.telegram.callbacksAnswered.push(JSON.parse(body || '{}'));
      return sendJson(res, 200, { ok: true, result: true });
    }
    if (method === 'editMessageReplyMarkup') return sendJson(res, 200, { ok: true, result: true });
    if (method === 'deleteWebhook') {
      mock.telegram.deleteWebhook += 1;
      return sendJson(res, 200, { ok: true, result: true });
    }
    if (method === 'setWebhook') {
      mock.telegram.setWebhook = JSON.parse(body || '{}');
      return sendJson(res, 200, { ok: true, result: true });
    }
    return sendJson(res, 200, { ok: true, result: true });
  }

  // ---- WhatsApp Graph ------------------------------------------------
  const media = /^\/v25\.0\/(\d+)\/media$/.exec(pathname);
  if (media) {
    const authorized = String(req.headers.authorization || '') === `Bearer ${WA_TOKEN}`;
    if (!authorized) return sendJson(res, 401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    mock.whatsapp.mediaUploads += 1;
    const filename = /filename="([^"]+)"/.exec(body)?.[1] || null;
    mock.whatsapp.documents.push({ filename, bytes: Buffer.byteLength(body, 'utf8') });
    return sendJson(res, 200, { id: `media-mock-${mock.whatsapp.mediaUploads}` });
  }
  const graph = /^\/v25\.0\/(\d+)(\/messages)?$/.exec(pathname);
  if (graph) {
    const authorized = String(req.headers.authorization || '') === `Bearer ${WA_TOKEN}`;
    if (!authorized) {
      return sendJson(res, 401, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });
    }
    if (!graph[2]) {
      mock.whatsapp.phoneGets += 1;
      return sendJson(res, 200, {
        display_phone_number: '+57 300 111 2233',
        verified_name: 'Agenda Mock',
        quality_rating: 'GREEN',
        id: graph[1]
      });
    }
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
    if (payload.status === 'read') {
      mock.whatsapp.reads.push(payload);
      return sendJson(res, 200, { success: true });
    }
    if (payload.type === 'document') {
      mock.whatsapp.sends.push(payload);
      return sendJson(res, 200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.DOC${mock.whatsapp.sends.length}` }] });
    }
    mock.whatsapp.sends.push(payload);
    const id = payload.type === 'template' ? `wamid.TPL${mock.whatsapp.sends.length}` : `wamid.OUT${mock.whatsapp.sends.length}`;
    return sendJson(res, 200, { messaging_product: 'whatsapp', messages: [{ id }] });
  }

  // ---- Gmail ---------------------------------------------------------
  if (pathname.startsWith('/gmail/v1/')) {
    if (!String(req.headers.authorization || '').includes(GOOGLE_ACCESS)) {
      return sendJson(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
    }
    if (pathname === '/gmail/v1/users/me/profile') {
      return sendJson(res, 200, { emailAddress: 'owner@example.com', messagesTotal: 10, threadsTotal: 8 });
    }
    if (pathname === '/gmail/v1/users/me/messages' && req.method === 'GET') {
      mock.gmail.listCalls += 1;
      return sendJson(res, 200, { messages: mock.gmail.list, resultSizeEstimate: mock.gmail.list.length });
    }
    if (pathname === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
      const payload = JSON.parse(body || '{}');
      const raw = Buffer.from(String(payload.raw || ''), 'base64url').toString('utf8');
      mock.gmail.sends.push({ raw, threadId: payload.threadId || null });
      return sendJson(res, 200, { id: `sent-${mock.gmail.sends.length}`, threadId: payload.threadId || 'thread-out' });
    }
    const modify = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/.exec(pathname);
    if (modify && req.method === 'POST') {
      mock.gmail.modify.push(modify[1]);
      return sendJson(res, 200, { id: modify[1] });
    }
    const getMessage = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(pathname);
    if (getMessage && req.method === 'GET') {
      const message = mock.gmail.messages[getMessage[1]];
      if (!message) return sendJson(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
      return sendJson(res, 200, message);
    }
    return sendJson(res, 404, { error: { code: 404, message: `Ruta mock no implementada: ${pathname}` } });
  }

  return sendJson(res, 404, { error: { code: 404, message: `Ruta mock no implementada: ${pathname}` } });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-canales-'));
process.env.DATA_DIR = dataDir;
process.env.CHANNELS_AUTOSTART = 'off';
// El scheduler de workflows (t8) arranca al importar lib/routes/workflows.mjs y
// envía avisos proactivos por el mismo chat de Telegram que usa el test. Se
// aísla igual que documenta docs/WORKFLOWS.md §8 para que el autocheck sea
// determinista (sin esto, los envíos del scheduler rompen los conteos).
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_APPROVALS_AUTOSTART = '0';
process.env.LLM_PROVIDER = 'deterministic';
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.APP_SECRET = process.env.APP_SECRET || 'autocheck-secret-key';
process.env.GOOGLE_CLIENT_ID = 'mock-client';
process.env.GOOGLE_CLIENT_SECRET = 'mock-secret';
process.env.WA_API_VERSION = 'v25.0';
// Limpieza de variables reales que podrían activar canales/LLM.
for (const name of ['WA_ENABLED', 'WA_ACCESS_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET',
  'TELEGRAM_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'EMAIL_ENABLED', 'NOTIFY_EMAIL_TO',
  'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_API_KEY']) {
  delete process.env[name];
}
for (const name of ['TELEGRAM_API_BASE', 'WA_GRAPH_BASE', 'GMAIL_API_BASE', 'GOOGLE_TOKEN_URL',
  'GOOGLE_USERINFO_URL', 'GOOGLE_AUTH_BASE', 'APP_URL']) {
  delete process.env[name];
}

const mockServer = http.createServer((req, res) => {
  Promise.resolve(mockHandler(req, res)).catch((error) => {
    sendJson(res, 500, { error: { message: error?.message || 'mock error' } });
  });
});
const mockPort = await listen(mockServer);
const mockBase = `http://127.0.0.1:${mockPort}`;
process.env.TELEGRAM_API_BASE = mockBase;
process.env.WA_GRAPH_BASE = mockBase;
process.env.GMAIL_API_BASE = `${mockBase}/gmail/v1`;
process.env.GOOGLE_TOKEN_URL = `${mockBase}/oauth/token`;
process.env.GOOGLE_USERINFO_URL = `${mockBase}/oauth/userinfo`;
process.env.GOOGLE_AUTH_BASE = `${mockBase}/oauth/auth`;

const { createApp } = await import('../http/app.mjs');
const channels = await import('../channels.mjs');
const { resetLimiters } = await import('./ratelimit.mjs');
const app = await createApp();
const appServer = http.createServer((req, res) => {
  Promise.resolve(app.handler(req, res)).catch((error) => {
    try {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Error interno del servidor', code: 'INTERNAL', detail: error?.message }));
    } catch { /* socket cerrado */ }
  });
});
const appPort = await listen(appServer);
const appBase = `http://127.0.0.1:${appPort}`;
process.env.APP_URL = appBase;

async function api(method, pathname, body, headers = {}) {
  const options = { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers }, redirect: 'manual' };
  if (body !== undefined && method !== 'GET') options.body = JSON.stringify(body);
  const response = await fetch(`${appBase}${pathname}`, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, headers: response.headers };
}

function whatsappPayload(message) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '573001112233', phone_number_id: '111222333' },
          contacts: [{ profile: { name: 'Tester' }, wa_id: message.from }],
          messages: [message]
        }
      }]
    }]
  };
}

async function postWhatsApp(message) {
  const raw = JSON.stringify(whatsappPayload(message));
  const signature = `sha256=${crypto.createHmac('sha256', 'wa-app-secret-123').update(raw).digest('hex')}`;
  const response = await fetch(`${appBase}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw
  });
  return { status: response.status, text: await response.text() };
}

async function postTelegramWebhook(update, secret = 'tg-webhook-secret-123') {
  const response = await fetch(`${appBase}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update)
  });
  return { status: response.status, text: await response.text() };
}

console.log('Agenda Copilot P95 — autocheck de canales');
console.log(`DATA_DIR temporal: ${dataDir}`);
console.log(`Mock: ${mockBase} · App: ${appBase}`);

/* ------------------------------------------------------------------ */
/* 1. Simulador y estado inicial                                       */
/* ------------------------------------------------------------------ */
section('1. Simulador local y estado de canales');

let response = await api('GET', '/api/channels');
check('GET /api/channels responde 200', response.status === 200);
const initialChannels = response.json?.items || [];
check('incluye los 5 canales base', ['simulator', 'telegram', 'whatsapp', 'email', 'generic'].every((id) => initialChannels.some((item) => item.id === id)), JSON.stringify(initialChannels.map((item) => item.id)));
const simulator = initialChannels.find((item) => item.id === 'simulator');
check('simulador siempre disponible', simulator?.configured === true && simulator?.enabled === true);
check('simulador trae instrucciones', (simulator?.instructions || []).length >= 3);
const telegramInitial = initialChannels.find((item) => item.id === 'telegram');
check('Telegram sin token = no configurado', telegramInitial?.configured === false);
check('Telegram sin token muestra instrucciones', (telegramInitial?.instructions || []).length >= 3);

response = await api('POST', '/api/channels/simulate', { text: 'HOY' });
check('simular HOY responde 200 con reply', response.status === 200 && typeof response.json?.reply === 'string' && response.json.reply.includes('AGENDA COPILOT'), response.text.slice(0, 160));
check('simular devuelve salida por el simulador', response.json?.outbound?.[0]?.ok === true);

response = await api('POST', '/api/channels/simulate', { text: 'CAPTURA comprar café' });
check('simular CAPTURA confirma captura', response.status === 200 && /Capturado/.test(response.json?.reply || ''));

response = await api('POST', '/api/channels/simulate', { text: '   ' });
check('simular texto vacío → 400 REQUIRED', response.status === 400 && response.json?.code === 'REQUIRED');

response = await api('GET', '/api/channels/inbox?limit=10');
check('bandeja local muestra entrantes y salientes', response.status === 200 && response.json?.total >= 4 && response.json.items.some((item) => item.direction === 'inbound') && response.json.items.some((item) => item.direction === 'outbound'));

response = await api('GET', '/api/channels/messages?limit=2');
check('GET /api/channels/messages es alias de inbox', response.status === 200 && Array.isArray(response.json?.items));

/* ------------------------------------------------------------------ */
/* 2. WhatsApp Cloud API                                               */
/* ------------------------------------------------------------------ */
section('2. WhatsApp Cloud API: HMAC, idempotencia, ventana 24 h y plantillas');

response = await api('POST', '/api/channels/whatsapp/config', {
  accessToken: 'token-invalido', phoneNumberId: '111222333'
});
check('rechaza credenciales inválidas de WhatsApp', response.status >= 400 && /WA_UNAUTHORIZED|WA_PROVIDER_ERROR/.test(response.json?.code || ''), JSON.stringify(response.json));
response = await api('GET', '/api/channels/whatsapp');
check('no persiste credenciales inválidas (config atómica)', response.json?.item?.configured === false && response.json.item.config.find((field) => field.key === 'accessToken')?.configured === false);

response = await api('POST', '/api/channels/whatsapp/config', {
  accessToken: WA_TOKEN,
  phoneNumberId: '111222333',
  appSecret: 'wa-app-secret-123',
  verifyToken: 'wa-verify-123',
  defaultTo: '573001112233',
  templateName: 'recordatorio',
  templateLanguage: 'es_CO',
  enabled: true
});
check('guarda credenciales válidas y activa WhatsApp', response.status === 200 && response.json?.item?.configured === true && response.json?.item?.enabled === true, response.text.slice(0, 200));
check('la respuesta no incluye el token en claro', !response.text.includes(WA_TOKEN));

// Firma inválida
const invalid = await fetch(`${appBase}/api/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeefdeadbeef' },
  body: JSON.stringify(whatsappPayload({ from: '573001112233', id: 'wamid.SIG', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'HOY' } }))
});
check('firma HMAC inválida → 401', invalid.status === 401);
const invalidJson = await invalid.json().catch(() => ({}));
check('error de firma con código WEBHOOK_SIGNATURE_INVALID', invalidJson.code === 'WEBHOOK_SIGNATURE_INVALID');

// Mensaje válido + duplicado
const inboundMessage = { from: '573001112233', id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'HOY' } };
let result = await postWhatsApp(inboundMessage);
check('webhook válido responde 200 {received:true}', result.status === 200 && JSON.parse(result.text).received === true);
await waitFor(() => mock.whatsapp.sends.length >= 1, { timeoutMs: 4_000 });
check('WhatsApp responde al usuario (texto libre dentro de la ventana)', mock.whatsapp.sends.length === 1 && mock.whatsapp.sends[0].type === 'text' && String(mock.whatsapp.sends[0].text?.body || '').includes('AGENDA COPILOT'), JSON.stringify(mock.whatsapp.sends[0] || {}).slice(0, 200));
check('se marca como leído (best effort)', mock.whatsapp.reads.some((read) => read.message_id === 'wamid.IN1'));

result = await postWhatsApp(inboundMessage);
check('mensaje repetido responde 200 sin reprocesar', result.status === 200);
await sleep(700);
check('mensaje repetido no duplica la respuesta de WhatsApp', mock.whatsapp.sends.length === 1);

// Idempotencia contra la agenda: CAPTURA repetida solo crea un ítem
const inboxBefore = (await api('GET', '/api/inbox')).json;
const beforeCount = Array.isArray(inboxBefore?.items) ? inboxBefore.items.length : 0;
const captureMessage = { from: '573001112233', id: 'wamid.CAP1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'CAPTURA comprar flores para la oficina' } };
await postWhatsApp(captureMessage);
await postWhatsApp(captureMessage);
await waitFor(async () => {
  const current = (await api('GET', '/api/inbox')).json;
  return Array.isArray(current?.items) && current.items.length > beforeCount;
}, { timeoutMs: 4_000 });
await sleep(400);
const inboxAfter = (await api('GET', '/api/inbox')).json;
const afterCount = Array.isArray(inboxAfter?.items) ? inboxAfter.items.length : 0;
check('un mensaje repetido no duplica la cita/captura', afterCount - beforeCount === 1, `antes=${beforeCount} después=${afterCount}`);

// Prueba de credenciales: solo contra el dueño; un tercero se rechaza (t30)
response = await api('POST', '/api/channels/whatsapp/test', { to: '573001112233' });
check('prueba de WhatsApp contra el dueño valida credenciales', response.status === 200 && response.json?.result?.credentials === true, response.text.slice(0, 200));
const waTestThirdBefore = mock.whatsapp.sends.length;
response = await api('POST', '/api/channels/whatsapp/test', { to: '573009998877' });
check('prueba de WhatsApp a un tercero → 403 NOT_OWNER', response.status === 403 && response.json?.code === 'NOT_OWNER' && mock.whatsapp.sends.length === waTestThirdBefore, response.text.slice(0, 220));

response = await api('GET', '/api/channels/whatsapp');
check('estado de WhatsApp sin advertencia de App Secret', !(response.json?.item?.warnings || []).some((warning) => /Sin App Secret/.test(warning)));
check('WhatsApp registra estado de entrega/ventana', typeof response.json?.item?.runtime?.windowHours === 'number' && response.json.item.runtime.windowHours === 24);

/* ------------------------------------------------------------------ */
/* 3. Telegram: long polling, getMe, dedupe y callback query           */
/* ------------------------------------------------------------------ */
section('3. Telegram: long polling, validación getMe, dedupe y botones');

response = await api('POST', '/api/channels/telegram/config', { botToken: '999:token-invalido', enabled: true });
check('rechaza token inválido contra getMe', response.status === 502 && response.json?.code === 'TELEGRAM_INVALID_TOKEN', response.text.slice(0, 200));
response = await api('GET', '/api/channels/telegram');
check('no persiste token inválido (config atómica)', response.json?.item?.configured === false);

mock.telegram.updates.push({
  update_id: 9001,
  message: {
    message_id: 50,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 12345, type: 'private' },
    from: { id: 12345, username: 'tester' },
    text: 'HOY'
  }
});
response = await api('POST', '/api/channels/telegram/config', {
  botToken: TG_TOKEN,
  defaultChatId: '12345',
  webhookSecret: 'tg-webhook-secret-123',
  mode: 'polling',
  enabled: true
});
check('guarda token válido y arranca long polling', response.status === 200 && response.json?.item?.configured === true && response.json?.item?.enabled === true, response.text.slice(0, 160));
check('getMe identifica el bot', response.json?.item?.runtime?.botUsername === 'agenda_mock_bot');
const assistantReplies = () => mock.telegram.sent.filter((item) => String(item.text || '').includes('AGENDA COPILOT'));
await waitFor(() => assistantReplies().length >= 1, { timeoutMs: 6_000 });
const firstReply = assistantReplies()[0];
check('el bot responde por Telegram (long polling)', !!firstReply, JSON.stringify(firstReply || {}).slice(0, 200));
check('muestra “escribiendo…” antes de responder', mock.telegram.actions.some((action) => action.action === 'typing'));
await waitFor(async () => {
  const status = (await api('GET', '/api/channels/telegram')).json;
  return status?.item?.runtime?.polling?.persistedOffset >= 9002;
}, { timeoutMs: 4_000 });
response = await api('GET', '/api/channels/telegram');
check('offset de getUpdates persistido', Number(response.json?.item?.runtime?.polling?.persistedOffset) >= 9002, JSON.stringify(response.json?.item?.runtime?.polling));

// Reentrega del mismo update por webhook: no debe duplicar
// Se cuentan solo las respuestas del asistente (no los avisos del scheduler).
const sentBefore = assistantReplies().length;
const duplicate = await postTelegramWebhook(mock.telegram.updates[0] || {
  update_id: 9001,
  message: { message_id: 50, date: Math.floor(Date.now() / 1000), chat: { id: 12345, type: 'private' }, from: { id: 12345, username: 'tester' }, text: 'HOY' }
});
check('webhook de Telegram con secreto correcto → 200', duplicate.status === 200 && JSON.parse(duplicate.text).received === true);
await sleep(700);
check('update repetido no duplica la respuesta', assistantReplies().length === sentBefore);
response = await api('GET', '/api/channels/inbox?channel=telegram&limit=20');
check('Telegram marca el duplicado en la bandeja', (response.json?.items || []).some((item) => item.status === 'duplicate'), JSON.stringify((response.json?.items || []).map((item) => item.status)));

// Callback query (botones inline 1/2/3)
const callbackUpdate = {
  update_id: 9002,
  callback_query: {
    id: 'cb-1',
    from: { id: 12345, username: 'tester' },
    data: '1',
    message: { message_id: 51, chat: { id: 12345, type: 'private' }, text: '1) Opción A\n2) Opción B' }
  }
};
const callback = await postTelegramWebhook(callbackUpdate);
check('callback_query de botón responde 200', callback.status === 200);
await waitFor(() => mock.telegram.callbacksAnswered.length >= 1, { timeoutMs: 3_000 });
check('Telegram confirma la pulsación (answerCallbackQuery)', mock.telegram.callbacksAnswered.length >= 1);

const buttonSend = await channels.notifyChannel('telegram', {
  text: 'Elige una opción:\n1) Opción A\n2) Opción B',
  meta: { buttons: ['1', '2'], buttonLabels: ['Opción 1', 'Opción 2'] }
});
const buttonMessage = mock.telegram.sent.find((item) => String(item.text || '').includes('Elige una opción'));
check('Telegram renderiza botones inline 1/2/3', buttonSend.ok && !!buttonMessage && (buttonMessage.reply_markup?.inline_keyboard?.[0] || []).length === 2, JSON.stringify(buttonMessage || {}).slice(0, 200));

const badSecret = await postTelegramWebhook({ update_id: 9003, message: { message_id: 52, date: Math.floor(Date.now() / 1000), chat: { id: 12345 }, from: { id: 12345 }, text: 'HOY' } }, 'secreto-incorrecto');
check('webhook de Telegram con secreto inválido → 401', badSecret.status === 401);

const beforeDelete = mock.telegram.deleteWebhook;
response = await api('POST', '/api/channels/telegram/delete-webhook');
check('limpieza de webhook de Telegram (409) disponible', response.status === 200 && mock.telegram.deleteWebhook > beforeDelete);

channels.stopChannels();
await sleep(200);

/* ------------------------------------------------------------------ */
/* 4. Webhook genérico                                                 */
/* ------------------------------------------------------------------ */
section('4. Webhook genérico: token, salida HTTP y dedupe');

response = await api('POST', '/api/channels/webhook:demo/config', {
  label: 'Demo n8n',
  outboundUrl: `${mockBase}/outbox`,
  preset: 'n8n'
});
check('crea instancia de webhook y devuelve token una vez', response.status === 200 && typeof response.json?.generatedToken === 'string' && response.json.generatedToken.length >= 32, response.text.slice(0, 200));
const webhookToken = response.json?.generatedToken;
check('el token del webhook no se repite en el listado', !JSON.stringify((await api('GET', '/api/channels')).json).includes(webhookToken));

response = await api('POST', '/api/channels/inbound/webhook:demo', { text: 'HOY', id: 'ext-1', user: 'n8n' });
check('webhook sin token → 401', response.status === 401 && response.json?.code === 'WEBHOOK_SIGNATURE_INVALID');

response = await api('POST', '/api/channels/inbound/webhook:demo', { text: 'HOY', id: 'ext-1', user: 'n8n' }, { authorization: `Bearer ${webhookToken}` });
check('webhook con token responde con reply', response.status === 200 && response.json?.received === true && String(response.json?.reply || '').includes('AGENDA COPILOT'), response.text.slice(0, 200));
await waitFor(() => mock.outbox.length >= 1, { timeoutMs: 3_000 });
check('webhook genérico envía la respuesta a la URL de salida', mock.outbox.length >= 1 && mock.outbox[0].body?.event === 'agenda.message' && String(mock.outbox[0].body?.reply || '').includes('AGENDA COPILOT'), JSON.stringify(mock.outbox[0]?.body || {}).slice(0, 200));

const outboxBefore = mock.outbox.length;
response = await api('POST', '/api/channels/inbound/webhook:demo', { text: 'HOY', id: 'ext-1', user: 'n8n' }, { authorization: `Bearer ${webhookToken}` });
check('webhook repetido se marca como duplicado', response.status === 200 && response.json?.duplicate === true);
await sleep(500);
check('duplicado no reenvía a la URL de salida', mock.outbox.length === outboxBefore);

response = await api('POST', '/api/channels/inbound/webhook:noexiste', { text: 'HOY', id: 'x-1' }, { authorization: 'Bearer token-inventado-12345' });
check('instancia de webhook desconocida → 404', response.status === 404 && response.json?.code === 'UNKNOWN_CHANNEL', response.text.slice(0, 160));
response = await api('GET', '/api/channels/webhook:noexiste');
check('GET de instancia desconocida → 404', response.status === 404 && response.json?.code === 'NOT_FOUND');

response = await api('POST', '/api/webhooks/generic', { text: 'HOY', id: 'gen-1' });
check('alias /api/webhooks/generic funciona en modo local', response.status === 200 && response.json?.received === true && typeof response.json?.signal === 'object');

response = await api('POST', '/api/channels/webhook:demo/config', { enabled: false });
check('desactiva la instancia de webhook', response.status === 200 && response.json?.item?.enabled === false);
response = await api('POST', '/api/channels/inbound/webhook:demo', { text: 'HOY', id: 'ext-2' }, { authorization: `Bearer ${webhookToken}` });
check('webhook deshabilitado → 403 CHANNEL_DISABLED', response.status === 403 && response.json?.code === 'CHANNEL_DISABLED');
await api('POST', '/api/channels/webhook:demo/config', { enabled: true });

// Una instancia personalizada sin token queda cerrada incluso en modo local
response = await api('POST', '/api/channels/webhook:demo/config', { token: null });
check('borra el token de una instancia de webhook', response.status === 200 && response.json?.item?.runtime?.tokenConfigured === false);
response = await api('POST', '/api/channels/inbound/webhook:demo', { text: 'HOY', id: 'ext-3' }, { authorization: `Bearer ${webhookToken}` });
check('instancia sin token → 503 (no queda abierta)', response.status === 503 && response.json?.code === 'WEBHOOK_SECRET_MISSING');
const rotatedToken = 'token-rotado-1234567890abcdef';
response = await api('POST', '/api/channels/webhook:demo/config', { token: rotatedToken });
check('rota el token de la instancia de webhook', response.status === 200 && response.json?.changed?.includes('token'));
response = await api('POST', '/api/channels/inbound/webhook:demo', { text: 'HOY', id: 'ext-3' }, { authorization: `Bearer ${rotatedToken}` });
check('el token rotado vuelve a aceptar entradas', response.status === 200 && response.json?.received === true);

/* ------------------------------------------------------------------ */
/* 5. Correo Gmail: OAuth, polling, mismo hilo y anti-bucle            */
/* ------------------------------------------------------------------ */
section('5. Correo Gmail: OAuth de lectura, polling y respuesta en el hilo');

response = await api('GET', '/api/channels/email');
check('correo sin conexión = no configurado con instrucciones', response.json?.item?.configured === false && (response.json?.item?.instructions || []).length >= 3);

response = await api('GET', '/api/channels/email/oauth/start');
check('OAuth de Gmail inicia con 302', response.status === 302, `status=${response.status}`);
const authLocation = response.headers.get('location') || '';
check('el consentimiento pide gmail.modify y gmail.send', authLocation.includes('gmail.modify') && authLocation.includes('gmail.send'), authLocation.slice(0, 200));
const authUrl = new URL(authLocation);
const state = authUrl.searchParams.get('state');
check('OAuth incluye redirect_uri y state', !!authUrl.searchParams.get('redirect_uri') && !!state);
check('redirect_uri apunta al callback del canal', String(authUrl.searchParams.get('redirect_uri')).endsWith('/api/channels/email/oauth/callback'));

response = await api('GET', `/api/channels/email/oauth/callback?code=mock-code&state=${encodeURIComponent(state)}`);
check('callback OAuth conecta Gmail (302 al centro)', response.status === 302 && String(response.headers.get('location') || '').includes('channel=email'), `status=${response.status} location=${response.headers.get('location')}`);
response = await api('GET', '/api/channels/email');
check('Gmail queda configurado tras el OAuth', response.json?.item?.configured === true && response.json?.item?.runtime?.account === 'owner@example.com', JSON.stringify(response.json?.item?.runtime));

response = await api('GET', `/api/channels/email/oauth/callback?code=mock-code&state=invalido`);
check('state inválido → 400 OAUTH_STATE_INVALID', response.status === 400 && response.json?.code === 'OAUTH_STATE_INVALID');

response = await api('POST', '/api/channels/email/config', {
  enabled: true,
  to: 'owner@example.com',
  allowFrom: ['owner@example.com'],
  pollIntervalMin: 60,
  maxPerPoll: 5,
  replyEnabled: true,
  markRead: true
});
check('guarda configuración de correo y activa el canal', response.status === 200 && response.json?.item?.enabled === true, response.text.slice(0, 200));

await waitFor(() => mock.gmail.sends.length >= 1, { timeoutMs: 6_000 });
check('el correo entrante se procesa y se responde', mock.gmail.sends.length >= 1, JSON.stringify(mock.gmail).slice(0, 200));
const sentMail = mock.gmail.sends[0];
check('la respuesta va en el mismo hilo', sentMail?.threadId === 'thread-1', String(sentMail?.threadId));
check('la respuesta usa In-Reply-To y References', /^In-Reply-To: <msg-1@example\.com>\r?$/m.test(sentMail?.raw || '') && /^References: .*<msg-1@example\.com>\r?$/m.test(sentMail?.raw || ''), String(sentMail?.raw || '').split('\n').slice(0, 12).join(' | '));
check('la respuesta lleva la cabecera anti-bucle X-Agenda-Copilot', /^X-Agenda-Copilot: auto-reply\r?$/m.test(sentMail?.raw || ''));
check('la respuesta contiene la contestación del asistente', /AGENDA COPILOT/.test(sentMail?.raw || ''));
check('el mensaje procesado se marca como leído', !!(await waitFor(() => mock.gmail.modify.includes('m1'), { timeoutMs: 3_000 })));

const sendsBefore = mock.gmail.sends.length;
response = await api('POST', '/api/channels/email/poll');
check('segunda revisión no reprocesa el mismo mensaje', response.status === 200 && (response.json?.processed === 0 || response.json?.skipped === true || response.json?.reason === 'in-progress'), response.text.slice(0, 200));
await sleep(500);
check('no hay respuesta duplicada por correo', mock.gmail.sends.length === sendsBefore);

// Autorespuesta propia marcada: el polling debe ignorarla
mock.gmail.list = [{ id: 'm2' }];
mock.gmail.messages.m2 = gmailMessage({
  id: 'm2',
  subject: 'Re: HOY',
  body: 'Respuesta automática de la agenda',
  extraHeaders: { 'X-Agenda-Copilot': 'auto-reply' }
});
response = await api('POST', '/api/channels/email/poll');
check('ignora las respuestas automáticas del propio canal', response.status === 200 && (response.json?.ignored ?? 0) >= 1, response.text.slice(0, 200));
check('la autorespuesta no genera otro correo', mock.gmail.sends.length === sendsBefore);

/* ------------------------------------------------------------------ */
/* 6. Seguridad, rate limit y compatibilidad                           */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 6. Aprobaciones y entregables (t18)                                 */
/* ------------------------------------------------------------------ */
section('6. Aprobaciones y entregables (WhatsApp, Telegram, correo y simulador)');
resetLimiters();

response = await api('POST', '/api/channels/approvals/config', {
  preferredChannel: 'simulator',
  notifyOnCreate: true,
  reminderMinutes: 15,
  maxReminders: 2,
  simulatorTarget: 'demo-owner',
  owners: { simulator: ['demo-owner'] }
});
check('configura aprobaciones y lista blanca del simulador', response.status === 200 && response.json?.config?.owners?.simulator?.includes('demo-owner') && response.json?.preferred?.channel === 'simulator', response.text.slice(0, 200));

async function createProposal(extra = {}) {
  return api('POST', '/api/office/proposals', {
    kind: 'email',
    channel: 'email',
    recipients: ['cliente@externo.com'],
    subject: 'Propuesta comercial',
    body: 'Adjunto la propuesta para revisión y firma.',
    attachments: ['propuesta.pdf'],
    ...extra
  });
}
async function proposalStatus(id) {
  const result = await api('GET', `/api/office/proposals/${id}`);
  return result.json?.item?.status || null;
}
async function ledgerCount(action, proposalId = null) {
  const result = await api('GET', '/api/office/ledger?limit=300');
  return (result.json?.items || []).filter((entry) => entry.action === action && (!proposalId || entry.payload?.proposalId === proposalId)).length;
}
async function pendingItem(id) {
  const result = await api('GET', '/api/channels/approvals/pending');
  return (result.json?.items || []).find((item) => item.id === id) || null;
}
function whatsappPayloadText(payload) {
  if (!payload) return '';
  if (payload.type === 'template') return String(payload.template?.components?.[0]?.parameters?.[0]?.text || '');
  return String(payload.text?.body || '');
}

// 1) N2: tarjeta, aprobación y doble respuesta
const p1 = await createProposal();
const p1id = p1.json?.id;
check('propuesta N2 creada y pendiente', p1.status === 201 && p1.json?.level === 'N2' && p1.json?.status === 'pending', p1.text.slice(0, 200));

response = await api('POST', `/api/channels/approvals/${p1id}/send`, { channel: 'simulator', to: 'demo-owner' });
check('envía tarjeta de aprobación por el simulador', response.status === 200 && response.json?.ok === true && response.json?.card?.text?.includes(p1id) && response.json?.card?.text?.includes('Riesgo'), response.text.slice(0, 240));
check('la tarjeta incluye nivel, destinatarios y acciones 1/2/3', /N2/.test(response.json?.card?.text || '') && /cliente@externo\.com/.test(response.json?.card?.text || '') && /1 = aprobar/i.test(response.json?.card?.text || ''));
response = await api('GET', '/api/channels/inbox?channel=simulator&limit=5');
check('la tarjeta queda en la bandeja local', (response.json?.items || []).some((item) => item.meta?.approval === true && item.meta?.proposalId === p1id));

response = await api('POST', '/api/channels/simulate', { text: `ok ${p1id}`, userId: 'demo-owner' });
check('responder “ok” aprueba en el gate', response.status === 200 && response.json?.approval?.decision === 'approved' && /aprobada/i.test(response.json?.reply || ''), response.text.slice(0, 240));
check('la propuesta queda approved en la Oficina', (await proposalStatus(p1id)) === 'approved');
check('el ledger registra una sola aprobación', (await ledgerCount('proposal.approved', p1id)) === 1);

response = await api('POST', '/api/channels/simulate', { text: 'ok', userId: 'demo-owner' });
check('una respuesta repetida responde “ya se decidió”', response.status === 200 && /ya se decidió/i.test(response.json?.reply || ''), response.text.slice(0, 200));
check('la repetición no vuelve a aprobar', (await ledgerCount('proposal.approved', p1id)) === 1 && (await proposalStatus(p1id)) === 'approved');

response = await api('POST', `/api/channels/approvals/${p1id}/send`, { channel: 'simulator', to: 'demo-owner' });
check('no se reenvía una propuesta ya decidida', response.status === 409 && response.json?.code === 'ALREADY_DECIDED', response.text.slice(0, 160));

// 1-bis) decisión tomada por la UI después de enviar la tarjeta
const pui = await createProposal({ subject: 'Decidida desde la UI' });
const puiid = pui.json?.id;
await api('POST', `/api/channels/approvals/${puiid}/send`, { channel: 'simulator', to: 'demo-owner' });
await api('POST', `/api/office/proposals/${puiid}/approve`, { by: 'jefe' });
response = await api('POST', '/api/channels/simulate', { text: `ok ${puiid}`, userId: 'demo-owner' });
check('si la UI ya decidió, el canal responde “ya se decidió”', response.status === 200 && /ya se decidió/i.test(response.json?.reply || ''), response.text.slice(0, 200));
check('la decisión de la UI no se duplica desde el canal', (await proposalStatus(puiid)) === 'approved' && (await ledgerCount('proposal.approved', puiid)) === 1);

// 2) N2: rechazo
const p2 = await createProposal({ subject: 'Propuesta para rechazar' });
const p2id = p2.json?.id;
await api('POST', `/api/channels/approvals/${p2id}/send`, { channel: 'simulator', to: 'demo-owner' });
response = await api('POST', '/api/channels/simulate', { text: `no ${p2id}`, userId: 'demo-owner' });
check('responder “no” rechaza en el gate', response.status === 200 && response.json?.approval?.decision === 'rejected' && (await proposalStatus(p2id)) === 'rejected', response.text.slice(0, 200));

// 3) corrección
const p3 = await createProposal({ subject: 'Propuesta para corregir' });
const p3id = p3.json?.id;
await api('POST', `/api/channels/approvals/${p3id}/send`, { channel: 'simulator', to: 'demo-owner' });
response = await api('POST', '/api/channels/simulate', { text: 'corrige: pon 10:00 y revisa el precio', userId: 'demo-owner' });
const p3state = await api('GET', `/api/office/proposals/${p3id}`);
check('“corrige: …” devuelve la corrección al gate', response.status === 200 && response.json?.approval?.decision === 'corrected' && p3state.json?.item?.status === 'rejected' && /pon 10:00/.test(p3state.json?.item?.rejectReason || ''), (response.json?.reply || '').slice(0, 200));
check('la corrección queda en el ledger', (await ledgerCount('proposal.correction', p3id)) === 1);

// 4) remitente no autorizado
const p4 = await createProposal({ subject: 'Propuesta protegida' });
const p4id = p4.json?.id;
await api('POST', `/api/channels/approvals/${p4id}/send`, { channel: 'simulator', to: 'demo-owner' });
const deniedBefore = await ledgerCount('proposal.approval_denied');
response = await api('POST', '/api/channels/simulate', { text: 'ok', userId: 'intruso' });
check('un remitente no autorizado es rechazado', response.status === 200 && /No autorizado/i.test(response.json?.reply || ''), response.text.slice(0, 200));
check('la propuesta sigue pendiente tras el intento no autorizado', (await proposalStatus(p4id)) === 'pending');
check('el intento no autorizado se audita en el ledger', (await ledgerCount('proposal.approval_denied')) === deniedBefore + 1);

// El mismo intento desde WhatsApp/Telegram/correo de remitentes no autorizados:
// el adaptador deja pasar el mensaje y el gate responde + audita.
const deniedBeforeChannels = await ledgerCount('proposal.approval_denied');
const waIntruderBefore = mock.whatsapp.sends.length;
await postWhatsApp({
  from: '573009998877',
  id: `wamid.INTRUSO${Date.now()}`,
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text',
  text: { body: `ok ${p4id}` }
});
const waIntruderReply = await waitFor(() => mock.whatsapp.sends.slice(waIntruderBefore).find((item) => item.to === '573009998877' && /No autorizado/i.test(String(item.text?.body || ''))), { timeoutMs: 3_000 });
check('WhatsApp no autorizado recibe “no autorizado” y se audita', !!waIntruderReply && (await ledgerCount('proposal.approval_denied')) === deniedBeforeChannels + 1, String(waIntruderReply?.text?.body || '').slice(0, 160));

const tgIntruderBefore = mock.telegram.sent.length;
await postTelegramWebhook({
  update_id: 9401,
  message: {
    message_id: 401,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 99999, type: 'private' },
    from: { id: 99999, username: 'intruso' },
    text: `ok ${p4id}`
  }
});
const tgIntruderReply = await waitFor(() => mock.telegram.sent.slice(tgIntruderBefore).find((item) => String(item.chat_id) === '99999' && /No autorizado/i.test(String(item.text || ''))), { timeoutMs: 3_000 });
check('Telegram no autorizado recibe “no autorizado” y se audita', !!tgIntruderReply && (await ledgerCount('proposal.approval_denied')) === deniedBeforeChannels + 2, String(tgIntruderReply?.text || '').slice(0, 160));

const mailIntruderBefore = mock.gmail.sends.length;
mock.gmail.list = [{ id: 'intr-mail-1' }];
mock.gmail.messages['intr-mail-1'] = gmailMessage({
  id: 'intr-mail-1',
  threadId: 'thread-intr-1',
  subject: `Re: [${p4id}] Aprobación N2 · Propuesta protegida`,
  from: 'Intruso <intruso@example.com>',
  body: `ok ${p4id}`
});
await api('POST', '/api/channels/email/poll');
const mailIntruder = await waitFor(() => mock.gmail.sends.slice(mailIntruderBefore).find((item) => /^To: intruso@example\.com/m.test(item.raw) && /No autorizado/i.test(item.raw)), { timeoutMs: 4_000 });
check('correo no autorizado recibe “no autorizado” y se audita', !!mailIntruder && (await ledgerCount('proposal.approval_denied')) === deniedBeforeChannels + 3, String(mailIntruder?.raw || '').slice(0, 160));
check('los intentos no autorizados no deciden la propuesta', (await proposalStatus(p4id)) === 'pending');

response = await api('POST', '/api/channels/simulate', { text: `no ${p4id}`, userId: 'demo-owner' });
check('el dueño puede rechazar la propuesta pendiente', response.status === 200 && (await proposalStatus(p4id)) === 'rejected');

// 5) ambigüedad: dos pendientes para el mismo dueño
const p5 = await createProposal({ subject: 'Pendiente A' });
const p6 = await createProposal({ subject: 'Pendiente B' });
const p5id = p5.json?.id;
const p6id = p6.json?.id;
await api('POST', `/api/channels/approvals/${p5id}/send`, { channel: 'simulator', to: 'demo-owner' });
await api('POST', `/api/channels/approvals/${p6id}/send`, { channel: 'simulator', to: 'demo-owner' });
response = await api('POST', '/api/channels/simulate', { text: 'ok', userId: 'demo-owner' });
check('con dos pendientes exige el id (sin ambigüedad)', response.status === 200 && /Indica el id|Respuesta con el id|propuestas pendientes/i.test(response.json?.reply || '') && (await proposalStatus(p5id)) === 'pending' && (await proposalStatus(p6id)) === 'pending', response.text.slice(0, 220));
response = await api('POST', '/api/channels/simulate', { text: `ok ${p5id}`, userId: 'demo-owner' });
check('con el id explícito aprueba la correcta', response.status === 200 && (await proposalStatus(p5id)) === 'approved' && (await proposalStatus(p6id)) === 'pending');
await api('POST', '/api/channels/simulate', { text: `no ${p6id}`, userId: 'demo-owner' });

// 6) N3: código de un solo uso
const n3 = await createProposal({ subject: 'Pago factura 2026', body: 'Pago urgente de la factura de servicios.', meta: { money: true }, attachments: [] });
const n3id = n3.json?.id;
check('propuesta con dinero se clasifica N3', n3.json?.level === 'N3', n3.text.slice(0, 160));
await api('POST', `/api/channels/approvals/${n3id}/send`, { channel: 'simulator', to: 'demo-owner' });
response = await api('POST', '/api/channels/simulate', { text: '1', userId: 'demo-owner' });
const codeMatch = /Código N3[^\n]*:\s*([A-Z2-9]{6})/.exec(response.json?.reply || '');
check('N3 devuelve código de 6 al aprobar por canal', response.status === 200 && (await proposalStatus(n3id)) === 'approved' && !!codeMatch, response.text.slice(0, 240));

// 7) Telegram: tarjeta con botones inline y callback
const ptg = await createProposal({ subject: 'Propuesta Telegram' });
const ptgid = ptg.json?.id;
const tgSentBefore = mock.telegram.sent.length;
response = await api('POST', `/api/channels/approvals/${ptgid}/send`, { channel: 'telegram', to: '12345' });
const telegramCard = mock.telegram.sent.slice(tgSentBefore).find((item) => String(item.text || '').includes(ptgid));
check('Telegram envía tarjeta con botones inline', response.status === 200 && !!telegramCard && (telegramCard.reply_markup?.inline_keyboard || []).flat().some((button) => button.callback_data === `ap:${ptgid}:approve`) && (telegramCard.reply_markup?.inline_keyboard || []).flat().length >= 3, JSON.stringify(telegramCard || {}).slice(0, 240));
response = await postTelegramWebhook({
  update_id: 9301,
  callback_query: {
    id: 'cb-appr-tg-1',
    from: { id: 12345, username: 'tester' },
    data: `ap:${ptgid}:approve`,
    message: { message_id: 301, chat: { id: 12345, type: 'private' }, text: `Aprobación ${ptgid}` }
  }
});
check('callback de aprobación por Telegram responde 200', response.status === 200);
check('el botón aprueba en el gate', !!(await waitFor(async () => (await proposalStatus(ptgid)) === 'approved', { timeoutMs: 4_000 })));
check('Telegram confirma la pulsación', mock.telegram.callbacksAnswered.some((item) => item.callback_query_id === 'cb-appr-tg-1'));

// 8) WhatsApp: tarjeta 1/2/3 y respuesta numérica
const pwa = await createProposal({ subject: 'Propuesta WhatsApp' });
const pwaid = pwa.json?.id;
const waBefore = mock.whatsapp.sends.length;
response = await api('POST', `/api/channels/approvals/${pwaid}/send`, { channel: 'whatsapp', to: '573001112233' });
const whatsappCard = mock.whatsapp.sends.slice(waBefore).find((item) => whatsappPayloadText(item).includes(pwaid));
check('WhatsApp envía tarjeta con instrucciones 1/2/3', response.status === 200 && !!whatsappCard && /1 = aprobar/i.test(whatsappPayloadText(whatsappCard)), JSON.stringify(whatsappCard || {}).slice(0, 240));
response = await postWhatsApp({
  from: '573001112233',
  id: `wamid.APPR${Date.now()}`,
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text',
  text: { body: '1' }
});
check('webhook de WhatsApp acepta la respuesta', response.status === 200);
check('responder “1” por WhatsApp aprueba en el gate', !!(await waitFor(async () => (await proposalStatus(pwaid)) === 'approved', { timeoutMs: 4_000 })));

// 9) Correo: tarjeta HTML + Reply-To y respuesta por el mismo hilo
const pmail = await createProposal({ subject: 'Propuesta por correo' });
const pmailid = pmail.json?.id;
const mailBefore = mock.gmail.sends.length;
response = await api('POST', `/api/channels/approvals/${pmailid}/send`, { channel: 'email', to: 'owner@example.com' });
await waitFor(() => mock.gmail.sends.length > mailBefore, { timeoutMs: 4_000 });
const mailCard = mock.gmail.sends.slice(mailBefore).at(-1) || null;
check('el correo de aprobación es HTML con Reply-To', response.status === 200 && !!mailCard && /multipart\/alternative/i.test(mailCard.raw) && /^Reply-To: /m.test(mailCard.raw) && /Content-Type: text\/html/i.test(mailCard.raw), String(mailCard?.raw || '').slice(0, 200));
check('el asunto del correo es ASCII y conserva el id', !!mailCard && String(mailCard.raw).includes('Subject: [' + pmailid + ']'), String(mailCard?.raw || '').split('\n')[1]);
mock.gmail.list = [{ id: 'appr-mail-1' }];
mock.gmail.messages['appr-mail-1'] = gmailMessage({
  id: 'appr-mail-1',
  threadId: 'thread-appr-1',
  subject: `Re: [${pmailid}] Aprobación N2 · Propuesta por correo`,
  from: 'Owner <owner@example.com>',
  body: 'ok'
});
response = await api('POST', '/api/channels/email/poll');
check('el polling de correo procesa la respuesta', response.status === 200);
check('responder “ok” por correo aprueba en el gate', !!(await waitFor(async () => (await proposalStatus(pmailid)) === 'approved', { timeoutMs: 5_000 })));

// 10) Aviso automático y recordatorios (máx. 2, a los 15 min)
const pauto = await createProposal({ subject: 'Propuesta con aviso automático' });
const autoid = pauto.json?.id;
const tick1 = await channels.runApprovalsTick({ now: Date.now() });
check('el watcher avisa de la propuesta nueva por el canal preferido', tick1.ok === true && tick1.notified >= 1 && !!(await pendingItem(autoid))?.sent?.some((sent) => sent.channel === 'simulator' && sent.source === 'auto'), JSON.stringify(tick1));
const tick2 = await channels.runApprovalsTick({ now: Date.now() + 16 * 60 * 1000 });
const afterReminder1 = await pendingItem(autoid);
check('recordatorio a los 15 min (1/2)', tick2.reminders >= 1 && afterReminder1?.sent?.[0]?.reminders === 1, JSON.stringify(tick2));
const tick3 = await channels.runApprovalsTick({ now: Date.now() + 32 * 60 * 1000 });
const afterReminder2 = await pendingItem(autoid);
check('recordatorio a los 30 min (2/2)', tick3.reminders >= 1 && afterReminder2?.sent?.[0]?.reminders === 2, JSON.stringify(tick3));
const tick4 = await channels.runApprovalsTick({ now: Date.now() + 48 * 60 * 1000 });
const afterReminder3 = await pendingItem(autoid);
check('nunca más de 2 recordatorios', tick4.reminders === 0 && afterReminder3?.sent?.[0]?.reminders === 2, JSON.stringify(tick4));
await api('POST', '/api/channels/simulate', { text: `no ${autoid}`, userId: 'demo-owner' });

// 10-bis) Recordatorio manual (inmediato, máximo 2)
const prem = await createProposal({ subject: 'Recordatorio manual' });
const premid = prem.json?.id;
await api('POST', `/api/channels/approvals/${premid}/send`, { channel: 'simulator', to: 'demo-owner' });
response = await api('POST', `/api/channels/approvals/${premid}/remind`, {});
check('POST /approvals/:id/remind envía de inmediato', response.status === 200 && response.json?.reminders === 1, response.text.slice(0, 200));
response = await api('POST', `/api/channels/approvals/${premid}/remind`, {});
const remindSecond = response.status;
response = await api('POST', `/api/channels/approvals/${premid}/remind`, {});
check('el recordatorio manual respeta el máximo de 2', remindSecond === 200 && response.status === 409 && response.json?.code === 'MAX_REMINDERS', response.text.slice(0, 200));
await api('POST', '/api/channels/simulate', { text: `no ${premid}`, userId: 'demo-owner' });

// 11) Entregables: DOCX real generado por lib/docs y enviado por cada canal
response = await api('POST', '/api/docs', {
  type: 'docx',
  title: 'Informe P95',
  subtitle: 'Prueba de entrega por canales',
  sections: [
    { heading: 'Resumen', level: 1 },
    { paragraph: 'Documento generado por lib/docs y enviado como adjunto por los canales.' }
  ]
});
const docId = response.json?.id;
const docName = response.json?.filename;
const docBytes = response.json?.bytes;
check('lib/docs genera un DOCX real (DOC-…)', response.status === 201 && /^DOC-/.test(String(docId || '')) && typeof docName === 'string' && docName.endsWith('.docx') && docBytes > 1000, response.text.slice(0, 240));
const docDownload = await fetch(`${appBase}/api/docs/${docId}/download`);
const docBuffer = Buffer.from(await docDownload.arrayBuffer());
check('el DOCX descargado tiene firma ZIP y tamaño', docDownload.status === 200 && docBuffer.length === docBytes && docBuffer.subarray(0, 2).toString() === 'PK');

async function approveAndExecuteProposal(id) {
  const approved = await api('POST', `/api/office/proposals/${id}/approve`, { by: 'jefe' });
  const code = approved.json?.code || null;
  const executed = await api('POST', `/api/office/proposals/${id}/execute`, code ? { code } : {});
  return { approved, code, executed };
}

const simInboxBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
response = await api('POST', '/api/channels/send-document', { docId, channel: 'simulator', to: 'tercero' });
const simDocProposal = response.json?.proposal?.id;
check('send-document crea propuesta 202 con adjunto (simulador)', response.status === 202 && response.json?.status === 'pending_approval' && !!simDocProposal && response.json?.proposal?.channel === 'simulator' && response.json?.doc?.id === docId && response.json?.doc?.filename === docName && (response.json?.proposal?.attachments || []).includes(docId), response.text.slice(0, 260));
response = await api('GET', '/api/channels/inbox?channel=simulator&limit=100');
check('el documento no se envía antes de aprobar/ejecutar', (response.json?.count || 0) === simInboxBefore);
const simDocRun = await approveAndExecuteProposal(simDocProposal);
check('aprobar+ejecutar envía el documento al simulador', simDocRun.executed.status === 200 && simDocRun.executed.json?.status === 'executed' && (simDocRun.executed.json?.item?.status === 'executed'), simDocRun.executed.text.slice(0, 220));
response = await api('GET', '/api/channels/inbox?channel=simulator&limit=100');
check('la bandeja registra el documento adjunto ejecutado', (response.json?.items || []).some((item) => item.meta?.document === true && item.meta?.filename === docName && item.meta?.size === docBytes));

const tgDocsBefore = mock.telegram.documents.length;
response = await api('POST', '/api/channels/send-document', { docId, channel: 'telegram', to: '12345' });
const tgDocProposal = response.json?.proposal?.id;
check('send-document crea propuesta 202 para Telegram', response.status === 202 && !!tgDocProposal && response.json?.proposal?.channel === 'telegram' && response.json?.doc?.filename === docName, response.text.slice(0, 220));
check('Telegram no envía el documento antes de ejecutar', mock.telegram.documents.length === tgDocsBefore);
const tgDocRun = await approveAndExecuteProposal(tgDocProposal);
check('ejecutar la propuesta envía el DOCX por Telegram', tgDocRun.executed.status === 200 && tgDocRun.executed.json?.status === 'executed' && mock.telegram.documents.length === tgDocsBefore + 1 && mock.telegram.documents.at(-1).filename === docName, tgDocRun.executed.text.slice(0, 220));

const waDocsBefore = mock.whatsapp.documents.length;
response = await api('POST', '/api/channels/send-document', { docId, channel: 'whatsapp', to: '573001112233' });
const waDocProposal = response.json?.proposal?.id;
check('send-document crea propuesta 202 para WhatsApp', response.status === 202 && !!waDocProposal && response.json?.proposal?.channel === 'whatsapp' && response.json?.doc?.filename === docName, response.text.slice(0, 220));
check('WhatsApp no envía el documento antes de ejecutar', mock.whatsapp.documents.length === waDocsBefore);
const waDocRun = await approveAndExecuteProposal(waDocProposal);
check('ejecutar la propuesta envía el DOCX por WhatsApp', waDocRun.executed.status === 200 && waDocRun.executed.json?.status === 'executed' && mock.whatsapp.documents.length === waDocsBefore + 1 && mock.whatsapp.documents.at(-1).filename === docName, waDocRun.executed.text.slice(0, 220));

const mailDocsBefore = mock.gmail.sends.length;
response = await api('POST', '/api/channels/send-document', { docId, channel: 'email', to: 'owner@example.com' });
const mailDocProposal = response.json?.proposal?.id;
check('send-document crea propuesta 202 para correo', response.status === 202 && !!mailDocProposal && response.json?.proposal?.channel === 'email' && response.json?.doc?.filename === docName, response.text.slice(0, 220));
check('Gmail no envía el documento antes de ejecutar', mock.gmail.sends.length === mailDocsBefore);
const mailDocRun = await approveAndExecuteProposal(mailDocProposal);
const mailAttachment = mock.gmail.sends.slice(mailDocsBefore).find((item) => String(item.raw || '').includes('filename="' + docName + '"'));
check('ejecutar la propuesta envía el DOCX como adjunto MIME', mailDocRun.executed.status === 200 && mailDocRun.executed.json?.status === 'executed' && !!mailAttachment && /Content-Transfer-Encoding: base64/i.test(mailAttachment.raw), mailDocRun.executed.text.slice(0, 220));

const legacyDocMailBefore = mock.gmail.sends.length;
response = await api('POST', `/api/docs/${docId}/send-email`, { to: ['tercero-doc@example.com'], subject: 'T30 documento', body: 'Adjunto por el flujo nuevo' });
const legacyDocProposal = response.json?.proposal?.id;
check('/api/docs/:id/send-email crea propuesta 202 sin enviar', response.status === 202 && response.json?.status === 'pending_approval' && !!legacyDocProposal && response.json?.proposal?.channel === 'email' && response.json?.doc?.filename === docName && mock.gmail.sends.length === legacyDocMailBefore, response.text.slice(0, 260));
const legacyDocRun = await approveAndExecuteProposal(legacyDocProposal);
const legacyAttachment = mock.gmail.sends.slice(legacyDocMailBefore).find((item) => String(item.raw || '').includes('filename="' + docName + '"'));
check('ejecutar /api/docs/:id/send-email envía un correo con el adjunto', legacyDocRun.executed.status === 200 && legacyDocRun.executed.json?.status === 'executed' && !!legacyAttachment && mock.gmail.sends.length === legacyDocMailBefore + 1, legacyDocRun.executed.text.slice(0, 220));

response = await api('POST', '/api/channels/send-document', { docId: 'no-existe.docx', channel: 'simulator', to: 'demo-owner' });
check('documento inexistente → 404 DOC_NOT_FOUND', response.status === 404 && response.json?.code === 'DOC_NOT_FOUND', response.text.slice(0, 160));

// 12) Endpoint de pendientes
response = await api('GET', '/api/channels/approvals/pending');
check('GET /api/channels/approvals/pending responde con items', response.status === 200 && Array.isArray(response.json?.items) && typeof response.json?.count === 'number');

// 12-bis) Sin bypass de salida: a terceros = propuesta, al dueño = directo (t30)
response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-sim', body: 'Mensaje T30 al simulador' });
const simSendProposal = response.json?.proposal?.id;
const simInboxSendBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
check('/api/channels/simulator/send crea propuesta N2 sin enviar', response.status === 202 && response.json?.status === 'pending_approval' && !!simSendProposal && response.json?.proposal?.channel === 'simulator' && response.json?.proposal?.level === 'N2', response.text.slice(0, 220));
check('el simulador no recibe el mensaje antes de ejecutar', (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count === simInboxSendBefore);
const simSendRun = await approveAndExecuteProposal(simSendProposal);
check('aprobar+ejecutar envía exactamente un mensaje al simulador', simSendRun.executed.status === 200 && simSendRun.executed.json?.status === 'executed' && (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count === simInboxSendBefore + 1, simSendRun.executed.text.slice(0, 220));

const waSendBefore = mock.whatsapp.sends.length;
response = await api('POST', '/api/channels/whatsapp/send', { to: '573008887776', body: 'Mensaje T30 por WhatsApp' });
const waSendProposal = response.json?.proposal?.id;
check('/api/channels/whatsapp/send crea propuesta N2 sin enviar', response.status === 202 && response.json?.status === 'pending_approval' && !!waSendProposal && response.json?.proposal?.channel === 'whatsapp' && response.json?.proposal?.level === 'N2' && mock.whatsapp.sends.length === waSendBefore, response.text.slice(0, 220));
const waSendRun = await approveAndExecuteProposal(waSendProposal);
const waApprovedSend = mock.whatsapp.sends.slice(waSendBefore);
check('aprobar+ejecutar envía un único WhatsApp al tercero (plantilla)', waSendRun.executed.status === 200 && waSendRun.executed.json?.status === 'executed' && waApprovedSend.length === 1 && waApprovedSend[0]?.type === 'template' && waApprovedSend[0]?.template?.name === 'recordatorio', JSON.stringify({ status: waSendRun.executed.status, executed: waSendRun.executed.json?.status, sends: waApprovedSend }).slice(0, 500));

const tgSendBefore = mock.telegram.sent.length;
response = await api('POST', '/api/channels/telegram/send', { to: '99999', body: 'Mensaje T30 por Telegram' });
const tgSendProposal = response.json?.proposal?.id;
check('/api/channels/telegram/send crea propuesta N2 sin enviar', response.status === 202 && response.json?.status === 'pending_approval' && !!tgSendProposal && response.json?.proposal?.channel === 'telegram' && response.json?.proposal?.level === 'N2' && mock.telegram.sent.length === tgSendBefore, response.text.slice(0, 220));
const tgSendRun = await approveAndExecuteProposal(tgSendProposal);
check('aprobar+ejecutar envía un único Telegram al tercero', tgSendRun.executed.status === 200 && tgSendRun.executed.json?.status === 'executed' && mock.telegram.sent.length === tgSendBefore + 1, tgSendRun.executed.text.slice(0, 220));

const mailSendBefore = mock.gmail.sends.length;
response = await api('POST', '/api/channels/email/send', { to: 'tercero@example.com', subject: 'T30 correo', body: 'Mensaje T30 por correo' });
const mailSendProposal = response.json?.proposal?.id;
check('/api/channels/email/send crea propuesta N2 sin enviar', response.status === 202 && response.json?.status === 'pending_approval' && !!mailSendProposal && response.json?.proposal?.channel === 'email' && response.json?.proposal?.level === 'N2' && mock.gmail.sends.length === mailSendBefore, response.text.slice(0, 220));
const mailSendRun = await approveAndExecuteProposal(mailSendProposal);
check('aprobar+ejecutar envía un único correo al tercero', mailSendRun.executed.status === 200 && mailSendRun.executed.json?.status === 'executed' && mock.gmail.sends.length === mailSendBefore + 1 && String(mock.gmail.sends.at(-1)?.raw || '').includes('Subject: T30 correo'), mailSendRun.executed.text.slice(0, 220));

response = await api('POST', '/api/channels/simulator/test', { to: 'tercero-sim' });
check('el simulador puede probarse sin lista blanca', response.status === 200 && response.json?.ok === true);
response = await api('POST', '/api/channels/telegram/test', { to: '12345' });
check('prueba de Telegram contra el dueño → 200', response.status === 200 && response.json?.ok === true, response.text.slice(0, 220));
response = await api('POST', '/api/channels/email/test', { to: 'owner@example.com' });
check('prueba de correo contra el dueño → 200', response.status === 200 && response.json?.ok === true, response.text.slice(0, 220));
response = await api('POST', '/api/channels/telegram/test', { to: '99999' });
check('/api/channels/telegram/test a tercero → 403 NOT_OWNER', response.status === 403 && response.json?.code === 'NOT_OWNER', response.text.slice(0, 220));
response = await api('POST', '/api/channels/email/test', { to: 'intruso@example.com' });
check('/api/channels/email/test a tercero → 403 NOT_OWNER', response.status === 403 && response.json?.code === 'NOT_OWNER', response.text.slice(0, 220));
const legacyWaBefore = mock.whatsapp.sends.length;
response = await api('POST', '/api/whatsapp/test', { to: '573009998877', text: 'intruso' });
check('/api/whatsapp/test a tercero → 403 NOT_OWNER', response.status === 403 && response.json?.code === 'NOT_OWNER' && mock.whatsapp.sends.length === legacyWaBefore, response.text.slice(0, 220));
response = await api('POST', '/api/telegram/test', { chatId: '99999', text: 'intruso' });
check('/api/telegram/test a tercero → 403 NOT_OWNER', response.status === 403 && response.json?.code === 'NOT_OWNER', response.text.slice(0, 220));

const gmailGateBefore = mock.gmail.sends.length;
response = await api('POST', '/api/gmail/send', { to: 'tercero@example.com', subject: 'T30 gmail gate', body: 'No debe enviarse directo' });
// 12-ter) t35: aprobación forzada en total y autonomía solo con flag
response = await api('POST', '/api/office/mode', { mode: 'total', by: 'selfcheck' });
check('modo total activado para probar el gate', response.status === 200 && response.json?.mode === 'total', response.text.slice(0, 160));
response = await api('POST', '/api/channels/approvals/config', { allowAutonomousOutbound: false });
check('autonomía de salida desactivada por defecto', response.status === 200 && response.json?.config?.allowAutonomousOutbound === false, response.text.slice(0, 200));
check('flag de autonomía es patch parcial (conserva owners/preferred/recordatorios)', response.json?.config?.owners?.simulator?.includes('demo-owner') && response.json?.preferred?.channel === 'simulator' && response.json?.config?.reminderMinutes === 15 && response.json?.config?.maxReminders === 2 && response.json?.config?.simulatorTarget === 'demo-owner', JSON.stringify({ owners: response.json?.config?.owners, preferred: response.json?.preferred, reminderMinutes: response.json?.config?.reminderMinutes, maxReminders: response.json?.config?.maxReminders }));
const totalInboxBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-sim', body: 'Modo total sin flag' });
const totalProposal = response.json?.proposal?.id;
check('modo total sin flag → 202 pending_approval', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.approvalRequired === true && response.json?.auto === false && response.json?.executed === false && !!totalProposal, response.text.slice(0, 260));
check('respuesta incluye risk, flags, message y approvalUrl', !!response.json?.proposal?.risk && Array.isArray(response.json?.proposal?.flags) && typeof response.json?.message === 'string' && response.json?.approvalUrl === `/api/office/proposals/${totalProposal}`, response.text.slice(0, 260));
check('modo total sin flag no envía antes de ejecutar', ((await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0) === totalInboxBefore);
const totalRun = await approveAndExecuteProposal(totalProposal);
check('aprobar+ejecutar en total sin flag envía exactamente 1', totalRun.executed.status === 200 && totalRun.executed.json?.status === 'executed' && ((await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0) === totalInboxBefore + 1);

response = await api('POST', '/api/channels/approvals/config', { allowAutonomousOutbound: true });
check('autonomía de salida explícita activada sin borrar owners/preferred', response.status === 200 && response.json?.config?.allowAutonomousOutbound === true && response.json?.config?.owners?.simulator?.includes('demo-owner') && response.json?.preferred?.channel === 'simulator', response.text.slice(0, 240));
const ledgerTrue = await api('GET', '/api/office/ledger?limit=200');
const trueSettingEntry = (ledgerTrue.json?.items || []).find((entry) => entry.action === 'office.settings' && entry.payload?.source === 'channels.approvals.config' && entry.payload?.changes?.allowAutonomousOutbound === true);
check('activar autonomía deja entrada office.settings auditada con source', !!trueSettingEntry && trueSettingEntry.payload?.by === 'user', JSON.stringify(trueSettingEntry || {}).slice(0, 240));
const ledgerBeforeInjection = (await api('GET', '/api/office/ledger?limit=1')).json?.total;
process.env.CHANNELS_TEST_FAIL_OFFICE_LEDGER = '1';
try {
  response = await api('POST', '/api/channels/approvals/config', { allowAutonomousOutbound: false });
} finally {
  delete process.env.CHANNELS_TEST_FAIL_OFFICE_LEDGER;
}
check('fallo del ledger → 503 OFFICE_UNAVAILABLE', response.status === 503 && response.json?.code === 'OFFICE_UNAVAILABLE', response.text.slice(0, 200));
check('fallo del ledger no cambia el flag', (await api('GET', '/api/channels/approvals/status')).json?.config?.allowAutonomousOutbound === true);
check('fallo del ledger no añade entrada office.settings', (await api('GET', '/api/office/ledger?limit=1')).json?.total === ledgerBeforeInjection);
const autoInboxBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-sim', body: 'Autonomía explícita de prueba', label: 'público' });
const autoProposal = response.json?.proposal?.id;
check('total + flag + conocido + riesgo≤2 → executed automático', response.status === 202 && response.json?.status === 'executed' && response.json?.auto === true && response.json?.executed === true && response.json?.approvalRequired === false && response.json?.proposal?.status === 'executed' && Number(response.json?.proposal?.risk?.score) <= 2, response.text.slice(0, 300));
check('autonomía envía exactamente 1 mensaje', ((await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0) === autoInboxBefore + 1);
const ledgerAfterAuto = await api('GET', '/api/office/ledger?limit=200');
const autoLedger = (ledgerAfterAuto.json?.items || []).find((entry) => entry.action === 'outbound.autonomous' && entry.payload?.proposalId === autoProposal);
const execLedger = (ledgerAfterAuto.json?.items || []).find((entry) => entry.action === 'proposal.executed' && entry.payload?.proposalId === autoProposal);
check('ledger outbound.autonomous queda antes del envío', !!autoLedger && !!execLedger && Number(autoLedger.seq) < Number(execLedger.seq), JSON.stringify({ autoLedger: autoLedger?.seq, execLedger: execLedger?.seq }));

await api('POST', '/api/office/mode', { mode: 'asistido', by: 'selfcheck' });
const assistedBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-sim', body: 'Autonomía no aplica en asistido' });
check('flag activo pero modo asistido → sigue pending', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.auto === false && ((await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0) === assistedBefore, response.text.slice(0, 220));
await api('POST', '/api/office/mode', { mode: 'total', by: 'selfcheck' });

const docResp = await api('POST', '/api/docs', { type: 'docx', title: 'N3 autonomía', sections: [{ heading: 'Resumen', level: 1 }, { paragraph: 'Adjunto N3' }] });
const docIdN3 = docResp.json?.id;
const docNameN3 = docResp.json?.filename;
const tgDocsBeforeN3 = mock.telegram.documents.length;
response = await api('POST', '/api/channels/send-document', { docId: docIdN3, channel: 'telegram', to: '77777', caption: 'N3 con adjunto' });
const n3Proposal = response.json?.proposal?.id;
check('N3 con adjunto en total+flag sigue pending', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.auto === false && response.json?.executed === false && response.json?.proposal?.level === 'N3' && (response.json?.proposal?.attachments || []).includes(docIdN3), response.text.slice(0, 300));
check('N3 no envía el adjunto antes de aprobar', mock.telegram.documents.length === tgDocsBeforeN3);
const n3Approved = await api('POST', `/api/office/proposals/${n3Proposal}/approve`, { by: 'jefe' });
const n3Code = n3Approved.json?.code;
check('N3 approve entrega código de 6', typeof n3Code === 'string' && n3Code.length === 6, String(n3Code));
const n3NoCode = await api('POST', `/api/office/proposals/${n3Proposal}/execute`, {});
check('N3 sin código no se ejecuta', n3NoCode.status === 400 && n3NoCode.json?.code === 'CODE_REQUIRED', n3NoCode.text.slice(0, 160));
const n3Executed = await api('POST', `/api/office/proposals/${n3Proposal}/execute`, { code: n3Code });
check('N3 con código ejecuta y envía 1 documento', n3Executed.status === 200 && n3Executed.json?.status === 'executed' && mock.telegram.documents.length === tgDocsBeforeN3 + 1 && mock.telegram.documents.at(-1).filename === docNameN3, n3Executed.text.slice(0, 220));

response = await api('POST', '/api/channels/send-document', { channel: 'simulator', to: 'demo-owner' });
check('send-document sin docId → 400 REQUIRED', response.status === 400 && response.json?.code === 'REQUIRED', response.text.slice(0, 160));

const mailBeforeDocsGate = mock.gmail.sends.length;
response = await api('POST', `/api/docs/${docIdN3}/send-email`, { to: ['tercero-doc-t35@example.com'], subject: 'T35 correo', body: 'Adjunto T35' });
check('docs send-email con Gmail → 202 pending, sin enviar', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.auto === false && response.json?.executed === false && typeof response.json?.message === 'string' && typeof response.json?.approvalUrl === 'string' && mock.gmail.sends.length === mailBeforeDocsGate, response.text.slice(0, 260));

response = await api('POST', '/api/channels/approvals/config', { allowAutonomousOutbound: false });
const ledgerFinal = await api('GET', '/api/office/ledger?limit=200');
const falseSettingEntry = (ledgerFinal.json?.items || []).find((entry) => entry.action === 'office.settings' && entry.payload?.source === 'channels.approvals.config' && entry.payload?.changes?.allowAutonomousOutbound === false);
check('desactivar autonomía deja nueva entrada office.settings y flag false', response.status === 200 && response.json?.config?.allowAutonomousOutbound === false && !!falseSettingEntry && (!trueSettingEntry || Number(falseSettingEntry.seq) > Number(trueSettingEntry.seq)), JSON.stringify({ flag: response.json?.config?.allowAutonomousOutbound, seq: falseSettingEntry?.seq, trueSeq: trueSettingEntry?.seq }));
await api('POST', '/api/office/mode', { mode: 'asistido', by: 'selfcheck' });

// 12-quater) t46: ACL en send-document, send y docs send-email
async function createLabeledDoc(title, label) {
  const created = await api('POST', '/api/docs', { type: 'docx', title, sections: [{ heading: 'Resumen', level: 1 }, { paragraph: title }] });
  const id = created.json?.id;
  const labeled = await api('PUT', `/api/acl/documents/${encodeURIComponent(id)}`, { label, owner: 'selfcheck', by: 'selfcheck' });
  check(`etiqueta ACL ${label} en documento`, labeled.status === 200 && labeled.json?.item?.label === label, labeled.text.slice(0, 180));
  return { id, filename: created.json?.filename };
}
const aclReserved = await createLabeledDoc('ACL reservado', 'reservado');
const aclInternal = await createLabeledDoc('ACL interno', 'interno');
const aclPublic = await createLabeledDoc('ACL público', 'público');
const proposalsBeforeAcl = (await api('GET', '/api/office/proposals?limit=1')).json?.total;
const reservedInboxBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
response = await api('POST', '/api/channels/send-document', { docId: aclReserved.id, channel: 'simulator', to: 'tercero-acl', caption: 'Reservado sin confirmar' });
check('reservado→externo sin confirmar → 403 ACL_DENIED', response.status === 403 && response.json?.code === 'ACL_DENIED' && response.json?.details?.level === 'N3' && response.json?.details?.label === 'reservado', response.text.slice(0, 260));
check('ACL_DENIED no crea propuesta', ((await api('GET', '/api/office/proposals?limit=1')).json?.total || 0) === (proposalsBeforeAcl || 0));
response = await api('POST', '/api/channels/send-document', { docId: aclReserved.id, channel: 'simulator', to: 'tercero-acl', caption: 'Reservado confirmado', confirmedReserved: true });
const aclN3Proposal = response.json?.proposal?.id;
check('reservado confirmado → 202 N3 con meta.acl', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.proposal?.level === 'N3' && response.json?.proposal?.meta?.acl?.label === 'reservado' && Number(response.json?.proposal?.risk?.score) >= 7 && (response.json?.proposal?.flags || []).includes('ACL_RESERVED') && (response.json?.proposal?.attachments || []).includes(aclReserved.id), response.text.slice(0, 340));
const aclN3Approve = await api('POST', `/api/office/proposals/${aclN3Proposal}/approve`, { by: 'jefe' });
const aclN3Code = aclN3Approve.json?.code;
check('ACL N3 confirmado exige código al aprobar', typeof aclN3Code === 'string' && aclN3Code.length === 6, String(aclN3Code));
const aclN3NoCode = await api('POST', `/api/office/proposals/${aclN3Proposal}/execute`, {});
check('ACL N3 sin código no ejecuta', aclN3NoCode.status === 400 && aclN3NoCode.json?.code === 'CODE_REQUIRED', aclN3NoCode.text.slice(0, 160));
const aclN3Exec = await api('POST', `/api/office/proposals/${aclN3Proposal}/execute`, { code: aclN3Code });
check('ACL N3 con código envía 1 documento', aclN3Exec.status === 200 && aclN3Exec.json?.status === 'executed' && ((await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0) === reservedInboxBefore + 1, aclN3Exec.text.slice(0, 220));

response = await api('POST', '/api/channels/send-document', { docId: aclInternal.id, channel: 'simulator', to: 'tercero-acl', caption: 'Interno externo' });
check('interno→externo → 202 N2 con aviso ACL', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.acl?.label === 'interno' && response.json?.acl?.requiresConfirmation === true && response.json?.proposal?.meta?.acl?.label === 'interno' && response.json?.proposal?.level === 'N2', response.text.slice(0, 300));
response = await api('POST', '/api/channels/send-document', { docId: aclPublic.id, channel: 'simulator', to: 'tercero-acl', caption: 'Público' });
check('público→externo → 202 normal con meta ACL público', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.proposal?.meta?.acl?.label === 'público' && response.json?.acl?.requiresConfirmation === false, response.text.slice(0, 260));

process.env.ACL_INTERNAL_CONTACTS = 'owner@example.com';
try {
  response = await api('POST', '/api/channels/send-document', { docId: aclInternal.id, channel: 'email', to: 'owner@example.com', caption: 'Interno interno' });
} finally {
  delete process.env.ACL_INTERNAL_CONTACTS;
}
check('interno→interno → 202 sin aviso ACL', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.acl?.label === 'interno' && response.json?.acl?.requiresConfirmation === false, response.text.slice(0, 260));

await api('POST', '/api/office/mode', { mode: 'total', by: 'selfcheck' });
await api('POST', '/api/channels/approvals/config', { allowAutonomousOutbound: true });
const aclWarnInboxBefore = (await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0;
response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-sim', body: 'Interno con aviso ACL', label: 'interno' });
check('aviso ACL bloquea autonomía (sigue pending)', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.auto === false && response.json?.executed === false && response.json?.acl?.requiresConfirmation === true && ((await api('GET', '/api/channels/inbox?channel=simulator&limit=100')).json?.count || 0) === aclWarnInboxBefore, response.text.slice(0, 260));
await api('POST', '/api/channels/approvals/config', { allowAutonomousOutbound: false });
await api('POST', '/api/office/mode', { mode: 'asistido', by: 'selfcheck' });

response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-acl', body: 'Texto reservado', label: 'reservado' });
check('/send reservado→externo → 403 ACL_DENIED', response.status === 403 && response.json?.code === 'ACL_DENIED' && response.json?.details?.label === 'reservado', response.text.slice(0, 240));
response = await api('POST', '/api/channels/simulator/send', { to: 'tercero-acl', body: 'Texto con doc reservado', docId: aclReserved.id });
check('/send con docId reservado → 403 ACL_DENIED', response.status === 403 && response.json?.code === 'ACL_DENIED' && response.json?.details?.label === 'reservado', response.text.slice(0, 240));

const mailAclBefore = mock.gmail.sends.length;
response = await api('POST', `/api/docs/${aclReserved.id}/send-email`, { to: ['tercero-acl@example.com'], subject: 'ACL reservado', body: 'Intento bloqueado' });
check('/docs send-email reservado→externo → 403 ACL_DENIED', response.status === 403 && response.json?.code === 'ACL_DENIED' && mock.gmail.sends.length === mailAclBefore, response.text.slice(0, 260));
response = await api('POST', `/api/docs/${aclReserved.id}/send-email`, { to: ['tercero-acl@example.com'], subject: 'ACL reservado', body: 'Confirmado', confirmedReserved: true });
check('/docs send-email reservado confirmado → 202 N3', response.status === 202 && response.json?.status === 'pending_approval' && response.json?.proposal?.level === 'N3' && response.json?.proposal?.meta?.acl?.label === 'reservado' && mock.gmail.sends.length === mailAclBefore, response.text.slice(0, 300));

const ledgerAcl = await api('GET', '/api/office/ledger?limit=200');
check('ledger registra acl.enforced del bloqueo y del N3', (ledgerAcl.json?.items || []).some((entry) => entry.action === 'acl.enforced' && entry.payload?.label === 'reservado' && entry.payload?.allowed === false) && (ledgerAcl.json?.items || []).some((entry) => entry.action === 'acl.enforced' && entry.payload?.label === 'reservado' && entry.payload?.allowed === true), response.text.slice(0, 220));

const proposalsBeforeAclDown = (await api('GET', '/api/office/proposals?limit=1')).json?.total;
process.env.CHANNELS_TEST_DISABLE_ACL = '1';
try {
  response = await api('POST', '/api/channels/send-document', { docId: aclPublic.id, channel: 'simulator', to: 'tercero-acl' });
} finally {
  delete process.env.CHANNELS_TEST_DISABLE_ACL;
}
check('ACL no disponible → 503 ACL_UNAVAILABLE y sin propuesta', response.status === 503 && response.json?.code === 'ACL_UNAVAILABLE' && ((await api('GET', '/api/office/proposals?limit=1')).json?.total || 0) === (proposalsBeforeAclDown || 0), response.text.slice(0, 220));

resetLimiters();

section('7. Seguridad, rate limit y contratos heredados');

response = await api('GET', '/api/channels');
const channelsText = response.text;
const leaked = [WA_TOKEN, TG_TOKEN, 'wa-app-secret-123', 'tg-webhook-secret-123', 'refresh-mock', 'mock-secret', webhookToken]
  .filter((secret) => typeof secret === 'string' && secret.length > 5 && channelsText.includes(secret));
check('GET /api/channels no filtra secretos', leaked.length === 0, `fugados=${leaked.map((item) => item.slice(0, 6)).join(',')}`);

response = await api('GET', '/api/channels/inbox?limit=200');
const inboxText = response.text;
check('la bandeja no filtra secretos', ![WA_TOKEN, TG_TOKEN, 'refresh-mock', webhookToken].some((secret) => typeof secret === 'string' && inboxText.includes(secret)));

const dataText = fs.readFileSync(path.join(dataDir, 'agenda-data.json'), 'utf8');
const leakedOnDisk = [WA_TOKEN, TG_TOKEN, 'refresh-mock', 'mock-secret', 'wa-app-secret-123', webhookToken]
  .filter((secret) => typeof secret === 'string' && secret.length > 5 && dataText.includes(secret));
check('los secretos están cifrados en disco', leakedOnDisk.length === 0, `fugados=${leakedOnDisk.map((item) => item.slice(0, 6)).join(',')}`);

response = await api('GET', '/api/health');
check('health conserva la forma heredada de channels', !!response.json?.channels?.whatsapp && typeof response.json.channels.whatsapp.configured === 'boolean' && !!response.json.channels.telegram && !!response.json.channels.email);

response = await api('GET', '/api/bootstrap');
check('bootstrap sigue funcionando con canales', response.status === 200 && typeof response.json?.channels === 'object');

// Aviso proactivo del scheduler (t8) por todos los canales activos
const telegramSentBefore = mock.telegram.sent.length;
const waSentBefore = mock.whatsapp.sends.length;
const mailSentBefore = mock.gmail.sends.length;
const notified = await channels.notifyChannels('Recordatorio de prueba P95', { subject: 'Recordatorio P95' });
check('notifyChannels (scheduler) envía por WhatsApp, Telegram y correo', notified.length === 3 && notified.every((item) => item.ok), JSON.stringify(notified));
check('el aviso proactivo usa plantilla de WhatsApp', mock.whatsapp.sends.length > waSentBefore && mock.whatsapp.sends[mock.whatsapp.sends.length - 1].type === 'template');
check('el aviso proactivo llega a Telegram y Gmail', mock.telegram.sent.length > telegramSentBefore && mock.gmail.sends.length > mailSentBefore);

// Rate limit del simulador: 60/min por IP
let saw429 = false;
for (let index = 0; index < 65 && !saw429; index += 1) {
  const attempt = await api('POST', '/api/channels/simulate', { text: 'balance' });
  if (attempt.status === 429) saw429 = true;
}
check('rate limit del simulador → 429', saw429);

response = await api('GET', '/api/channels/health');
check('salud de canales responde', response.status === 200 && response.json?.ok === true && Array.isArray(response.json?.channels));

/* ------------------------------------------------------------------ */
/* Resumen                                                            */
/* ------------------------------------------------------------------ */
channels.stopChannels();
await sleep(200);
appServer.closeIdleConnections?.();
mockServer.closeIdleConnections?.();
await new Promise((resolve) => appServer.close(resolve));
await new Promise((resolve) => mockServer.close(resolve));
try {
  const { store } = await import('../store.mjs');
  await store.flush();
} catch { /* ignore */ }

const total = results.pass + results.fail;
console.log(`\n${'─'.repeat(60)}`);
console.log(`Resultado: ${results.pass}/${total} comprobaciones OK · ${results.fail} fallos`);
if (results.fail) {
  console.log('\nFallos:');
  for (const failure of results.failures) console.log(` - [${failure.section}] ${failure.name}${failure.detail ? ` :: ${failure.detail}` : ''}`);
  console.log(`\nDATA_DIR conservado para inspección: ${dataDir}`);
  process.exitCode = 1;
} else if (process.env.KEEP_DATA === '1') {
  console.log(`DATA_DIR conservado: ${dataDir}`);
} else {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('DATA_DIR temporal eliminado.');
}
// Salida explícita: evita que sockets keep-alive de undici retrasen el cierre.
process.exit(results.fail ? 1 : 0);

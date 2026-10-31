/**
 * Tests de webhooks: firmas (WhatsApp HMAC y Telegram secret), router correcto
 * (channels gana a core) y NO-DUPLICACIÓN de entregas reintentadas.
 *
 * Comprueba efectos en los datos (un solo mensaje procesado), no logs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTempDataDir, importLib, startTestApp, startMockServer, api, waitFor, clone } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-webhooks-');
const WA_TOKEN = 'qa-wa-token';
const WA_PHONE_ID = '111222333';
const WA_APP_SECRET = 'qa-app-secret';
const TG_TOKEN = '999:qa-tg-token';
const TG_SECRET = 'qa-tg-secret';

const sent = { whatsapp: [], telegram: [], getMe: 0 };
const mock = await startMockServer(async (req, body, reply) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  const graph = /^\/v25\.0\/(\d+)(\/messages)?$/.exec(pathname);
  if (graph) {
    if (String(req.headers.authorization || '') !== `Bearer ${WA_TOKEN}`) {
      return reply(401, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });
    }
    if (!graph[2]) {
      return reply(200, { id: graph[1], display_phone_number: '+57 300 111 2233', verified_name: 'QA Mock', quality_rating: 'GREEN' });
    }
    const payload = JSON.parse(body.toString('utf8') || '{}');
    sent.whatsapp.push(payload);
    return reply(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${sent.whatsapp.length}` }] });
  }
  const tg = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(pathname);
  if (tg) {
    if (tg[1] !== TG_TOKEN) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = tg[2];
    if (method === 'getMe') {
      sent.getMe += 1;
      return reply(200, { ok: true, result: { id: 111, is_bot: true, username: 'qa_agenda_bot', first_name: 'QA' } });
    }
    if (method === 'sendMessage') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      sent.telegram.push(payload);
      return reply(200, { ok: true, result: { message_id: 5000 + sent.telegram.length, chat: { id: payload.chat_id }, text: payload.text } });
    }
    return reply(200, { ok: true, result: true });
  }
  return reply(404, { error: { message: `mock sin ruta ${pathname}` } });
});

process.env.WA_GRAPH_BASE = mock.url;
process.env.TELEGRAM_API_BASE = mock.url;

const { store } = await importLib('lib/store.mjs');
const app = await startTestApp();

test.after(async () => {
  await app.close();
  await mock.close();
});

function whatsappPayload(messageId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA-QA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: WA_PHONE_ID },
          messages: [{
            from: '573001112233',
            id: messageId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: 'HOY' }
          }]
        }
      }]
    }]
  };
}

async function postWhatsApp(payload, { secret = WA_APP_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return api(app.base, 'POST', '/api/whatsapp/webhook', raw, {
    'content-type': 'application/json',
    'x-hub-signature-256': signature
  });
}

function channelMessages() {
  return store.get().channelState?.messages || [];
}

function countByDedupe(dedupeKey, status) {
  return channelMessages().filter((message) => message.dedupeKey === dedupeKey && (!status || message.status === status)).length;
}

test('router: los webhooks de WhatsApp/Telegram los sirve el módulo channels', () => {
  for (const [method, path] of [['POST', '/api/whatsapp/webhook'], ['POST', '/api/telegram/webhook']]) {
    const match = app.app.router.match(method, path);
    assert.ok(match, `${method} ${path} sin ruta`);
    assert.equal(match.route.module, 'channels', `${path} servido por ${match.route.module}`);
  }
});

test('WhatsApp: configuración vía API (mock Graph) y firma HMAC obligatoria', async () => {
  const configured = await api(app.base, 'POST', '/api/channels/whatsapp/config', {
    accessToken: WA_TOKEN,
    phoneNumberId: WA_PHONE_ID,
    appSecret: WA_APP_SECRET,
    verifyToken: 'qa-verify-token',
    defaultTo: '573001112233',
    enabled: true
  });
  assert.equal(configured.status, 200, configured.text);
  assert.equal(configured.json.item.enabled, true);
  assert.ok(!configured.text.includes(WA_TOKEN), 'el token no debe aparecer en claro');

  const bad = await postWhatsApp(whatsappPayload('wamid.BAD'), { secret: 'secreto-equivocado' });
  assert.equal(bad.status, 401, bad.text);
  assert.equal(bad.json.code, 'WEBHOOK_SIGNATURE_INVALID');
});

test('WhatsApp: el mismo message.id procesa UNA sola vez (efectos)', async () => {
  const messageId = 'wamid.QA-1';
  const dedupeKey = `msg:${messageId}`;
  const before = {
    received: countByDedupe(dedupeKey, 'received'),
    replies: countByDedupe(`${dedupeKey}:reply`, 'sent')
  };
  assert.equal(before.received, 0);

  const first = await postWhatsApp(whatsappPayload(messageId));
  assert.equal(first.status, 200, first.text);
  await waitFor(() => countByDedupe(dedupeKey, 'received') === 1, { timeoutMs: 5000 });
  await waitFor(() => countByDedupe(`${dedupeKey}:reply`, 'sent') === 1, { timeoutMs: 5000 });

  const second = await postWhatsApp(whatsappPayload(messageId));
  assert.equal(second.status, 200, second.text);
  await waitFor(() => channelMessages().some((message) => message.dedupeKey === dedupeKey && message.status === 'duplicate'), { timeoutMs: 5000 });

  assert.equal(countByDedupe(dedupeKey, 'received'), 1, 'mensaje entrante duplicado');
  assert.equal(countByDedupe(`${dedupeKey}:reply`, 'sent'), 1, 'respuesta duplicada enviada');
});

test('Telegram: config atómica con getMe, secreto obligatorio y dedupe por update_id', async () => {
  const invalid = await api(app.base, 'POST', '/api/channels/telegram/config', { botToken: '000:invalido', enabled: true });
  assert.ok(invalid.status >= 400, invalid.text);

  const configured = await api(app.base, 'POST', '/api/channels/telegram/config', {
    botToken: TG_TOKEN,
    webhookSecret: TG_SECRET,
    mode: 'webhook',
    enabled: true
  });
  assert.equal(configured.status, 200, configured.text);
  assert.equal(configured.json.item.runtime.botUsername, 'qa_agenda_bot');

  const update = {
    update_id: 9101,
    message: {
      message_id: 77,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, username: 'qa' },
      text: 'HOY'
    }
  };
  const dedupeKey = 'update:9101';

  const bad = await api(app.base, 'POST', '/api/telegram/webhook', update, { 'x-telegram-bot-api-secret-token': 'otro' });
  assert.equal(bad.status, 401, bad.text);
  assert.equal(bad.json.code, 'WEBHOOK_SIGNATURE_INVALID');

  const first = await api(app.base, 'POST', '/api/telegram/webhook', update, { 'x-telegram-bot-api-secret-token': TG_SECRET });
  assert.equal(first.status, 200, first.text);
  await waitFor(() => countByDedupe(dedupeKey, 'received') === 1, { timeoutMs: 5000 });
  await waitFor(() => countByDedupe(`${dedupeKey}:reply`, 'sent') === 1, { timeoutMs: 5000 });

  const second = await api(app.base, 'POST', '/api/telegram/webhook', update, { 'x-telegram-bot-api-secret-token': TG_SECRET });
  assert.equal(second.status, 200, second.text);
  await waitFor(() => channelMessages().some((message) => message.dedupeKey === dedupeKey && message.status === 'duplicate'), { timeoutMs: 5000 });

  assert.equal(countByDedupe(dedupeKey, 'received'), 1, 'update duplicado procesado dos veces');
  assert.equal(countByDedupe(`${dedupeKey}:reply`, 'sent'), 1,
    `respuestas telegram=${JSON.stringify(channelMessages().filter((m) => String(m.dedupeKey).includes('9101')).map((m) => `${m.dedupeKey}|${m.status}`))}`);
});

test('webhook genérico: token del canal y dedupe de la misma entrega', async () => {
  const created = await api(app.base, 'POST', '/api/channels/webhook:qa-hook/config', {
    label: 'QA hook',
    outboundUrl: `${mock.url}/outbox`,
    preset: 'n8n'
  });
  assert.equal(created.status, 200, created.text);
  const token = created.json.generatedToken;
  assert.ok(typeof token === 'string' && token.length >= 32, `token=${created.text.slice(0, 200)}`);

  const matches = () => channelMessages().filter((message) => String(message.dedupeKey || '').includes('gen-qa-1'));
  const payload = { id: 'gen-qa-1', user: 'qa-user', text: 'HOY' };
  const headers = { authorization: `Bearer ${token}` };
  const first = await api(app.base, 'POST', '/api/channels/inbound/webhook:qa-hook', payload, headers);
  assert.equal(first.status, 200, first.text);
  await waitFor(() => matches().some((message) => message.status === 'received'), { timeoutMs: 5000 });
  assert.equal(matches().filter((message) => message.status === 'received').length, 1);

  const second = await api(app.base, 'POST', '/api/channels/inbound/webhook:qa-hook', clone(payload), headers);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.duplicate, true, second.text);
  assert.equal(matches().filter((message) => message.status === 'received').length, 1);

  const blocked = await api(app.base, 'POST', '/api/channels/inbound/webhook:qa-hook', payload, { authorization: 'Bearer token-falso' });
  assert.equal(blocked.status, 401, blocked.text);
});

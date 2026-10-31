/**
 * Bandejas IMAP propias: CRUD, prueba de conexión y últimos mensajes.
 * Solo lectura; nunca borra ni marca como leído (BODY.PEEK).
 */
import { HttpError } from '../http/errors.mjs';
import { getChannelRuntime } from '../channels.mjs';
import { checkImapAccount, setImapAutoDraft } from '../channel/imap.mjs';
import { autoDraftNew } from '../channel/imap-auto.mjs';
import { imapWatchStatus, startImapWatch } from '../channel/imap-watch.mjs';
import { buildReplyProposal } from '../channel/imap-reply.mjs';
import {
  createImapAccount, deleteImapAccount, fetchImapMessages, listImapAccounts,
  recordImapError, testImapAccount
} from '../channel/imap.mjs';

export const name = 'imap-accounts';
export const priority = 245;

function toHttp(error) {
  if (error instanceof HttpError) return error;
  const status = Number(error?.status) || (error?.code === 'IMAP_NOT_FOUND' ? 404 : 400);
  return new HttpError(status, error?.code || 'IMAP_ERROR', error?.message || 'Error de bandeja IMAP.');
}

async function bodyObject(ctx, { allowEmpty = true } = {}) {
  const body = await ctx.body();
  if (body === undefined || body === null) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  return body;
}

async function checkRoute(ctx) {
  try {
    const result = await checkImapAccount(ctx.params.id);
    return ctx.json(200, { ok: true, ...result, watch: imapWatchStatus() });
  } catch (error) {
    throw toHttp(error);
  }
}
async function patchRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  if (typeof body.autoDraft !== 'boolean') {
    throw new HttpError(400, 'VALIDATION', 'Solo se puede cambiar autoDraft (true|false).', { field: 'autoDraft' });
  }
  try {
    return ctx.json(200, { ok: true, item: await setImapAutoDraft(ctx.params.id, body.autoDraft) });
  } catch (error) {
    throw toHttp(error);
  }
}

async function autoDraftRoute(ctx) {
  try {
    const result = await autoDraftNew(ctx.params.id, { registry: getChannelRuntime().registry });
    return ctx.json(200, { ok: true, ...result });
  } catch (error) {
    throw toHttp(error);
  }
}
async function listRoute(ctx) {
  const items = listImapAccounts();
  return ctx.json(200, { ok: true, items, count: items.length, watch: imapWatchStatus() });
}

async function createRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  try {
    return ctx.json(201, { ok: true, item: await createImapAccount(body) });
  } catch (error) {
    throw toHttp(error);
  }
}

async function deleteRoute(ctx) {
  try {
    return ctx.json(200, { ok: true, item: await deleteImapAccount(ctx.params.id), deleted: true });
  } catch (error) {
    throw toHttp(error);
  }
}

async function testRoute(ctx) {
  try {
    return ctx.json(200, { ok: true, ...await testImapAccount(ctx.params.id) });
  } catch (error) {
    await recordImapError(ctx.params.id, error);
    throw toHttp(error);
  }
}

async function messagesRoute(ctx) {
  const limit = Number(new URL(ctx.req.url, 'http://local').searchParams.get('limit') || 5);
  try {
    return ctx.json(200, { ok: true, ...await fetchImapMessages(ctx.params.id, { limit }) });
  } catch (error) {
    await recordImapError(ctx.params.id, error);
    throw toHttp(error);
  }
}

async function replyProposalRoute(ctx) {
  const body = await bodyObject(ctx);
  try {
    const result = await buildReplyProposal(ctx.params.id, ctx.params.uid, {
      instructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 600) : '',
      preview: body.preview === true,
      body: typeof body.body === 'string' ? body.body : null,
      subject: typeof body.subject === 'string' ? body.subject : null,
      registry: getChannelRuntime().registry
    });
    return ctx.json(result.preview ? 200 : 202, { ok: true, ...result });
  } catch (error) {
    throw toHttp(error);
  }
}
export const routes = [
  { method: 'GET', path: '/api/imap/accounts', name: 'imap.accounts.list', handler: listRoute },
  { method: 'POST', path: '/api/imap/accounts', name: 'imap.accounts.create', handler: createRoute },
  { method: 'DELETE', path: '/api/imap/accounts/:id', name: 'imap.accounts.delete', handler: deleteRoute },
  { method: 'POST', path: '/api/imap/accounts/:id/test', name: 'imap.accounts.test', handler: testRoute },
  { method: 'GET', path: '/api/imap/accounts/:id/messages', name: 'imap.accounts.messages', handler: messagesRoute },
  { method: 'PATCH', path: '/api/imap/accounts/:id', name: 'imap.accounts.patch', handler: patchRoute },
  { method: 'POST', path: '/api/imap/accounts/:id/auto-draft', name: 'imap.accounts.autoDraft', handler: autoDraftRoute },
  { method: 'POST', path: '/api/imap/accounts/:id/check', name: 'imap.accounts.check', handler: checkRoute },
  { method: 'POST', path: '/api/imap/accounts/:id/messages/:uid/reply-proposal', name: 'imap.accounts.reply', handler: replyProposalRoute }
];


// Vigilancia en segundo plano (se apaga en pruebas con CHANNELS_AUTOSTART=off).
try {
  startImapWatch({ registry: getChannelRuntime().registry });
} catch {
  /* nunca impide arrancar la app */
}





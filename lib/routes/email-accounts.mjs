/**
 * Cuentas SMTP propias: CRUD y prueba de envío real sin Google.
 *
 * La contraseña entra por POST/PATCH, se cifra en el store y nunca se
 * devuelve; las vistas solo indican `hasPassword`.
 */
import { HttpError } from '../http/errors.mjs';
import {
  createAccount, deleteAccount, listAccounts, testAccount, updateAccount
} from '../channel/smtp.mjs';

export const name = 'email-accounts';
export const priority = 250;

function toHttp(error) {
  if (error instanceof HttpError) return error;
  const status = Number(error?.status) || (error?.code === 'SMTP_NOT_FOUND' ? 404 : 400);
  return new HttpError(status, error?.code || 'SMTP_ERROR', error?.message || 'Error de correo SMTP.');
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

async function listRoute(ctx) {
  return ctx.json(200, { ok: true, items: listAccounts(), count: listAccounts().length });
}

async function createRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  try {
    const item = await createAccount(body);
    return ctx.json(201, { ok: true, item });
  } catch (error) {
    throw toHttp(error);
  }
}

async function patchRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  try {
    const item = await updateAccount(ctx.params.id, body);
    return ctx.json(200, { ok: true, item });
  } catch (error) {
    throw toHttp(error);
  }
}

async function deleteRoute(ctx) {
  try {
    const item = await deleteAccount(ctx.params.id);
    return ctx.json(200, { ok: true, item, deleted: true });
  } catch (error) {
    throw toHttp(error);
  }
}

async function testRoute(ctx) {
  const body = await bodyObject(ctx);
  try {
    const result = await testAccount(ctx.params.id, { to: body.to || null });
    return ctx.json(200, { ok: true, ...result });
  } catch (error) {
    throw toHttp(error);
  }
}

export const routes = [
  { method: 'GET', path: '/api/email/accounts', name: 'email.accounts.list', handler: listRoute },
  { method: 'POST', path: '/api/email/accounts', name: 'email.accounts.create', handler: createRoute },
  { method: 'PATCH', path: '/api/email/accounts/:id', name: 'email.accounts.patch', handler: patchRoute },
  { method: 'DELETE', path: '/api/email/accounts/:id', name: 'email.accounts.delete', handler: deleteRoute },
  { method: 'POST', path: '/api/email/accounts/:id/test', name: 'email.accounts.test', handler: testRoute }
];

/**
 * Reglas de correo y cuarentena revisable.
 *
 *   GET    /api/mail/rules
 *   POST   /api/mail/rules            {field, match, value, action}
 *   DELETE /api/mail/rules/:id
 *   GET    /api/mail/quarantine?status=held&limit=
 *   POST   /api/mail/quarantine/:id/release  {compose?:true}
 *   POST   /api/mail/quarantine/:id/discard
 *
 * Retener no envía ni responde: solo aparta el mensaje. «Redactar» compone una
 * propuesta N2 y la deja en la Oficina para aprobación.
 */
import { HttpError } from '../http/errors.mjs';
import { bodyOf, paramOf, queryInt, queryString } from '../agenda/http.mjs';
import {
  addRule, deleteRule, discardQuarantine, getQuarantine, listQuarantine,
  listRules, releaseQuarantine
} from '../channel/mail-guard.mjs';
import { buildReplyProposal } from '../channel/imap-reply.mjs';
import { getChannelRuntime } from '../channels.mjs';

export const name = 'mail-rules';
export const priority = 246;

async function bodyObject(ctx, { allowEmpty = true } = {}) {
  const body = await bodyOf(ctx);
  if (body === undefined || body === null) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  return body;
}

function rulesRoute(ctx) {
  const items = listRules();
  return ctx.json(200, { ok: true, items, count: items.length });
}

async function createRuleRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await addRule({
    field: body.field,
    match: body.match,
    value: body.value,
    action: body.action,
    enabled: body.enabled
  });
  return ctx.json(201, { ok: true, item });
}

async function deleteRuleRoute(ctx) {
  const item = await deleteRule(paramOf(ctx, 'id'));
  return ctx.json(200, { ok: true, item, deleted: true });
}

function quarantineRoute(ctx) {
  const result = listQuarantine({
    status: queryString(ctx, 'status', 'held'),
    limit: queryInt(ctx, 'limit', 50, { min: 1, max: 100 })
  });
  return ctx.json(200, { ok: true, ...result });
}

async function releaseRoute(ctx) {
  const id = paramOf(ctx, 'id');
  const item = getQuarantine(id);
  if (!item) throw new HttpError(404, 'NOT_FOUND', `No existe el elemento ${id}.`);
  const body = await bodyObject(ctx);
  let proposal = null;
  if (body.compose !== false && item.accountId && item.uid) {
    const result = await buildReplyProposal(item.accountId, item.uid, {
      registry: getChannelRuntime().registry,
      instructions: ''
    });
    proposal = result.proposal || null;
  }
  const released = await releaseQuarantine(id);
  return ctx.json(200, { ok: true, item: released, proposal });
}

async function discardRoute(ctx) {
  const item = await discardQuarantine(paramOf(ctx, 'id'));
  return ctx.json(200, { ok: true, item });
}

export const routes = [
  { method: 'GET', path: '/api/mail/rules', name: 'mail.rules.list', handler: rulesRoute },
  { method: 'POST', path: '/api/mail/rules', name: 'mail.rules.create', handler: createRuleRoute },
  { method: 'DELETE', path: '/api/mail/rules/:id', name: 'mail.rules.delete', handler: deleteRuleRoute },
  { method: 'GET', path: '/api/mail/quarantine', name: 'mail.quarantine.list', handler: quarantineRoute },
  { method: 'POST', path: '/api/mail/quarantine/:id/release', name: 'mail.quarantine.release', handler: releaseRoute },
  { method: 'POST', path: '/api/mail/quarantine/:id/discard', name: 'mail.quarantine.discard', handler: discardRoute }
];


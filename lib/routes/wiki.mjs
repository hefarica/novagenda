/**
 * API de la Wiki interna de la oficina (memoria escrita consultable).
 *
 *   GET    /api/wiki/pages?q=&tag=&limit=&offset=
 *   POST   /api/wiki/pages           {title, body, tags?}
 *   GET    /api/wiki/pages/:id
 *   PATCH  /api/wiki/pages/:id       {title?, body?, tags?}
 *   DELETE /api/wiki/pages/:id
 *   GET    /api/wiki/stats
 *
 * Auto-descubierto (priority 118), autenticación normal. Las páginas viven en
 * `data.wiki.pages` y se escapan siempre en la UI.
 */
import { HttpError } from '../http/errors.mjs';
import {
  bodyOf, paramOf, queryInt, queryString
} from '../agenda/http.mjs';
import {
  createPage, deletePage, getPage, listPages, updatePage, wikiStats
} from '../wiki/store.mjs';

export const name = 'wiki';
export const priority = 118;

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

function listRoute(ctx) {
  const result = listPages({
    q: queryString(ctx, 'q', ''),
    tag: queryString(ctx, 'tag', ''),
    limit: queryInt(ctx, 'limit', 50, { min: 1, max: 100 }),
    offset: queryInt(ctx, 'offset', 0, { min: 0, max: 500 })
  });
  return ctx.json(200, { ok: true, ...result });
}

function getRoute(ctx) {
  const item = getPage(paramOf(ctx, 'id'));
  if (!item) throw new HttpError(404, 'NOT_FOUND', `No existe la página ${paramOf(ctx, 'id')}.`);
  return ctx.json(200, { ok: true, item });
}

async function createRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await createPage({ title: body.title, body: body.body, tags: body.tags });
  return ctx.json(201, { ok: true, item });
}

async function patchRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await updatePage(paramOf(ctx, 'id'), {
    title: body.title,
    body: body.body,
    tags: body.tags
  });
  return ctx.json(200, { ok: true, item });
}

async function deleteRoute(ctx) {
  const item = await deletePage(paramOf(ctx, 'id'));
  return ctx.json(200, { ok: true, item, deleted: true });
}

function statsRoute(ctx) {
  return ctx.json(200, { ok: true, ...wikiStats() });
}

export const routes = [
  { method: 'GET', path: '/api/wiki/pages', name: 'wiki.pages.list', handler: listRoute },
  { method: 'POST', path: '/api/wiki/pages', name: 'wiki.pages.create', handler: createRoute },
  { method: 'GET', path: '/api/wiki/stats', name: 'wiki.stats', handler: statsRoute },
  { method: 'GET', path: '/api/wiki/pages/:id', name: 'wiki.pages.get', handler: getRoute },
  { method: 'PATCH', path: '/api/wiki/pages/:id', name: 'wiki.pages.patch', handler: patchRoute },
  { method: 'DELETE', path: '/api/wiki/pages/:id', name: 'wiki.pages.delete', handler: deleteRoute }
];


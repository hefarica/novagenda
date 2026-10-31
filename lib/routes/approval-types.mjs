/**
 * Tipos de aprobación y solicitudes declarativas.
 *
 *   GET    /api/approval-types
 *   POST   /api/approval-types                 {name, level, fields, description?}
 *   DELETE /api/approval-types/:id
 *   GET    /api/approval-requests?status=
 *   POST   /api/approval-requests              {typeId, title, values}
 *   POST   /api/approval-requests/:id/approve  {by, reason?}
 *   POST   /api/approval-requests/:id/reject   {by, reason?}
 */
import { bodyOf, paramOf, queryString, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import {
  approvalsStats, createRequest, createType, decideRequest, deleteType, listRequests, listTypes,
  updateType
} from '../approvals/store.mjs';
import { HttpError } from '../http/errors.mjs';
import { isPlainObject } from '../validate.mjs';

export const name = 'approval-types';
export const priority = 131;

async function objectBody(ctx) {
  const body = await bodyOf(ctx);
  if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  return body;
}

function typesRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...listTypes(store.get()) });
}

function requestsRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...listRequests(store.get(), { status: queryString(ctx, 'status', '') || null }) });
}

function statsRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...approvalsStats(store.get()) });
}

async function createTypeRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = createType(data, body); }, { label: 'approval-type' });
  return respond(ctx, 201, { ok: true, item });
}

async function patchTypeRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = updateType(data, paramOf(ctx, 'id'), body); }, { label: 'approval-type' });
  return respond(ctx, 200, { ok: true, item });
}

async function deleteTypeRoute(ctx) {
  let item;
  await store.mutate((data) => { item = deleteType(data, paramOf(ctx, 'id')); }, { label: 'approval-type' });
  return respond(ctx, 200, { ok: true, item, deleted: true });
}

async function createRequestRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = createRequest(data, body); }, { label: 'approval-request' });
  return respond(ctx, 201, { ok: true, item });
}

async function approveRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = decideRequest(data, paramOf(ctx, 'id'), { decision: 'approved', ...body }); }, { label: 'approval-request' });
  return respond(ctx, 200, { ok: true, item });
}

async function rejectRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = decideRequest(data, paramOf(ctx, 'id'), { decision: 'rejected', ...body }); }, { label: 'approval-request' });
  return respond(ctx, 200, { ok: true, item });
}

export const routes = [
  { method: 'GET', path: '/api/approval-types', name: 'approvalTypes.list', handler: route(typesRoute) },
  { method: 'POST', path: '/api/approval-types', name: 'approvalTypes.create', handler: route(createTypeRoute) },
  { method: 'PATCH', path: '/api/approval-types/:id', name: 'approvalTypes.update', handler: route(patchTypeRoute) },
  { method: 'DELETE', path: '/api/approval-types/:id', name: 'approvalTypes.delete', handler: route(deleteTypeRoute) },
  { method: 'GET', path: '/api/approval-requests', name: 'approvalRequests.list', handler: route(requestsRoute) },
  { method: 'POST', path: '/api/approval-requests', name: 'approvalRequests.create', handler: route(createRequestRoute) },
  { method: 'POST', path: '/api/approval-requests/:id/approve', name: 'approvalRequests.approve', handler: route(approveRoute) },
  { method: 'POST', path: '/api/approval-requests/:id/reject', name: 'approvalRequests.reject', handler: route(rejectRoute) },
  { method: 'GET', path: '/api/approval-types/stats', name: 'approvalTypes.stats', handler: route(statsRoute) }
];

export default { name, priority, routes };

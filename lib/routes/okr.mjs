/**
 * Objetivos y resultados clave (OKR).
 *
 *   GET    /api/okr/objectives?status=&q=
 *   POST   /api/okr/objectives
 *   GET    /api/okr/objectives/:id
 *   PATCH  /api/okr/objectives/:id
 *   DELETE /api/okr/objectives/:id
 *   POST   /api/okr/objectives/:id/key-results
 *   PATCH  /api/okr/objectives/:id/key-results/:krId
 *   DELETE /api/okr/objectives/:id/key-results/:krId
 *   GET    /api/okr/stats
 *
 * Auto-descubierto (priority 128). Mutaciones vía `store.mutate` + ledger
 * (`okr.change`).
 */
import { bodyOf, paramOf, queryString, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import {
  addKeyResult, createObjective, deleteKeyResult, deleteObjective, getObjective,
  listObjectives, okrStats, updateKeyResult, updateObjective
} from '../okr/store.mjs';
import { HttpError } from '../http/errors.mjs';
import { isPlainObject } from '../validate.mjs';

export const name = 'okr';
export const priority = 128;

async function objectBody(ctx) {
  const body = await bodyOf(ctx);
  if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  return body;
}

function listRoute(ctx) {
  const status = queryString(ctx, 'status', '');
  const q = queryString(ctx, 'q', '');
  return respond(ctx, 200, { ok: true, ...listObjectives(store.get(), { status: status || null, q }) });
}

function getRoute(ctx) {
  return respond(ctx, 200, { ok: true, item: getObjective(store.get(), paramOf(ctx, 'id')) });
}

async function createRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = createObjective(data, body); }, { label: 'okr-objective' });
  return respond(ctx, 201, { ok: true, item });
}

async function patchRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = updateObjective(data, paramOf(ctx, 'id'), body); }, { label: 'okr-objective' });
  return respond(ctx, 200, { ok: true, item });
}

async function deleteRoute(ctx) {
  let item;
  await store.mutate((data) => { item = deleteObjective(data, paramOf(ctx, 'id')); }, { label: 'okr-objective' });
  return respond(ctx, 200, { ok: true, item, deleted: true });
}

async function addKeyResultRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = addKeyResult(data, paramOf(ctx, 'id'), body); }, { label: 'okr-kr' });
  return respond(ctx, 201, { ok: true, item });
}

async function patchKeyResultRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => {
    item = updateKeyResult(data, paramOf(ctx, 'id'), paramOf(ctx, 'krId'), body);
  }, { label: 'okr-kr' });
  return respond(ctx, 200, { ok: true, item });
}

async function deleteKeyResultRoute(ctx) {
  let item;
  await store.mutate((data) => {
    item = deleteKeyResult(data, paramOf(ctx, 'id'), paramOf(ctx, 'krId'));
  }, { label: 'okr-kr' });
  return respond(ctx, 200, { ok: true, item, deleted: true });
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportRoute(ctx) {
  const rows = [];
  for (const objective of listObjectives(store.get()).items) {
    const krs = Array.isArray(objective.keyResults) ? objective.keyResults : [];
    if (!krs.length) {
      rows.push([objective.id, objective.title, objective.owner || '', objective.quarter || '', objective.status || '', objective.progress || 0, '', '', '', '', '']);
      continue;
    }
    for (const kr of krs) {
      rows.push([
        objective.id, objective.title, objective.owner || '', objective.quarter || '', objective.status || '', objective.progress || 0,
        kr.title, kr.target, kr.current, kr.unit || '', kr.progress || 0
      ]);
    }
  }
  const header = ['ID', 'Objetivo', 'Responsable', 'Trimestre', 'Estado', 'Avance objetivo %', 'Resultado clave', 'Meta', 'Actual', 'Unidad', 'Avance KR %'];
  const body = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  ctx.res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="objetivos.csv"',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  ctx.res.end(body);
}

function statsRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...okrStats(store.get()) });
}

export const routes = [
  { method: 'GET', path: '/api/okr/export.csv', name: 'okr.export.csv', handler: route(exportRoute) },
  { method: 'GET', path: '/api/okr/stats', name: 'okr.stats', handler: route(statsRoute) },
  { method: 'GET', path: '/api/okr/objectives', name: 'okr.objectives.list', handler: route(listRoute) },
  { method: 'POST', path: '/api/okr/objectives', name: 'okr.objectives.create', handler: route(createRoute) },
  { method: 'GET', path: '/api/okr/objectives/:id', name: 'okr.objectives.get', handler: route(getRoute) },
  { method: 'PATCH', path: '/api/okr/objectives/:id', name: 'okr.objectives.update', handler: route(patchRoute) },
  { method: 'DELETE', path: '/api/okr/objectives/:id', name: 'okr.objectives.delete', handler: route(deleteRoute) },
  { method: 'POST', path: '/api/okr/objectives/:id/key-results', name: 'okr.kr.create', handler: route(addKeyResultRoute) },
  { method: 'PATCH', path: '/api/okr/objectives/:id/key-results/:krId', name: 'okr.kr.update', handler: route(patchKeyResultRoute) },
  { method: 'DELETE', path: '/api/okr/objectives/:id/key-results/:krId', name: 'okr.kr.delete', handler: route(deleteKeyResultRoute) }
];

export default { name, priority, routes };


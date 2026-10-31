/**
 * API de la Base de tablas (registros estructurados).
 *
 *   GET    /api/base/tables
 *   POST   /api/base/tables                  {name, columns}
 *   GET    /api/base/tables/:id
 *   DELETE /api/base/tables/:id
 *   POST   /api/base/tables/:id/rows         {values}
 *   PATCH  /api/base/tables/:id/rows/:rowId  {values}
 *   DELETE /api/base/tables/:id/rows/:rowId
 *
 * `columns` acepta `Nombre:texto, Fecha:fecha, Valor:número, Pagado:casilla`
 * o `[{name,type}]`. Auto-descubierto (priority 116), autenticación normal.
 */
import { HttpError } from '../http/errors.mjs';
import { bodyOf, paramOf } from '../agenda/http.mjs';
import { askBase } from '../base/ask.mjs';
import { csvFilename, rowsFromCsv, tableToCsv } from '../base/csv.mjs';
import { tableToXlsx, xlsxFilename } from '../base/xlsx.mjs';
import {
  COLUMN_TYPES, addColumn, addRow, createTable, createView, deleteColumn, deleteRow, deleteTable, deleteView, duplicateRow, getTable, importRows, listTables, renameColumn, renameTable, updateRow
} from '../base/store.mjs';

export const name = 'base';
export const priority = 116;

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
  const items = listTables();
  return ctx.json(200, { ok: true, items, count: items.length, types: [...COLUMN_TYPES] });
}

function getRoute(ctx) {
  const table = getTable(paramOf(ctx, 'id'));
  if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${paramOf(ctx, 'id')}.`);
  return ctx.json(200, { ok: true, item: table });
}

async function createRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await createTable({ name: body.name, columns: body.columns });
  return ctx.json(201, { ok: true, item });
}

async function renameRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await renameTable(paramOf(ctx, 'id'), body.name);
  return ctx.json(200, { ok: true, item });
}

async function deleteRoute(ctx) {
  const item = await deleteTable(paramOf(ctx, 'id'));
  return ctx.json(200, { ok: true, item, deleted: true });
}

async function addColumnRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const result = await addColumn(paramOf(ctx, 'id'), { name: body.name, type: body.type });
  return ctx.json(201, { ok: true, ...result });
}

async function renameColumnRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const result = await renameColumn(paramOf(ctx, 'id'), paramOf(ctx, 'columnId'), body.name);
  return ctx.json(200, { ok: true, ...result });
}

async function deleteColumnRoute(ctx) {
  const result = await deleteColumn(paramOf(ctx, 'id'), paramOf(ctx, 'columnId'));
  return ctx.json(200, { ok: true, ...result });
}

async function addRowRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await addRow(paramOf(ctx, 'id'), body.values);
  return ctx.json(201, { ok: true, item });
}

async function patchRowRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await updateRow(paramOf(ctx, 'id'), paramOf(ctx, 'rowId'), body.values);
  return ctx.json(200, { ok: true, item });
}

async function askRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const answer = askBase(body.question, { tableId: body.tableId || null });
  return ctx.json(200, { ok: true, ...answer });
}

function sendCsv(ctx, buffer, filename, contentType = 'text/csv; charset=utf-8') {
  ctx.res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
    'content-length': buffer.length,
    'cache-control': 'no-store'
  });
  ctx.res.end(buffer);
}

async function importCsvRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const table = getTable(paramOf(ctx, 'id'));
  if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${paramOf(ctx, 'id')}.`);
  if (typeof body.csv !== 'string' || !body.csv.trim()) throw new HttpError(400, 'INVALID_VALUE', 'Falta el contenido CSV.', { field: 'csv' });
  if (body.csv.length > 500000) throw new HttpError(413, 'TOO_LARGE', 'El CSV supera 500 KB.', { field: 'csv' });
  let rows;
  try {
    rows = rowsFromCsv(body.csv, table.columns);
  } catch (error) {
    throw new HttpError(400, 'INVALID_CSV', error.message, { field: 'csv' });
  }
  const created = await importRows(table.id, rows);
  return ctx.json(201, { ok: true, imported: created.length, items: created });
}

function exportXlsxRoute(ctx) {
  const table = getTable(paramOf(ctx, 'id'));
  if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${paramOf(ctx, 'id')}.`);
  const buffer = tableToXlsx(table);
  return sendCsv(ctx, buffer, xlsxFilename(table), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function exportCsvRoute(ctx) {
  const table = getTable(paramOf(ctx, 'id'));
  if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${paramOf(ctx, 'id')}.`);
  return sendCsv(ctx, Buffer.from(tableToCsv(table), 'utf8'), csvFilename(table));
}

function listViewsRoute(ctx) {
  const table = getTable(paramOf(ctx, 'id'));
  if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${paramOf(ctx, 'id')}.`);
  return ctx.json(200, { ok: true, items: table.views || [] });
}

async function createViewRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const item = await createView(paramOf(ctx, 'id'), { name: body.name, filters: body.filters, sort: body.sort });
  return ctx.json(201, { ok: true, item });
}

async function deleteViewRoute(ctx) {
  const item = await deleteView(paramOf(ctx, 'id'), paramOf(ctx, 'viewId'));
  return ctx.json(200, { ok: true, item, deleted: true });
}

async function duplicateRowRoute(ctx) {
  const item = await duplicateRow(paramOf(ctx, 'id'), paramOf(ctx, 'rowId'));
  return ctx.json(201, { ok: true, item });
}

async function deleteRowRoute(ctx) {
  const item = await deleteRow(paramOf(ctx, 'id'), paramOf(ctx, 'rowId'));
  return ctx.json(200, { ok: true, item, deleted: true });
}

export const routes = [
  { method: 'POST', path: '/api/base/ask', name: 'base.ask', handler: askRoute },
  { method: 'GET', path: '/api/base/tables', name: 'base.tables.list', handler: listRoute },
  { method: 'POST', path: '/api/base/tables', name: 'base.tables.create', handler: createRoute },
  { method: 'POST', path: '/api/base/tables/:id/import.csv', name: 'base.tables.import', handler: importCsvRoute },
  { method: 'GET', path: '/api/base/tables/:id/export.xlsx', name: 'base.tables.exportXlsx', handler: exportXlsxRoute },
  { method: 'GET', path: '/api/base/tables/:id/export.csv', name: 'base.tables.export', handler: exportCsvRoute },
  { method: 'GET', path: '/api/base/tables/:id', name: 'base.tables.get', handler: getRoute },
  { method: 'PATCH', path: '/api/base/tables/:id', name: 'base.tables.rename', handler: renameRoute },
  { method: 'DELETE', path: '/api/base/tables/:id', name: 'base.tables.delete', handler: deleteRoute },
  { method: 'GET', path: '/api/base/tables/:id/views', name: 'base.views.list', handler: listViewsRoute },
  { method: 'POST', path: '/api/base/tables/:id/views', name: 'base.views.create', handler: createViewRoute },
  { method: 'DELETE', path: '/api/base/tables/:id/views/:viewId', name: 'base.views.delete', handler: deleteViewRoute },
  { method: 'POST', path: '/api/base/tables/:id/columns', name: 'base.columns.create', handler: addColumnRoute },
  { method: 'PATCH', path: '/api/base/tables/:id/columns/:columnId', name: 'base.columns.rename', handler: renameColumnRoute },
  { method: 'DELETE', path: '/api/base/tables/:id/columns/:columnId', name: 'base.columns.delete', handler: deleteColumnRoute },
  { method: 'POST', path: '/api/base/tables/:id/rows', name: 'base.rows.create', handler: addRowRoute },
  { method: 'PATCH', path: '/api/base/tables/:id/rows/:rowId', name: 'base.rows.patch', handler: patchRowRoute },
  { method: 'POST', path: '/api/base/tables/:id/rows/:rowId/duplicate', name: 'base.rows.duplicate', handler: duplicateRowRoute },
  { method: 'DELETE', path: '/api/base/tables/:id/rows/:rowId', name: 'base.rows.delete', handler: deleteRowRoute }
];



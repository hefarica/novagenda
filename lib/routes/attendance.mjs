/**
 * Jornada: turnos, pausas y horas.
 *
 *   GET    /api/attendance?from=&to=
 *   GET    /api/attendance/summary?from=&to=
 *   POST   /api/attendance/clock-in
 *   POST   /api/attendance/clock-out
 *   POST   /api/attendance/break
 *   PATCH  /api/attendance/:id
 *   DELETE /api/attendance/:id
 */
import { bodyOf, paramOf, queryString, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import {
  addBreak, attendanceSummary, clockIn, clockOut, deleteShift, listShifts, updateShift
} from '../attendance/store.mjs';
import { HttpError } from '../http/errors.mjs';
import { isPlainObject } from '../validate.mjs';

export const name = 'attendance';
export const priority = 128;

async function objectBody(ctx) {
  const body = await bodyOf(ctx);
  if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  return body;
}

function range(ctx) {
  return { from: queryString(ctx, 'from', ''), to: queryString(ctx, 'to', '') };
}

function listRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...listShifts(store.get(), range(ctx)) });
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportRoute(ctx) {
  const result = listShifts(store.get(), range(ctx));
  const header = ['ID', 'Fecha', 'Entrada', 'Salida', 'Pausa (min)', 'Horas', 'Nota', 'Estado'];
  const rows = result.items.map((shift) => [
    shift.id,
    shift.date,
    shift.start || '',
    shift.end || '',
    shift.breakMinutes || 0,
    shift.open ? '' : (shift.minutes ?? ''),
    shift.note || '',
    shift.open ? 'abierta' : 'cerrada'
  ]);
  const body = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  ctx.res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="jornada.csv"',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  ctx.res.end(body);
}

function summaryRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...attendanceSummary(store.get(), range(ctx)) });
}

async function clockInRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = clockIn(data, body); }, { label: 'attendance-shift' });
  return respond(ctx, 201, { ok: true, item });
}

async function clockOutRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = clockOut(data, body); }, { label: 'attendance-shift' });
  return respond(ctx, 200, { ok: true, item });
}

async function breakRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = addBreak(data, body.minutes); }, { label: 'attendance-shift' });
  return respond(ctx, 200, { ok: true, item });
}

async function patchRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = updateShift(data, paramOf(ctx, 'id'), body); }, { label: 'attendance-shift' });
  return respond(ctx, 200, { ok: true, item });
}

async function deleteRoute(ctx) {
  let item;
  await store.mutate((data) => { item = deleteShift(data, paramOf(ctx, 'id')); }, { label: 'attendance-shift' });
  return respond(ctx, 200, { ok: true, item, deleted: true });
}

export const routes = [
  { method: 'GET', path: '/api/attendance/export.csv', name: 'attendance.export.csv', handler: route(exportRoute) },
  { method: 'GET', path: '/api/attendance/summary', name: 'attendance.summary', handler: route(summaryRoute) },
  { method: 'GET', path: '/api/attendance', name: 'attendance.list', handler: route(listRoute) },
  { method: 'POST', path: '/api/attendance/clock-in', name: 'attendance.clockIn', handler: route(clockInRoute) },
  { method: 'POST', path: '/api/attendance/clock-out', name: 'attendance.clockOut', handler: route(clockOutRoute) },
  { method: 'POST', path: '/api/attendance/break', name: 'attendance.break', handler: route(breakRoute) },
  { method: 'PATCH', path: '/api/attendance/:id', name: 'attendance.update', handler: route(patchRoute) },
  { method: 'DELETE', path: '/api/attendance/:id', name: 'attendance.delete', handler: route(deleteRoute) }
];

export default { name, priority, routes };

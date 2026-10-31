/**
 * Salas físicas y reservas con control de choques.
 *
 *   GET    /api/rooms?date=AAAA-MM-DD
 *   GET    /api/rooms/availability?date=
 *   POST   /api/rooms
 *   PATCH  /api/rooms/:id
 *   DELETE /api/rooms/:id
 *   POST   /api/rooms/:id/reservations
 *   DELETE /api/rooms/reservations/:id
 *   GET    /api/rooms/stats
 */
import { bodyOf, paramOf, queryString, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import {
  availability, cancelReservation, createReservation, createRoom, deleteRoom, listRooms,
  roomsStats, updateReservation, updateRoom
} from '../rooms/store.mjs';
import { HttpError } from '../http/errors.mjs';
import { isPlainObject } from '../validate.mjs';

export const name = 'rooms';
export const priority = 128;

async function objectBody(ctx) {
  const body = await bodyOf(ctx);
  if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  return body;
}

function listRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...listRooms(store.get(), { date: queryString(ctx, 'date', '') }) });
}

function availabilityRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...availability(store.get(), queryString(ctx, 'date', '')) });
}

function statsRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...roomsStats(store.get()) });
}

async function createRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = createRoom(data, body); }, { label: 'rooms-room' });
  return respond(ctx, 201, { ok: true, item });
}

async function patchRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = updateRoom(data, paramOf(ctx, 'id'), body); }, { label: 'rooms-room' });
  return respond(ctx, 200, { ok: true, item });
}

async function deleteRoute(ctx) {
  let item;
  await store.mutate((data) => { item = deleteRoom(data, paramOf(ctx, 'id')); }, { label: 'rooms-room' });
  return respond(ctx, 200, { ok: true, item, deleted: true });
}

async function reserveRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = createReservation(data, paramOf(ctx, 'id'), body); }, { label: 'rooms-reservation' });
  return respond(ctx, 201, { ok: true, item });
}

async function patchReservationRoute(ctx) {
  const body = await objectBody(ctx);
  let item;
  await store.mutate((data) => { item = updateReservation(data, paramOf(ctx, 'id'), body); }, { label: 'rooms-reservation' });
  return respond(ctx, 200, { ok: true, item });
}

async function cancelRoute(ctx) {
  let item;
  await store.mutate((data) => { item = cancelReservation(data, paramOf(ctx, 'id')); }, { label: 'rooms-reservation' });
  return respond(ctx, 200, { ok: true, item, cancelled: true });
}

export const routes = [
  { method: 'GET', path: '/api/rooms/stats', name: 'rooms.stats', handler: route(statsRoute) },
  { method: 'GET', path: '/api/rooms/availability', name: 'rooms.availability', handler: route(availabilityRoute) },
  { method: 'GET', path: '/api/rooms', name: 'rooms.list', handler: route(listRoute) },
  { method: 'POST', path: '/api/rooms', name: 'rooms.create', handler: route(createRoute) },
  { method: 'PATCH', path: '/api/rooms/:id', name: 'rooms.update', handler: route(patchRoute) },
  { method: 'DELETE', path: '/api/rooms/:id', name: 'rooms.delete', handler: route(deleteRoute) },
  { method: 'POST', path: '/api/rooms/:id/reservations', name: 'rooms.reserve', handler: route(reserveRoute) },
  { method: 'PATCH', path: '/api/rooms/reservations/:id', name: 'rooms.reservation.update', handler: route(patchReservationRoute) },
  { method: 'DELETE', path: '/api/rooms/reservations/:id', name: 'rooms.cancel', handler: route(cancelRoute) }
];

export default { name, priority, routes };

/**
 * Salas físicas y reservas.
 *
 * `data.rooms = { items, reservations }`. Una reserva activa no puede cruzarse
 * con otra de la misma sala y fecha. Cada cambio deja `rooms.change` en el
 * ledger de la Oficina.
 */
import { HttpError } from '../http/errors.mjs';
import { appendLedger } from '../office/ledger.mjs';

const MAX_ROOMS = 20;
const MAX_RESERVATIONS = 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function ensureRooms(data) {
  if (!data.rooms || typeof data.rooms !== 'object' || Array.isArray(data.rooms)) data.rooms = {};
  if (!Array.isArray(data.rooms.items)) data.rooms.items = [];
  if (!Array.isArray(data.rooms.reservations)) data.rooms.reservations = [];
  return data.rooms;
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function requireText(value, field, { min = 2, max = 120 } = {}) {
  const text = clean(value, max);
  if (text.length < min) throw new HttpError(400, 'INVALID_VALUE', `${field} debe tener al menos ${min} caracteres.`, { field });
  return text;
}

function optionalText(value, field, max = 160) {
  if (value === undefined || value === null || value === '') return '';
  return clean(value, max);
}

function dateValue(value, field = 'date', { required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return '';
  const raw = String(value || '').trim();
  const match = DATE_RE.exec(raw);
  if (!match) throw new HttpError(400, 'INVALID_DATE', `${field} debe ser AAAA-MM-DD.`, { field });
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) {
    throw new HttpError(400, 'INVALID_DATE', `${field} no es una fecha real.`, { field });
  }
  return raw;
}

function timeValue(value, field) {
  const raw = String(value || '').trim();
  if (!TIME_RE.test(raw)) throw new HttpError(400, 'INVALID_TIME', `${field} debe ser HH:MM.`, { field });
  return raw;
}

function capacityValue(value) {
  if (value === undefined || value === null || value === '') return 0;
  const capacity = Number(value);
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10000) {
    throw new HttpError(400, 'INVALID_VALUE', 'capacity debe ser un entero entre 0 y 10000.', { field: 'capacity' });
  }
  return capacity;
}

function nextId(prefix, items) {
  let max = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(String(item.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function findRoom(data, id) {
  const room = ensureRooms(data).items.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!room) throw new HttpError(404, 'NOT_FOUND', `No existe la sala ${id}.`);
  return room;
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    location: room.location,
    capacity: room.capacity,
    notes: room.notes,
    active: room.active !== false,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt || room.createdAt
  };
}

function publicReservation(reservation) {
  return {
    id: reservation.id,
    roomId: reservation.roomId,
    title: reservation.title,
    date: reservation.date,
    start: reservation.start,
    end: reservation.end,
    by: reservation.by,
    status: reservation.status,
    createdAt: reservation.createdAt
  };
}

function overlaps(a, b) {
  return a.date === b.date && a.start < b.end && b.start < a.end;
}

function activeReservations(data, roomId, date) {
  return ensureRooms(data).reservations.filter((item) => item.roomId === roomId
    && item.date === date && item.status === 'active');
}

export function listRooms(data, { date = '' } = {}) {
  const rooms = ensureRooms(data).items
    .filter((room) => room.active !== false)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
  const day = date ? dateValue(date) : '';
  return {
    items: rooms.map((room) => ({
      ...publicRoom(room),
      reservations: day
        ? activeReservations(data, room.id, day).map(publicReservation).sort((a, b) => a.start.localeCompare(b.start))
        : []
    })),
    date: day || null,
    total: rooms.length
  };
}

export function availability(data, date) {
  const day = dateValue(date);
  const rooms = listRooms(data, { date: day }).items;
  return {
    date: day,
    rooms: rooms.map((room) => ({ ...room, busy: room.reservations.length > 0 })),
    free: rooms.filter((room) => room.reservations.length === 0).length,
    total: rooms.length
  };
}

export function createRoom(data, input = {}) {
  const rooms = ensureRooms(data);
  if (rooms.items.length >= MAX_ROOMS) throw new HttpError(409, 'ROOM_LIMIT', `Máximo ${MAX_ROOMS} salas.`);
  const now = nowIso();
  const room = {
    id: nextId('RM', rooms.items),
    name: requireText(input.name, 'name', { min: 2, max: 80 }),
    location: optionalText(input.location, 'location', 120),
    capacity: capacityValue(input.capacity),
    notes: optionalText(input.notes, 'notes', 240),
    active: true,
    createdAt: now,
    updatedAt: now
  };
  rooms.items.push(room);
  rooms.updatedAt = now;
  appendLedger(data, { actor: 'rooms', action: 'rooms.change', payload: { change: 'room_created', roomId: room.id, name: room.name } });
  return publicRoom(room);
}

export function updateRoom(data, id, input = {}) {
  const room = findRoom(data, id);
  if (input.name !== undefined) room.name = requireText(input.name, 'name', { min: 2, max: 80 });
  if (input.location !== undefined) room.location = optionalText(input.location, 'location', 120);
  if (input.capacity !== undefined) room.capacity = capacityValue(input.capacity);
  if (input.notes !== undefined) room.notes = optionalText(input.notes, 'notes', 240);
  if (input.active !== undefined) room.active = input.active !== false;
  room.updatedAt = nowIso();
  ensureRooms(data).updatedAt = room.updatedAt;
  appendLedger(data, { actor: 'rooms', action: 'rooms.change', payload: { change: 'room_updated', roomId: room.id } });
  return publicRoom(room);
}

export function deleteRoom(data, id) {
  const rooms = ensureRooms(data);
  const room = findRoom(data, id);
  const active = rooms.reservations.filter((item) => item.roomId === room.id && item.status === 'active');
  if (active.length) throw new HttpError(409, 'ROOM_HAS_RESERVATIONS', `La sala tiene ${active.length} reserva(s) activa(s); cancélalas antes de borrarla.`);
  rooms.items = rooms.items.filter((item) => item !== room);
  rooms.updatedAt = nowIso();
  appendLedger(data, { actor: 'rooms', action: 'rooms.change', payload: { change: 'room_deleted', roomId: room.id, name: room.name } });
  return publicRoom(room);
}

export function createReservation(data, roomId, input = {}) {
  const rooms = ensureRooms(data);
  const room = findRoom(data, roomId);
  if (room.active === false) throw new HttpError(409, 'ROOM_INACTIVE', 'La sala está inactiva.');
  if (rooms.reservations.length >= MAX_RESERVATIONS) throw new HttpError(409, 'RESERVATION_LIMIT', `Máximo ${MAX_RESERVATIONS} reservas.`);
  const date = dateValue(input.date);
  const start = timeValue(input.start, 'start');
  const end = timeValue(input.end, 'end');
  if (start >= end) throw new HttpError(400, 'INVALID_RANGE', 'La hora de fin debe ser posterior a la de inicio.', { field: 'end' });
  const candidate = { date, start, end };
  const conflict = activeReservations(data, room.id, date).find((item) => overlaps(candidate, item));
  if (conflict) {
    throw new HttpError(409, 'ROOM_CONFLICT', `La sala ya está reservada de ${conflict.start} a ${conflict.end} (${conflict.title}).`, {
      field: 'start',
      details: { reservation: publicReservation(conflict) }
    });
  }
  const now = nowIso();
  const reservation = {
    id: nextId('RS', rooms.reservations),
    roomId: room.id,
    title: requireText(input.title, 'title', { min: 3, max: 120 }),
    date,
    start,
    end,
    by: optionalText(input.by, 'by', 80) || 'owner',
    status: 'active',
    createdAt: now
  };
  rooms.reservations.push(reservation);
  rooms.updatedAt = now;
  appendLedger(data, { actor: 'rooms', action: 'rooms.change', payload: { change: 'reservation_created', roomId: room.id, reservationId: reservation.id, date, start, end } });
  return publicReservation(reservation);
}

export function updateReservation(data, id, input = {}) {
  const rooms = ensureRooms(data);
  const reservation = rooms.reservations.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!reservation) throw new HttpError(404, 'NOT_FOUND', `No existe la reserva ${id}.`);
  if (reservation.status !== 'active') throw new HttpError(409, 'RESERVATION_INACTIVE', 'Solo se puede editar una reserva activa.');
  const room = findRoom(data, reservation.roomId);
  const date = input.date !== undefined ? dateValue(input.date) : reservation.date;
  const start = input.start !== undefined ? timeValue(input.start, 'start') : reservation.start;
  const end = input.end !== undefined ? timeValue(input.end, 'end') : reservation.end;
  if (start >= end) throw new HttpError(400, 'INVALID_RANGE', 'La hora de fin debe ser posterior a la de inicio.', { field: 'end' });
  const candidate = { date, start, end };
  const conflict = activeReservations(data, room.id, date).find((item) => item !== reservation && overlaps(candidate, item));
  if (conflict) {
    throw new HttpError(409, 'ROOM_CONFLICT', `La sala ya está reservada de ${conflict.start} a ${conflict.end} (${conflict.title}).`, {
      field: 'start',
      details: { reservation: publicReservation(conflict) }
    });
  }
  if (input.title !== undefined) reservation.title = requireText(input.title, 'title', { min: 3, max: 120 });
  reservation.date = date;
  reservation.start = start;
  reservation.end = end;
  if (input.by !== undefined) reservation.by = optionalText(input.by, 'by', 80) || 'owner';
  reservation.updatedAt = nowIso();
  rooms.updatedAt = reservation.updatedAt;
  appendLedger(data, { actor: 'rooms', action: 'rooms.change', payload: { change: 'reservation_updated', roomId: room.id, reservationId: reservation.id, date, start, end } });
  return publicReservation(reservation);
}

export function cancelReservation(data, id) {
  const rooms = ensureRooms(data);
  const reservation = rooms.reservations.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!reservation) throw new HttpError(404, 'NOT_FOUND', `No existe la reserva ${id}.`);
  if (reservation.status === 'cancelled') throw new HttpError(409, 'ALREADY_CANCELLED', 'La reserva ya estaba cancelada.');
  reservation.status = 'cancelled';
  reservation.cancelledAt = nowIso();
  rooms.updatedAt = reservation.cancelledAt;
  appendLedger(data, { actor: 'rooms', action: 'rooms.change', payload: { change: 'reservation_cancelled', roomId: reservation.roomId, reservationId: reservation.id } });
  return publicReservation(reservation);
}

export function roomsStats(data) {
  const rooms = ensureRooms(data);
  return {
    rooms: rooms.items.filter((room) => room.active !== false).length,
    reservations: rooms.reservations.filter((item) => item.status === 'active').length,
    today: rooms.reservations.filter((item) => item.status === 'active' && item.date === new Date().toISOString().slice(0, 10)).length
  };
}

export { ensureRooms, MAX_ROOMS, MAX_RESERVATIONS };

/**
 * Jornada: entradas, salidas, pausas y horas.
 *
 * `data.attendance.entries` guarda turnos. Un turno abierto no tiene `end`.
 * Cada cambio deja `attendance.change` en el ledger de la Oficina.
 */
import { HttpError } from '../http/errors.mjs';
import { appendLedger } from '../office/ledger.mjs';

const MAX_SHIFTS = 2000;

function ensureAttendance(data) {
  if (!data.attendance || typeof data.attendance !== 'object' || Array.isArray(data.attendance)) data.attendance = {};
  if (!Array.isArray(data.attendance.entries)) data.attendance.entries = [];
  return data.attendance;
}

function nowIso() {
  return new Date().toISOString();
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'INVALID_DATE', 'Fecha inválida.', { field: 'date' });
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseIso(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'INVALID_DATE', `${field} debe ser una fecha ISO válida.`, { field });
  return date;
}

function clean(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function nextId(items) {
  let max = 0;
  for (const item of items) {
    const match = /^AT-(\d+)$/i.exec(String(item.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `AT-${String(max + 1).padStart(4, '0')}`;
}

function minutesOf(shift) {
  if (!shift.end) return 0;
  const start = Date.parse(shift.start);
  const end = Date.parse(shift.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(0, Math.round((end - start) / 60_000) - Number(shift.breakMinutes || 0));
}

function publicShift(shift) {
  return {
    id: shift.id,
    date: shift.date,
    start: shift.start,
    end: shift.end || null,
    breakMinutes: Number(shift.breakMinutes || 0),
    minutes: minutesOf(shift),
    note: shift.note,
    open: !shift.end,
    createdAt: shift.createdAt,
    updatedAt: shift.updatedAt
  };
}

function findShift(data, id) {
  const shift = ensureAttendance(data).entries.find((item) => String(item.id).toLowerCase() === String(id || '').toLowerCase());
  if (!shift) throw new HttpError(404, 'NOT_FOUND', `No existe el turno ${id}.`);
  return shift;
}

function findOpen(data) {
  return ensureAttendance(data).entries.find((item) => !item.end) || null;
}

function defaultRange(data, { from, to } = {}) {
  const entries = ensureAttendance(data).entries;
  const dates = entries.map((item) => item.date).sort();
  const last = dates[dates.length - 1] || dateKey(new Date());
  const end = to || last;
  const start = from || dateKey(new Date(Date.parse(`${end}T12:00:00`) - 6 * 86_400_000));
  return { from: start, to: end };
}

export function listShifts(data, { from, to } = {}) {
  const range = defaultRange(data, { from, to });
  const entries = ensureAttendance(data).entries
    .filter((shift) => shift.date >= range.from && shift.date <= range.to)
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  const closed = entries.filter((shift) => shift.end);
  const minutes = closed.reduce((sum, shift) => sum + minutesOf(shift), 0);
  const days = new Set(closed.map((shift) => shift.date)).size;
  return {
    items: entries.map(publicShift),
    from: range.from,
    to: range.to,
    summary: {
      minutes,
      hours: Math.round(minutes / 6) / 10,
      days,
      averageMinutes: days ? Math.round(minutes / days) : 0,
      open: entries.filter((shift) => !shift.end).length,
      shifts: entries.length
    },
    open: findOpen(data) ? publicShift(findOpen(data)) : null
  };
}

export function attendanceSummary(data, { from, to } = {}) {
  return listShifts(data, { from, to }).summary;
}

export function clockIn(data, input = {}) {
  if (findOpen(data)) throw new HttpError(409, 'ALREADY_OPEN', 'Ya hay una jornada abierta; ciérrala antes de abrir otra.');
  const entries = ensureAttendance(data).entries;
  if (entries.length >= MAX_SHIFTS) throw new HttpError(409, 'SHIFT_LIMIT', `Máximo ${MAX_SHIFTS} turnos.`);
  const at = input.at ? parseIso(input.at, 'at') : new Date();
  const now = nowIso();
  const shift = {
    id: nextId(entries),
    date: dateKey(at),
    start: at.toISOString(),
    end: null,
    breakMinutes: 0,
    note: clean(input.note, 240),
    createdAt: now,
    updatedAt: now
  };
  entries.push(shift);
  ensureAttendance(data).updatedAt = now;
  appendLedger(data, { actor: 'attendance', action: 'attendance.change', payload: { change: 'clock_in', shiftId: shift.id, at: shift.start } });
  return publicShift(shift);
}

export function clockOut(data, input = {}) {
  const shift = findOpen(data);
  if (!shift) throw new HttpError(409, 'NOT_OPEN', 'No hay una jornada abierta que cerrar.');
  const at = input.at ? parseIso(input.at, 'at') : new Date();
  if (at.getTime() <= Date.parse(shift.start)) throw new HttpError(400, 'INVALID_TIME', 'La salida debe ser posterior a la entrada.', { field: 'at' });
  shift.end = at.toISOString();
  shift.note = clean(input.note, 240) || shift.note;
  shift.updatedAt = nowIso();
  ensureAttendance(data).updatedAt = shift.updatedAt;
  appendLedger(data, { actor: 'attendance', action: 'attendance.change', payload: { change: 'clock_out', shiftId: shift.id, at: shift.end } });
  return publicShift(shift);
}

export function addBreak(data, minutes) {
  const shift = findOpen(data);
  if (!shift) throw new HttpError(409, 'NOT_OPEN', 'Abre la jornada antes de registrar una pausa.');
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 1 || value > 480) {
    throw new HttpError(400, 'INVALID_VALUE', 'La pausa debe ser un entero entre 1 y 480 minutos.', { field: 'minutes' });
  }
  shift.breakMinutes = Number(shift.breakMinutes || 0) + value;
  shift.updatedAt = nowIso();
  ensureAttendance(data).updatedAt = shift.updatedAt;
  appendLedger(data, { actor: 'attendance', action: 'attendance.change', payload: { change: 'break', shiftId: shift.id, minutes: value, total: shift.breakMinutes } });
  return publicShift(shift);
}

export function updateShift(data, id, input = {}) {
  const shift = findShift(data, id);
  if (input.start !== undefined) shift.start = parseIso(input.start, 'start').toISOString();
  if (input.end !== undefined) {
    shift.end = input.end === null || input.end === '' ? null : parseIso(input.end, 'end').toISOString();
    if (shift.end && Date.parse(shift.end) <= Date.parse(shift.start)) {
      throw new HttpError(400, 'INVALID_TIME', 'La salida debe ser posterior a la entrada.', { field: 'end' });
    }
  }
  if (input.breakMinutes !== undefined) {
    const value = Number(input.breakMinutes);
    if (!Number.isInteger(value) || value < 0 || value > 480) {
      throw new HttpError(400, 'INVALID_VALUE', 'breakMinutes debe ser un entero entre 0 y 480.', { field: 'breakMinutes' });
    }
    shift.breakMinutes = value;
  }
  if (input.note !== undefined) shift.note = clean(input.note, 240);
  shift.date = dateKey(shift.start);
  shift.updatedAt = nowIso();
  ensureAttendance(data).updatedAt = shift.updatedAt;
  appendLedger(data, { actor: 'attendance', action: 'attendance.change', payload: { change: 'shift_updated', shiftId: shift.id } });
  return publicShift(shift);
}

export function deleteShift(data, id) {
  const attendance = ensureAttendance(data);
  const shift = findShift(data, id);
  attendance.entries = attendance.entries.filter((item) => item !== shift);
  attendance.updatedAt = nowIso();
  appendLedger(data, { actor: 'attendance', action: 'attendance.change', payload: { change: 'shift_deleted', shiftId: shift.id, date: shift.date } });
  return publicShift(shift);
}

export { ensureAttendance, MAX_SHIFTS };

/**
 * Tareas de la agenda (GTD ligero): crear, asignar, listar y cerrar.
 *
 * Persistencia: `store.tasks` (array). Cada tarea puede venir de chat, correo
 * o acta, y puede vincularse a un evento de la agenda o a una persona.
 */

import { nextId } from '../store.mjs';
import { isValidDateKey } from '../agenda/time.mjs';
import { TravelError } from './places.mjs';

export const TASK_STATUSES = ['open', 'done', 'cancelled'];
export const TASK_ORIGINS = ['chat', 'correo', 'acta', 'manual', 'whatsapp', 'telegram', 'agente'];
export const TASK_PRIORITIES = ['P1', 'P2', 'P3', 'P4'];

function textField(value, field, { max = 300, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TravelError(400, 'VALIDATION', `${field} es requerido`, { field });
    return undefined;
  }
  if (typeof value !== 'string') throw new TravelError(400, 'VALIDATION', `${field} debe ser texto`, { field });
  const trimmed = value.trim();
  if (required && !trimmed) throw new TravelError(400, 'VALIDATION', `${field} no puede estar vacío`, { field });
  if (trimmed.length > max) throw new TravelError(400, 'VALIDATION', `${field} excede ${max} caracteres`, { field });
  return trimmed;
}

function parsePriority(value, fallback = 'P2') {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return fallback;
  if (TASK_PRIORITIES.includes(raw)) return raw;
  if (['ALTA', 'CRITICA', 'CRÍTICA'].includes(raw)) return 'P1';
  if (['MEDIA', 'NORMAL'].includes(raw)) return 'P2';
  if (['BAJA'].includes(raw)) return 'P3';
  return fallback;
}

function parseOrigin(value, fallback = 'manual') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return TASK_ORIGINS.includes(raw) ? raw : fallback;
}

function parseStatus(value, fallback = 'open') {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'closed' || raw === 'cerrada' || raw === 'hecha') return 'done';
  return TASK_STATUSES.includes(raw) ? raw : fallback;
}

/**
 * Acepta `title` o, si viene de chat, `text` con formato:
 *   "asignar tarea a Juan: revisar contrato"
 *   "crear tarea revisar contrato"
 */
export function parseTaskText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { title: '', owner: '' };
  let rest = raw.replace(/^(?:asignar|crear|añadir|agregar)\s+tarea\s*/i, '').trim();
  if (rest === raw) rest = raw.replace(/^tarea\s*/i, '').trim();
  // "a Laura: revisar contrato" / "a Laura, revisar contrato"
  let match = rest.match(/^a\s+([^:,.]{1,80})\s*[:,]\s*(.+)$/i);
  if (match) return { owner: match[1].trim(), title: match[2].trim() };
  // "a Laura revisar contrato" (sin separador) — solo si hay al menos 3 palabras
  match = rest.match(/^a\s+([^:,.]{1,80}?)\s+(.+)$/i);
  if (match) return { owner: match[1].trim(), title: match[2].trim() };
  // "Laura: revisar contrato"
  match = rest.match(/^([^:,.]{1,80})\s*[:,]\s*(.+)$/);
  if (match) return { owner: match[1].trim(), title: match[2].trim() };
  return { title: rest || raw, owner: '' };
}

export function validateTaskInput(input, { partial = false, current = null, data = null } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const allowed = new Set(['title', 'text', 'owner', 'responsable', 'due', 'priority', 'origin', 'source', 'status', 'eventId', 'person', 'notes', 'result', 'closedBy']);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new TravelError(400, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`, { field: key });
  }
  const parsed = source.text ? parseTaskText(source.text) : { title: '', owner: '' };
  const out = {};
  if (source.title !== undefined || source.text !== undefined || !partial) {
    const title = textField(source.title ?? parsed.title, 'title', { max: 300, required: !partial && !current });
    if (title !== undefined) out.title = title;
  }
  if (source.owner !== undefined || source.responsable !== undefined || parsed.owner) {
    out.owner = textField(source.owner ?? source.responsable ?? parsed.owner, 'owner', { max: 120 }) || 'Yo';
  }
  if (source.due !== undefined) {
    if (source.due === null || source.due === '') out.due = null;
    else {
      if (!isValidDateKey(source.due)) throw new TravelError(400, 'INVALID_DATE', 'due debe ser YYYY-MM-DD', { field: 'due' });
      out.due = source.due;
    }
  }
  if (source.priority !== undefined) out.priority = parsePriority(source.priority);
  if (source.origin !== undefined || source.source !== undefined) out.origin = parseOrigin(source.origin ?? source.source, 'manual');
  if (source.status !== undefined) out.status = parseStatus(source.status);
  if (source.eventId !== undefined && source.eventId !== null && source.eventId !== '') {
    if (typeof source.eventId !== 'string') throw new TravelError(400, 'VALIDATION', 'eventId debe ser texto', { field: 'eventId' });
    if (data && !(data.agenda || []).some((event) => event.id === source.eventId)) {
      throw new TravelError(404, 'EVENT_NOT_FOUND', `No encontré el evento ${source.eventId}`, { field: 'eventId' });
    }
    out.eventId = source.eventId;
  } else if (source.eventId === null) {
    out.eventId = null;
  }
  for (const field of ['person', 'notes', 'result', 'closedBy']) {
    if (source[field] !== undefined) out[field] = textField(source[field], field, { max: field === 'notes' ? 2000 : 200 }) || '';
  }
  if (partial && !Object.keys(out).length) throw new TravelError(400, 'EMPTY_PATCH', 'No hay campos para actualizar');
  return out;
}

export function tasksOf(data) {
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export function ensureTasks(data) {
  if (!Array.isArray(data.tasks)) data.tasks = [];
  return data;
}

export function createTask(data, input) {
  const fields = validateTaskInput(input, { data });
  ensureTasks(data);
  const now = new Date().toISOString();
  const task = {
    id: nextId('TK', data.tasks),
    title: fields.title,
    owner: fields.owner || 'Yo',
    due: fields.due ?? null,
    priority: fields.priority || 'P2',
    origin: fields.origin || 'manual',
    status: fields.status || 'open',
    eventId: fields.eventId ?? null,
    person: fields.person || '',
    notes: fields.notes || '',
    result: fields.result || '',
    createdAt: now,
    updatedAt: now,
    closedAt: fields.status === 'done' ? now : null,
    closedBy: fields.closedBy || null
  };
  data.tasks.push(task);
  return task;
}

export function getTask(data, id) {
  return tasksOf(data).find((task) => String(task.id).toLowerCase() === String(id).toLowerCase()) || null;
}

export function updateTask(data, id, input) {
  const task = getTask(data, id);
  if (!task) throw new TravelError(404, 'NOT_FOUND', `No encontré la tarea ${id}`, { field: 'id' });
  const fields = validateTaskInput(input, { partial: true, current: task, data });
  ensureTasks(data);
  const stored = getTask(data, id);
  Object.assign(stored, fields, { updatedAt: new Date().toISOString() });
  if (fields.status === 'done' && !stored.closedAt) stored.closedAt = new Date().toISOString();
  if (fields.status && fields.status !== 'done') stored.closedAt = null;
  return stored;
}

export function closeTask(data, id, { result, closedBy } = {}) {
  const task = getTask(data, id);
  if (!task) throw new TravelError(404, 'NOT_FOUND', `No encontré la tarea ${id}`, { field: 'id' });
  if (task.status === 'done') return { task, alreadyClosed: true };
  ensureTasks(data);
  const stored = getTask(data, id);
  stored.status = 'done';
  stored.closedAt = new Date().toISOString();
  stored.updatedAt = stored.closedAt;
  if (closedBy !== undefined) stored.closedBy = String(closedBy).slice(0, 200);
  if (result !== undefined) stored.result = String(result).slice(0, 2000);
  return { task: stored, alreadyClosed: false };
}

export function reopenTask(data, id) {
  const task = getTask(data, id);
  if (!task) throw new TravelError(404, 'NOT_FOUND', `No encontré la tarea ${id}`, { field: 'id' });
  ensureTasks(data);
  const stored = getTask(data, id);
  stored.status = 'open';
  stored.closedAt = null;
  stored.updatedAt = new Date().toISOString();
  return stored;
}

export function deleteTask(data, id) {
  ensureTasks(data);
  const index = data.tasks.findIndex((task) => String(task.id).toLowerCase() === String(id).toLowerCase());
  if (index < 0) throw new TravelError(404, 'NOT_FOUND', `No encontré la tarea ${id}`, { field: 'id' });
  const [removed] = data.tasks.splice(index, 1);
  return removed;
}

export function listTasks(data, { status = 'all', owner, origin, q, due, eventId } = {}) {
  let items = [...tasksOf(data)];
  const normalizedStatus = String(status || 'all').toLowerCase();
  if (normalizedStatus !== 'all') items = items.filter((task) => task.status === parseStatus(normalizedStatus, 'all'));
  if (owner) items = items.filter((task) => String(task.owner || '').toLowerCase().includes(String(owner).toLowerCase()));
  if (origin) items = items.filter((task) => task.origin === parseOrigin(origin, 'manual'));
  if (due) items = items.filter((task) => task.due === due);
  if (eventId) items = items.filter((task) => task.eventId === eventId);
  if (q) {
    const query = String(q).toLowerCase();
    items = items.filter((task) => `${task.title} ${task.notes} ${task.owner} ${task.person}`.toLowerCase().includes(query));
  }
  const statusRank = { open: 0, done: 1, cancelled: 2 };
  items.sort((a, b) => {
    const rank = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (rank) return rank;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  return items;
}

export function taskSummary(data) {
  const tasks = tasksOf(data);
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === 'open').length,
    done: tasks.filter((task) => task.status === 'done').length,
    cancelled: tasks.filter((task) => task.status === 'cancelled').length,
    overdue: tasks.filter((task) => task.status === 'open' && task.due && task.due < new Date().toISOString().slice(0, 10)).length
  };
}

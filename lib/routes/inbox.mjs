import { store, nextId, addActivity } from '../store.mjs';
import { dateKeyOfIso, isValidDateKey, isValidIso, isoAtLocal, timezoneOf } from '../agenda/time.mjs';
import { createAgendaEvent } from '../agenda/events.mjs';
import { findSlotsDetailed } from '../agenda/conflicts.mjs';
import { normalizePriority } from '../agenda/score.mjs';
import {
  bodyOf, itemEnvelope, listEnvelope, notFound, queryBool, queryInt, queryString,
  respond, route, sendError, paramOf
} from '../agenda/http.mjs';

export const name = 'inbox';
export const priority = 100;

const EDITABLE_INBOX_FIELDS = ['input', 'type', 'context', 'actionable', 'due', 'estimatedMin', 'priority', 'notes', 'source', 'processed', 'dismissed'];

async function mutateWith(fn) {
  let result;
  await store.mutate(async (data) => { result = await fn(data); });
  return result;
}

function fail(ctx, result) {
  const payload = { error: result.error, code: result.code, requestId: ctx?.requestId };
  if (result.field) payload.field = result.field;
  if (result.conflicts) {
    payload.conflicts = result.conflicts;
    payload.details = { ...(payload.details || {}), conflicts: result.conflicts };
  }
  if (result.errors) {
    payload.errors = result.errors;
    payload.details = { ...(payload.details || {}), errors: result.errors };
  }
  return respond(ctx, result.status || 400, payload);
}

function validateInboxInput(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  for (const key of Object.keys(input)) {
    if (!EDITABLE_INBOX_FIELDS.includes(key)) {
      throw Object.assign(new Error(`Campo no editable: ${key}`), { status: 400, code: 'UNKNOWN_FIELD', field: key });
    }
  }
  const out = {};
  if (input.input !== undefined || !partial) {
    const value = String(input.input ?? input.title ?? '').trim();
    if (!value) throw Object.assign(new Error('input es requerido'), { status: 400, code: 'VALIDATION', field: 'input' });
    if (value.length > 2000) throw Object.assign(new Error('input excede 2000 caracteres'), { status: 400, code: 'VALIDATION', field: 'input' });
    out.input = value;
  }
  if (input.type !== undefined) out.type = String(input.type).trim().slice(0, 50) || 'Tarea';
  if (input.context !== undefined) out.context = String(input.context).trim().slice(0, 120);
  if (input.source !== undefined) out.source = String(input.source).trim().slice(0, 50);
  if (input.notes !== undefined) out.notes = String(input.notes ?? '').slice(0, 1000);
  if (input.priority !== undefined) out.priority = normalizePriority(input.priority, 'P2');
  if (input.actionable !== undefined) out.actionable = input.actionable === true || ['true', '1', 'si', 'sí'].includes(String(input.actionable).toLowerCase());
  if (input.processed !== undefined) out.processed = input.processed === true || String(input.processed) === '1';
  if (input.dismissed !== undefined) out.dismissed = input.dismissed === true;
  if (input.due !== undefined && input.due !== null && input.due !== '') {
    if (!isValidDateKey(input.due)) throw Object.assign(new Error('due debe ser YYYY-MM-DD'), { status: 400, code: 'INVALID_DATE', field: 'due' });
    out.due = input.due;
  } else if (input.due === null) {
    out.due = null;
  }
  if (input.estimatedMin !== undefined) {
    const value = Number(input.estimatedMin);
    if (!Number.isFinite(value) || value < 5 || value > 1440) {
      throw Object.assign(new Error('estimatedMin debe estar entre 5 y 1440'), { status: 400, code: 'VALIDATION', field: 'estimatedMin' });
    }
    out.estimatedMin = Math.round(value);
  }
  return out;
}

function inboxList(ctx) {
  const data = store.get();
  const processed = queryString(ctx, 'processed');
  const source = queryString(ctx, 'source');
  const q = queryString(ctx, 'q');
  const limit = queryInt(ctx, 'limit', 500, { min: 1, max: 2000 });
  let items = (data.inbox || []).filter((item) => {
    if (processed !== null && String(item.processed) !== String(queryBool(ctx, 'processed', true))) return false;
    if (source && String(item.source || '').toLowerCase() !== source.toLowerCase()) return false;
    if (q && !`${item.input} ${item.notes} ${item.id}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  items = [...items].sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
  const total = items.length;
  return respond(ctx, 200, listEnvelope(items.slice(0, limit), {
    total,
    pending: (data.inbox || []).filter((item) => !item.processed).length
  }));
}

function inboxGet(ctx) {
  const id = paramOf(ctx, 'id');
  const item = (store.get().inbox || []).find((row) => row.id === id);
  if (!item) return notFound(ctx, `No encontré ${id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

async function inboxCreate(ctx) {
  const body = await bodyOf(ctx);
  let fields;
  try {
    fields = validateInboxInput(body, { partial: false });
  } catch (error) {
    return sendError(ctx, error);
  }
  let item;
  await mutateWith((data) => {
    item = {
      id: nextId('IN', data.inbox),
      capturedAt: new Date().toISOString(),
      source: fields.source || body.source || 'App',
      type: fields.type || 'Tarea',
      input: fields.input,
      context: fields.context || 'Móvil',
      actionable: fields.actionable !== false,
      due: fields.due ?? null,
      estimatedMin: fields.estimatedMin ?? 30,
      priority: fields.priority || 'P2',
      processed: false,
      agendaId: null,
      notes: fields.notes || ''
    };
    data.inbox.push(item);
    addActivity('inbox', `Captura: ${item.input}`);
  });
  return respond(ctx, 201, itemEnvelope(item));
}

async function inboxPatch(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const item = (store.get().inbox || []).find((row) => row.id === id);
  if (!item) return notFound(ctx, `No encontré ${id}`);
  let fields;
  try {
    fields = validateInboxInput(body, { partial: true });
  } catch (error) {
    return sendError(ctx, error);
  }
  await mutateWith(() => { Object.assign(item, fields); });
  return respond(ctx, 200, itemEnvelope(item));
}

function priorityDefaults(priority) {
  const value = normalizePriority(priority, 'P2');
  if (value === 'P1') return { impact: 5, urgency: 4 };
  if (value === 'P2') return { impact: 4, urgency: 3 };
  if (value === 'P3') return { impact: 3, urgency: 2 };
  return { impact: 3, urgency: 3 };
}

/**
 * Convierte una captura del Inbox en una cita validada.
 * - Acepta start/end, date+time o busca el primer hueco libre.
 * - Comprueba conflictos y FreeBusy (nunca asume libre).
 * - Marca `processed`, guarda `agendaId` y auditoría.
 */
async function inboxConvert(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const data = store.get();
  const item = (data.inbox || []).find((row) => row.id === id);
  if (!item) return notFound(ctx, `No encontré ${id}`);
  if (item.processed && body.force !== true) {
    return respond(ctx, 409, {
      error: `La captura ${id} ya fue procesada${item.agendaId ? ` (${item.agendaId})` : ''}`,
      code: 'ALREADY_PROCESSED', requestId: ctx.requestId
    });
  }
  const tz = timezoneOf(data.settings);
  const defaults = priorityDefaults(body.priority || item.priority);
  const durationMin = Math.max(5, Number(body.durationMin || item.estimatedMin || 30));
  const payload = {
    title: String(body.title || item.input || '').trim().slice(0, 200),
    type: body.type || (String(item.type || '').toLowerCase() === 'reunión' || String(item.type || '').toLowerCase() === 'reunion' ? 'Reunión' : 'Compromiso'),
    result: body.result || '',
    priority: normalizePriority(body.priority || item.priority, 'P2'),
    impact: body.impact ?? defaults.impact,
    urgency: body.urgency ?? defaults.urgency,
    deepFocus: body.deepFocus ?? false,
    context: body.context || item.context || '',
    notes: body.notes ?? `Desde inbox ${item.id}`,
    attendees: Array.isArray(body.attendees) ? body.attendees : undefined
  };
  if (body.start || body.end) {
    payload.start = body.start;
    payload.end = body.end;
    if (payload.start && !payload.end) {
      payload.end = new Date(new Date(payload.start).getTime() + durationMin * 60000).toISOString();
    }
  } else if (body.date) {
    if (!isValidDateKey(body.date)) return respond(ctx, 400, { error: 'date inválida', code: 'INVALID_DATE', field: 'date', requestId: ctx.requestId });
    const time = /^\d{1,2}:\d{2}$/.test(String(body.time || '')) ? body.time : '09:00';
    payload.start = isoAtLocal(body.date, time, tz);
    payload.end = new Date(new Date(payload.start).getTime() + durationMin * 60000).toISOString();
  } else if (body.time && body.date === undefined) {
    const start = isoAtLocal(dateKeyOfIso(new Date().toISOString(), tz), body.time, tz);
    payload.start = start;
    payload.end = new Date(new Date(start).getTime() + durationMin * 60000).toISOString();
  } else {
    // Sin horario explícito: primer hueco disponible desde ahora.
    const slots = await findSlotsDetailed({
      durationMin, fromIso: new Date().toISOString(), days: 7, count: 1,
      data, settings: data.settings
    });
    if (!slots.slots.length) {
      return respond(ctx, 409, {
        error: 'No hay hueco disponible para convertir la captura; indica fecha y hora',
        code: 'NO_SLOT', requestId: ctx.requestId
      });
    }
    payload.start = slots.slots[0].start;
    payload.end = slots.slots[0].end;
  }

  let result;
  await store.mutate(async (current) => {
    result = await createAgendaEvent({
      data: current,
      settings: current.settings,
      payload,
      check: body.check !== false,
      force: body.force === true,
      allowUnverified: body.allowUnverified === true
    });
    if (result.ok) {
      const target = current.inbox.find((row) => row.id === id);
      if (target) {
        target.processed = true;
        target.agendaId = result.event.id;
        target.processedAt = new Date().toISOString();
        target.updatedAt = target.processedAt;
      }
      addActivity('inbox', `Captura ${id} convertida en ${result.event.id}`);
    }
  });
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, { item: presentInbox(store.get().inbox.find((row) => row.id === id)), event: result.event });
}

function presentInbox(item) {
  return item || null;
}

async function inboxDismiss(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const item = (store.get().inbox || []).find((row) => row.id === id);
  if (!item) return notFound(ctx, `No encontré ${id}`);
  await mutateWith(() => {
    item.processed = true;
    item.dismissed = true;
    item.dismissedAt = new Date().toISOString();
    item.notes = body.reason ? `${item.notes || ''}`.trim() : item.notes;
  });
  addActivity('inbox', `Captura descartada: ${item.id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

async function inboxDelete(ctx) {
  const id = paramOf(ctx, 'id');
  let removed = null;
  await mutateWith((data) => {
    const index = data.inbox.findIndex((row) => row.id === id);
    if (index >= 0) removed = data.inbox.splice(index, 1)[0];
  });
  if (!removed) return notFound(ctx, `No encontré ${id}`);
  return respond(ctx, 200, { ok: true, item: removed });
}

export const routes = [
  { method: 'GET', path: '/api/inbox', name: 'inbox.list', handler: route(inboxList) },
  { method: 'POST', path: '/api/inbox', name: 'inbox.create', handler: route(inboxCreate) },
  { method: 'GET', path: '/api/inbox/:id', name: 'inbox.get', handler: route(inboxGet) },
  { method: 'PATCH', path: '/api/inbox/:id', name: 'inbox.patch', handler: route(inboxPatch) },
  { method: 'DELETE', path: '/api/inbox/:id', name: 'inbox.delete', handler: route(inboxDelete) },
  { method: 'POST', path: '/api/inbox/:id/convert', name: 'inbox.convert', handler: route(inboxConvert) },
  { method: 'POST', path: '/api/inbox/:id/dismiss', name: 'inbox.dismiss', handler: route(inboxDismiss) }
];

export default { name, priority, routes };

import { store } from '../store.mjs';
import { isValidDateKey, timezoneOf } from '../agenda/time.mjs';
import {
  createRoutine, deleteRoutine, listRoutines, previewRoutine, previewRoutineById,
  runDailyMaterialization, routineFromInput, setRoutineActive, skipRoutineDate, updateRoutine,
  materializeRoutineRange
} from '../agenda/routines.mjs';
import { findRoutine, routinesFromData, routineOccurrencesBetween } from '../agenda/occurrences.mjs';
import {
  bodyOf, itemEnvelope, listEnvelope, notFound, queryBool, queryInt, queryString,
  respond, route, sendError, paramOf
} from '../agenda/http.mjs';

export const name = 'routines';
export const priority = 100;

async function mutateWith(fn) {
  let result;
  await store.mutate(async (data) => { result = await fn(data); });
  return result;
}

function fail(ctx, result) {
  const payload = { error: result.error, code: result.code, requestId: ctx?.requestId };
  if (result.field) payload.field = result.field;
  return respond(ctx, result.status || 400, payload);
}

function routinesList(ctx) {
  const data = store.get();
  const kind = queryString(ctx, 'kind');
  const active = queryString(ctx, 'active');
  const q = queryString(ctx, 'q');
  const items = listRoutines(data, data.settings, {
    kind: kind || undefined,
    active: active === null ? undefined : queryBool(ctx, 'active', true),
    q: q || undefined
  });
  return respond(ctx, 200, listEnvelope(items, { kind: kind || null }));
}

function routinesGet(ctx) {
  const id = paramOf(ctx, 'id');
  const data = store.get();
  const routine = findRoutine(data, id, data.settings);
  if (!routine) return notFound(ctx, `No encontré la rutina ${id}`);
  const count = queryInt(ctx, 'preview', 0, { min: 0, max: 365 });
  return respond(ctx, 200, itemEnvelope(routine, count ? { preview: previewRoutine(routine, { count, settings: data.settings }) } : {}));
}

async function routinesCreate(ctx) {
  const body = await bodyOf(ctx);
  let result;
  try {
    result = await mutateWith((data) => createRoutine(data, body, data.settings));
  } catch (error) {
    return sendError(ctx, error);
  }
  if (!result.ok) return fail(ctx, result);
  // Si la nueva rutina aplica hoy, se materializa de inmediato (idempotente).
  await mutateWith((data) => materializeRoutineRange(data, data.settings, {
    fromKey: undefined, toKey: undefined, maxOccurrences: 4
  })).catch(() => {});
  return respond(ctx, 201, itemEnvelope(result.routine));
}

async function routinesPatch(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  let result;
  try {
    result = await mutateWith((data) => updateRoutine(data, id, body, data.settings));
  } catch (error) {
    return sendError(ctx, error);
  }
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, itemEnvelope(result.routine));
}

async function routinesDelete(ctx) {
  const id = paramOf(ctx, 'id');
  const keepGenerated = queryBool(ctx, 'keepGenerated', true);
  const result = await mutateWith((data) => deleteRoutine(data, id, { keepGenerated }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, { ok: true, removed: result.removed, removedGenerated: result.removedGenerated });
}

async function routinesToggle(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const data = store.get();
  const routine = findRoutine(data, id, data.settings);
  if (!routine) return notFound(ctx, `No encontré la rutina ${id}`);
  const active = body.active === undefined ? !routine.active : body.active;
  const result = await mutateWith((current) => setRoutineActive(current, id, active, current.settings));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, itemEnvelope(result.routine));
}

async function routinesSkip(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const date = body.date || queryString(ctx, 'date');
  if (!date) return respond(ctx, 400, { error: 'date es requerido', code: 'VALIDATION', field: 'date', requestId: ctx.requestId });
  const result = await mutateWith((data) => skipRoutineDate(data, id, date, { reason: body.reason || '' }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, itemEnvelope(result.routine, { date: result.date, cancelled: result.cancelled }));
}

function routinesPreview(ctx) {
  const id = paramOf(ctx, 'id');
  const data = store.get();
  const count = queryInt(ctx, 'count', 30, { min: 1, max: 365 });
  const from = queryString(ctx, 'from');
  const occurrences = previewRoutineById(data, id, { count, fromKey: from || undefined, settings: data.settings });
  if (!occurrences) return notFound(ctx, `No encontré la rutina ${id}`);
  return respond(ctx, 200, { items: occurrences, count: occurrences.length, total: occurrences.length, id, requested: count });
}

async function routinesPreviewDraft(ctx) {
  const body = await bodyOf(ctx);
  const data = store.get();
  const { count: rawCount, from: rawFrom, ...draft } = body || {};
  try {
    const routine = routineFromInput(draft, { partial: false, settings: data.settings });
    const count = Math.max(1, Math.min(365, Number(rawCount || 30)));
    const occurrences = previewRoutine(routine, { count, fromKey: rawFrom || undefined, settings: data.settings });
    return respond(ctx, 200, { items: occurrences, count: occurrences.length, total: occurrences.length, requested: count, routine });
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function routinesMaterialize(ctx) {
  const body = await bodyOf(ctx);
  const data = store.get();
  let summary;
  if (body.from || body.to) {
    summary = await mutateWith((current) => materializeRoutineRange(current, current.settings, {
      fromKey: body.from, toKey: body.to, maxOccurrences: body.maxOccurrences
    }));
  } else {
    summary = await mutateWith((current) => runDailyMaterialization(current, current.settings, {
      todayKey: body.date, backfillDays: body.backfillDays, maxOccurrences: body.maxOccurrences
    }));
  }
  return respond(ctx, 200, { ok: (summary.errors || []).length === 0, summary });
}

function routinesOccurrences(ctx) {
  const data = store.get();
  const tz = timezoneOf(data.settings);
  const from = queryString(ctx, 'from');
  const to = queryString(ctx, 'to');
  if (!isValidDateKey(from) || !isValidDateKey(to)) {
    return respond(ctx, 400, { error: 'from y to deben ser YYYY-MM-DD', code: 'VALIDATION', requestId: ctx.requestId });
  }
  const items = [];
  for (const routine of routinesFromData(data, data.settings)) {
    if (!routine.active) continue;
    for (const occurrence of routineOccurrencesBetween(routine, from, to, data.settings, { includeSkipped: true })) {
      items.push({
        routineId: routine.id, kind: routine.kind, title: routine.title,
        date: occurrence.date, start: occurrence.start, end: occurrence.end,
        skipped: occurrence.skipped
      });
    }
  }
  items.sort((a, b) => new Date(a.start) - new Date(b.start));
  return respond(ctx, 200, listEnvelope(items, { from, to, timezone: tz }));
}

export const routes = [
  { method: 'GET', path: '/api/routines', name: 'routines.list', handler: route(routinesList) },
  { method: 'POST', path: '/api/routines', name: 'routines.create', handler: route(routinesCreate) },
  { method: 'POST', path: '/api/routines/preview', name: 'routines.preview.draft', handler: route(routinesPreviewDraft) },
  { method: 'POST', path: '/api/routines/materialize', name: 'routines.materialize', handler: route(routinesMaterialize) },
  { method: 'GET', path: '/api/routines/occurrences', name: 'routines.occurrences', handler: route(routinesOccurrences) },
  { method: 'GET', path: '/api/routines/:id', name: 'routines.get', handler: route(routinesGet) },
  { method: 'PATCH', path: '/api/routines/:id', name: 'routines.patch', handler: route(routinesPatch) },
  { method: 'DELETE', path: '/api/routines/:id', name: 'routines.delete', handler: route(routinesDelete) },
  { method: 'POST', path: '/api/routines/:id/toggle', name: 'routines.toggle', handler: route(routinesToggle) },
  { method: 'POST', path: '/api/routines/:id/skip', name: 'routines.skip', handler: route(routinesSkip) },
  { method: 'GET', path: '/api/routines/:id/preview', name: 'routines.preview', handler: route(routinesPreview) },
  // Compatibilidad con los endpoints históricos del modelo.
  { method: 'GET', path: '/api/recurrences', name: 'recurrences.list', handler: route((ctx) => {
    const data = store.get();
    return respond(ctx, 200, listEnvelope(listRoutines(data, data.settings, { kind: 'recurrence' })));
  }) },
  { method: 'GET', path: '/api/meetings', name: 'meetings.list', handler: route((ctx) => {
    const data = store.get();
    return respond(ctx, 200, listEnvelope(listRoutines(data, data.settings, { kind: 'meeting' })));
  }) },
  { method: 'PATCH', path: '/api/recurrences/:id', name: 'recurrences.patch', handler: route(routinesPatch) },
  { method: 'PATCH', path: '/api/meetings/:id', name: 'meetings.patch', handler: route(routinesPatch) },
  { method: 'DELETE', path: '/api/meetings/:id', name: 'meetings.delete', handler: route(routinesDelete) }
];

export default { name, priority, routes };

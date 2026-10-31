/**
 * Rutas de agenda física (lugares, viajes, Meet) y tareas.
 *
 * Se monta por auto-descubrimiento (`export const routes`). La lógica vive en
 * `lib/travel/**`; este módulo solo valida HTTP, muta el store y responde.
 */

import { addActivity, store } from '../store.mjs';
import {
  bodyOf, itemEnvelope, listEnvelope, notFound, queryInt, queryString, respond,
  route, sendError, paramOf
} from '../agenda/http.mjs';
import { timezoneOf } from '../agenda/time.mjs';
import {
  createPlace, deletePlace, getPlace, listPlaces, placeLabel, resolvePlace, updatePlace,
  TravelError, PLACE_CATEGORIES, DEFAULT_PLACES
} from '../travel/places.mjs';
import { estimateTravel, travelSettings, formatTravelSummary, TRAVEL_MODES } from '../travel/eta.mjs';
import { planTravel, computeEventTravel, parseInstant } from '../travel/plan.mjs';
import { ensureMeetLink, meetForEvent } from '../travel/meet.mjs';
import {
  closeTask, createTask, deleteTask, getTask, listTasks, reopenTask, taskSummary,
  updateTask, parseTaskText, TASK_ORIGINS, TASK_PRIORITIES, TASK_STATUSES
} from '../travel/tasks.mjs';

export const name = 'travel';
export const priority = 100;

async function mutateWith(fn) {
  let result;
  await store.mutate(async (data) => { result = await fn(data); });
  return result;
}

function travelError(error) {
  return error;
}

/* ------------------------------------------------------------------ */
/* Lugares                                                             */
/* ------------------------------------------------------------------ */

function placesList(ctx) {
  const data = store.get();
  const items = listPlaces(data, {
    q: queryString(ctx, 'q'),
    city: queryString(ctx, 'city'),
    category: queryString(ctx, 'category')
  });
  return respond(ctx, 200, listEnvelope(items, {
    cities: [...new Set(items.map((place) => place.city).filter(Boolean))].sort(),
    categories: PLACE_CATEGORIES,
    total: items.length
  }));
}

async function placesCreate(ctx) {
  const body = await bodyOf(ctx);
  try {
    const place = await mutateWith((data) => {
      const created = createPlace(data, body);
      addActivity('travel', `Lugar creado: ${created.name}`, { placeId: created.id });
      return created;
    });
    return respond(ctx, 201, itemEnvelope(place));
  } catch (error) {
    return sendError(ctx, travelError(error));
  }
}

function placesGet(ctx) {
  const place = getPlace(store.get(), paramOf(ctx, 'id'));
  if (!place) return notFound(ctx, `No encontré el lugar ${paramOf(ctx, 'id')}`);
  return respond(ctx, 200, itemEnvelope(place));
}

async function placesPatch(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  try {
    const place = await mutateWith((data) => {
      const updated = updatePlace(data, id, body);
      addActivity('travel', `Lugar editado: ${updated.name}`, { placeId: updated.id });
      return updated;
    });
    return respond(ctx, 200, itemEnvelope(place));
  } catch (error) {
    return sendError(ctx, travelError(error));
  }
}

async function placesDelete(ctx) {
  const id = paramOf(ctx, 'id');
  try {
    const place = await mutateWith((data) => {
      const removed = deletePlace(data, id);
      addActivity('travel', `Lugar eliminado: ${removed.name}`, { placeId: removed.id });
      return removed;
    });
    return respond(ctx, 200, { ok: true, item: place });
  } catch (error) {
    return sendError(ctx, travelError(error));
  }
}

function placesResolve(ctx) {
  const data = store.get();
  const text = queryString(ctx, 'text') || queryString(ctx, 'q') || queryString(ctx, 'place');
  if (!text) return respond(ctx, 400, { error: 'text es requerido', code: 'VALIDATION', field: 'text', requestId: ctx.requestId });
  const resolved = resolvePlace(data, text);
  if (!resolved) {
    return respond(ctx, 404, {
      error: `No encontré «${text}» en el catálogo`,
      code: 'PLACE_NOT_FOUND', field: 'text', requestId: ctx.requestId,
      suggestions: listPlaces(data).slice(0, 5).map((place) => ({ id: place.id, name: place.name, city: place.city }))
    });
  }
  return respond(ctx, 200, { item: resolved.place, score: Math.round(resolved.score * 100) / 100, method: resolved.method, label: placeLabel(resolved.place) });
}

/* ------------------------------------------------------------------ */
/* ETA y planificador                                                  */
/* ------------------------------------------------------------------ */

async function eta(ctx, input = null) {
  const data = store.get();
  const body = input || {
    fromPlace: queryString(ctx, 'fromPlace') || queryString(ctx, 'from'),
    toPlace: queryString(ctx, 'toPlace') || queryString(ctx, 'to'),
    at: queryString(ctx, 'at')
  };
  const from = resolvePlace(data, body.fromPlace ?? body.from);
  const to = resolvePlace(data, body.toPlace ?? body.to);
  if (!from) throw new TravelError(404, 'PLACE_NOT_FOUND', 'No encontré el lugar de origen', { field: 'fromPlace' });
  if (!to) throw new TravelError(404, 'PLACE_NOT_FOUND', 'No encontré el lugar de destino', { field: 'toPlace' });
  const departAt = body.at ? parseInstant(body.at, 'at', timezoneOf(data.settings)) : new Date().toISOString();
  const estimate = await estimateTravel({
    from: from.place, to: to.place, departAt, mode: body.mode || 'auto', settings: data.settings,
    marginMin: body.marginMin, speedKmh: body.speedKmh, gapMin: body.gapMin
  });
  return {
    ...estimate,
    from: { ...from.place, label: placeLabel(from.place) },
    to: { ...to.place, label: placeLabel(to.place) },
    summary: formatTravelSummary(estimate, { fromLabel: placeLabel(from.place), toLabel: placeLabel(to.place) })
  };
}

async function etaGet(ctx) {
  try {
    return respond(ctx, 200, await eta(ctx));
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function etaPost(ctx) {
  try {
    return respond(ctx, 200, await eta(ctx, await bodyOf(ctx)));
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function planPost(ctx) {
  const body = await bodyOf(ctx);
  const data = store.get();
  try {
    const plan = await planTravel({
      data,
      settings: data.settings,
      fromPlace: body.fromPlace ?? body.from,
      fromAt: body.fromAt,
      toPlace: body.toPlace ?? body.to,
      toAt: body.toAt,
      mode: body.mode || 'auto',
      durationMin: body.durationMin,
      horizonDays: body.horizonDays
    });
    // Se devuelve el plan directo (spec t15). No duplicar referencias: el
    // redactor de respuestas convierte referencias repetidas en "[circular]".
    return respond(ctx, 200, plan);
  } catch (error) {
    return sendError(ctx, error);
  }
}

function travelConfig(ctx) {
  const data = store.get();
  const config = travelSettings(data.settings);
  return respond(ctx, 200, {
    item: {
      modes: TRAVEL_MODES,
      speedsKmh: config.speeds,
      marginsMin: config.margins,
      rushFactor: config.rushFactor,
      rushWindows: config.rushWindows,
      autoModes: config.autoModes,
      googleDistanceMatrix: Boolean(process.env.GOOGLE_DISTANCE_MATRIX_KEY || process.env.GOOGLE_MAPS_API_KEY),
      places: listPlaces(data).length,
      defaultPlaces: DEFAULT_PLACES.length
    }
  });
}

/* ------------------------------------------------------------------ */
/* Integración con agenda: viaje del evento y Meet                     */
/* ------------------------------------------------------------------ */

async function eventTravel(ctx) {
  const id = paramOf(ctx, 'id');
  const data = store.get();
  const event = (data.agenda || []).find((item) => item.id === id);
  if (!event) return notFound(ctx, `No encontré la cita ${id}`);
  try {
    const travel = await computeEventTravel({ data, settings: data.settings, event });
    return respond(ctx, 200, {
      item: event,
      travel,
      feasible: travel?.feasible ?? null,
      warning: travel?.warning || null,
      // Copia propia: evita que el redactor marque la referencia repetida.
      alternatives: (travel?.alternatives || []).map((alternative) => ({ ...alternative }))
    });
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function meetPost(ctx) {
  const id = paramOf(ctx, 'id');
  const data = store.get();
  const event = (data.agenda || []).find((item) => item.id === id);
  if (!event) return notFound(ctx, `No encontré la cita ${id}`);
  try {
    const result = await mutateWith(async (current) => {
      const target = (current.agenda || []).find((item) => item.id === id);
      const meet = await ensureMeetLink({ data: current, settings: current.settings, event: target });
      target.updatedAt = new Date().toISOString();
      addActivity('calendar', `${meet.generated ? 'Sala Meet generada' : 'Meet creado en Google'}: ${target.title}`, { agendaId: target.id });
      return { event: target, meet };
    });
    return respond(ctx, 200, {
      ok: true,
      item: result.event,
      meetLink: result.meet.meetLink,
      generated: result.meet.generated,
      provider: result.meet.provider,
      note: result.meet.note,
      googleError: result.meet.googleError || null,
      meet: result.event.meet ? { ...result.event.meet } : null
    });
  } catch (error) {
    return sendError(ctx, error);
  }
}

function meetGet(ctx) {
  const id = paramOf(ctx, 'id');
  const event = (store.get().agenda || []).find((item) => item.id === id);
  if (!event) return notFound(ctx, `No encontré la cita ${id}`);
  const meet = meetForEvent(event);
  return respond(ctx, 200, {
    item: event,
    ...meet,
    meet: meet.meet ? { ...meet.meet } : null
  });
}

/* ------------------------------------------------------------------ */
/* Tareas                                                              */
/* ------------------------------------------------------------------ */

function tasksList(ctx) {
  const data = store.get();
  const status = queryString(ctx, 'status', 'all');
  const items = listTasks(data, {
    status,
    owner: queryString(ctx, 'owner'),
    origin: queryString(ctx, 'origin'),
    q: queryString(ctx, 'q'),
    due: queryString(ctx, 'due'),
    eventId: queryString(ctx, 'eventId')
  });
  const limit = queryInt(ctx, 'limit', 500, { min: 1, max: 2000 });
  return respond(ctx, 200, listEnvelope(items.slice(0, limit), {
    total: items.length,
    summary: taskSummary(data),
    origins: TASK_ORIGINS,
    priorities: TASK_PRIORITIES,
    statuses: TASK_STATUSES
  }));
}

function tasksExport(ctx) {
  const data = store.get();
  const items = listTasks(data, {
    status: queryString(ctx, 'status', 'all'),
    owner: queryString(ctx, 'owner'),
    origin: queryString(ctx, 'origin'),
    q: queryString(ctx, 'q'),
    due: queryString(ctx, 'due'),
    eventId: queryString(ctx, 'eventId')
  });
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['ID', 'Título', 'Estado', 'Prioridad', 'Responsable', 'Vence', 'Origen', 'Persona', 'Notas', 'Resultado', 'Creada', 'Cerrada'];
  const rows = items.map((task) => [
    task.id, task.title, task.status, task.priority, task.owner, task.due, task.origin,
    task.person, task.notes, task.result, task.createdAt, task.closedAt
  ]);
  const body = '\uFEFF' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
  ctx.res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="tareas.csv"',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  ctx.res.end(body);
}

async function tasksCreate(ctx) {
  const body = await bodyOf(ctx);
  const input = { ...body };
  if (input.text && !input.origin && !input.source) input.origin = 'chat';
  try {
    const task = await mutateWith((data) => {
      const created = createTask(data, input);
      addActivity('task', `Tarea creada: ${created.title}`, { taskId: created.id });
      return created;
    });
    return respond(ctx, 201, itemEnvelope(task));
  } catch (error) {
    return sendError(ctx, error);
  }
}

function tasksGet(ctx) {
  const task = getTask(store.get(), paramOf(ctx, 'id'));
  if (!task) return notFound(ctx, `No encontré la tarea ${paramOf(ctx, 'id')}`);
  return respond(ctx, 200, itemEnvelope(task));
}

async function tasksPatch(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  try {
    const task = await mutateWith((data) => {
      const updated = updateTask(data, id, body);
      addActivity('task', `Tarea editada: ${updated.title}`, { taskId: updated.id });
      return updated;
    });
    return respond(ctx, 200, itemEnvelope(task));
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function tasksClose(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  try {
    const result = await mutateWith((data) => {
      const closed = closeTask(data, id, { result: body.result, closedBy: body.closedBy || body.owner });
      addActivity('task', `Tarea cerrada: ${closed.task.title}`, { taskId: closed.task.id });
      return closed;
    });
    return respond(ctx, 200, { ok: true, item: result.task, alreadyClosed: result.alreadyClosed });
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function tasksReopen(ctx) {
  const id = paramOf(ctx, 'id');
  try {
    const task = await mutateWith((data) => {
      const reopened = reopenTask(data, id);
      addActivity('task', `Tarea reabierta: ${reopened.title}`, { taskId: reopened.id });
      return reopened;
    });
    return respond(ctx, 200, itemEnvelope(task));
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function tasksDelete(ctx) {
  const id = paramOf(ctx, 'id');
  try {
    const removed = await mutateWith((data) => deleteTask(data, id));
    return respond(ctx, 200, { ok: true, item: removed });
  } catch (error) {
    return sendError(ctx, error);
  }
}

function tasksSummaryRoute(ctx) {
  return respond(ctx, 200, { item: taskSummary(store.get()) });
}

function tasksParse(ctx) {
  const text = queryString(ctx, 'text');
  if (!text) return respond(ctx, 400, { error: 'text es requerido', code: 'VALIDATION', field: 'text', requestId: ctx.requestId });
  return respond(ctx, 200, { item: parseTaskText(text) });
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

export const routes = [
  // Lugares
  { method: 'GET', path: '/api/travel/places', name: 'travel.places.list', handler: route(placesList) },
  { method: 'POST', path: '/api/travel/places', name: 'travel.places.create', handler: route(placesCreate) },
  { method: 'GET', path: '/api/travel/places/:id', name: 'travel.places.get', handler: route(placesGet) },
  { method: 'PATCH', path: '/api/travel/places/:id', name: 'travel.places.patch', handler: route(placesPatch) },
  { method: 'DELETE', path: '/api/travel/places/:id', name: 'travel.places.delete', handler: route(placesDelete) },
  { method: 'GET', path: '/api/travel/resolve', name: 'travel.resolve', handler: route(placesResolve) },
  { method: 'GET', path: '/api/travel/eta', name: 'travel.eta.get', handler: route(etaGet) },
  { method: 'POST', path: '/api/travel/eta', name: 'travel.eta.post', handler: route(etaPost) },
  { method: 'GET', path: '/api/travel/config', name: 'travel.config', handler: route(travelConfig) },
  { method: 'POST', path: '/api/travel/plan', name: 'travel.plan', handler: route(planPost) },

  // Integración con agenda
  { method: 'GET', path: '/api/agenda/:id/travel', name: 'travel.event.get', handler: route(eventTravel) },
  { method: 'POST', path: '/api/agenda/:id/meet', name: 'travel.event.meet', handler: route(meetPost) },
  { method: 'GET', path: '/api/agenda/:id/meet', name: 'travel.event.meet.get', handler: route(meetGet) },

  // Tareas
  { method: 'GET', path: '/api/tasks', name: 'tasks.list', handler: route(tasksList) },
  { method: 'GET', path: '/api/tasks/export.csv', name: 'tasks.export.csv', handler: route(tasksExport) },
  { method: 'POST', path: '/api/tasks', name: 'tasks.create', handler: route(tasksCreate) },
  { method: 'GET', path: '/api/tasks/summary', name: 'tasks.summary', handler: route(tasksSummaryRoute) },
  { method: 'GET', path: '/api/tasks/parse', name: 'tasks.parse', handler: route(tasksParse) },
  { method: 'GET', path: '/api/tasks/:id', name: 'tasks.get', handler: route(tasksGet) },
  { method: 'PATCH', path: '/api/tasks/:id', name: 'tasks.patch', handler: route(tasksPatch) },
  { method: 'DELETE', path: '/api/tasks/:id', name: 'tasks.delete', handler: route(tasksDelete) },
  { method: 'POST', path: '/api/tasks/:id/close', name: 'tasks.close', handler: route(tasksClose) },
  { method: 'POST', path: '/api/tasks/:id/reopen', name: 'tasks.reopen', handler: route(tasksReopen) }
];

export default { name, priority, routes };

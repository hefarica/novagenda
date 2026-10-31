import { store } from '../store.mjs';
import { addDaysKey, dateKeyOfIso, isValidDateKey, isValidIso, isoAtLocal, minutesBetween, timezoneOf } from '../agenda/time.mjs';
import { computeP95FromData } from '../agenda/p95.mjs';
import { withComputedScore } from '../agenda/score.mjs';
import { checkConflicts, findSlotsDetailed } from '../agenda/conflicts.mjs';
import {
  cancelAgendaEvent, completeAgendaEvent, createAgendaEvent, deleteAgendaEventHard,
  patchAgendaEvent, presentEvent, recalculateAllScores
} from '../agenda/events.mjs';
import {
  captureDailyMetrics, getMetrics, monthlyReport, snapshotDailyMetrics, weeklyReport,
  formatMonthlyText, formatWeeklyText
} from '../metrics/metrics.mjs';
import { googleSyncStatus, reconcileGoogle } from '../google.mjs';
import { dashboard, monthlySummary } from '../assistant.mjs';
import { agendaIcsFilename, buildAgendaIcs } from '../agenda/ics.mjs';
import {
  bodyOf, itemEnvelope, listEnvelope, notFound, queryBool, queryInt, queryString,
  respond, route, sendError, paramOf
} from '../agenda/http.mjs';

/**
 * Rutas del motor de agenda y métricas.
 * Se monta por auto-descubrimiento (`export const routes`).
 */

export const name = 'agenda';
export const priority = 100;

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

function parseInstant(raw, { end = false } = {}) {
  if (!raw) return null;
  if (isValidIso(raw)) return raw;
  if (isValidDateKey(raw)) {
    const tz = timezoneOf(store.get().settings);
    return end ? isoAtLocal(raw, '23:59', tz) : isoAtLocal(raw, '00:00', tz);
  }
  return null;
}

function agendaIcs(ctx) {
  const data = store.get();
  const ics = buildAgendaIcs(data, {
    calendarName: data.settings?.ownerName || 'Agenda',
    now: new Date()
  });
  const filename = agendaIcsFilename(data);
  ctx.res.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(ics),
    'cache-control': 'no-store'
  });
  ctx.res.end(ctx.head ? undefined : ics);
  return 200;
}

function agendaList(ctx) {
  const data = store.get();
  const tz = timezoneOf(data.settings);
  const from = parseInstant(queryString(ctx, 'from'));
  const to = parseInstant(queryString(ctx, 'to'), { end: true });
  const date = queryString(ctx, 'date');
  const status = queryString(ctx, 'status');
  const type = queryString(ctx, 'type');
  const q = queryString(ctx, 'q');
  const limit = queryInt(ctx, 'limit', 500, { min: 1, max: 2000 });
  const order = queryString(ctx, 'order', 'start');
  const STATUSES = ['Pendiente', 'En curso', 'Hecho', 'Cancelada', 'Reprogramada'];
  if (status !== null && !STATUSES.some((value) => value.toLowerCase() === status.toLowerCase())) {
    return respond(ctx, 400, {
      error: `status inválido. Valores: ${STATUSES.join(', ')}`,
      code: 'INVALID_VALUE', field: 'status', requestId: ctx.requestId
    });
  }
  if (!['start', 'score'].includes(order)) {
    return respond(ctx, 400, {
      error: 'order debe ser start o score', code: 'INVALID_VALUE', field: 'order', requestId: ctx.requestId
    });
  }
  if (queryString(ctx, 'date') !== null && !isValidDateKey(date)) {
    return respond(ctx, 400, { error: 'date debe ser YYYY-MM-DD', code: 'INVALID_DATE', field: 'date', requestId: ctx.requestId });
  }
  // `from`/`to` malformados se ignoran (no filtran), según el contrato de API.
  let rows = data.agenda.filter((event) => {
    if (!event) return false;
    if (date && dateKeyOfIso(event.start, tz) !== date) return false;
    if (from && new Date(event.start).getTime() < new Date(from).getTime()) return false;
    if (to && new Date(event.start).getTime() > new Date(to).getTime()) return false;
    if (status && String(event.status || '').toLowerCase() !== status.toLowerCase()) return false;
    if (type && String(event.type || '').toLowerCase() !== type.toLowerCase()) return false;
    if (q && !`${event.title} ${event.notes} ${event.id} ${event.result}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  rows = rows.map(presentEvent);
  rows.sort(order === 'score'
    ? (a, b) => (Number(b.score) - Number(a.score)) || (new Date(a.start) - new Date(b.start))
    : (a, b) => new Date(a.start) - new Date(b.start));
  const total = rows.length;
  return listEnvelope(rows.slice(0, limit), { total, date: date || null });
}

function agendaGet(ctx) {
  const id = paramOf(ctx, 'id');
  const event = store.get().agenda.find((item) => item.id === id);
  if (!event) return notFound(ctx, `No encontré ${id}`);
  return respond(ctx, 200, itemEnvelope(presentEvent(event)));
}

async function agendaCreate(ctx) {
  const raw = await bodyOf(ctx);
  const { force, allowUnverified, check, ...payload } = raw || {};
  const result = await mutateWith((data) => createAgendaEvent({
    data,
    settings: data.settings,
    payload,
    check: check !== false,
    force: force === true,
    allowUnverified: allowUnverified === true
  }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 201, itemEnvelope(presentEvent(result.event)));
}

async function agendaPatch(ctx) {
  const id = paramOf(ctx, 'id');
  const raw = await bodyOf(ctx);
  const { force, allowUnverified, check, ...patch } = raw || {};
  const result = await mutateWith((data) => patchAgendaEvent({
    data,
    settings: data.settings,
    id,
    patch,
    check: check !== false,
    force: force === true,
    allowUnverified: allowUnverified === true
  }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, itemEnvelope(presentEvent(result.event), { changed: result.changed }));
}

async function agendaDelete(ctx) {
  const id = paramOf(ctx, 'id');
  const result = await mutateWith((data) => cancelAgendaEvent({ data, settings: data.settings, id }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, { ok: true, item: presentEvent(result.event), google: result.google });
}

async function agendaHardDelete(ctx) {
  const id = paramOf(ctx, 'id');
  const result = await mutateWith((data) => deleteAgendaEventHard({ data, id }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, { ok: true, item: presentEvent(result.event) });
}

async function agendaComplete(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const result = await mutateWith((data) => completeAgendaEvent({
    data, settings: data.settings, id, actualMin: body.actualMin, notes: body.notes
  }));
  if (!result.ok) return fail(ctx, result);
  return respond(ctx, 200, itemEnvelope(presentEvent(result.event)));
}

async function agendaConflicts(ctx) {
  const start = parseInstant(queryString(ctx, 'start'));
  const end = parseInstant(queryString(ctx, 'end'));
  if (!start || !end) return respond(ctx, 400, { error: 'start y end son requeridos', code: 'VALIDATION', requestId: ctx.requestId });
  const ignoreId = queryString(ctx, 'ignoreId');
  const result = await checkConflicts({
    data: store.get(), settings: store.get().settings, start, end,
    ignoreIds: ignoreId ? [ignoreId] : []
  });
  return respond(ctx, 200, {
    conflicts: result.conflicts,
    conflictCount: result.conflictCount,
    errors: result.errors,
    unknown: result.unknown,
    canBook: result.canBook,
    warnings: result.warnings
  });
}

async function agendaSlots(ctx, defaults = {}) {
  const durationMin = queryInt(ctx, 'durationMin', defaults.durationMin ?? 60, { min: 5, max: 720 });
  const from = parseInstant(queryString(ctx, 'from')) || defaults.fromIso || new Date().toISOString();
  const days = queryInt(ctx, 'days', 5, { min: 1, max: 60 });
  const count = queryInt(ctx, 'count', 3, { min: 1, max: 10 });
  const ignoreId = queryString(ctx, 'ignoreId') || defaults.ignoreId || null;
  const result = await findSlotsDetailed({
    durationMin, fromIso: from, days, count,
    data: store.get(), settings: store.get().settings,
    ignoreIds: ignoreId ? [ignoreId] : [],
    includeWeekend: queryBool(ctx, 'includeWeekend', false)
  });
  return respond(ctx, 200, {
    slots: result.slots,
    errors: result.errors,
    unknown: result.unknown,
    horizon: result.horizon
  });
}

function eventSlots(ctx) {
  const id = paramOf(ctx, 'id');
  const event = store.get().agenda.find((item) => item.id === id);
  if (!event) return notFound(ctx, `No encontré ${id}`);
  const durationMin = Math.max(5, Math.abs(minutesBetween(event.start, event.end)) || 60);
  return agendaSlots(ctx, { durationMin, ignoreId: id, fromIso: event.start });
}

async function eventConflicts(ctx) {
  const id = paramOf(ctx, 'id');
  const event = store.get().agenda.find((item) => item.id === id);
  if (!event) return notFound(ctx, `No encontré ${id}`);
  const result = await checkConflicts({
    data: store.get(), settings: store.get().settings, start: event.start, end: event.end, ignoreIds: [id]
  });
  return respond(ctx, 200, {
    conflicts: result.conflicts, conflictCount: result.conflictCount,
    errors: result.errors, unknown: result.unknown, canBook: result.canBook
  });
}

async function agendaRecalculate(ctx) {
  const changed = await mutateWith((data) => recalculateAllScores(data));
  return respond(ctx, 200, { ok: true, changed });
}

function dashboardRoute(ctx) {
  return respond(ctx, 200, dashboard());
}

function p95Route(ctx) {
  const data = store.get();
  const result = computeP95FromData(data, { timezone: timezoneOf(data.settings) });
  return respond(ctx, 200, {
    index: result.index,
    score: result.score,
    components: result.components,
    weights: result.weights,
    targets: result.targets,
    inputs: result.inputs,
    weightsSum: result.weightsSum
  });
}

function metricsGet(ctx) {
  const days = queryInt(ctx, 'days', 90, { min: 1, max: 1100 });
  const from = queryString(ctx, 'from');
  const to = queryString(ctx, 'to');
  const data = store.get();
  const result = getMetrics(data, { days, from: from || undefined, to: to || undefined });
  const p95 = computeP95FromData(data, { timezone: timezoneOf(data.settings) });
  return respond(ctx, 200, {
    items: result.rows,
    rows: result.rows,
    count: result.rows.length,
    total: result.rows.length,
    from: result.from,
    to: result.to,
    days: result.days,
    fields: result.fields,
    totals: result.totals,
    p95: p95.index,
    components: p95.components
  });
}

async function metricsPost(ctx) {
  const body = await bodyOf(ctx);
  const { date, ...patch } = body || {};
  const data = store.get();
  const tz = timezoneOf(data.settings);
  const dateKey = date || dateKeyOfIso(new Date().toISOString(), tz);
  if (!isValidDateKey(dateKey)) return respond(ctx, 400, { error: 'date inválida', code: 'INVALID_DATE', field: 'date', requestId: ctx.requestId });
  try {
    const item = await mutateWith((current) => captureDailyMetrics(current, patch, { dateKey }));
    return respond(ctx, 200, itemEnvelope(item));
  } catch (error) {
    return sendError(ctx, error);
  }
}

function reportWeekly(ctx) {
  const report = weeklyReport(store.get());
  return respond(ctx, 200, {
    text: formatWeeklyText(report),
    report,
    metrics: report.metrics,
    monthly: monthlySummary()
  });
}

function reportMonthly(ctx) {
  const report = monthlyReport(store.get());
  return respond(ctx, 200, { text: formatMonthlyText(report), report, metrics: report.metrics });
}

function googleSyncStatusRoute(ctx) {
  return respond(ctx, 200, googleSyncStatus());
}

async function googleSyncNow(ctx) {
  const report = await reconcileGoogle({ data: store.get(), force: true });
  return respond(ctx, 200, { ok: report.ok !== false, report });
}

export const routes = [
  { method: 'GET', path: '/api/dashboard', name: 'dashboard.get', handler: route(dashboardRoute) },
  { method: 'GET', path: '/api/p95', name: 'p95.get', handler: route(p95Route) },
  { method: 'GET', path: '/api/metrics', name: 'metrics.list', handler: route(metricsGet) },
  { method: 'POST', path: '/api/metrics', name: 'metrics.capture', handler: route(metricsPost) },
  { method: 'GET', path: '/api/report/weekly', name: 'report.weekly', handler: route(reportWeekly) },
  { method: 'GET', path: '/api/report/monthly', name: 'report.monthly', handler: route(reportMonthly) },
  { method: 'GET', path: '/api/google/sync', name: 'google.sync.status', handler: route(googleSyncStatusRoute) },
  { method: 'POST', path: '/api/google/sync', name: 'google.sync.run', handler: route(googleSyncNow) },
  { method: 'GET', path: '/api/agenda', name: 'agenda.list', handler: route(agendaList) },
  { method: 'GET', path: '/api/agenda/export.ics', name: 'agenda.export.ics', handler: agendaIcs },
  { method: 'POST', path: '/api/agenda', name: 'agenda.create', handler: route(agendaCreate) },
  { method: 'GET', path: '/api/agenda/slots', name: 'agenda.slots', handler: route(agendaSlots) },
  { method: 'GET', path: '/api/agenda/conflicts', name: 'agenda.conflicts', handler: route(agendaConflicts) },
  { method: 'POST', path: '/api/agenda/recalculate-scores', name: 'agenda.scores.recalculate', handler: route(agendaRecalculate) },
  { method: 'GET', path: '/api/agenda/:id', name: 'agenda.get', handler: route(agendaGet) },
  { method: 'PATCH', path: '/api/agenda/:id', name: 'agenda.patch', handler: route(agendaPatch) },
  { method: 'DELETE', path: '/api/agenda/:id', name: 'agenda.cancel', handler: route(agendaDelete) },
  { method: 'POST', path: '/api/agenda/:id/complete', name: 'agenda.complete', handler: route(agendaComplete) },
  { method: 'POST', path: '/api/agenda/:id/cancel', name: 'agenda.cancel.post', handler: route(agendaDelete) },
  { method: 'DELETE', path: '/api/agenda/:id/hard', name: 'agenda.delete', handler: route(agendaHardDelete) },
  { method: 'GET', path: '/api/agenda/:id/conflicts', name: 'agenda.event.conflicts', handler: route(eventConflicts) },
  { method: 'GET', path: '/api/agenda/:id/slots', name: 'agenda.event.slots', handler: route(eventSlots) }
];

// La reconciliación periódica la programa el scheduler de workflows (t8).
// Aquí solo se expone el estado y el disparo manual vía POST /api/google/sync.

export default { name, priority, routes };


#!/usr/bin/env node
/**
 * Autochequeo del motor de agenda (t2).
 *
 * Ejecuta las aceptaciones clave con un DATA_DIR temporal (nunca toca
 * data/agenda-data.json) y sin red: Google se mockea con `setGoogleTransport`.
 *
 * Uso:
 *   node lib/agenda/selfcheck.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// IMPORTANTE: DATA_DIR se define ANTES de importar store.mjs.
const tmpRoot = path.join(os.tmpdir(), `agenda-p95-selfcheck-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.DATA_DIR = tmpRoot;
process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
process.env.APP_SECRET = process.env.APP_SECRET || 'selfcheck-only-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'selfcheck-client';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'selfcheck-secret';

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const results = [];
function check(name, condition, evidence = '') {
  results.push({ name, ok: !!condition, evidence });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  [${evidence}]` : ''}`);
}
const approx = (a, b, tol = 0.11) => Math.abs(Number(a) - Number(b)) <= tol;

const { store } = await imp('lib/store.mjs');
const time = await imp('lib/agenda/time.mjs');
const p95mod = await imp('lib/agenda/p95.mjs');
const score = await imp('lib/agenda/score.mjs');
const occ = await imp('lib/agenda/occurrences.mjs');
const routines = await imp('lib/agenda/routines.mjs');
const conflicts = await imp('lib/agenda/conflicts.mjs');
const events = await imp('lib/agenda/events.mjs');
const google = await imp('lib/google.mjs');
const metrics = await imp('lib/metrics/metrics.mjs');
const assistant = await imp('lib/assistant.mjs');
const agendaRoutes = await imp('lib/routes/agenda.mjs');
const routineRoutes = await imp('lib/routes/routines.mjs');
const inboxRoutes = await imp('lib/routes/inbox.mjs');

const tz = process.env.TIMEZONE;
const data0 = store.get();
const today = time.dateKeyOfIso(new Date().toISOString(), tz);

// ---------------------------------------------------------------------------
// 1. Índice P95: 7 componentes, pesos del Excel, sin puntos fijos.
// ---------------------------------------------------------------------------
const excel = p95mod.excelReferenceP95();
check('P95 reproduce el valor del Excel (08_DASHBOARD!A4 = 13.1)', approx(excel.index, 13.1), `index=${excel.index}`);
check('P95 tiene 7 componentes y los pesos suman 1', excel.components.length === 7 && approx(excel.weightsSum, 1, 1e-9), `sum=${excel.weightsSum}`);
const allBad = p95mod.computeP95({ agendaExecution: 0, deepFocus: 0, overdue: 99, meetingEffectiveness: 0, okrProgress: 0, weeklyExecution: 0, weeklyReview: 0 }, {});
check('P95 no regala puntos fijos (todo incumplido ⇒ 0)', allBad.index === 0 && allBad.components.every((component) => component.points === 0), `index=${allBad.index}`);
const zeroWeights = p95mod.computeP95(excel.inputs, { weights: Object.fromEntries(Object.keys(excel.weights).map((k) => [k, 0])) });
check('Pesos a cero ⇒ índice 0', zeroWeights.index === 0, `index=${zeroWeights.index}`);

const seedP95 = p95mod.computeP95FromData(data0, { dateKey: today, timezone: tz });
const sumPoints = Math.round(seedP95.components.reduce((sum, component) => sum + component.points, 0) * 10) / 10;
check('Índice del seed = suma de sus 7 componentes', approx(seedP95.index, sumPoints, 0.05), `index=${seedP95.index} sum=${sumPoints}`);
check('Vencidas usa la fórmula INVERSO (1 − vencidas/meta)', seedP95.components.find((c) => c.key === 'overdue')?.points === 15, 'overdue=0 ⇒ 15 pts');

// ---------------------------------------------------------------------------
// 2. Score de prioridad y Top 3.
// ---------------------------------------------------------------------------
check('Score AG-0001 = 96', score.priorityScore(data0.agenda.find((e) => e.id === 'AG-0001')) === 96);
check('Score AG-0002 = 94 (foco profundo)', score.priorityScore(data0.agenda.find((e) => e.id === 'AG-0002')) === 94);
check('Score AG-0003 = 72', score.priorityScore(data0.agenda.find((e) => e.id === 'AG-0003')) === 72);
check('Score AG-0004 = 90', score.priorityScore(data0.agenda.find((e) => e.id === 'AG-0004')) === 90);
const beforeTop = assistant.dashboard().top3.map((e) => e.id);
await store.mutate((d) => {
  const event = d.agenda.find((e) => e.id === 'AG-0003');
  Object.assign(event, { impact: 5, urgency: 5, priority: 'P1', deepFocus: true });
});
const afterTop = assistant.dashboard().top3.map((e) => e.id);
check('Cambiar impacto/urgencia reordena el Top 3', afterTop[0] === 'AG-0003' && beforeTop[0] !== afterTop[0], `${beforeTop} → ${afterTop}`);
await store.mutate((d) => {
  const event = d.agenda.find((e) => e.id === 'AG-0003');
  Object.assign(event, { impact: 4, urgency: 3, priority: 'P2', deepFocus: false });
});

// ---------------------------------------------------------------------------
// 3. Conflictos con plantillas futuras, festivos, fin de semana y alternativas.
// ---------------------------------------------------------------------------
let wednesday = time.addDaysKey(today, 1);
while (time.weekdayCodeOfKey(wednesday) !== 'MIE') wednesday = time.addDaysKey(wednesday, 1);
const wedStart = time.isoAtLocal(wednesday, '07:30', tz);
const wedEnd = time.isoAtLocal(wednesday, '08:15', tz);
const conflict = await conflicts.checkConflicts({ data: store.get(), settings: store.get().settings, start: wedStart, end: wedEnd });
check('Miércoles 07:30 choca con la plantilla R-002', conflict.conflicts.some((c) => c.routineId === 'R-002' || c.id === 'R-002'), JSON.stringify(conflict.conflicts.map((c) => c.id)));
const slots = await conflicts.findSlotsDetailed({ durationMin: 60, fromIso: wedStart, days: 5, count: 3, data: store.get(), settings: store.get().settings });
check('Alternativas dentro de jornada y sin solapes', slots.slots.length === 3 && slots.slots.every((slot) => {
  const key = time.timeKeyOf(new Date(slot.start), tz);
  return key >= '07:00' && key < '19:00' && !conflict.conflicts.some((c) => time.overlaps(c.start, c.end, slot.start, slot.end));
}), slots.slots.map((s) => time.timeKeyOf(new Date(s.start), tz)).join(','));
check('Alternativas no caen en fin de semana', slots.slots.every((slot) => !['SAB', 'DOM'].includes(time.weekdayCodeOfKey(slot.date))));
await store.mutate((d) => { d.settings.holidays = [wednesday]; });
const holidaySlots = await conflicts.findSlotsDetailed({ durationMin: 60, fromIso: time.isoAtLocal(wednesday, '08:00', tz), days: 1, count: 1, data: store.get(), settings: store.get().settings });
check('Festivo configurable no ofrece alternativas', holidaySlots.slots.length === 0);
await store.mutate((d) => { d.settings.holidays = []; });

// Google día completo + FreeBusy roto.
const transportCalls = [];
let freeBusyFail = false;
let allDayMode = false;
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
google.setGoogleTransport((url, options = {}) => {
  const target = String(url);
  const method = (options.method || 'GET').toUpperCase();
  transportCalls.push({ url: target, method, body: options.body });
  if (target.includes('/token')) return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  if (target.includes('userinfo')) return jsonResponse({ email: 'selfcheck@example.com' });
  if (target.includes('calendarList')) return jsonResponse({ items: [{ id: 'primary', summary: 'Principal', primary: true, accessRole: 'owner', timeZone: tz }] });
  if (target.includes('/freeBusy')) {
    if (freeBusyFail) return jsonResponse({ error: { message: 'freebusy down' } }, 400);
    return jsonResponse({ calendars: { primary: { busy: [] } } });
  }
  if (target.includes('/events') && method === 'POST') {
    globalThis.__selfcheckEventCounter = (globalThis.__selfcheckEventCounter || 0) + 1;
    return jsonResponse({ id: `g-selfcheck-${globalThis.__selfcheckEventCounter}`, updated: new Date().toISOString() });
  }
  if (target.includes('/events') && method === 'PATCH') return jsonResponse({ id: 'g-selfcheck-1', updated: new Date().toISOString() });
  if (target.includes('/events') && method === 'DELETE') return new Response(null, { status: 204 });
  if (target.includes('/events')) {
    if (allDayMode) {
      return jsonResponse({ items: [{ id: 'allday', summary: 'Viaje', status: 'confirmed', transparency: 'opaque', start: { date: wednesday }, end: { date: time.addDaysKey(wednesday, 1) }, updated: new Date().toISOString() }] });
    }
    return jsonResponse({ items: [], nextSyncToken: 'selfcheck-sync' });
  }
  if (target.includes('/revoke')) return new Response(null, { status: 200 });
  return jsonResponse({ error: { message: `unmocked ${target}` } }, 500);
});
await google.finishGoogleOAuth({ code: 'selfcheck', redirectUri: 'http://localhost/cb' });
allDayMode = true;
google.clearGoogleCaches();
const allDay = await conflicts.checkConflicts({
  data: store.get(), settings: store.get().settings,
  start: time.isoAtLocal(wednesday, '10:00', tz), end: time.isoAtLocal(wednesday, '11:00', tz)
});
check('Evento de Google de día completo bloquea la jornada', allDay.conflicts.some((c) => c.source === 'google-allday'), '');
allDayMode = false;
freeBusyFail = true;
google.clearGoogleCaches();
const broken = await conflicts.checkConflicts({
  data: store.get(), settings: store.get().settings,
  start: time.isoAtLocal(time.addDaysKey(today, 3), '10:00', tz), end: time.isoAtLocal(time.addDaysKey(today, 3), '11:00', tz)
});
check('FreeBusy roto es visible y NUNCA se asume libre', broken.errors.length > 0 && broken.unknown === true && broken.canBook === false, `${broken.errors.length} error(es)`);
freeBusyFail = false;

// ---------------------------------------------------------------------------
// 4. Google bidireccional: crear → editar → cancelar borra en Google.
// ---------------------------------------------------------------------------
let createdEvent;
await store.mutate(async (d) => {
  const result = await events.createAgendaEvent({
    data: d, settings: d.settings, check: false,
    payload: { title: 'Cita selfcheck', start: time.isoAtLocal(time.addDaysKey(today, 4), '09:00', tz), end: time.isoAtLocal(time.addDaysKey(today, 4), '10:00', tz) }
  });
  createdEvent = result.event;
});
check('Crear cita la sincroniza con Google', !!createdEvent?.google?.eventId, String(createdEvent?.google?.eventId));
await store.mutate(async (d) => {
  await events.patchAgendaEvent({ data: d, settings: d.settings, id: createdEvent.id, patch: { title: 'Cita selfcheck editada' }, check: false });
});
check('PATCH de la cita actualiza Google', transportCalls.some((c) => c.method === 'PATCH'));
const deletesBefore = transportCalls.filter((c) => c.method === 'DELETE').length;
await store.mutate(async (d) => {
  await events.cancelAgendaEvent({ data: d, settings: d.settings, id: createdEvent.id });
});
check('Cancelar en la app borra el evento en Google', transportCalls.filter((c) => c.method === 'DELETE').length === deletesBefore + 1);
check('El evento cancelado ya no conserva vínculo Google', !store.get().agenda.find((e) => e.id === createdEvent.id)?.google);

// ---------------------------------------------------------------------------
// 5. Rutinas: preview 30, clamp mensual, skip, materialización idempotente.
// ---------------------------------------------------------------------------
const routine002 = occ.findRoutine(store.get(), 'R-002');
const preview30 = routines.previewRoutine(routine002, { count: 30, fromKey: today, settings: store.get().settings });
check('Preview de R-002 muestra 30 fechas laborables', preview30.length === 30 && preview30.every((o) => !['SAB', 'DOM'].includes(time.weekdayCodeOfKey(o.date))), `n=${preview30.length}`);
const monthly = occ.normalizeRoutine({ id: 'R-SELF-M', active: true, frequency: 'MENSUAL', rule: '31', time: '08:00', durationMin: 30, title: 'Mensual', start: '2027-01-01' }, 'recurrence', store.get().settings);
const clamp = routines.previewRoutine(monthly, { count: 4, fromKey: '2027-01-01', settings: store.get().settings });
check('Mensual día 31 hace clamp a fin de mes', ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'].every((date) => clamp.some((o) => o.date === date)), clamp.map((o) => o.date).join(','));
const skipDate = preview30[2].date;
await store.mutate((d) => routines.skipRoutineDate(d, 'R-002', skipDate, { reason: 'selfcheck' }));
const afterSkip = routines.previewRoutine(occ.findRoutine(store.get(), 'R-002'), { count: 30, fromKey: today, settings: store.get().settings });
check('Excepción por fecha elimina la aparición', !afterSkip.some((o) => o.date === skipDate));
await store.mutate((d) => {
  d.recurrences.push({ id: 'R-SELF-T', active: true, frequency: 'DIARIA', rule: '', time: '05:45', durationMin: 10, type: 'Administrativo', title: 'Selfcheck', result: '', priority: 'P3', impact: 2, urgency: 2, deepFocus: false, reminderMin: 0, whatsapp: false, calendar: false, owner: 'Yo', start: today, end: null, notes: '' });
});
const firstRun = await store.mutate((d) => routines.materializeRoutineRange(d, d.settings, { fromKey: today, toKey: today }));
const secondRun = await store.mutate((d) => routines.materializeRoutineRange(d, d.settings, { fromKey: today, toKey: today }));
const firstSelf = firstRun.created.filter((item) => item.routineId === 'R-SELF-T').length;
const secondSelf = secondRun.created.filter((item) => item.routineId === 'R-SELF-T').length;
check('Materialización idempotente (sin dobles reservas)', firstSelf === 1 && secondSelf === 0, `selfRun1=${firstSelf} selfRun2=${secondSelf} totalRun1=${firstRun.created.length}`);

// ---------------------------------------------------------------------------
// 6. Métricas de 14 campos e Inbox → cita.
// ---------------------------------------------------------------------------
const metric = await store.mutate((d) => metrics.snapshotDailyMetrics(d, { patch: { energyAM: 4, energyPM: 3, interruptions: 2, improvement: '1%', comments: 'selfcheck' } }));
check('Métricas guardan exactamente los 14 campos', Object.keys(metric).length === 14, Object.keys(metric).join(','));
check('Métricas capturan energía/interrupciones/mejora/comentarios', metric.energyAM === 4 && metric.energyPM === 3 && metric.interruptions === 2 && metric.improvement === '1%' && metric.comments === 'selfcheck');
check('planDaily se detecta por rol, no por ID hardcodeado', metric.planDaily === true);
const history = metrics.getMetrics(store.get(), { days: 90 });
check('GET de métricas 90 días devuelve los 14 campos', history.rows.length >= 1 && history.fields.length === 14);
const meetingPatch = await callRoute(routineRoutes, 'PATCH', '/api/routines/:id', { params: { id: 'MT-001' }, body: { effectiveness: 5 } });
const ratedP95 = p95mod.computeP95FromData(store.get(), { dateKey: today, timezone: tz });
check('Efectividad de reuniones alimenta el componente 4 del índice', meetingPatch.status === 200 && meetingPatch.payload.item.effectiveness === 5
  && ratedP95.components.find((c) => c.key === 'meetingEffectiveness')?.points === 10, `points=${ratedP95.components.find((c) => c.key === 'meetingEffectiveness')?.points}`);

function makeCtx({ method = 'GET', pathname = '/', query = {}, params = {}, body = undefined }) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  return {
    method, path: pathname, params, query: search, requestId: 'selfcheck',
    url: new URL(`http://localhost${pathname}${search.toString() ? `?${search}` : ''}`),
    _body: body,
    async body() { return this._body === undefined ? {} : this._body; },
    json(status, payload) { this.response = { status, payload }; return status; }
  };
}
async function callRoute(module, method, pathname, options = {}) {
  const handler = module.routes.find((route) => route.method === method && route.path === pathname)?.handler;
  if (!handler) throw new Error(`Ruta no encontrada: ${method} ${pathname}`);
  const ctx = makeCtx({ method, pathname, ...options });
  await handler(ctx);
  return ctx.response;
}
const inboxCreated = await callRoute(inboxRoutes, 'POST', '/api/inbox', { body: { input: 'Convertir selfcheck', priority: 'P2', estimatedMin: 30 } });
const converted = await callRoute(inboxRoutes, 'POST', '/api/inbox/:id/convert', {
  params: { id: inboxCreated.payload.item.id },
  body: { date: time.addDaysKey(today, 6), time: '11:00', durationMin: 30 }
});
check('Inbox → cita validada marca processed y agendaId', converted.status === 200 && converted.payload.item.processed === true && converted.payload.item.agendaId === converted.payload.event.id);
const conflictRoute = await callRoute(agendaRoutes, 'POST', '/api/agenda', { body: { title: 'Choque selfcheck', start: wedStart, end: wedEnd } });
check('POST /api/agenda avisa el choque con R-002 (409)', conflictRoute.status === 409 && (conflictRoute.payload.conflicts || []).some((c) => c.routineId === 'R-002'), `status=${conflictRoute.status}`);

// ---------------------------------------------------------------------------
// 7. Compatibilidad del asistente + robustez de datos corruptos.
// ---------------------------------------------------------------------------
const hoy = await assistant.handleAssistant('HOY', { channel: 'web', userId: 'selfcheck' });
check('Comando HOY sigue funcionando', /AGENDA COPILOT/.test(hoy.reply), hoy.reply.split('\n')[0]);
const semana = await assistant.handleAssistant('SEMANA', { channel: 'web', userId: 'selfcheck' });
check('Comando SEMANA sigue funcionando', /SEMANA P95/.test(semana.reply));
await store.mutate((d) => {
  d.agenda.push({ id: 'AG-SELF-BAD', start: 'no-es-fecha', end: 'tampoco', due: '2026-02-31', title: 'Corrupto', status: 'Pendiente', impact: 3, urgency: 3, priority: 'P2', type: 'Compromiso', score: 65 });
});
let robust = true;
try {
  assistant.dashboard();
  p95mod.computeP95FromData(store.get());
  conflicts.detectTodayConflicts({ data: store.get() });
  metrics.snapshotDailyMetrics(store.get(), {});
  await assistant.handleAssistant('HOY', { channel: 'web', userId: 'selfcheck' });
} catch (error) {
  robust = false;
  console.log('   error robustez:', error.message);
}
check('Datos corruptos no rompen dashboard/P95/conflictos/métricas/HOY', robust);

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
const failed = results.filter((result) => !result.ok);
console.log(`\n=== SELFCHECK === ${results.length} checks, ${failed.length} failed`);
if (failed.length) console.log(failed.map((result) => `- ${result.name}`).join('\n'));
try {
  await store.flush?.();
} catch { /* la limpieza no debe ocultar el resultado */ }
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch { /* Windows puede retener handles; no es un fallo del selfcheck */ }
process.exit(failed.length ? 1 : 0);

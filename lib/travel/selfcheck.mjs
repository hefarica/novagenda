#!/usr/bin/env node
/**
 * Autochequeo de agenda física (t15).
 *
 * Usa un DATA_DIR temporal y Google mockeado: no toca la agenda real ni la red.
 * Uso: node lib/travel/selfcheck.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmpRoot = path.join(os.tmpdir(), `agenda-travel-selfcheck-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.DATA_DIR = tmpRoot;
process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
process.env.APP_SECRET = process.env.APP_SECRET || 'travel-selfcheck-secret';

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const results = [];
function check(name, condition, evidence = '') {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  [${evidence}]` : ''}`);
}

const { store, encryptJSON } = await imp('lib/store.mjs');
const time = await imp('lib/agenda/time.mjs');
const places = await imp('lib/travel/places.mjs');
const eta = await imp('lib/travel/eta.mjs');
const plan = await imp('lib/travel/plan.mjs');
const tasks = await imp('lib/travel/tasks.mjs');
const meet = await imp('lib/travel/meet.mjs');
const events = await imp('lib/agenda/events.mjs');
const travelRoutes = await imp('lib/routes/travel.mjs');

function makeCtx({ method = 'GET', pathname = '/', query = {}, params = {}, body = undefined }) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  return {
    method, path: pathname, params, query: search, requestId: 'travel-selfcheck',
    url: new URL(`http://localhost${pathname}${search.toString() ? `?${search}` : ''}`),
    _body: body,
    async body() { return this._body === undefined ? {} : this._body; },
    json(status, payload) { this.response = { status, payload }; return status; }
  };
}
async function callRoute(method, pathname, options = {}) {
  const handler = travelRoutes.routes.find((route) => route.method === method && route.path === pathname)?.handler;
  if (!handler) throw new Error(`Ruta no encontrada: ${method} ${pathname}`);
  const ctx = makeCtx({ method, pathname, ...options });
  await handler(ctx);
  return ctx.response;
}

// ---------------------------------------------------------------------------
// 1. Catálogo y resolución difusa
// ---------------------------------------------------------------------------
const data0 = store.get();
const cali = places.resolvePlace(data0, 'Cali');
const palmira = places.resolvePlace(data0, 'Palmira, Valle');
check('Catálogo semilla resuelve Cali', cali?.place?.id === 'PL-0001', cali?.place?.name);
check('Resolución difusa resuelve «Palmira, Valle»', palmira?.place?.id === 'PL-0002', `score=${palmira?.score}`);
check('Lugar desconocido devuelve null', places.resolvePlace(data0, 'Marte') === null);
check('Google Meet se detecta como ubicación en línea', places.isOnlineLocation('https://meet.google.com/abc-defg-hij') === true);

// CRUD por servicio
let buga;
await store.mutate((d) => { buga = places.createPlace(d, { name: 'Buga', city: 'Buga', lat: 3.9009, lon: -76.3020, category: 'ciudad' }); });
check('Crear lugar persiste y resuelve', !!buga.id && places.resolvePlace(store.get(), 'Buga')?.place?.id === buga.id, buga.id);
await store.mutate((d) => places.updatePlace(d, buga.id, { notes: 'sede nueva' }));
check('Editar lugar', places.getPlace(store.get(), buga.id)?.notes === 'sede nueva');
await store.mutate((d) => places.deletePlace(d, buga.id));
check('Eliminar lugar', places.getPlace(store.get(), buga.id) === null);

// CRUD por ruta
let response = await callRoute('POST', '/api/travel/places', { body: { name: 'Tuluá', city: 'Tuluá', lat: 4.0847, lon: -76.1954, category: 'ciudad' } });
check('POST /api/travel/places', response.status === 201 && response.payload.item.name === 'Tuluá', String(response.status));
const tuluaId = response.payload.item.id;
response = await callRoute('GET', '/api/travel/places', { query: { q: 'tulua' } });
check('GET /api/travel/places?q', response.status === 200 && response.payload.items.some((place) => place.id === tuluaId));
response = await callRoute('PATCH', '/api/travel/places/:id', { params: { id: tuluaId }, body: { notes: 'ruta' } });
check('PATCH /api/travel/places/:id', response.status === 200 && response.payload.item.notes === 'ruta');
response = await callRoute('DELETE', '/api/travel/places/:id', { params: { id: tuluaId } });
check('DELETE /api/travel/places/:id', response.status === 200 && !places.getPlace(store.get(), tuluaId));

// ---------------------------------------------------------------------------
// 2. ETA offline: perfil, margen y punta
// ---------------------------------------------------------------------------
const km = eta.haversineKm(cali.place, palmira.place);
check('Haversine Cali–Palmira ≈ 20–32 km', km > 20 && km < 32, `${km} km`);
const normal = await eta.estimateTravel({ from: cali.place, to: palmira.place, departAt: '2026-10-29T16:00:00-05:00', mode: 'auto', gapMin: 30, settings: data0.settings });
check('ETA 16:00: mixto, 20 min de margen, 30 min no alcanza', normal.mode === 'mixto' && normal.marginMin === 20 && normal.feasible === false, JSON.stringify({ eta: normal.etaMin, total: normal.totalMin, feasible: normal.feasible }));
const rush = await eta.estimateTravel({ from: cali.place, to: palmira.place, departAt: '2026-10-29T17:30:00-05:00', mode: 'auto', settings: data0.settings });
check('Factor punta 1.35 a las 17:30', rush.rush === true && rush.rushFactor === 1.35 && rush.etaMin > normal.etaMin, `${normal.etaMin} → ${rush.etaMin}`);
const road = await eta.estimateTravel({ from: cali.place, to: places.resolvePlace(data0, 'Bogotá').place, departAt: '2026-10-29T10:00:00-05:00', mode: 'carretera', settings: data0.settings });
check('Perfil carretera aplica margen de 35 min', road.mode === 'carretera' && road.marginMin === 35, JSON.stringify({ km: road.km, eta: road.etaMin, margin: road.marginMin }));

// Proveedor externo opcional (mock): si hay clave usa Distance Matrix.
process.env.GOOGLE_DISTANCE_MATRIX_KEY = 'selfcheck-key';
eta.setEtaTransport(async () => new Response(JSON.stringify({
  status: 'OK',
  rows: [{ elements: [{ status: 'OK', duration: { value: 900 }, distance: { value: 12000 } }] }]
}), { status: 200, headers: { 'content-type': 'application/json' } }));
const googleEta = await eta.estimateTravel({ from: cali.place, to: palmira.place, departAt: '2026-10-29T10:00:00-05:00', settings: data0.settings });
check('Distance Matrix opcional se usa si hay clave', googleEta.source === 'google' && googleEta.etaMin === 15 && googleEta.km === 12, JSON.stringify({ source: googleEta.source, km: googleEta.km, eta: googleEta.etaMin }));
delete process.env.GOOGLE_DISTANCE_MATRIX_KEY;
eta.resetEtaTransport();
eta.clearEtaCache();

// ---------------------------------------------------------------------------
// 3. Planificador: ejemplo del jefe y traslado holgado
// ---------------------------------------------------------------------------
const infeasible = await plan.planTravel({
  data: store.get(), settings: store.get().settings,
  fromPlace: 'Cali', fromAt: '2026-10-29T16:00:00-05:00',
  toPlace: 'Palmira', toAt: '2026-10-29T16:30:00-05:00'
});
check('Cali 16:00 → Palmira 16:30 es infeasible', infeasible.feasible === false, JSON.stringify({ km: infeasible.km, eta: infeasible.etaMin, total: infeasible.totalMin, gap: infeasible.gapMin }));
check('Devuelve al menos 2 alternativas válidas', infeasible.alternatives.length >= 2 && infeasible.alternatives.every((alt) => {
  const gap = time.minutesBetween(infeasible.departureAt, alt.at);
  return gap >= infeasible.totalMin;
}), infeasible.alternatives.map((alt) => `${alt.at} (${alt.kind})`).join(' | '));
check('Alternativas con hora nueva y primer hueco', infeasible.alternatives.some((alt) => alt.kind === 'minimum') && infeasible.alternatives.some((alt) => alt.kind === 'next-gap'));
const feasible = await plan.planTravel({
  data: store.get(), settings: store.get().settings,
  fromPlace: 'Cali', fromAt: '2026-10-29T16:00:00-05:00',
  toPlace: 'Palmira', toAt: '2026-10-29T18:00:00-05:00'
});
check('Cali 16:00 → Palmira 18:00 es feasible con margen', feasible.feasible === true && feasible.gapMin >= feasible.totalMin, JSON.stringify({ gap: feasible.gapMin, total: feasible.totalMin }));
response = await callRoute('POST', '/api/travel/plan', { body: { fromPlace: 'Cali', fromAt: '2026-10-29T16:00:00-05:00', toPlace: 'Palmira', toAt: '2026-10-29T16:30:00-05:00' } });
check('POST /api/travel/plan', response.status === 200 && response.payload.feasible === false && response.payload.alternatives.length >= 2, String(response.status));

// ---------------------------------------------------------------------------
// 4. Integración con agenda: warning sin corromper
// ---------------------------------------------------------------------------
let previous, target;
await store.mutate(async (d) => {
  previous = (await events.createAgendaEvent({ data: d, settings: d.settings, payload: { title: 'Reunión Cali', start: '2026-10-29T15:00:00-05:00', end: '2026-10-29T15:30:00-05:00', location: 'Cali' }, check: false })).event;
  target = (await events.createAgendaEvent({ data: d, settings: d.settings, payload: { title: 'Reunión Palmira', start: '2026-10-29T16:00:00-05:00', end: '2026-10-29T17:00:00-05:00', location: 'Palmira' }, check: false })).event;
});
check('Evento guarda location validado', target.location === 'Palmira', target.location);
check('Evento imposible devuelve travelWarning (no bloquea)', target.travel?.feasible === false && /No llegas/.test(target.travelWarning || ''), target.travelWarning);
response = await callRoute('GET', '/api/agenda/:id/travel', { params: { id: target.id } });
check('GET /api/agenda/:id/travel', response.status === 200 && response.payload.travel.feasible === false && response.payload.alternatives.length >= 2, String(response.status));
let moved;
await store.mutate(async (d) => {
  moved = (await events.patchAgendaEvent({ data: d, settings: d.settings, id: target.id, patch: { start: '2026-10-29T17:30:00-05:00', end: '2026-10-29T18:30:00-05:00' }, check: false })).event;
});
check('Mover a hora viable recalcula y quita warning', moved.travel?.feasible === true && !moved.travelWarning, JSON.stringify({ feasible: moved.travel?.feasible }));

// ---------------------------------------------------------------------------
// 5. Meet: generado y Google (mock)
// ---------------------------------------------------------------------------
const meetGenerated = await store.mutate(async (d) => meet.ensureMeetLink({ data: d, settings: d.settings, event: d.agenda.find((event) => event.id === target.id) }));
check('Sin Google entrega sala Jitsi real, no un Meet falso', /^https:\/\/meet\.jit\.si\/AgendaP95-[a-f0-9]{12}$/.test(meetGenerated.meetLink) && meetGenerated.provider === 'jitsi' && meetGenerated.fallback === true && /Jitsi/i.test(meetGenerated.note), meetGenerated.meetLink);
const meetEvent = store.get().agenda.find((event) => event.id === target.id);
check('meetLink Jitsi queda guardado sin marcar como Google', meetEvent.meetLink === meetGenerated.meetLink && meetEvent.meet?.provider === 'jitsi' && meetEvent.meet?.generated === false);
response = await callRoute('POST', '/api/agenda/:id/meet', { params: { id: target.id } });
check('POST /api/agenda/:id/meet idempotente', response.status === 200 && response.payload.meetLink === meetGenerated.meetLink && response.payload.provider === 'jitsi' && response.payload.generated === false);

// Google Meet real simulado
const connection = {
  id: 'g-selfcheck', email: 'meet@example.com',
  token: encryptJSON({ access_token: 'token', refresh_token: 'refresh', expires_at: Date.now() + 3600000 }),
  calendars: [{ id: 'primary', primary: true }],
  sync: {}
};
await store.mutate((d) => {
  d.googleConnections = [connection];
  d.settings.defaultGoogle = { connectionId: connection.id, calendarId: 'primary' };
});
const meetCalls = [];
meet.setMeetTransport(async (url, options = {}) => {
  meetCalls.push({ url: String(url), method: options.method });
  return new Response(JSON.stringify({
    id: 'g-meeting-1', hangoutLink: 'https://meet.google.com/real-room-abc',
    conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/real-room-abc' }] }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});
let googleEvent;
await store.mutate(async (d) => {
  googleEvent = (await events.createAgendaEvent({ data: d, settings: d.settings, payload: { title: 'Meet Google', start: '2026-10-30T10:00:00-05:00', end: '2026-10-30T11:00:00-05:00' }, check: false, syncGoogle: false })).event;
});
const googleMeet = await store.mutate(async (d) => meet.ensureMeetLink({ data: d, settings: d.settings, event: d.agenda.find((event) => event.id === googleEvent.id) }));
check('Meet con Google devuelve enlace real y generated:false', googleMeet.generated === false && googleMeet.meetLink === 'https://meet.google.com/real-room-abc', JSON.stringify(googleMeet));
check('Meet usa conferenceDataVersion=1', meetCalls.some((call) => call.url.includes('conferenceDataVersion=1')));
meet.resetMeetTransport();

// ---------------------------------------------------------------------------
// 6. Tareas
// ---------------------------------------------------------------------------
response = await callRoute('POST', '/api/tasks', { body: { text: 'asignar tarea a Laura: revisar contrato', due: '2026-10-30', priority: 'P1', origin: 'chat' } });
check('POST /api/tasks desde chat', response.status === 201 && response.payload.item.owner === 'Laura' && response.payload.item.title === 'revisar contrato', JSON.stringify(response.payload.item));
const taskId = response.payload.item.id;
response = await callRoute('GET', '/api/tasks', { query: { status: 'open' } });
check('GET /api/tasks?status=open', response.status === 200 && response.payload.items.some((task) => task.id === taskId));
response = await callRoute('POST', '/api/tasks/:id/close', { params: { id: taskId }, body: { result: 'listo', closedBy: 'Laura' } });
check('POST /api/tasks/:id/close', response.status === 200 && response.payload.item.status === 'done' && !!response.payload.item.closedAt, JSON.stringify({ status: response.payload.item?.status, alreadyClosed: response.payload.alreadyClosed }));
response = await callRoute('POST', '/api/tasks/:id/close', { params: { id: taskId }, body: {} });
check('Cerrar dos veces es idempotente', response.status === 200 && response.payload.alreadyClosed === true);
check('Tarea cerrada no aparece como abierta', !tasks.listTasks(store.get(), { status: 'open' }).some((task) => task.id === taskId));

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
const failed = results.filter((result) => !result.ok);
console.log(`\n=== TRAVEL SELFCHECK === ${results.length} checks, ${failed.length} failed`);
if (failed.length) console.log(failed.map((result) => `- ${result.name}`).join('\n'));
try { await store.flush?.(); } catch { /* noop */ }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows puede retener handles */ }
process.exit(failed.length ? 1 : 0);



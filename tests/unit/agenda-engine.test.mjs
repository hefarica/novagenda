/**
 * Tests del motor de agenda (t2): fechas, P95, score, rutinas, conflictos,
 * métricas, inbox→cita, Google mockeado y robustez ante fechas inválidas.
 *
 * node --test. DATA_DIR temporal SIEMPRE antes de importar el store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, clone, deepEqual } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-engine-');
const { store, encryptJSON, localDateKey } = await importLib('lib/store.mjs');
const engine = await importLib('lib/agenda/index.mjs');
const metrics = await importLib('lib/metrics/metrics.mjs');
const google = await importLib('lib/google.mjs');
const assistant = await importLib('lib/assistant.mjs');

const today = localDateKey();

/* ------------------------------------------------------------------ */
/* Fechas y horas                                                      */
/* ------------------------------------------------------------------ */
test('fechas: rechaza 31-feb y rangos invertidos, acepta ISO con offset', () => {
  assert.equal(engine.isValidDateKey('2026-02-31'), false);
  assert.equal(engine.isValidDateKey('2026-02-28'), true);
  assert.equal(engine.isValidIso('2026-02-31T09:00:00-05:00'), false);
  assert.equal(engine.isValidIso('2026-03-01T09:00:00-05:00'), true);
  assert.equal(engine.validateRange(engine.isoAtLocal(today, '10:00'), engine.isoAtLocal(today, '09:00')).ok, false);
  assert.equal(engine.validateRange(engine.isoAtLocal(today, '09:00'), engine.isoAtLocal(today, '10:00')).ok, true);
});

test('fechas: zona horaria, día de la semana y fin de semana', () => {
  assert.equal(engine.dateKeyOfIso('2026-10-27T04:00:00Z', 'America/Bogota'), '2026-10-26');
  assert.equal(engine.weekdayCodeOfKey('2026-10-27'), 'MAR');
  assert.equal(engine.weekStartKey('2026-10-27'), '2026-10-26');
  assert.equal(engine.isWeekend('2026-10-31'), true);
  assert.equal(engine.isWeekend('2026-10-30'), false);
  assert.equal(engine.isHoliday('2026-01-01', { holidays: ['2026-01-01'] }), true);
  assert.equal(engine.isHoliday('2026-01-02', { holidays: ['2026-01-01'] }), false);
});

/* ------------------------------------------------------------------ */
/* Índice P95                                                          */
/* ------------------------------------------------------------------ */
test('P95 reproduce el Excel (08_DASHBOARD!A4 = 13.1)', () => {
  const result = engine.computeP95(engine.EXCEL_P95_REFERENCE.inputs, {});
  assert.equal(result.index, 13.1);
  assert.equal(result.components.length, 7);
  assert.ok(Math.abs(result.weightsSum - 1) < 1e-9);
});

test('P95: componentes y pesos por defecto sobre entradas fijas', () => {
  const result = engine.computeP95({
    agendaExecution: 0.25, deepFocus: 0, overdue: 0, meetingEffectiveness: 0,
    okrProgress: 0.76175, weeklyExecution: 0.2, weeklyReview: 0
  }, {});
  deepEqual(result.components.map((component) => component.points), [7.35, 0, 15, 0, 15, 2.5, 0], 'points');
  assert.equal(result.index, 39.9);
});

test('P95: pesos y metas editables cambian el índice', () => {
  const inputs = { agendaExecution: 0.85, deepFocus: 120, overdue: 0, meetingEffectiveness: 4, okrProgress: 0.7, weeklyExecution: 0.8, weeklyReview: 1 };
  assert.equal(engine.computeP95(inputs, {}).index, 100);
  const custom = engine.normalizeP95Settings({ weights: { agendaExecution: 0.1 }, okrProgress: 0.9 });
  const result = engine.computeP95(inputs, custom);
  assert.ok(result.index < 100, `index=${result.index}`);
  assert.equal(result.weights.agendaExecution, 0.1);
  assert.equal(result.targets.okrProgress, 0.9);
  assert.equal(result.index, 81.7);
});

test('P95 desde el store: índice numérico finito', () => {
  const result = engine.computeP95FromData(store.get(), { dateKey: today });
  assert.equal(typeof result.index, 'number');
  assert.ok(Number.isFinite(result.index));
});

/* ------------------------------------------------------------------ */
/* Score de prioridad                                                  */
/* ------------------------------------------------------------------ */
test('score: fórmula del Excel 02_AGENDA!Y', () => {
  assert.equal(engine.priorityScore({ impact: 5, urgency: 4, priority: 'P1', deepFocus: true }), 94);
  assert.equal(engine.priorityScore({ impact: 5, urgency: 5, priority: 'P1', deepFocus: false }), 96);
  assert.equal(engine.priorityScore({ impact: 4, urgency: 3, priority: 'P2', deepFocus: false }), 72);
  assert.equal(engine.priorityScore({ impact: 5, urgency: 4, priority: 'P1', deepFocus: false }), 90);
  assert.equal(engine.priorityScore({ impact: 1, urgency: 1, priority: 'P9', deepFocus: false }), 28);
});

test('score: cambiar impacto/urgencia reordena el Top 3', () => {
  const data = clone(store.get());
  const events = data.agenda.filter((event) => event.status !== 'Cancelada');
  const before = engine.topPriorities(events.map(engine.withComputedScore), 3).map((event) => event.id);
  const target = events.find((event) => event.id === 'AG-0003');
  target.impact = 5;
  target.urgency = 5;
  const after = engine.topPriorities(events.map(engine.withComputedScore), 3).map((event) => event.id);
  assert.notDeepEqual(after, before);
  assert.ok(after.includes('AG-0003'), `top3=${after.join(',')}`);
});

/* ------------------------------------------------------------------ */
/* Rutinas: normalización, preview, clamp, skip, idempotencia           */
/* ------------------------------------------------------------------ */
test('rutinas: MENSUAL día 31 hace clamp a fin de mes', () => {
  const routine = { frequency: 'MENSUAL', rule: '31', time: '08:00', title: 'Cierre mensual', durationMin: 60, active: true };
  const dates = engine.previewRoutine(routine, { count: 4, fromKey: '2027-01-01', settings: {} }).map((row) => row.date);
  deepEqual(dates, ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'], 'fechas');
});

test('rutinas: R-002 preview 30 laborables 07:30-09:00', () => {
  const data = store.get();
  const rows = engine.previewRoutineById(data, 'R-002', { count: 30, settings: data.settings });
  assert.equal(rows.length, 30);
  for (const row of rows) {
    assert.ok(String(row.start).includes('T07:30'), `start=${row.start}`);
    assert.ok(String(row.end).includes('T09:00'), `end=${row.end}`);
    assert.equal(engine.isWeekend(row.date), false);
  }
});

test('rutinas: skip de fecha y materialización idempotente', async () => {
  const data = clone(store.get());
  const settings = clone(data.settings);
  const first = engine.previewRoutineById(data, 'R-002', { count: 1, settings })[0].date;
  const skipped = engine.skipRoutineDate(data, 'R-002', first);
  assert.equal(skipped.ok, true);
  const next = engine.previewRoutineById(data, 'R-002', { count: 1, settings })[0].date;
  assert.notEqual(next, first);

  const from = engine.addDaysKey(today, 7);
  const to = engine.addDaysKey(from, 7);
  const run1 = await engine.materializeRoutineRange(data, settings, { fromKey: from, toKey: to });
  const run2 = await engine.materializeRoutineRange(data, settings, { fromKey: from, toKey: to });
  assert.ok(run1.created.length > 0);
  assert.equal(run2.created.length, 0);
});

test('rutinas: backfill recupera días perdidos sin fin de semana', async () => {
  const data = clone(store.get());
  const settings = clone(data.settings);
  for (const routine of data.recurrences) routine.start = engine.addDaysKey(today, -10);
  settings.routinesLastRun = engine.addDaysKey(today, -3);
  const summary = await engine.runDailyMaterialization(data, settings, { todayKey: today, backfillDays: 7 });
  assert.equal(summary.backfilled, true);
  assert.ok(summary.created.length > 0);
  const min = engine.addDaysKey(today, -2);
  for (const row of summary.created) {
    assert.ok(row.date >= min && row.date <= today, `fecha fuera de rango: ${row.date}`);
    assert.equal(engine.isWeekend(row.date), false);
  }
});

/* ------------------------------------------------------------------ */
/* Conflictos                                                          */
/* ------------------------------------------------------------------ */
test('conflictos: rutina futura R-002 bloquea el miércoles 07:30', async () => {
  let wednesday = today;
  for (let index = 0; index < 14; index += 1) {
    if (engine.weekdayCodeOfKey(wednesday) === 'MIE' && wednesday > today) break;
    wednesday = engine.addDaysKey(wednesday, 1);
  }
  const data = store.get();
  const result = await engine.checkConflicts({
    data,
    settings: data.settings,
    includeGoogle: false,
    start: engine.isoAtLocal(wednesday, '07:30'),
    end: engine.isoAtLocal(wednesday, '08:15')
  });
  const conflict = result.conflicts.find((item) => item.routineId === 'R-002');
  assert.ok(conflict, 'sin conflicto R-002');
  assert.equal(conflict.source, 'routine');
  assert.equal(result.canBook, false);
});

test('conflictos: findSlotsDetailed da 3 huecos sin solape', async () => {
  const data = store.get();
  const from = engine.addDaysKey(today, 1);
  const result = await engine.findSlotsDetailed({
    durationMin: 60, fromIso: engine.isoAtLocal(from, '07:00'), days: 3, count: 3,
    data, settings: data.settings, includeGoogle: false
  });
  assert.equal(result.slots.length, 3);
  const busy = await engine.collectBusyDetailed(
    engine.isoAtLocal(from, '00:00'), engine.isoAtLocal(engine.addDaysKey(from, 2), '23:59'),
    { data, settings: data.settings, includeGoogle: false }
  );
  for (const slot of result.slots) {
    const start = new Date(slot.start).getTime();
    const end = new Date(slot.end).getTime();
    assert.equal(end - start, 60 * 60000);
    assert.equal(engine.isWeekend(slot.date), false);
    for (const block of busy.busy) {
      const overlaps = start < new Date(block.end).getTime() && end > new Date(block.start).getTime();
      assert.equal(overlaps, false, `solape con ${block.source}:${block.id || block.title}`);
    }
  }
});

test('conflictos: Google día completo bloquea y FreeBusy roto nunca asume libre', async () => {
  await store.mutate((data) => {
    data.googleConnections = [{
      id: 'GC-TEST', email: 'qa@example.com', label: 'QA',
      token: encryptJSON({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 }),
      calendars: [{ id: 'primary', summary: 'Principal', primary: true }],
      sync: { lastSyncAt: null, lastError: null, calendars: {} }
    }];
    data.settings.selectedCalendars = { 'GC-TEST': ['primary'] };
  });
  const data = store.get();
  const day = engine.addDaysKey(today, 2);
  let mode = 'allday';
  google.setGoogleTransport(async (url) => {
    const href = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (href.includes('/freeBusy')) {
      if (mode === 'broken') return json({ error: { message: 'boom', status: 'INVALID_ARGUMENT' } }, 400);
      return json({ calendars: { primary: { busy: [] } } });
    }
    if (href.includes('/events')) {
      return json({ items: [{ id: 'gd-1', summary: 'Festivo', status: 'confirmed', start: { date: day }, end: { date: engine.addDaysKey(day, 1) } }], nextSyncToken: 't1' });
    }
    return json({});
  });
  google.clearGoogleCaches();
  const blocked = await engine.checkConflicts({
    data, settings: data.settings,
    start: engine.isoAtLocal(day, '10:00'), end: engine.isoAtLocal(day, '11:00')
  });
  assert.ok(blocked.conflicts.some((item) => item.source === 'google-allday'), JSON.stringify(blocked.conflicts));

  mode = 'broken';
  google.clearGoogleCaches();
  const broken = await engine.checkConflicts({
    data, settings: data.settings,
    start: engine.isoAtLocal(day, '10:00'), end: engine.isoAtLocal(day, '11:00')
  });
  assert.ok(broken.errors.length > 0);
  assert.equal(broken.unknown, true);
  assert.equal(broken.canBook, false);
  google.resetGoogleTransport();
  await store.mutate((current) => {
    current.googleConnections = [];
    current.settings.selectedCalendars = {};
  });
});

/* ------------------------------------------------------------------ */
/* Métricas                                                            */
/* ------------------------------------------------------------------ */
test('métricas: snapshot exacto de 14 campos y planDaily por rol', () => {
  const data = clone(store.get());
  const row = metrics.snapshotDailyMetrics(data, { dateKey: today });
  deepEqual(Object.keys(row).sort(), [...metrics.METRIC_FIELDS].sort(), 'campos');
  assert.equal(row.planDaily, true);
});

test('métricas: la captura manual se conserva al re-snapshot', () => {
  const data = clone(store.get());
  metrics.snapshotDailyMetrics(data, { dateKey: today, patch: { energyAM: 4, energyPM: 3, interruptions: 2, improvement: 'mejor', comments: 'ok' } });
  const row = metrics.snapshotDailyMetrics(data, { dateKey: today });
  deepEqual([row.energyAM, row.energyPM, row.interruptions, row.improvement, row.comments], [4, 3, 2, 'mejor', 'ok'], 'manuales');
});

/* ------------------------------------------------------------------ */
/* Inbox → cita                                                        */
/* ------------------------------------------------------------------ */
test('inbox convert: 200 una vez y 409 ALREADY_PROCESSED al reintentar', async () => {
  const inboxRoutes = (await importLib('lib/routes/inbox.mjs')).routes;
  const route = inboxRoutes.find((item) => item.name === 'inbox.convert');
  assert.ok(route);
  const data = store.get();
  const item = data.inbox.find((row) => !row.processed);
  assert.ok(item, 'sin captura pendiente en el seed');
  let monday = today;
  for (let index = 0; index < 14; index += 1) {
    if (engine.weekdayCodeOfKey(monday) === 'LUN') break;
    monday = engine.addDaysKey(monday, 1);
  }
  const call = async (body) => {
    let captured = null;
    await route.handler({
      params: { id: item.id }, query: new URLSearchParams(), requestId: 'test',
      body: async () => body,
      json(status, payload) { captured = { status, payload }; return status; }
    });
    return captured;
  };
  const first = await call({ date: monday, time: '13:00' });
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.item.processed, true);
  assert.equal(first.payload.event.id, first.payload.item.agendaId);
  const second = await call({ date: monday, time: '13:00' });
  assert.equal(second.status, 409);
  assert.equal(second.payload.code, 'ALREADY_PROCESSED');
});

/* ------------------------------------------------------------------ */
/* Google bidireccional (transporte mock)                              */
/* ------------------------------------------------------------------ */
test('Google: crear/editar/cancelar sincroniza y desconectar revoca', async () => {
  const data = store.get();
  data.googleConnections = [{
    id: 'GC-1', email: 'qa@example.com', label: 'QA',
    token: encryptJSON({ access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3600000 }),
    calendars: [{ id: 'primary', summary: 'Principal', primary: true, accessRole: 'owner' }],
    sync: { lastSyncAt: null, lastError: null, calendars: {} }
  }];
  data.settings.defaultGoogle = { connectionId: 'GC-1', calendarId: 'primary' };
  data.settings.autoSyncGoogle = true;

  const calls = [];
  let deleteStatus = 204;
  google.setGoogleTransport(async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const href = String(url);
    calls.push({ method, href });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (href.includes('oauth2.googleapis.com/revoke')) return json({}, 200);
    if (method === 'POST' && /\/events$/.test(new URL(href).pathname)) return json({ id: 'G-EVT-1', htmlLink: 'https://calendar/1' });
    if (method === 'PATCH') return json({ id: 'G-EVT-1', updated: new Date().toISOString() });
    if (method === 'DELETE') return deleteStatus === 204 ? new Response(null, { status: 204 }) : json({ error: { message: 'Gone' } }, deleteStatus);
    return json({ items: [], nextSyncToken: 'tok-1' });
  });

  const tomorrow = engine.addDaysKey(today, 1);
  const created = await engine.createAgendaEvent({
    data, settings: data.settings,
    payload: { title: 'Cita QA Google', start: engine.isoAtLocal(tomorrow, '14:00'), end: engine.isoAtLocal(tomorrow, '14:30'), priority: 'P2', impact: 4, urgency: 3 },
    check: false, syncGoogle: true
  });
  assert.equal(created.ok, true);
  assert.equal(created.event.google.eventId, 'G-EVT-1');
  assert.ok(calls.some((call) => call.method === 'POST'));

  const patched = await engine.patchAgendaEvent({ data, settings: data.settings, id: created.event.id, patch: { title: 'Cita QA v2' }, check: false });
  assert.equal(patched.ok, true);
  assert.ok(calls.some((call) => call.method === 'PATCH'));

  const link = clone(created.event.google);
  const cancelled = await engine.cancelAgendaEvent({ data, settings: data.settings, id: created.event.id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.event.google, null);
  assert.ok(calls.some((call) => call.method === 'DELETE'));

  deleteStatus = 410;
  const gone = await google.deleteGoogleEvent(link);
  assert.deepEqual({ deleted: gone.deleted, alreadyDeleted: gone.alreadyDeleted }, { deleted: true, alreadyDeleted: true });

  const disconnected = await google.disconnectGoogle('GC-1');
  assert.equal(disconnected.revoked, true);
  assert.ok(calls.some((call) => call.href.includes('/revoke')));
  assert.equal(store.get().settings.defaultGoogle, null);
  google.resetGoogleTransport();
});

/* ------------------------------------------------------------------ */
/* Robustez ante fechas inválidas (regresión P0)                       */
/* ------------------------------------------------------------------ */
test('fechas inválidas no rompen dashboard, HOY, balance ni métricas', async () => {
  await store.mutate((data) => {
    data.agenda.push(
      { id: 'AG-BAD1', start: 'x', end: 'y', title: 'fecha rota', status: 'Pendiente', priority: 'P2' },
      { id: 'AG-BAD2', start: '2026-02-31T09:00:00-05:00', end: '2026-02-31T10:00:00-05:00', title: '31 feb', status: 'Pendiente', priority: 'P2' }
    );
  });
  const data = store.get();
  assert.equal(typeof engine.computeP95FromData(data, { dateKey: today }).index, 'number');
  assert.equal(Object.keys(metrics.snapshotDailyMetrics(data, { dateKey: today })).length, 14);
  assert.ok(Array.isArray(engine.detectTodayConflicts({ data, settings: data.settings, dateKey: today }).conflicts));
  assert.equal(typeof assistant.dashboard(), 'object');
  assert.equal(typeof await assistant.handleAssistant('HOY'), 'object');
  assert.equal(typeof await assistant.handleAssistant('balance'), 'object');
});

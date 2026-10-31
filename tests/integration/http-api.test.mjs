/**
 * Tests de integración HTTP: validación estricta, backup/restore, métricas
 * y autenticación por modo (local vs APP_AUTH=on).
 *
 * node --test con DATA_DIR temporal y puerto efímero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api, clone } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-http-');
const { store } = await importLib('lib/store.mjs');
const session = await importLib('lib/security/session.mjs');
const app = await startTestApp();

test.after(async () => {
  process.env.APP_AUTH = '';
  await app.close();
});

test('GET /api/health responde con módulos montados y sin auth', async () => {
  const response = await api(app.base, 'GET', '/api/health');
  assert.equal(response.status, 200);
  assert.ok(response.json && response.json.ok === true, JSON.stringify(response.json).slice(0, 200));
  assert.ok(response.json.modules, 'falta health.modules');
});

test('GET /api/bootstrap conserva el contrato histórico', async () => {
  const response = await api(app.base, 'GET', '/api/bootstrap');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.agenda), 'agenda no es array');
  assert.ok(response.json.settings && typeof response.json.settings === 'object');
});

test('validación: 31-feb, end<start y campos desconocidos se rechazan con 400', async () => {
  const badDate = await api(app.base, 'POST', '/api/agenda', {
    title: 'Fecha imposible', start: '2026-02-31T09:00:00-05:00', end: '2026-02-31T10:00:00-05:00'
  });
  assert.equal(badDate.status, 400, badDate.text);
  assert.equal(badDate.json.code, 'INVALID_DATE');

  const inverted = await api(app.base, 'POST', '/api/agenda', {
    title: 'Rango invertido', start: '2026-11-10T11:00:00-05:00', end: '2026-11-10T10:00:00-05:00'
  });
  assert.equal(inverted.status, 400, inverted.text);
  assert.equal(inverted.json.code, 'INVALID_RANGE');

  const unknown = await api(app.base, 'POST', '/api/agenda', {
    title: 'Campo raro', start: '2026-11-10T10:00:00-05:00', end: '2026-11-10T11:00:00-05:00', hacker: true
  });
  assert.equal(unknown.status, 400, unknown.text);
  assert.equal(unknown.json.code, 'UNKNOWN_FIELD');
});

test('validación: PATCH no permite cambiar el id', async () => {
  const response = await api(app.base, 'PATCH', '/api/agenda/AG-0001', { id: 'AG-9999', title: 'Intento' });
  assert.equal(response.status, 400, response.text);
  assert.equal(response.json.code, 'UNKNOWN_FIELD');
  assert.equal(response.json.field, 'id');
});

test('backup descarga y restore devuelve el contenido exacto', async () => {
  const before = await api(app.base, 'GET', '/api/backup?secrets=none');
  assert.equal(before.status, 200);
  assert.ok(before.json.data && Array.isArray(before.json.data.agenda));
  const snapshot = clone(before.json);

  const created = await api(app.base, 'POST', '/api/inbox', { input: 'Captura que debe desaparecer al restaurar' });
  assert.equal(created.status, 201, created.text);
  assert.ok(store.get().inbox.length >= 2);

  const restored = await api(app.base, 'POST', '/api/backup/restore', { confirm: 'RESTORE', data: snapshot });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(store.get().inbox.length, snapshot.data.inbox.length);
  assert.equal(store.get().agenda.length, snapshot.data.agenda.length);
});

test('GET /api/metrics?days=90 devuelve items y p95 numérico', async () => {
  const response = await api(app.base, 'GET', '/api/metrics?days=90');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.items));
  assert.equal(typeof response.json.p95, 'number');
  assert.equal(response.json.components.length, 7);
});

test('auth: en local se puede escribir sin sesión y APP_AUTH=on exige login', async () => {
  assert.equal(session.hostConfig().required, false);
  const localWrite = await api(app.base, 'POST', '/api/inbox', { input: 'Captura en modo local' });
  assert.equal(localWrite.status, 201, localWrite.text);

  process.env.APP_AUTH = 'on';
  try {
    assert.equal(session.hostConfig().required, true);
    const blocked = await api(app.base, 'POST', '/api/inbox', { input: 'No debería entrar' });
    assert.equal(blocked.status, 401, blocked.text);
    assert.equal(blocked.json.code, 'UNAUTHENTICATED');

    const status = await api(app.base, 'GET', '/api/auth/status');
    assert.equal(status.status, 200);

    const setup = await api(app.base, 'POST', '/api/auth/setup', { username: 'owner', password: 'clave-segura-123' });
    assert.equal(setup.status, 201, setup.text);
    const cookie = (setup.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');
    assert.ok(cookie.includes('ac_sid='), `cookie=${cookie}`);

    const authorized = await api(app.base, 'POST', '/api/inbox', { input: 'Captura autenticada' }, { cookie });
    assert.equal(authorized.status, 201, authorized.text);

    const logout = await api(app.base, 'POST', '/api/auth/logout', {}, { cookie });
    assert.equal(logout.status, 200);
    const afterLogout = await api(app.base, 'POST', '/api/inbox', { input: 'Tras logout' }, { cookie });
    assert.equal(afterLogout.status, 401);
  } finally {
    process.env.APP_AUTH = '';
  }
});

test('auth: HOST no-loopback exige sesión por configuración', () => {
  const previous = process.env.HOST;
  process.env.HOST = '0.0.0.0';
  try {
    assert.equal(session.hostConfig().required, true);
    assert.equal(session.hostConfig().loopback, false);
  } finally {
    if (previous === undefined) delete process.env.HOST;
    else process.env.HOST = previous;
  }
});

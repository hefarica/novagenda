/**
 * Tests de avisos inteligentes (t16), keep-alive del servidor y hook del
 * scheduler (registerTickHandler).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createTempDataDir, importLib, startTestApp, api, repoRoot } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-nudges-');
await importLib('lib/store.mjs');
const workflows = await importLib('lib/workflows/scheduler.mjs');
const app = await startTestApp();

test.after(async () => { await app.close(); });

const port = app.server.address().port;

function rawRequest(socket, text) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n') && /(?:content-length: 0\r\n\r\n|"ok":)/i.test(buffer)) {
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(text);
    setTimeout(() => {
      socket.off('data', onData);
      resolve(buffer);
    }, 3000).unref?.();
  });
}

test('nudges: config válida, rechazo de valores fuera de rango y silencio', async () => {
  const config = await api(app.base, 'GET', '/api/nudges/config');
  assert.equal(config.status, 200, config.text.slice(0, 200));
  assert.ok(config.json.config || config.json.item || config.json, 'sin configuración');

  const invalid = await api(app.base, 'POST', '/api/nudges/config', { maxPerHour: 99 });
  assert.equal(invalid.status, 400, invalid.text.slice(0, 200));

  const silenced = await api(app.base, 'POST', '/api/nudges/config', {
    silence: { enabled: true, from: '00:00', to: '23:59' }
  });
  assert.equal(silenced.status, 200, silenced.text.slice(0, 200));
  const evaluate = await api(app.base, 'POST', '/api/nudges/evaluate', { dryRun: false });
  assert.equal(evaluate.status, 200, evaluate.text.slice(0, 200));
  assert.equal(evaluate.json.skipped, 'silence', evaluate.text.slice(0, 300));

  const restored = await api(app.base, 'POST', '/api/nudges/config', {
    silence: { enabled: false, from: '21:30', to: '07:00' }
  });
  assert.equal(restored.status, 200, restored.text.slice(0, 200));
  const dry = await api(app.base, 'POST', '/api/nudges/evaluate', { dryRun: true });
  assert.equal(dry.status, 200, dry.text.slice(0, 200));
  assert.ok(Array.isArray(dry.json.items) || Array.isArray(dry.json.candidates), dry.text.slice(0, 300));
});

test('keep-alive: dos peticiones por el mismo socket tras 8 s de inactividad', async () => {
  const source = fs.readFileSync(path.join(repoRoot, 'server.mjs'), 'utf8');
  assert.match(source, /keepAliveTimeout\s*=\s*65_000/, 'server.mjs sin keepAliveTimeout=65 s');
  assert.match(source, /headersTimeout\s*=\s*66_000/, 'server.mjs sin headersTimeout=66 s');
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const first = await rawRequest(socket, 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  assert.match(first, /HTTP\/1\.1 200/, first.slice(0, 200));
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const second = await rawRequest(socket, 'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  assert.match(second, /HTTP\/1\.1 200/, second.slice(0, 200));
  socket.destroy();
});

test('hook: registerTickHandler idempotente, dry-run, errores y timeout de 5 s', async () => {
  const fixedNow = new Date('2026-10-30T17:46:00-05:00');

  const baseline = await workflows.workflowTick({ now: fixedNow, includeSignals: false, dryRun: true });
  assert.equal(baseline.ok, true);

  const calls = [];
  const handler = (context) => { calls.push(context); };
  const unregister = workflows.registerTickHandler(handler);
  const unregisterAgain = workflows.registerTickHandler(handler); // Set: no duplica
  assert.equal(typeof unregister, 'function');
  const withHandler = await workflows.workflowTick({ now: fixedNow, includeSignals: false, dryRun: true });
  assert.equal(withHandler.ok, true);
  assert.equal(calls.length, 1, `handler llamado ${calls.length} veces`);
  assert.equal(calls[0].dryRun, true);
  unregister();
  unregisterAgain();
  const afterUnregister = await workflows.workflowTick({ now: fixedNow, includeSignals: false, dryRun: true });
  assert.equal(afterUnregister.ok, true);
  assert.equal(calls.length, 1, 'handler se ejecutó tras unregister');

  const throwing = () => { throw new Error('boom QA'); };
  const unregisterThrow = workflows.registerTickHandler(throwing);
  const resilient = await workflows.workflowTick({ now: fixedNow, includeSignals: false, dryRun: true });
  assert.equal(resilient.ok, true, 'un handler que lanza rompió el tick');
  unregisterThrow();

  const slow = () => new Promise((resolve) => setTimeout(resolve, 6000));
  const unregisterSlow = workflows.registerTickHandler(slow);
  const started = Date.now();
  const timed = await workflows.workflowTick({ now: fixedNow, includeSignals: false, dryRun: true });
  const elapsed = Date.now() - started;
  assert.equal(timed.ok, true, 'el timeout del handler rompió el tick');
  assert.ok(elapsed >= 4800 && elapsed < 12000, `elapsed=${elapsed}`);
  unregisterSlow();
});


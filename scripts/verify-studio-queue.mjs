/**
 * Verificación de la cola persistente del Estudio.
 *
 * Uso: node scripts/verify-studio-queue.mjs
 * Requiere Node 24; usa DATA_DIR temporal y un puerto >=3310. Nunca toca 3000.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-studio-queue-'));
const ROUTES = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-studio-routes-'));
const original = { ...process.env };
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'verify-studio-queue-only-secret';
process.env.HOST = '127.0.0.1';
process.env.LOG_LEVEL = 'error';
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
delete process.env.STUDIO_WORKER;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 600)}`}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(120);
  }
  throw new Error('timeout');
}

for (const file of ['studio.mjs']) {
  const target = pathToFileURL(path.join(ROOT, 'lib', 'routes', file)).href;
  fs.writeFileSync(path.join(ROUTES, file), `export { name, priority, routes } from ${JSON.stringify(target)};\n`, 'utf8');
}

let server = null;
let jobs = null;
try {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'lib/http/app.mjs')).href);
  jobs = await import(pathToFileURL(path.join(ROOT, 'lib/studio/jobs.mjs')).href);
  const { store } = await import(pathToFileURL(path.join(ROOT, 'lib/store.mjs')).href);
  const { getOrganization } = await import(pathToFileURL(path.join(ROOT, 'lib/studio/org.mjs')).href);
  const app = await createApp({ rootDir: ROOT, routesDir: ROUTES });
  server = http.createServer(app.handler);
  let port = 0;
  for (let candidate = 3310; candidate <= 3340 && !port; candidate += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      port = candidate;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      server.close();
      server = http.createServer(app.handler);
    }
  }
  if (!port) throw new Error('No hay puerto libre >=3310');
  const base = `http://127.0.0.1:${port}`;

  async function req(method, route, body) {
    const init = { method, headers: { connection: 'close' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(base + route, init);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
    return { status: response.status, json, text };
  }

  jobs.startStudioWorker({ intervalMs: 200 });
  const first = await req('POST', '/api/studio/jobs', {
    type: 'code',
    title: 'Verificación cola',
    brief: 'Genera una utilidad mínima con README, código y una prueba.'
  });
  check('POST encargo responde 202', first.status === 202, first);
  check('encargo nace queued/attempts 0', first.json?.job?.status === 'queued' && first.json?.job?.attempts === 0, first.json?.job);
  const firstId = first.json?.job?.id;
  const done = await waitFor(async () => {
    const response = await req('GET', '/api/studio/jobs');
    return response.json?.items?.find((job) => job.id === firstId && job.status === 'done') || null;
  });
  check('worker completa el encargo', done.status === 'done' && done.attempts === 1, done);
  check('artefacto único descargable', done.artifact?.kind === 'code' && !!done.artifact?.filename, done.artifact);
  check('GET incluye estado del worker', (await req('GET', '/api/studio/jobs')).json?.worker?.running === true, (await req('GET', '/api/studio/jobs')).json?.worker);

  // Recuperación de un job queued: se crea con el worker detenido y se arranca después.
  jobs.stopStudioWorker();
  const queued = await req('POST', '/api/studio/jobs', {
    type: 'code',
    title: 'Recuperación queued',
    brief: 'Genera una utilidad mínima para probar la recuperación persistente.'
  });
  const queuedId = queued.json?.job?.id;
  check('queued persiste sin worker', queued.status === 202 && queued.json?.job?.status === 'queued', queued.json?.job);
  jobs.startStudioWorker({ intervalMs: 200 });
  const recoveredQueued = await waitFor(async () => {
    const response = await req('GET', '/api/studio/jobs');
    return response.json?.items?.find((job) => job.id === queuedId && job.status === 'done') || null;
  });
  check('worker retoma queued al arrancar', recoveredQueued.status === 'done' && recoveredQueued.attempts === 1, recoveredQueued);

  // Recuperación de running interrumpido: el worker debe reintentar (attempts 2) sin perder el job.
  jobs.stopStudioWorker();
  const interrupted = await req('POST', '/api/studio/jobs', {
    type: 'code',
    title: 'Recuperación running',
    brief: 'Genera una utilidad mínima para probar la recuperación de un job interrumpido.'
  });
  const interruptedId = interrupted.json?.job?.id;
  await store.mutate((state) => {
    const org = getOrganization();
    const job = org.jobs.find((item) => item.id === interruptedId);
    job.status = 'running';
    job.attempts = 1;
    job.nextAttemptAt = null;
    job.startedAt = new Date().toISOString();
    state.organization = org;
  }, { label: 'verify-studio-queue-running' });
  jobs.startStudioWorker({ intervalMs: 200 });
  const recoveredRunning = await waitFor(async () => {
    const response = await req('GET', '/api/studio/jobs');
    return response.json?.items?.find((job) => job.id === interruptedId && job.status === 'done') || null;
  });
  check('worker retoma running al arrancar', recoveredRunning.status === 'done' && recoveredRunning.attempts === 2, recoveredRunning);

  // Reintentos reales y backoff: un job que falla siempre debe agotar 3 intentos y quedar failed.
  jobs.stopStudioWorker();
  const retryJob = await req('POST', '/api/studio/jobs', {
    type: 'code',
    title: 'Reintentos reales',
    brief: 'Genera una utilidad mínima que fallará para validar el backoff.'
  });
  const retryId = retryJob.json?.job?.id;
  await store.mutate((state) => {
    const org = getOrganization();
    const job = org.jobs.find((item) => item.id === retryId);
    job.type = 'tipo-invalido-para-forzar-fallo';
    state.organization = org;
  }, { label: 'verify-studio-queue-retry' });
  jobs.startStudioWorker({ intervalMs: 200 });
  const retryFailed = await waitFor(async () => {
    const response = await req('GET', '/api/studio/jobs');
    return response.json?.items?.find((job) => job.id === retryId && job.status === 'failed') || null;
  }, 20000);
  check('reintentos con backoff agotan 3 intentos', retryFailed.status === 'failed' && retryFailed.attempts === 3 && !!retryFailed.lastError && !retryFailed.artifact, retryFailed);
  // Un job con 3 intentos no se ejecuta una cuarta vez.
  jobs.stopStudioWorker();
  const exhausted = await req('POST', '/api/studio/jobs', {
    type: 'code',
    title: 'Máximo de intentos',
    brief: 'Genera una utilidad mínima para verificar que no hay cuarto intento.'
  });
  const exhaustedId = exhausted.json?.job?.id;
  await store.mutate((state) => {
    const org = getOrganization();
    const job = org.jobs.find((item) => item.id === exhaustedId);
    job.status = 'retrying';
    job.attempts = 3;
    job.nextAttemptAt = null;
    state.organization = org;
  }, { label: 'verify-studio-queue-exhausted' });
  jobs.startStudioWorker({ intervalMs: 200 });
  const failed = await waitFor(async () => {
    const response = await req('GET', '/api/studio/jobs');
    return response.json?.items?.find((job) => job.id === exhaustedId && job.status === 'failed') || null;
  });
  check('máximo 3 intentos → failed sin cuarto intento', failed.status === 'failed' && failed.attempts === 3, failed);
} catch (error) {
  fail += 1;
  console.error('ERROR', error?.stack || error);
} finally {
  try { await jobs?.waitForStudioWorker(); } catch { /* nada */ }
  try { jobs?.stopStudioWorker(); } catch { /* nada */ }
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temporal */ }
  try { fs.rmSync(ROUTES, { recursive: true, force: true }); } catch { /* temporal */ }
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
}
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;



#!/usr/bin/env node
/**
 * Smoke test de Agenda Copilot P95 (t6): arranca el servidor real con DATA_DIR
 * y puerto temporales y ejerce 12 flujos críticos de punta a punta.
 *
 * Uso: node scripts/smoke.mjs
 * Sale 0 solo si los 12 flujos pasan. Nunca toca `data/` real.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-smoke-'));
const APP_SECRET = crypto.randomBytes(24).toString('hex');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];
let base = '';

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message || String(error) });
    console.log(`FAIL ${name} :: ${error?.message || error}`);
  }
}

async function api(method, apiPath, body, headers = {}) {
  const response = await fetch(`${base}${apiPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}

function weekdayCode(key) {
  const codes = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
  const [year, month, day] = key.split('-').map(Number);
  return codes[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}

const port = await freePort();
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATA_DIR,
    PORT: String(port),
    APP_HOST: '127.0.0.1',
    HOST: '127.0.0.1',
    APP_SECRET,
    NODE_ENV: 'test',
    WORKFLOWS_AUTOSTART: '0',
    CHANNELS_AUTOSTART: 'off',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    WA_ACCESS_TOKEN: '',
    TELEGRAM_BOT_TOKEN: '',
    LLM_PROVIDER: ''
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

function cleanup() {
  try { child.kill(); } catch { /* ya terminó */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

base = `http://127.0.0.1:${port}`;
let healthy = false;
for (let attempt = 0; attempt < 100 && !healthy; attempt += 1) {
  if (child.exitCode !== null) break;
  try {
    const response = await fetch(`${base}/api/health`);
    healthy = response.ok;
  } catch {
    await sleep(200);
  }
}
if (!healthy) {
  console.error('El servidor no arrancó. Log:\n' + serverLog.slice(-3000));
  cleanup();
  process.exit(1);
}

const today = localDateKey();
const tomorrow = addDays(today, 1);
let createdId = null;
let backupPayload = null;

/* 1. Salud y módulos */
await check('1. GET /api/health (servidor arriba, módulos montados)', async () => {
  const response = await api('GET', '/api/health');
  assert(response.status === 200, `status=${response.status}`);
  assert(response.json?.ok === true, JSON.stringify(response.json).slice(0, 200));
  assert(response.json.modules, 'sin health.modules');
  return `routes=${response.json.routes ?? '?'}`;
});

/* 2. Bootstrap */
await check('2. GET /api/bootstrap (contrato histórico)', async () => {
  const response = await api('GET', '/api/bootstrap');
  assert(response.status === 200, `status=${response.status}`);
  assert(Array.isArray(response.json.agenda) && response.json.agenda.length >= 5, 'agenda inválida');
  assert(response.json.settings && typeof response.json.settings === 'object', 'settings inválido');
  return `agenda=${response.json.agenda.length}`;
});

/* 3. Asistente determinista */
await check('3. POST /api/assistant HOY responde en español', async () => {
  const response = await api('POST', '/api/assistant', { text: 'HOY' });
  assert(response.status === 200, `status=${response.status}`);
  const reply = String(response.json?.reply || '');
  assert(reply.includes('AGENDA COPILOT'), reply.slice(0, 160));
  return reply.split('\n')[0];
});

/* 4. Crear cita */
await check('4. POST /api/agenda crea una cita validada', async () => {
  const response = await api('POST', '/api/agenda', {
    title: 'Smoke cita',
    start: `${tomorrow}T06:00:00-05:00`,
    end: `${tomorrow}T06:30:00-05:00`,
    priority: 'P2',
    impact: 4,
    urgency: 3
  });
  assert(response.status === 201, `status=${response.status} ${response.text.slice(0, 200)}`);
  createdId = response.json.item.id;
  assert(createdId, 'sin id');
  return createdId;
});

/* 5. Editar cita */
await check('5. PATCH /api/agenda/:id edita y recalcula score', async () => {
  const response = await api('PATCH', `/api/agenda/${createdId}`, { title: 'Smoke cita v2', impact: 5 });
  assert(response.status === 200, `status=${response.status} ${response.text.slice(0, 200)}`);
  assert(response.json.item.title === 'Smoke cita v2', response.text.slice(0, 200));
  return `score=${response.json.item.score}`;
});

/* 6. Cancelar cita */
await check('6. DELETE /api/agenda/:id cancela (no borra el histórico)', async () => {
  const response = await api('DELETE', `/api/agenda/${createdId}`);
  assert(response.status === 200, `status=${response.status}`);
  assert(response.json.item.status === 'Cancelada', response.text.slice(0, 200));
  return 'Cancelada';
});

/* 7. Validación 31-feb */
await check('7. Validación rechaza 31-feb con 400', async () => {
  const response = await api('POST', '/api/agenda', {
    title: 'Fecha imposible',
    start: '2026-02-31T09:00:00-05:00',
    end: '2026-02-31T10:00:00-05:00'
  });
  assert(response.status === 400, `status=${response.status}`);
  assert(response.json.code === 'INVALID_DATE', response.text.slice(0, 200));
  return 'INVALID_DATE';
});

/* 8. Conflicto con rutina */
await check('8. Conflicto con rutina futura responde 409', async () => {
  let wednesday = today;
  for (let index = 0; index < 14; index += 1) {
    if (weekdayCode(wednesday) === 'MIE' && wednesday > today) break;
    wednesday = addDays(wednesday, 1);
  }
  const response = await api('POST', '/api/agenda', {
    title: 'Choque con foco',
    start: `${wednesday}T07:30:00-05:00`,
    end: `${wednesday}T08:15:00-05:00`
  });
  assert(response.status === 409, `status=${response.status} ${response.text.slice(0, 200)}`);
  assert(response.json.code === 'CONFLICT', response.text.slice(0, 200));
  assert(Array.isArray(response.json.conflicts) && response.json.conflicts.length > 0, 'sin conflicts');
  return `conflicts=${response.json.conflicts.length}`;
});

/* 9. Inbox captura → convertir (200) y reintento (409) */
await check('9. Inbox → cita: 200 y reintento 409 ALREADY_PROCESSED', async () => {
  const created = await api('POST', '/api/inbox', { input: 'Smoke: captura para convertir' });
  assert(created.status === 201, `captura status=${created.status}`);
  const id = created.json.item.id;
  let monday = today;
  for (let index = 0; index < 14; index += 1) {
    if (weekdayCode(monday) === 'LUN') break;
    monday = addDays(monday, 1);
  }
  const converted = await api('POST', `/api/inbox/${id}/convert`, { date: monday, time: '13:00' });
  assert(converted.status === 200, `convert status=${converted.status} ${converted.text.slice(0, 200)}`);
  assert(converted.json.item.processed === true, 'no quedó processed');
  const retry = await api('POST', `/api/inbox/${id}/convert`, { date: monday, time: '13:00' });
  assert(retry.status === 409 && retry.json.code === 'ALREADY_PROCESSED', `retry=${retry.status} ${retry.text.slice(0, 160)}`);
  return `${id} → ${converted.json.event.id}`;
});

/* 10. Rutinas: preview de R-002 */
await check('10. GET /api/routines/R-002/preview devuelve 7 apariciones', async () => {
  const response = await api('GET', '/api/routines/R-002/preview?count=7');
  assert(response.status === 200, `status=${response.status}`);
  const items = response.json.items || response.json.occurrences || [];
  assert(Array.isArray(items) && items.length === 7, `items=${items.length}`);
  return items.map((item) => item.date).join(',');
});

/* 11. Métricas y backup/restore */
await check('11. Métricas (14 campos) y backup/restore', async () => {
  const metrics = await api('GET', '/api/metrics?days=90');
  assert(metrics.status === 200, `metrics=${metrics.status}`);
  assert(Array.isArray(metrics.json.items), 'items inválido');
  assert(typeof metrics.json.p95 === 'number', 'p95 inválido');
  assert(metrics.json.fields?.length === 14, `fields=${metrics.json.fields?.length}`);

  const backup = await api('GET', '/api/backup?secrets=none');
  assert(backup.status === 200, `backup=${backup.status}`);
  backupPayload = backup.json;
  assert(backupPayload?.data?.agenda?.length >= 5, 'backup sin agenda');

  const restored = await api('POST', '/api/backup/restore', { confirm: 'RESTORE', data: backupPayload });
  assert(restored.status === 200, `restore=${restored.status} ${restored.text.slice(0, 160)}`);
  return `metrics=${metrics.json.items.length}, p95=${metrics.json.p95}`;
});

/* 12. Canales simulador + webhook genérico + señales dry-run */
await check('12. Simulador de canales, webhook genérico y señales (dry-run)', async () => {
  const simulated = await api('POST', '/api/channels/simulate', { text: 'HOY' });
  assert(simulated.status === 200, `simulate=${simulated.status} ${simulated.text.slice(0, 160)}`);
  assert(String(simulated.json.reply || '').includes('AGENDA COPILOT'), 'sin reply del simulador');

  const inbound = await api('POST', '/api/webhooks/generic', { text: 'HOY', id: 'smoke-generic-1' });
  assert(inbound.status === 200, `generic=${inbound.status} ${inbound.text.slice(0, 160)}`);
  assert(inbound.json.received === true, inbound.text.slice(0, 160));

  const signals = await api('POST', '/api/signals/evaluate', { dryRun: true });
  assert(signals.status === 200, `signals=${signals.status} ${signals.text.slice(0, 160)}`);
  assert(Array.isArray(signals.json.candidates), 'signals sin candidates');
  return `signals candidates=${signals.json.candidates.length}`;
});

/* 13. Oficina: gate N2 (sin aprobar no ejecuta → aprobar → ejecutar una vez) */
await check('13. Oficina: gate N2, aprobación y ejecución única', async () => {
  const created = await api('POST', '/api/office/proposals', {
    kind: 'document',
    channel: 'document',
    subject: 'Smoke documento',
    body: 'Borrador de smoke.',
    attachments: ['smoke.pdf']
  });
  assert(created.status === 201, `crear=${created.status} ${created.text.slice(0, 200)}`);
  const id = created.json.item.id;
  assert(created.json.level === 'N2', `level=${created.json.level}`);
  const blocked = await api('POST', `/api/office/proposals/${id}/execute`, {});
  assert(blocked.status === 409 && blocked.json.code === 'NOT_APPROVED', `sin aprobar=${blocked.status} ${blocked.text.slice(0, 160)}`);
  const approved = await api('POST', `/api/office/proposals/${id}/approve`, { by: 'smoke' });
  assert(approved.status === 200, `aprobar=${approved.status} ${approved.text.slice(0, 160)}`);
  const executed = await api('POST', `/api/office/proposals/${id}/execute`, {});
  assert(executed.status === 200 && executed.json.executed === true, `ejecutar=${executed.status} ${executed.text.slice(0, 200)}`);
  const again = await api('POST', `/api/office/proposals/${id}/execute`, {});
  assert(again.status === 409 && again.json.code === 'ALREADY_EXECUTED', `doble=${again.status}`);
  return `${id} N2 approve→execute; doble 409`;
});

/* 14. Documentos reales (DOCX) */
await check('14. Documentos: DOCX real, descarga ZIP y borrado', async () => {
  const created = await api('POST', '/api/docs', {
    type: 'docx',
    title: 'Smoke DOCX',
    sections: [{ heading: 'Prueba', paragraphs: ['Contenido de smoke.'], bullets: ['Uno', 'Dos'] }]
  });
  assert(created.status === 201, `crear=${created.status} ${created.text.slice(0, 200)}`);
  const id = created.json.item?.id || created.json.id || created.json.item?.document?.id;
  assert(id, `sin id de documento: ${created.text.slice(0, 300)}`);
  const download = await fetch(`${base}/api/docs/${id}/download`);
  assert(download.status === 200, `download=${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());
  assert(buffer.length > 1000 && buffer[0] === 0x50 && buffer[1] === 0x4b, `zip=${buffer.length} bytes`);
  const deleted = await api('DELETE', `/api/docs/${id}`);
  assert(deleted.status === 200, `delete=${deleted.status}`);
  const gone = await api('GET', `/api/docs/${id}`);
  assert(gone.status === 404, `tras borrar=${gone.status}`);
  return `${id} DOCX ${buffer.length} B`;
});

/* 15. Agenda física: plan inviable con alternativas y plan viable */
await check('15. Agenda física: Cali→Palmira inviable con alternativas; holgado viable', async () => {
  const date = tomorrow;
  const tight = await api('POST', '/api/travel/plan', {
    fromPlace: 'Cali', fromAt: `${date}T16:00:00-05:00`,
    toPlace: 'Palmira', toAt: `${date}T16:30:00-05:00`, mode: 'auto'
  });
  assert(tight.status === 200, `plan=${tight.status} ${tight.text.slice(0, 200)}`);
  assert(tight.json.feasible === false, `feasible=${tight.json.feasible}`);
  assert(Array.isArray(tight.json.alternatives) && tight.json.alternatives.length >= 2, `alts=${tight.json.alternatives?.length}`);

  const relaxed = await api('POST', '/api/travel/plan', {
    fromPlace: 'Cali', fromAt: `${date}T08:00:00-05:00`,
    toPlace: 'Palmira', toAt: `${date}T10:00:00-05:00`, mode: 'auto'
  });
  assert(relaxed.status === 200 && relaxed.json.feasible === true, `holgado=${relaxed.status}`);
  return `km=${tight.json.km} eta=${tight.json.etaMin} alts=${tight.json.alternatives.length}`;
});

/* 16. Avisos inteligentes: configuración y silencio */
await check('16. Avisos: config válida, silencio respetado y evaluate dry-run', async () => {
  const config = await api('GET', '/api/nudges/config');
  assert(config.status === 200, `config=${config.status}`);
  const silenced = await api('POST', '/api/nudges/config', { silence: { enabled: true, from: '00:00', to: '23:59' } });
  assert(silenced.status === 200, `silencio=${silenced.status}`);
  const evaluate = await api('POST', '/api/nudges/evaluate', { dryRun: false });
  assert(evaluate.status === 200 && evaluate.json.skipped === 'silence', `evaluate=${evaluate.status} ${evaluate.text.slice(0, 200)}`);
  await api('POST', '/api/nudges/config', { silence: { enabled: false, from: '21:30', to: '07:00' } });
  const dry = await api('POST', '/api/nudges/evaluate', { dryRun: true });
  assert(dry.status === 200, `dry=${dry.status}`);
  return `skipped=silence · dry items=${(dry.json.items || []).length}`;
});

/* 17. Módulos nuevos montados en /api/health */
await check('17. /api/health lista los módulos nuevos (oficina, docs, viajes, avisos, estilo, identidad)', async () => {
  const health = await api('GET', '/api/health');
  assert(health.status === 200);
  const modules = (health.json.modules || []).filter((module) => module.ok !== false).map((module) => module.name);
  for (const name of ['office', 'docs', 'travel', 'nudges', 'style', 'identity']) {
    assert(modules.includes(name), `falta módulo ${name} en ${modules.join(',')}`);
  }
  return `módulos=${modules.length}`;
});

const failed = results.filter((result) => !result.ok);
console.log(`\n=== SMOKE: ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) {
  console.error('\nFlujos fallidos:');
  for (const failure of failed) console.error(` - ${failure.name}: ${failure.detail}`);
  console.error('\nLog del servidor (últimas líneas):\n' + serverLog.slice(-2000));
}

cleanup();
process.exit(failed.length === 0 ? 0 : 1);


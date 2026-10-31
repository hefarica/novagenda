/* Verifica Momentos: resumen semanal con datos reales y UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3330';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9364;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function waitFor(fn, timeout = 20000, label = 'espera') {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-moments-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-moments-chrome-'));
const APP_SECRET = 'moments-e2e-secret-fijo-0123456789';
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: {
    ...process.env, APP_SECRET, DATA_DIR: dataDir, PORT: port, NO_OPEN: '1',
    WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off'
  },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const api = async (method, path, body) => {
    const response = await fetch(`${URL_APP}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* sin cuerpo */ }
    return { status: response.status, json };
  };
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const key = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const tomorrowDate = new Date(today.getTime() + 86_400_000);
  const yesterdayDate = new Date(today.getTime() - 86_400_000);
  const tomorrow = key(tomorrowDate);
  const yesterday = key(yesterdayDate);

  const event = await api('POST', '/api/agenda', {
    title: 'Reunión Momentos E2E',
    start: `${tomorrow}T15:00:00-05:00`,
    end: `${tomorrow}T16:00:00-05:00`,
    location: 'Cali',
    priority: 'P2'
  });
  check('Crea evento', event.status === 201, JSON.stringify(event.json).slice(0, 200));
  const task = await api('POST', '/api/tasks', {
    title: 'Tarea vencida E2E', due: yesterday, priority: 'P1', owner: 'Yo'
  });
  check('Crea tarea vencida', task.status === 201, String(task.status));
  const proposal = await api('POST', '/api/office/proposals', {
    kind: 'document', channel: 'document', subject: 'Propuesta pendiente E2E', body: 'Borrador.', attachments: ['acta.pdf']
  });
  check('Crea propuesta pendiente', proposal.status === 201, String(proposal.status));
  const room = await api('POST', '/api/rooms', { name: 'Sala Momentos', location: 'Piso 2', capacity: 6 });
  const reservation = await api('POST', `/api/rooms/${room.json.item.id}/reservations`, {
    title: 'Reserva Momentos E2E', date: tomorrow, start: '11:00', end: '12:00'
  });
  check('Crea reserva de sala', reservation.status === 201, String(reservation.status));

  const weekly = await api('GET', '/api/moments/weekly');
  check('API calcula la semana', weekly.status === 200 && weekly.json?.counts?.tasksDone >= 0 && weekly.json?.needsYou?.overdueTasks?.length >= 1, JSON.stringify(weekly.json?.counts));
  check('API incluye evento y sala', (weekly.json?.next || []).some((item) => item.title === 'Reunión Momentos E2E') && (weekly.json?.reservations || []).some((item) => item.title === 'Reserva Momentos E2E'));

  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 20000, 'chrome');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let cdpId = 1;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.exception?.description || 'excepción');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      pageErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = cdpId += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate');
    return result.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="moments"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="moments"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-moments')?.classList.contains('active') && document.querySelector('#momentsNeeds')?.textContent.includes('Propuesta pendiente E2E')`), 12000, 'momentos');
  check('La UI muestra la propuesta pendiente', true);
  const needs = await evaluate(`document.querySelector('#momentsNeeds')?.textContent || ''`);
  check('La UI prioriza la tarea vencida', /Tarea vencida E2E/.test(needs) && /vencida/i.test(needs), needs.replace(/\s+/g, ' ').trim().slice(0, 120));
  const next = await evaluate(`document.querySelector('#momentsNext')?.textContent || ''`);
  check('La UI lista el próximo evento', /Reunión Momentos E2E/.test(next));
  const rooms = await evaluate(`document.querySelector('#momentsRooms')?.textContent || ''`);
  check('La UI lista la sala reservada', /Reserva Momentos E2E/.test(rooms));
  const counts = await evaluate(`document.querySelector('#momentsCounts')?.textContent || ''`);
  check('La UI muestra contadores', /Tareas cerradas/.test(counts) && /Salas/.test(counts), counts.replace(/\s+/g, ' ').trim().slice(0, 120));

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-momentos-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de momentos sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.error(`FAIL  excepción — ${error.message}`);
} finally {
  try { ws?.close(); } catch { /* nada */ }
  try { chrome?.kill(); } catch { /* nada */ }
  try { app.kill(); } catch { /* nada */ }
  await sleep(400);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ }
}
console.log(`\n${failures ? `${failures} fallo(s)` : '=== MOMENTOS: PASS ==='}`);
process.exitCode = failures ? 1 : 0;



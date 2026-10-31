import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3344';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9378;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-taskcopy-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-taskcopy-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-taskcopy-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
let pageErrors = [];
let evaluate = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const api = async (method, path, body) => {
    const response = await fetch(`${URL_APP}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await response.json(); } catch { /* sin cuerpo */ }
    return { status: response.status, json };
  };
  const created = await api('POST', '/api/tasks', { title: 'Enviar acta E2E', due: '2026-11-02', priority: 'P1', owner: 'Héctor', notes: 'Con anexo' });
  check('Crea tarea por API', created.status === 201 && Boolean(created.json?.item?.id), `${created.status} ${created.json?.item?.id || ''}`);

  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 20000, 'chrome');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let cdpId = 1;
  const pending = new Map();
  pageErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.exception?.description || 'excepción');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') pageErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = cdpId += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate');
    return result.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="tasks"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="tasks"]')?.click()`);
  await sleep(700);
  await evaluate(`document.querySelector('[data-nav="tasks"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-tasks')?.classList.contains('active')`), 10000, 'vista tareas activa');
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#taskList .task-row')].some((node) => node.textContent.includes('Enviar acta E2E'))`), 15000, 'tarea listada');
  await evaluate(`(() => { const row = [...document.querySelectorAll('#taskList .task-row')].find((node) => node.textContent.includes('Enviar acta E2E')); row?.querySelector('[data-task-duplicate]')?.click(); return true; })()`);
  const tasks = await waitFor(async () => {
    const result = await api('GET', '/api/tasks');
    const items = result.json?.items || [];
    return items.length === 2 ? items : null;
  }, 15000, 'tarea duplicada');
  const copy = tasks.find((item) => item.title === 'Enviar acta E2E (copia)');
  check('Duplica la tarea', Boolean(copy?.id), copy?.id || '');
  check('Copia prioridad, dueño y notas', copy?.priority === 'P1' && copy?.owner === 'Héctor' && copy?.notes === 'Con anexo', JSON.stringify(copy || {}).slice(0, 160));
  check('Conserva la tarea original', tasks.some((item) => item.title === 'Enviar acta E2E' && item.id !== copy?.id));
  check('UI de tareas sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.error(`FAIL  excepción — ${error.message}`);
  console.error('pageErrors:', pageErrors.slice(0, 6));
  try { console.error('debug nav:', await evaluate(`document.querySelector('#view-tasks')?.className + ' | ' + document.body.innerText.slice(0, 300)`)); } catch { /* nada */ }
} finally {
  try { ws?.close(); } catch { /* nada */ }
  try { chrome?.kill(); } catch { /* nada */ }
  try { app.kill(); } catch { /* nada */ }
  await sleep(400);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ }
}
console.log(`\n${failures ? `${failures} fallo(s)` : '=== TAREAS DUPLICAR: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

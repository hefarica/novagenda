import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3337';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9371;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-copy-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-copy-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-copy-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const api = async (method, path, body) => {
    const response = await fetch(`${URL_APP}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await response.json(); } catch { /* sin cuerpo */ }
    return { status: response.status, json };
  };
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const created = await api('POST', '/api/agenda', {
    title: 'Cita original E2E',
    start: `${day}T14:00:00-05:00`,
    end: `${day}T15:00:00-05:00`,
    type: 'Compromiso',
    priority: 'P2'
  });
  check('Crea cita por API', created.status === 201 && Boolean(created.json?.item?.id), String(created.status));

  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
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
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate');
    return result.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="agenda"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="agenda"]')?.click()`);
  const row = await waitFor(async () => evaluate(`(() => { const rows = [...document.querySelectorAll('#agendaList .agenda-row')]; return rows.some((node) => node.textContent.includes('Cita original E2E')); })()`), 15000, 'cita en agenda');
  check('La cita aparece en agenda', Boolean(row));

  await evaluate(`(() => { const row = [...document.querySelectorAll('#agendaList .agenda-row')].find((node) => node.textContent.includes('Cita original E2E')); row?.querySelector('[data-act="duplicate-event"]')?.click(); return true; })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-event[open]'))`), 8000, 'diálogo duplicar');
  const prefilled = await evaluate(`(() => { const f = document.querySelector('#eventForm'); return { title: f?.elements.title.value || '', start: f?.elements.start.value || '', heading: document.querySelector('#eventTitle')?.textContent || '' }; })()`);
  check('Abre el formulario como nueva cita', prefilled.heading === 'Nueva cita' && prefilled.title === 'Cita original E2E', JSON.stringify(prefilled));
  check('Prellena fecha y hora', prefilled.start.includes(day) && prefilled.start.includes('14:00'), prefilled.start);

  // 18:30 queda fuera de las rutinas por defecto; el viernes a las 16:00
  // choca con la revisión semanal y la prueba se volvía dependiente del día.
  await evaluate(`(() => { const f = document.querySelector('#eventForm'); f.elements.title.value = 'Cita original E2E (copia)'; f.elements.start.value = '${day}T18:30'; f.elements.end.value = '${day}T19:30'; f.requestSubmit(); return true; })()`);
  const copied = await waitFor(async () => {
    const result = await api('GET', `/api/agenda?from=${day}&to=${day}`);
    const items = result.json?.items || [];
    return items.find((item) => item.title === 'Cita original E2E (copia)') || null;
  }, 15000, 'cita copiada');
  check('Guarda la cita duplicada', Boolean(copied?.id) && copied.start.includes('18:30'), copied?.id || '');
  const all = await api('GET', `/api/agenda?from=${day}&to=${day}`);
  check('Conserva la cita original', (all.json?.items || []).some((item) => item.title === 'Cita original E2E'));
  check('UI de agenda sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== AGENDA DUPLICAR: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3343';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9377;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-routineprint-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-routineprint-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-routineprint-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
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
  const first = await api('POST', '/api/routines', { title: 'Foco de la mañana E2E', frequency: 'LABORABLES', time: '07:30', durationMin: 90, type: 'Foco', priority: 'P1' });
  const second = await api('POST', '/api/routines', { title: 'Revisión semanal E2E', frequency: 'SEMANAL', rule: 'LUN', time: '16:00', durationMin: 45, type: 'Administrativo', priority: 'P2' });
  check('Crea dos rutinas por API', first.status === 201 && second.status === 201, first.status + '/' + second.status);

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="routines"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="routines"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#routinePrintBtn')) && document.querySelectorAll('#routinesList .routine-card').length >= 2 && document.querySelector('#routinesList')?.textContent.includes('Foco de la mañana E2E')`), 15000, 'rutinas listadas');
  await evaluate(`window.__printCalled = false; window.print = () => { window.__printCalled = true; }; document.querySelector('#routinePrintBtn')?.click(); true`);
  check('El botón imprime las rutinas', await evaluate(`window.__printCalled === true`));
  const stamp = await evaluate(`document.querySelector('#routinesPrintStamp')?.textContent || ''`);
  check('Genera membrete con activas y fecha', /Héctor Fabio Riascos C\./.test(stamp) && /\d+ rutina\(s\) activa\(s\)/.test(stamp) && /\d{4}/.test(stamp), stamp);

  await cdp('Emulation.setEmulatedMedia', { media: 'print' });
  const styles = await evaluate(`(() => ({
    nl: getComputedStyle(document.querySelector('#view-routines .nl-card')).display,
    toolbar: getComputedStyle(document.querySelector('#view-routines .toolbar')).display,
    actions: getComputedStyle(document.querySelector('#routinesList .routine-actions')).display,
    chips: getComputedStyle(document.querySelector('#routinesList .occurrence-chips')).display,
    head: getComputedStyle(document.querySelector('#routinesPrintHead')).display,
    cards: document.querySelectorAll('#routinesList .routine-card').length,
    body: getComputedStyle(document.body).backgroundColor
  }))()`);
  check('Oculta lenguaje natural, filtros y acciones', styles.nl === 'none' && styles.toolbar === 'none' && styles.actions === 'none' && styles.chips === 'none', JSON.stringify(styles));
  check('Muestra las rutinas y su membrete', styles.head === 'block' && styles.cards >= 2 && /rgb\(255, 255, 255\)/.test(styles.body), JSON.stringify(styles));
  const pdf = await cdp('Page.printToPDF', { printBackground: false, preferCSSPageSize: true });
  const bytes = Buffer.from(pdf.data, 'base64');
  check('Chrome genera un PDF de rutinas', bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 1000, `${bytes.length} bytes`);
  await cdp('Emulation.setEmulatedMedia', { media: 'screen' });
  check('UI de impresión Rutinas sin errores', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== RUTINAS IMPRIMIR: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


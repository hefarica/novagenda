import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3338';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9372;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-print-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-print-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-print-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const created = await fetch(`${URL_APP}/api/agenda`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Cita para imprimir E2E', start: `${day}T10:00:00-05:00`, end: `${day}T11:00:00-05:00`, type: 'Compromiso', priority: 'P1' })
  });
  check('Crea cita para imprimir', created.status === 201, String(created.status));

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
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#agendaList .agenda-row')].some((node) => node.textContent.includes('Cita para imprimir E2E'))`), 15000, 'cita');
  await evaluate(`window.__printCalled = false; window.print = () => { window.__printCalled = true; }; document.querySelector('#agendaPrintBtn')?.click(); true`);
  check('El botón dispara la impresión', await evaluate(`window.__printCalled === true`));
  const stamp = await evaluate(`document.querySelector('#agendaPrintStamp')?.textContent || ''`);
  check('Genera membrete de impresión', /Héctor Fabio Riascos C\./.test(stamp) && /\d{4}/.test(stamp), stamp);

  await cdp('Emulation.setEmulatedMedia', { media: 'print' });
  const styles = await evaluate(`(() => ({
    drawer: getComputedStyle(document.querySelector('.drawer')).display,
    topbar: getComputedStyle(document.querySelector('.topbar')).display,
    actions: getComputedStyle(document.querySelector('.head-actions')).display,
    toolbar: getComputedStyle(document.querySelector('.toolbar')).display,
    printHead: getComputedStyle(document.querySelector('#agendaPrintHead')).display,
    body: getComputedStyle(document.body).backgroundColor
  }))()`);
  check('En impresión oculta menú y barra', styles.drawer === 'none' && styles.topbar === 'none' && styles.actions === 'none', JSON.stringify(styles));
  check('En impresión muestra membrete', styles.printHead === 'block' && /rgb\(255, 255, 255\)/.test(styles.body), JSON.stringify(styles));
  const pdf = await cdp('Page.printToPDF', { printBackground: false, preferCSSPageSize: true });
  const bytes = Buffer.from(pdf.data, 'base64');
  check('Chrome genera un PDF válido', bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 1000, `${bytes.length} bytes`);
  await cdp('Emulation.setEmulatedMedia', { media: 'screen' });
  await evaluate(`document.querySelector('[data-view-mode="week"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#agendaWeek') && !document.querySelector('#agendaWeek').hidden`), 8000, 'modo semana');
  await cdp('Emulation.setEmulatedMedia', { media: 'print' });
  const weekPrint = await evaluate(`(() => ({ display: getComputedStyle(document.querySelector('#agendaList')).display, rows: document.querySelectorAll('#agendaList .agenda-row').length, week: getComputedStyle(document.querySelector('#agendaWeek')).display }))()`);
  check('Imprime la lista aunque esté en Semana', weekPrint.display !== 'none' && weekPrint.rows > 0 && weekPrint.week === 'none', JSON.stringify(weekPrint));
  await cdp('Emulation.setEmulatedMedia', { media: 'screen' });
  check('UI de impresión sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== AGENDA IMPRIMIR: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3345';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9379;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-attprint-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-attprint-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-attprint-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
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
  const start = await api('POST', '/api/attendance/clock-in', { note: 'E2E impresión' });
  await sleep(350);
  const end = await api('POST', '/api/attendance/clock-out', {});
  const attendance = await api('GET', '/api/attendance');
  check('Crea un turno cerrado por API', start.status === 201 && end.status === 200 && (attendance.json?.items || []).length === 1, `${start.status}/${end.status}`);
  const csvResponse = await fetch(`${URL_APP}/api/attendance/export.csv`);
  const csvBytes = new Uint8Array(await csvResponse.clone().arrayBuffer());
  const csvText = await csvResponse.text();
  const hasBom = csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF;
  check('Exporta la jornada en CSV', csvResponse.status === 200 && /text\/csv/.test(csvResponse.headers.get('content-type') || '') && hasBom && csvText.includes('E2E impresión') && csvText.includes('Pausa (min)'), `${csvResponse.status} ${csvText.length} bytes :: ${csvText.slice(0, 300)}`);

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="attendance"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="attendance"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-attendance')?.classList.contains('active')`), 10000, 'vista jornada');
  await waitFor(async () => evaluate(`document.querySelectorAll('#attendanceList .doc-row').length === 1`), 15000, 'turno listado');
  await evaluate(`window.__printCalled = false; window.print = () => { window.__printCalled = true; }; document.querySelector('#attendancePrintBtn')?.click(); true`);
  check('El botón imprime la jornada', await evaluate(`window.__printCalled === true`));
  const stamp = await evaluate(`document.querySelector('#attendancePrintStamp')?.textContent || ''`);
  check('Genera membrete con rango y turnos', /Héctor Fabio Riascos C\./.test(stamp) && /1 turno\(s\)/.test(stamp) && /→/.test(stamp), stamp);

  await cdp('Emulation.setEmulatedMedia', { media: 'print' });
  const styles = await evaluate(`(() => ({
    head: getComputedStyle(document.querySelector('#attendancePrintHead')).display,
    firstCard: getComputedStyle(document.querySelector('#view-attendance > .card.glass')).display,
    actions: getComputedStyle(document.querySelector('#attendanceList .approval-actions')).display,
    rows: document.querySelectorAll('#attendanceList .doc-row').length,
    body: getComputedStyle(document.body).backgroundColor
  }))()`);
  check('Oculta reloj y acciones, muestra el reporte', styles.head === 'block' && styles.firstCard === 'none' && styles.actions === 'none' && styles.rows === 1, JSON.stringify(styles));
  const pdf = await cdp('Page.printToPDF', { printBackground: false, preferCSSPageSize: true });
  const bytes = Buffer.from(pdf.data, 'base64');
  check('Chrome genera un PDF de jornada', bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 1000, `${bytes.length} bytes`);
  await cdp('Emulation.setEmulatedMedia', { media: 'screen' });
  check('UI de impresión Jornada sin errores', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== JORNADA IMPRIMIR: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


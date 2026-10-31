/* Verifica Jornada: entrada, pausa, salida y borrado desde la UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3331';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9365;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-attendance-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-attendance-chrome-'));
const APP_SECRET = 'attendance-e2e-secret-fijo-0123456789';
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
  const initial = await api('GET', '/api/attendance');
  check('API arranca sin turnos', initial.status === 200 && (initial.json?.items || []).length === 0);

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="attendance"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="attendance"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-attendance')?.classList.contains('active') && document.querySelector('#attendanceHint')?.textContent.includes('Pulsa Entrada')`), 12000, 'vista jornada');
  check('Jornada abre sin turnos', true);

  await evaluate(`document.querySelector('#attendanceIn')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/attendance');
    return Boolean(result.json?.open);
  }, 10000, 'entrada');
  check('Registra entrada', true);
  await waitFor(async () => evaluate(`document.querySelector('#attendanceStatus')?.textContent.includes('Abierta desde') && !document.querySelector('#attendanceBreak')?.disabled`), 10000, 'estado abierto en UI');
  const statusOpen = await evaluate(`document.querySelector('#attendanceStatus')?.textContent || ''`);
  check('Muestra jornada abierta', /Abierta desde/.test(statusOpen), statusOpen);

  await evaluate(`document.querySelector('#attendanceBreak')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt[open]'))`), 8000, 'pausa');
  await evaluate(`(() => { const form = document.querySelector('#promptForm'); form.elements.value.value = '20'; form.requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/attendance');
    return result.json?.open?.breakMinutes === 20;
  }, 10000, 'pausa registrada');
  check('Registra pausa', true);

  await evaluate(`document.querySelector('#attendanceOut')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/attendance');
    return (result.json?.items || []).some((shift) => shift.end);
  }, 10000, 'salida');
  check('Registra salida', true);
  await waitFor(async () => evaluate(`document.querySelector('#attendanceList')?.textContent.includes('1') && document.querySelector('#attendanceCounts')?.textContent.replace(/\\s+/g, '').includes('Días1')`), 10000, 'historial y resumen');
  const counts = await evaluate(`document.querySelector('#attendanceCounts')?.textContent || ''`);
  check('Resumen con horas y días', /Horas/.test(counts) && /Días/.test(counts), counts.replace(/\s+/g, ' ').trim().slice(0, 100));

  await evaluate(`document.querySelector('#attendanceList [data-attendance-action="edit"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#attendanceList .attendance-edit'))`), 8000, 'edición de turno');
  await evaluate(`(() => {
    const row = document.querySelector('#attendanceList .attendance-edit');
    row.querySelector('[data-shift-break]').value = '15';
    row.querySelector('[data-shift-note]').value = 'Ajustado desde la UI';
    row.querySelector('[data-attendance-action="save"]').click();
    return true;
  })()`);
  await waitFor(async () => evaluate(`!document.querySelector('#attendanceList .attendance-edit') && (document.querySelector('#attendanceList')?.textContent || '').includes('Ajustado desde la UI')`), 10000, 'turno actualizado');
  check('Edita un turno desde la UI', true);
  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-jornada-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`document.querySelector('#attendanceList [data-attendance-action="delete"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar borrado');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/attendance');
    return (result.json?.items || []).length === 0;
  }, 10000, 'turno borrado');
  check('Borra turno desde la UI', true);
  check('UI de jornada sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== JORNADA: PASS ==='}`);
process.exitCode = failures ? 1 : 0;



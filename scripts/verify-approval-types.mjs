/* Verifica tipos de aprobación y solicitudes en la UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3334';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9368;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-approval-types-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-approval-types-chrome-'));
const APP_SECRET = 'approval-types-e2e-secret-fijo-0123456789';
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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="approvals"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="approvals"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-approvals')?.classList.contains('active') && Boolean(document.querySelector('#approvalTypeForm'))`), 12000, 'aprobaciones');

  await evaluate(`(() => {
    const form = document.querySelector('#approvalTypeForm');
    form.elements.name.value = 'Permiso de salida E2E';
    form.elements.level.value = 'N2';
    form.elements.fields.value = 'Motivo:texto, Fecha:fecha';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await fetch(`${URL_APP}/api/approval-types`).then((response) => response.json());
    return (result.items || []).some((type) => type.name === 'Permiso de salida E2E');
  }, 12000, 'tipo creado');
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#approvalTypeSelect option')].some((option) => option.textContent.includes('Permiso de salida E2E'))`), 10000, 'tipo en selector');
  check('Crea tipo desde la UI', true);
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#approvalTypesList [data-approval-type-action="edit"]')].length > 0`), 10000, 'tipo editable');
  await evaluate(`document.querySelector('#approvalTypesList [data-approval-type-action="edit"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#approvalTypeForm')?.elements.name.value === 'Permiso de salida E2E'`), 8000, 'form tipo');
  await evaluate(`(() => { const f = document.querySelector('#approvalTypeForm'); f.elements.name.value = 'Permiso de salida E2E editado'; f.elements.slaHours.value = '12'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await fetch(`${URL_APP}/api/approval-types`).then((response) => response.json());
    return (result.items || []).some((type) => type.name === 'Permiso de salida E2E editado' && type.slaHours === 12);
  }, 12000, 'tipo editado');
  check('Edita el tipo desde la UI', true);

  await waitFor(async () => evaluate(`document.querySelectorAll('#approvalRequestFields input').length >= 2`), 8000, 'campos dinámicos');
  await evaluate(`(() => {
    const form = document.querySelector('#approvalRequestForm');
    form.elements.title.value = 'Salir el viernes E2E';
    const fields = document.querySelectorAll('#approvalRequestFields [name]');
    fields[0].value = 'Trámite personal';
    fields[1].value = '2026-10-30';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await fetch(`${URL_APP}/api/approval-requests?status=pending`).then((response) => response.json());
    return (result.items || []).some((request) => request.title === 'Salir el viernes E2E');
  }, 12000, 'solicitud creada');
  await waitFor(async () => evaluate(`document.querySelector('#approvalRequestsList')?.textContent.includes('Salir el viernes E2E')`), 10000, 'solicitud en lista');
  check('Crea solicitud y exige campos', true);

  await evaluate(`document.querySelector('#approvalTypeForm')?.scrollIntoView({ block: 'center' })`);
  await sleep(200);
  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-tipos-aprobacion-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`document.querySelector('#approvalRequestsList [data-approval-request-action="approve"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar aprobación');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await fetch(`${URL_APP}/api/approval-requests?status=pending`).then((response) => response.json());
    return !(result.items || []).some((request) => request.title === 'Salir el viernes E2E');
  }, 12000, 'aprobada');
  check('Aprueba la solicitud desde la UI', true);
  check('UI de tipos sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== TIPOS DE APROBACIÓN: PASS ==='}`);
process.exitCode = failures ? 1 : 0;



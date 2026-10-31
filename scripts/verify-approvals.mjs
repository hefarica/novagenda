/* Verifica el Centro de aprobaciones: bandeja, aprobar, rechazar y cuarentena vacía. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3326';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9360;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-approvals-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-approvals-chrome-'));
const APP_SECRET = 'approvals-e2e-secret-fijo-0123456789';
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

  const make = async (subject, kind = 'document', channel = 'document') => {
    const result = await api('POST', '/api/office/proposals', {
      kind, channel, subject, body: `Borrador de ${subject}.`, attachments: kind === 'document' ? ['acta.docx'] : []
    });
    return result.json?.item?.id || result.json?.id;
  };
  const approveId = await make('Acta pendiente E2E');
  const executeId = await make('Propuesta para ejecutar E2E');
  const rejectId = await make('Propuesta a rechazar E2E');
  check('Crea tres propuestas pendientes', !!approveId && !!executeId && !!rejectId, `${approveId}, ${executeId}, ${rejectId}`);
  const pendingCount = await api('GET', '/api/office/proposals?status=pending');
  check('Las propuestas esperan aprobación', (pendingCount.json?.proposals || []).length === 3);

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
  await waitFor(async () => evaluate(`document.querySelector('#view-approvals')?.classList.contains('active') && document.querySelectorAll('#approvalPending .doc-row').length === 3`), 10000, 'bandeja');
  check('El centro muestra las tres pendientes', true);
  await waitFor(async () => evaluate(`document.querySelector('#approvalMetrics')?.textContent.includes('Tiempo medio')`), 10000, 'métricas');
  const metricsText = await evaluate(`document.querySelector('#approvalMetrics')?.textContent || ''`);
  check('Métricas de SLA visibles', /Tiempo medio/.test(metricsText) && /Fuera de SLA/.test(metricsText), metricsText.slice(0, 120));
  const summary = await evaluate(`document.querySelector('#approvalsSummary')?.textContent || ''`);
  check('Resumen con antigüedad y estado', /esperando|No hay propuestas/.test(summary), summary);

  await evaluate(`document.querySelector('[data-approval-action="approve"][data-approval-id="${approveId}"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar aprobación');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/office/proposals?status=approved');
    return (result.json?.proposals || []).some((item) => item.id === approveId);
  }, 12000, 'aprobada');
  check('Aprueba desde el centro', true);

  await evaluate(`document.querySelector('[data-approval-action="reject"][data-approval-id="${rejectId}"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt[open]'))`), 8000, 'motivo de rechazo');
  await evaluate(`(() => { const form = document.querySelector('#promptForm'); form.elements.value.value = 'No cumple el alcance'; form.requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/office/proposals?status=rejected');
    return (result.json?.proposals || []).some((item) => item.id === rejectId);
  }, 12000, 'rechazada');
  check('Rechaza desde el centro', true);

  await waitFor(async () => evaluate(`document.querySelector('#approvalApproved')?.textContent.includes('${approveId}')`), 10000, 'aprobada en la lista');
  check('Mueve la aprobada a por ejecutar', true);
  const approvedButtons = await evaluate(`document.querySelectorAll('#approvalApproved [data-approval-action="execute"]').length`);
  check('Ofrece ejecutar la aprobada', approvedButtons >= 1, `${approvedButtons}`);
  await waitFor(async () => evaluate(`document.querySelector('#approvalQuarantine')?.textContent.includes('No hay correo retenido')`), 8000, 'cuarentena vacía');
  check('Cuarentena con estado vacío', true);

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-aprobaciones-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de aprobaciones sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== APROBACIONES: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


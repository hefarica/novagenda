/* Verifica Preguntar a la base: API y UI con datos reales. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3332';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9366;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-ask-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-ask-chrome-'));
const APP_SECRET = 'ask-base-e2e-secret-fijo-0123456789';
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
  const table = await api('POST', '/api/base/tables', { name: 'Predios', columns: 'Nombre:texto, Estado:texto, Valor:número' });
  const tableId = table.json?.item?.id;
  const columns = Object.fromEntries((table.json?.item?.columns || []).map((column) => [column.name, column.id]));
  check('Crea tabla de prueba', table.status === 201 && !!tableId);
  for (const values of [
    { [columns.Nombre]: 'Predio Norte', [columns.Estado]: 'pagado', [columns.Valor]: 150 },
    { [columns.Nombre]: 'Predio Sur', [columns.Estado]: 'pagado', [columns.Valor]: 80 },
    { [columns.Nombre]: 'Predio Centro', [columns.Estado]: 'pendiente', [columns.Valor]: 200 }
  ]) {
    const row = await api('POST', `/api/base/tables/${tableId}/rows`, { values });
    if (row.status !== 201) throw new Error(`fila ${row.status}`);
  }
  const asked = await api('POST', '/api/base/ask', { question: '¿cuántos predios con estado = pagado?' });
  check('API responde con filas reales', asked.status === 200 && asked.json?.matched === 2 && asked.json?.rows?.length === 2, asked.json?.answer);
  await api('POST', '/api/base/tables', { name: 'Contactos', columns: 'Nombre:texto, Ciudad:texto' });
  const ambiguous = await api('POST', '/api/base/ask', { question: '¿cuántos registros hay?' });
  check('API no adivina tabla ambigua', ambiguous.status === 200 && ambiguous.json?.ambiguous === true);

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="base"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="base"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-base')?.classList.contains('active') && Boolean(document.querySelector('#baseAskForm'))`), 12000, 'vista base');
  check('Base abre con el cuadro de preguntas', true);

  await evaluate(`(() => {
    const form = document.querySelector('#baseAskForm');
    form.elements.question.value = '¿cuántos predios con estado = pagado?';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseAskAnswer')?.textContent.includes('2 fila')`), 12000, 'respuesta');
  const answer = await evaluate(`document.querySelector('#baseAskAnswer')?.textContent || ''`);
  check('UI responde con conteo', /2 fila/.test(answer), answer.slice(0, 120));
  const rowsText = await evaluate(`document.querySelector('#baseAskRows')?.textContent || ''`);
  check('UI muestra filas reales', /Predio Norte/.test(rowsText) && /Predio Sur/.test(rowsText) && !/Predio Centro/.test(rowsText), rowsText.replace(/\s+/g, ' ').trim().slice(0, 120));

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-base-preguntar-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de preguntas sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== PREGUNTAR A LA BASE: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


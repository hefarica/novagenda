/* Verifica Auditoría: consulta filtrable, estadísticas, verificación y exportación + UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3322';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9356;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-audit-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-audit-chrome-'));
const APP_SECRET = 'audit-e2e-secret-fijo-0123456789';
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
    const text = await response.text();
    try { json = JSON.parse(text); } catch { /* csv o vacío */ }
    return { status: response.status, json, text, headers: response.headers };
  };

  await api('POST', '/api/lingo/terms', { term: 'Catastro', variants: ['Catrastro'], context: 'entidades' });
  await api('POST', '/api/lingo/terms', { term: 'Palmira', variants: ['Palmitra'], context: 'ciudades' });

  const events = await api('GET', '/api/audit/events');
  check('Lista eventos del ledger', events.status === 200 && events.json?.total >= 2 && events.json?.items?.[0]?.action === 'lingo.change', `total ${events.json?.total}`);
  const filteredActor = await api('GET', '/api/audit/events?actor=lingo');
  check('Filtra por actor', filteredActor.json?.total === 2 && filteredActor.json?.items?.every((item) => item.actor === 'lingo'), `total ${filteredActor.json?.total}`);
  const filteredQ = await api('GET', '/api/audit/events?q=Palmira');
  check('Filtra por texto del payload', filteredQ.json?.total === 1 && filteredQ.json?.items?.[0]?.payload?.term === 'Palmira', JSON.stringify(filteredQ.json?.items?.[0]?.payload || {}));
  const badDate = await api('GET', '/api/audit/events?from=2026-13-01');
  check('Rechaza fecha inválida (400)', badDate.status === 400 && badDate.json?.code === 'INVALID_DATE', JSON.stringify(badDate.json).slice(0, 100));
  const badRange = await api('GET', '/api/audit/events?from=2026-12-31&to=2026-01-01');
  check('Rechaza rango invertido (400)', badRange.status === 400 && badRange.json?.code === 'INVALID_RANGE', JSON.stringify(badRange.json).slice(0, 100));

  const stats = await api('GET', '/api/audit/stats');
  check('Estadísticas y cadena íntegra', stats.json?.total >= 2 && stats.json?.verification?.ok === true && stats.json?.actors?.some((row) => row.name === 'lingo'), JSON.stringify(stats.json?.verification || {}));

  const exportedJson = await api('GET', '/api/audit/export?format=json&actor=lingo');
  check('Exporta JSON filtrado', exportedJson.status === 200 && exportedJson.json?.entries?.length === 2 && exportedJson.json?.verification?.ok === true, `entries ${exportedJson.json?.entries?.length}`);
  const exportedCsv = await api('GET', '/api/audit/export?format=csv&actor=lingo');
  check('Exporta CSV filtrado', exportedCsv.status === 200 && /text\/csv/.test(exportedCsv.headers.get('content-type') || '') && exportedCsv.text.startsWith('seq,ts,actor,action') && exportedCsv.text.includes('lingo.change'), exportedCsv.text.slice(0, 60).replace(/\r?\n/g, ' | '));

  /* ------------------------------- UI real ------------------------------- */
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate');
    return result.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="audit"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="audit"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-audit')?.classList.contains('active') && document.querySelectorAll('#auditTable tbody tr').length >= 2`), 10000, 'vista auditoría');
  check('La Auditoría abre desde el menú', true);
  const verifyText = await evaluate(`document.querySelector('#auditVerifyResult')?.textContent || ''`);
  check('Muestra la cadena íntegra', /íntegra/i.test(verifyText), verifyText);

  await evaluate(`(() => {
    const form = document.querySelector('#auditFilters');
    form.elements.actor.value = 'lingo';
    form.elements.q.value = 'Palmira';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#auditTable tbody tr').length === 1 && document.querySelector('#auditTable')?.textContent.includes('lingo.change')`), 10000, 'filtro UI');
  check('Filtra desde la UI', true);

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-auditoria-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`document.querySelector('#auditReset')?.click()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#auditTable tbody tr').length >= 2`), 10000, 'limpiar filtro');
  check('Limpia filtros', true);
  await evaluate(`document.querySelector('#auditVerify')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#auditVerifyResult')?.textContent.includes('íntegra')`), 10000, 'verificar UI');
  check('Verifica la cadena desde la UI', true);
  const exportLinks = await evaluate(`Boolean(document.querySelector('#auditExportJson')) && Boolean(document.querySelector('#auditExportCsv'))`);
  check('Expone exportación JSON y CSV', exportLinks === true);
  check('UI Auditoría sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== AUDITORÍA: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

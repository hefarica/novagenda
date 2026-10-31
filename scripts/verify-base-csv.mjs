/* Verifica exportación CSV de Base desde la UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3339';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9373;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 20000, label = 'espera') { const start = Date.now(); let last = null; while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(250); } throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`); }
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-basecsv-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-basecsv-chrome-'));
const downloadDir = mkdtempSync(join(tmpdir(), 'agenda-basecsv-dl-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], { env: { ...process.env, APP_SECRET: 'basecsv-e2e-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' }, stdio: 'ignore' });
let chrome = null; let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const created = await fetch(`${URL_APP}/api/base/tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Predios E2E', columns: 'Predio:texto, Área:número, Pagado:casilla' }) }).then((response) => response.json());
  const tableId = created.item.id;
  await fetch(`${URL_APP}/api/base/tables/${tableId}/rows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { c1: 'El Roble, lote 2', c2: '1250.5', c3: true } }) });
  const direct = await fetch(`${URL_APP}/api/base/tables/${tableId}/export.csv`);
  const body = await direct.text();
  check('API exporta CSV con cabecera', direct.ok && /text\/csv/.test(direct.headers.get('content-type') || '') && body.includes('Predio'), `${direct.status} ${direct.headers.get('content-type')} ${JSON.stringify(body.slice(0, 60))}`);
  check('API neutraliza y escapa', body.includes('"El Roble, lote 2"') && body.includes('Sí'), direct.headers.get('content-disposition') || '');

  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 20000, 'chrome');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let cdpId = 1; const pending = new Map(); const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); if (message.error) reject(new Error(message.error.message)); else resolve(message.result); return; }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.exception?.description || 'excepción');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') pageErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = cdpId += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate'); return result.result?.value; };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="base"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="base"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-base')?.classList.contains('active') && !document.querySelector('#baseTableTools')?.hidden && Boolean(document.querySelector('#baseExportCsv'))`), 15000, 'tabla');
  check('Base muestra el botón Exportar CSV', true);
  await evaluate(`document.querySelector('#baseExportCsv')?.click()`);
  const file = await waitFor(() => {
    const names = readdirSync(downloadDir).filter((name) => name.endsWith('.csv'));
    return names.length ? join(downloadDir, names[0]) : null;
  }, 12000, 'descarga CSV');
  const downloaded = readFileSync(file, 'utf8');
  check('El navegador descarga el CSV', downloaded.includes('Predio') && downloaded.includes('El Roble, lote 2'));
  check('UI de exportación sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) { failures += 1; console.error(`FAIL  excepción — ${error.message}`); }
finally { try { ws?.close(); } catch { /* nada */ } try { chrome?.kill(); } catch { /* nada */ } try { app.kill(); } catch { /* nada */ } await sleep(400); try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } try { rmSync(downloadDir, { recursive: true, force: true }); } catch { /* nada */ } }
console.log(`\n${failures ? `${failures} fallo(s)` : '=== BASE CSV: PASS ==='}`);
process.exitCode = failures ? 1 : 0;



/* Verifica historial de versiones en Documentos. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3336';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9370;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 20000, label = 'espera') { const start = Date.now(); let last = null; while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(250); } throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`); }
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-docver-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-docver-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], { env: { ...process.env, APP_SECRET: 'docver-e2e-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' }, stdio: 'ignore' });
let chrome = null; let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const create = async (text) => { const response = await fetch(`${URL_APP}/api/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'docx', title: 'Acta versionada E2E', sections: [{ heading: 'Acuerdo', paragraphs: [text] }] }) }); return response.json(); };
  const one = await create('Primera versión');
  await create('Segunda versión');
  check('Crea dos versiones del mismo título', !!one.id, one.id);
  const versions = await fetch(`${URL_APP}/api/docs/${one.id}/versions`).then((response) => response.json());
  check('API agrupa versiones', versions.count === 2 && versions.items.length === 2, `${versions.count}`);

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
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="docs"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="docs"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-docs')?.classList.contains('active') && document.querySelectorAll('#docsList .doc-row').length >= 2`), 12000, 'documentos');
  check('La lista muestra los documentos', true);
  await evaluate(`document.querySelector('#docsList [data-doc-act="versions"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#docsList .doc-version').length >= 2`), 12000, 'versiones UI');
  check('La UI agrupa las dos versiones', true);
  const text = await evaluate(`document.querySelector('#docsList .doc-versions')?.textContent || ''`);
  check('La UI lista fechas y descargas', /Descargar/.test(text) && /Acta versionada E2E/.test(await evaluate(`document.querySelector('#docsList')?.textContent || ''`)), text.replace(/\s+/g, ' ').trim().slice(0, 140));
  mkdirSync('docs/capturas', { recursive: true });
  await evaluate(`(() => { const el = document.querySelector('#docsList .doc-versions'); if (el) { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -140); } return window.scrollY; })()`);
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-versiones-documento-light.png', Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('#docsList [data-doc-act="rename"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'diálogo renombrar');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Acta versionada E2E renombrada'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#docsList')?.textContent.includes('Acta versionada E2E renombrada')`), 10000, 'título renombrado');
  check('Renombra un documento desde la UI', true);
  await evaluate(`document.querySelector('#docsList [data-doc-act="duplicate"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#docsList')?.textContent.includes('(copia)')`), 12000, 'copia en lista');
  const copies = await fetch(`${URL_APP}/api/docs`).then((response) => response.json());
  check('Duplica un documento desde la UI', (copies.items || []).some((item) => item.title.includes('(copia)')), `${(copies.items || []).length} documentos`);
  const exportButton = await evaluate(`document.querySelector('#docsExportZip')?.textContent || ''`);
  check('Ofrece descargar todos los documentos', /Descargar todo/.test(exportButton), exportButton.trim());
  const zipResponse = await fetch(`${URL_APP}/api/docs/export.zip`);
  const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
  check('El ZIP de documentos descarga', zipResponse.status === 200 && /zip/.test(zipResponse.headers.get('content-type') || '') && zipBuffer.subarray(0, 2).toString() === 'PK' && zipBuffer.length > 100, `HTTP ${zipResponse.status}, ${zipBuffer.length} bytes`);
  check('UI de versiones sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) { failures += 1; console.error(`FAIL  excepción — ${error.message}`); }
finally { try { ws?.close(); } catch { /* nada */ } try { chrome?.kill(); } catch { /* nada */ } try { app.kill(); } catch { /* nada */ } await sleep(400); try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } }
console.log(`\n${failures ? `${failures} fallo(s)` : '=== VERSIONES DE DOCUMENTO: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


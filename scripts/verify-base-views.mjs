/* Verifica vistas guardadas en Base desde la UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3342';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9376;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 20000, label = 'espera') { const start = Date.now(); let last = null; while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(250); } throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`); }
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-baseviews-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-baseviews-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], { env: { ...process.env, APP_SECRET: 'baseviews-e2e-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' }, stdio: 'ignore' });
let chrome = null; let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const created = await fetch(`${URL_APP}/api/base/tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Vistas UI E2E', columns: 'Predio:texto, Pagado:casilla' }) }).then((response) => response.json());
  const tableId = created.item.id;
  for (const [predio, pagado] of [['El Roble', true], ['La Palma', false], ['El Cedro', true]]) {
    await fetch(`${URL_APP}/api/base/tables/${tableId}/rows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { c1: predio, c2: pagado } }) });
  }
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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="base"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="base"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-base')?.classList.contains('active') && !document.querySelector('#baseFilterBar')?.hidden`), 15000, 'tabla');
  check('Base muestra el filtro', true);
  await evaluate(`document.querySelector('#baseRenameTable')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'diálogo renombrar');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Predios E2E'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseTableTitle')?.textContent.includes('Predios E2E')`), 10000, 'tabla renombrada');
  check('Renombra la tabla desde la UI', true);
  await evaluate(`document.querySelector('#baseAddColumn')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'diálogo columna');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Estado'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open) && document.querySelector('#promptForm')?.elements.value.value === 'texto'`), 8000, 'tipo columna');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'texto'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseRows')?.textContent.includes('Estado')`), 10000, 'columna agregada');
  check('Agrega una columna desde la UI', true);
  await evaluate(`document.querySelector('#baseRenameColumn')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'diálogo columna actual');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Estado'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open) && document.querySelector('#promptForm')?.elements.value.value === 'Estado'`), 8000, 'nuevo nombre columna');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Situación'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseRows')?.textContent.includes('Situación')`), 10000, 'columna renombrada');
  check('Renombra una columna desde la UI', true);
  await evaluate(`document.querySelector('#baseDeleteColumn')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'diálogo eliminar columna');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Situación'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar eliminar columna');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => evaluate(`!document.querySelector('#baseRows')?.textContent.includes('Situación')`), 10000, 'columna eliminada');
  check('Elimina una columna desde la UI', true);
  await evaluate(`(() => { const col = document.querySelector('#baseFilterColumn'); col.value = 'c2'; document.querySelector('#baseFilterOp').value = 'eq'; document.querySelector('#baseFilterValue').value = 'Sí'; document.querySelector('#baseFilterApply').click(); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseTableCount')?.textContent.includes('2 de 3')`), 8000, 'filtro aplicado');
  check('Filtra filas y muestra el conteo', await evaluate(`document.querySelector('#baseRows')?.textContent.includes('El Roble') && !document.querySelector('#baseRows')?.textContent.includes('La Palma')`));
  await evaluate(`document.querySelector('#baseRows [data-base-sort="c1"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseRows tbody tr td:first-child')?.textContent.includes('El Cedro')`), 8000, 'orden asc');
  await evaluate(`document.querySelector('#baseRows [data-base-sort="c1"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseRows tbody tr td:first-child')?.textContent.includes('El Roble')`), 8000, 'orden desc');
  check('Ordena por columna y alterna dirección', true);
  await evaluate(`document.querySelector('#baseSaveView')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt[open]'))`), 8000, 'diálogo vista');
  await evaluate(`(() => { const input = document.querySelector('#promptForm input[name="value"]'); input.value = 'Pagados'; document.querySelector('#promptForm').requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await fetch(`${URL_APP}/api/base/tables/${tableId}`).then((response) => response.json());
    return (result.item?.views || []).some((view) => view.name === 'Pagados');
  }, 10000, 'vista guardada');
  check('Guarda la vista con nombre', true);
  await evaluate(`document.querySelector('#baseFilterClear')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseTableCount')?.textContent.includes('3 fila')`), 8000, 'limpiar');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#baseViews [data-base-view]'))`), 8000, 'chip vista');
  await evaluate(`document.querySelector('#baseViews [data-base-view]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseTableCount')?.textContent.includes('2 de 3')`), 8000, 'reaplicar');
  check('Reaplica la vista guardada', true);
  mkdirSync('docs/capturas', { recursive: true });
  await evaluate(`document.querySelector('#baseFilterBar')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-base-vistas-guardadas-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de vistas sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) { failures += 1; console.error(`FAIL  excepción — ${error.message}`); }
finally { try { ws?.close(); } catch { /* nada */ } try { chrome?.kill(); } catch { /* nada */ } try { app.kill(); } catch { /* nada */ } await sleep(400); try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } }
console.log(`\n${failures ? `${failures} fallo(s)` : '=== BASE VISTAS GUARDADAS: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

/* Verifica copia de seguridad desde Ajustes. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3335';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9369;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 20000, label = 'espera') { const start = Date.now(); let last = null; while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(250); } throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`); }
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-backup-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-backup-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], { env: { ...process.env, APP_SECRET: 'backup-e2e-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' }, stdio: 'ignore' });
let chrome = null; let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const task = await fetch(`${URL_APP}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Tarea copia E2E', due: '2026-10-30' }) });
  check('Crea dato para exportar', task.status === 201, String(task.status));
  const exported = await fetch(`${URL_APP}/api/admin/export`).then((response) => response.json());
  check('API exporta JSON', exported.format === 'agenda-copilot-export' && exported.counts.tasks === 1, JSON.stringify(exported.counts));
  check('API no exporta secretos', !/NO_DEBE_SALIR|"password"|"apiKey"/i.test(JSON.stringify(exported)));

  const fullResponse = await fetch(`${URL_APP}/api/backup?secrets=none`);
  const full = await fullResponse.json();
  check('API ofrece copia completa restaurable', fullResponse.status === 200 && full.includesSecrets === false && Boolean(full.data?.settings) && Array.isArray(full.data?.agenda), `${fullResponse.status}, secretos=${full.includesSecrets}`);
  check('Copia completa no incluye secretos', !/NO_DEBE_SALIR|"password"|"apiKey"/i.test(JSON.stringify(full.data?.secrets || {})), JSON.stringify(full.data?.secrets || {}));
  const noConfirm = await fetch(`${URL_APP}/api/backup/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: full.data }) });
  check('Restaurar exige confirmación', noConfirm.status === 400, String(noConfirm.status));

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="integrations"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="integrations"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-integrations')?.classList.contains('active') && Boolean(document.querySelector('#backupDownload'))`), 12000, 'ajustes');
  check('Ajustes muestra copia de seguridad', true);
  check('Ajustes ofrece copia completa y restaurar', Boolean(await evaluate(`document.querySelector('#backupFullDownload') && document.querySelector('#backupRestore')`)));
  await evaluate(`document.querySelector('#backupDownload')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#backupStatus')?.textContent.includes('Copia generada')`), 12000, 'copia');
  const status = await evaluate(`document.querySelector('#backupStatus')?.textContent || ''`);
  check('La copia reporta contadores', /1 tareas/.test(status) || /1 tarea/.test(status), status);
  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-copia-seguridad-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de copia sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) { failures += 1; console.error(`FAIL  excepción — ${error.message}`); }
finally { try { ws?.close(); } catch { /* nada */ } try { chrome?.kill(); } catch { /* nada */ } try { app.kill(); } catch { /* nada */ } await sleep(400); try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } }
console.log(`\n${failures ? `${failures} fallo(s)` : '=== COPIA DE SEGURIDAD: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

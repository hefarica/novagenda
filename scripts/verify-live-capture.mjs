/* Verifica captura en vivo con un SpeechRecognition simulado. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3337';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9375;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 20000, label = 'espera') { const start = Date.now(); let last = null; while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(250); } throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`); }
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-live-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-live-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], { env: { ...process.env, APP_SECRET: 'live-e2e-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' }, stdio: 'ignore' });
let chrome = null; let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
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
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    class FakeRecognition {
      constructor() { window.__fakeRec = this; }
      start() { setTimeout(() => { this.onstart?.(); setTimeout(() => { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'Hola equipo, revisemos el acta de liberación.' }], { isFinal: true })] }); }, 40); }, 20); }
      stop() { setTimeout(() => this.onend?.(), 20); }
      abort() { this.onend?.(); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  })();` });
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="docs"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="docs"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-docs')?.classList.contains('active') && Boolean(document.querySelector('#captureLive'))`), 12000, 'documentos');
  await evaluate(`document.querySelector('#captureLive')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#captureLive')?.textContent.includes('Detener captura')`), 8000, 'captura activa');
  check('Inicia la captura en vivo', true);
  await waitFor(async () => evaluate(`document.querySelector('#meetingCaptureForm')?.elements.transcript.value.includes('Hola equipo')`), 8000, 'texto transcrito');
  check('Escribe la transcripción final', true, await evaluate(`document.querySelector('#meetingCaptureForm')?.elements.transcript.value || ''`));
  const status = await evaluate(`document.querySelector('#captureLiveStatus')?.textContent || ''`);
  check('Muestra estado de captura', /Captura en vivo/.test(status), status);
  check('Marca el botón como escuchando', await evaluate(`document.querySelector('#captureLive')?.classList.contains('listening')`));
  check('Usa español por defecto', await evaluate(`window.__fakeRec?.lang === 'es-CO'`), await evaluate(`window.__fakeRec?.lang || ''`));
  await evaluate(`document.querySelector('#captureLive')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#captureLive')?.textContent.includes('Captura en vivo')`), 8000, 'captura detenida');
  await evaluate(`(() => { const s = document.querySelector('#captureLiveLang'); s.value = 'en-US'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await evaluate(`document.querySelector('#captureLive')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#captureLive')?.textContent.includes('Detener captura')`), 8000, 'captura en inglés');
  check('Respeta el idioma elegido', await evaluate(`window.__fakeRec?.lang === 'en-US'`), await evaluate(`window.__fakeRec?.lang || ''`));
  await evaluate(`document.querySelector('[data-nav="agenda"]')?.click()`);
  await waitFor(async () => evaluate(`(async () => { const mod = await import('/js/voice.js'); return mod.isLiveDictationActive() === false; })()`), 8000, 'detenida al navegar');
  const stopped = await evaluate(`document.querySelector('#captureLiveStatus')?.textContent || ''`);
  check('Detiene al salir de Documentos', /salir de Documentos/.test(stopped), stopped);
  await evaluate(`document.querySelector('[data-nav="docs"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#captureLive')?.textContent.includes('Captura en vivo')`), 8000, 'botón restablecido');
  check('Restablece el botón al volver', true);
  check('Sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) { failures += 1; console.error(`FAIL  excepción — ${error.message}`); }
finally { try { ws?.close(); } catch { /* nada */ } try { chrome?.kill(); } catch { /* nada */ } try { app.kill(); } catch { /* nada */ } await sleep(400); try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ } }
console.log(`\n${failures ? `${failures} fallo(s)` : '=== CAPTURA EN VIVO: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3339';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9373;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-record-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-record-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-record-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
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
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.exception?.description || 'excepción');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') pageErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
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
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      class FakeMediaRecorder extends EventTarget {
        constructor(stream, options = {}) {
          super();
          this.stream = stream;
          this.mimeType = options.mimeType || 'audio/webm';
          this.state = 'inactive';
          this._timer = null;
          window.__recorder = this;
        }
        static isTypeSupported(type) { return /webm|ogg/.test(type); }
        _data(size) { const event = new Event('dataavailable'); event.data = new Blob([new Uint8Array(size)], { type: this.mimeType }); this.dispatchEvent(event); }
        start() { this.state = 'recording'; this._timer = setInterval(() => this._data(128), 200); }
        stop() {
          if (this.state !== 'recording') return;
          clearInterval(this._timer);
          this.state = 'inactive';
          this._data(512);
          this.dispatchEvent(new Event('stop'));
        }
      }
      window.MediaRecorder = FakeMediaRecorder;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => { window.__micRequested = true; return { getTracks: () => [{ stop: () => { window.__trackStopped = true; } }] }; } }
      });
      URL.createObjectURL = () => 'blob:fake-audio';
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; };
    })();
  ` });
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="docs"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="docs"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#captureRecord'))`), 12000, 'botón grabar audio');
  check('La captura de reunión ofrece grabar audio', true);

  await evaluate(`document.querySelector('#captureRecord')?.click()`);
  await waitFor(async () => evaluate(`window.__recorder?.state === 'recording'`), 8000, 'grabando');
  const recordingText = await evaluate(`document.querySelector('#captureRecord')?.textContent || ''`);
  const recordingStatus = await evaluate(`document.querySelector('#captureRecordStatus')?.textContent || ''`);
  check('Inicia la grabación local', /Detener y descargar/.test(recordingText) && /No se envía al servidor/.test(recordingStatus), recordingText.trim());
  check('Pide permiso de micrófono', await evaluate(`window.__micRequested === true`));

  await sleep(700);
  await evaluate(`document.querySelector('#captureRecord')?.click()`);
  const downloaded = await waitFor(async () => evaluate(`window.__download || null`), 8000, 'descarga');
  const doneStatus = await evaluate(`document.querySelector('#captureRecordStatus')?.textContent || ''`);
  check('Descarga el audio al detener', /^reunion-.*\.webm$/.test(downloaded?.name || ''), downloaded?.name || '');
  check('Libera el micrófono', await evaluate(`window.__trackStopped === true`));
  check('Reporta audio descargado y tamaño', /Audio descargado/.test(doneStatus) && /KB|MB/.test(doneStatus), doneStatus);
  check('Vuelve al estado inicial', (await evaluate(`document.querySelector('#captureRecord')?.textContent || ''`)).includes('Grabar audio'));
  check('UI de grabación sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== GRABACIÓN DE REUNIÓN: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

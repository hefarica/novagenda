/* Captura la portada en tema claro y oscuro para revisar el nuevo azul. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9353;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-theme-shot-'));
let chrome = null;
let ws = null;

async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

try {
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,960', 'about:blank'
  ], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 20000, 'chrome');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let cdpId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = cdpId += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  mkdirSync('docs/capturas', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('agenda-p95.theme.v1','${theme}')}catch(e){}`
    });
    await cdp('Page.navigate', { url: URL_APP });
    await waitFor(async () => {
      const result = await cdp('Runtime.evaluate', { expression: `document.readyState === 'complete' && document.documentElement.dataset.theme`, returnByValue: true });
      return result.result?.value === theme;
    }, 25000, `tema ${theme}`);
    await sleep(1200);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`docs/capturas/tema-${theme}-azul.png`, Buffer.from(shot.data, 'base64'));
    await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-nav="integrations"]')?.click()` });
    await sleep(1200);
    const integ = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`docs/capturas/tema-${theme}-integraciones.png`, Buffer.from(integ.data, 'base64'));
    console.log(`captura ${theme} OK`);
  }
} finally {
  try { ws?.close(); } catch { /* nada */ }
  try { chrome?.kill(); } catch { /* nada */ }
  await sleep(300);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ }
}


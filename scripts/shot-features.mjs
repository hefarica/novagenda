/* Captura el Laboratorio de funciones (solo lectura) en el navegador. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'agenda-shotfeat-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws;
async function waitFor(fn, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } throw new Error('timeout'); }
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let id = 1; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = id++; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout')); } }, 20000); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:3000' });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await send('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1200);
  await evaluate(`document.querySelector('[data-nav="integrations"]').click()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#featuresBody .feature-row').length > 0`));
  await evaluate(`document.querySelector('#featuresCard').scrollIntoView({ block: 'center' })`);
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('docs/capturas/vista-features-light.png', Buffer.from(shot.data, 'base64'));
  console.log('OK docs/capturas/vista-features-light.png');
} finally {
  try { ws?.close(); } catch {} try { chrome.kill(); } catch {} await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

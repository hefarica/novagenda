/* Captura varias vistas de la app en un tema para revisión visual.
   Uso: node scripts/theme-views.mjs [url] [light|dark]
   Guarda docs/capturas/vista-<clave>-<tema>.png */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3000';
const THEME = process.argv[3] === 'dark' ? 'dark' : 'light';
const OUT = 'docs/capturas';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const VIEWS = ['office', 'docs', 'integrations', 'agenda', 'style', 'routines', 'nudges', 'tasks'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* reintento */ }
    await sleep(250);
  }
  throw new Error('timeout');
}

const profile = mkdtempSync(join(tmpdir(), 'agenda-views-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  mkdirSync(OUT, { recursive: true });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS')), { once: true });
  });

  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = id++;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 25000);
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval');
    return r.result?.value;
  };
  const waitLoad = async () => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000);
      const onMsg = (e) => {
        if (JSON.parse(e.data).method === 'Page.loadEventFired') {
          clearTimeout(timer); ws.removeEventListener('message', onMsg); resolve();
        }
      };
      ws.addEventListener('message', onMsg);
    });
    await sleep(1200);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  await waitLoad();
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1', ${JSON.stringify(THEME)})`);
  await send('Page.reload');
  await waitLoad();
  for (let i = 0; i < 25; i += 1) {
    const ready = await evaluate(`(document.querySelector('#todayLabel')?.textContent || '').indexOf('Cargando') === -1`);
    if (ready) break;
    await sleep(400);
  }

  for (const view of VIEWS) {
    const clicked = await evaluate(`(() => {
      const btn = document.querySelector('[data-nav="${view}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!clicked) { console.log(`SKIP ${view} (sin botón)`); continue; }
    await sleep(1400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(OUT, `vista-${view}-${THEME}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const title = await evaluate(`document.querySelector('#hello')?.textContent || ''`);
    console.log(`OK ${file} (${title})`);
  }
} finally {
  try { ws?.close(); } catch { /* ignorar */ }
  try { chrome.kill(); } catch { /* ignorar */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignorar */ }
}



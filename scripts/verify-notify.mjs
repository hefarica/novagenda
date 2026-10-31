/* E2E de avisos del navegador: permiso, activación, persistencia y consulta del feed.
   Uso: node scripts/verify-notify.mjs http://127.0.0.1:3312 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3312';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function waitFor(fn, timeout = 20000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

const profile = mkdtempSync(join(tmpdir(), 'agenda-notify-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let id = 1; const pending = new Map(); const errors = []; const requests = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text || 'log');
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params?.request?.url || '');
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = id++; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 25000); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  try {
    await send('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'granted', origin: URL_APP });
  } catch { /* algunos builds no exponen el permiso */ }
  await send('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await send('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1200);
  await evaluate(`document.querySelector('[data-nav="nudges"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#nudgeNotifyToggle'))`), 10000, 'toggle');
  check('Existe el interruptor de avisos del navegador', true);

  const before = await evaluate(`document.querySelector('#nudgeNotifyToggle').checked`);
  check('Arranca apagado', before === false);

  await evaluate(`document.querySelector('#nudgeNotifyToggle').click()`);
  const saved = await waitFor(async () => evaluate(`localStorage.getItem('agenda-p95.notify.v1')`), 10000, 'activar');
  check('Se activa y persiste', saved === '1', String(saved));
  const status = await evaluate(`document.querySelector('#nudgeNotifyStatus')?.textContent || ''`);
  check('El estado lo confirma', /activas/i.test(status), status.slice(0, 90));
  await sleep(1500);
  const polled = requests.some((url) => url.includes('/api/nudges/feed'));
  check('Consulta el feed al activarse', polled);

  await evaluate(`document.querySelector('#nudgeNotifyToggle').click()`);
  const off = await waitFor(async () => (await evaluate(`localStorage.getItem('agenda-p95.notify.v1')`)) === null ? 'off' : null, 10000, 'desactivar');
  check('Se puede desactivar', off === 'off');

  const realErrors = errors.filter((e) => !/favicon|manifest|notifications/i.test(e));
  check('Sin errores de consola', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.log('FAIL  excepción —', error?.message || error);
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : failures + ' fallo(s)'}`);
  process.exit(failures ? 1 : 0);
}

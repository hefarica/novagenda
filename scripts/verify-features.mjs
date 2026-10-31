/* E2E del Laboratorio de funciones (UI + API) en una instancia temporal.
   Uso: node scripts/verify-features.mjs http://127.0.0.1:3308 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3308';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}
const apiFeature = async (id) => {
  const data = await (await fetch(`${URL_APP}/api/features`)).json();
  return (data.items || []).find((item) => item.id === id);
};

const profile = mkdtempSync(join(tmpdir(), 'agenda-feat-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  mkdirSync('docs/capturas', { recursive: true });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text || 'log');
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = id++; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 25000); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await send('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1500);
  await evaluate(`document.querySelector('[data-nav="integrations"]').click()`);

  const count = await waitFor(async () => evaluate(`document.querySelectorAll('#featuresBody .feature-row').length`), 20000, 'filas');
  check('El laboratorio lista las 12 funciones', count === 12, `filas=${count}`);
  const summary = await evaluate(`document.querySelector('#featuresState')?.textContent || ''`);
  check('Resumen de estado visible', /apagadas|sombra|activas/.test(summary), summary);

  // Cambiar lingo a sombra desde la UI.
  await evaluate(`(() => {
    const sel = document.querySelector('[data-feature-mode="lingo"]');
    sel.value = 'shadow';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const shadow = await waitFor(async () => { const item = await apiFeature('lingo'); return item && item.mode === 'shadow' ? item : null; }, 15000, 'lingo shadow');
  check('Cambio a sombra persiste en la API', shadow.mode === 'shadow' && shadow.status === 'shadow', `mode=${shadow.mode} status=${shadow.status}`);
  const tag = await waitFor(async () => {
    const text = await evaluate(`document.querySelector('[data-id="lingo"] .tag')?.textContent || ''`);
    return /sombra/i.test(text) ? text : null;
  }, 10000, 'fila sombra');
  check('La fila muestra Sombra', true, tag);

  // Volver a apagada.
  await evaluate(`(() => {
    const sel = document.querySelector('[data-feature-mode="lingo"]');
    sel.value = 'off';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const off = await waitFor(async () => { const item = await apiFeature('lingo'); return item && item.mode === 'off' ? item : null; }, 15000, 'lingo off');
  check('Vuelve a apagada', off.mode === 'off' && off.status === 'off', off.mode);

  // Kill switch de lingo.
  await evaluate(`document.querySelector('[data-feature-pause="lingo"]')?.click()`);
  const paused = await waitFor(async () => { const item = await apiFeature('lingo'); return item && item.paused ? item : null; }, 15000, 'pausa');
  check('Pausar deja la función pausada y apagada', paused.paused === true && paused.status === 'off', `paused=${paused.paused}`);
  const pauseRow = await waitFor(async () => {
    const text = await evaluate(`document.querySelector('[data-feature-pause="lingo"]')?.textContent.trim() || ''`);
    return /reanudar/i.test(text) ? text : null;
  }, 10000, 'boton reanudar');
  check('El botón cambia a Reanudar', true, pauseRow);
  await evaluate(`document.querySelector('[data-feature-pause="lingo"]')?.click()`);
  const resumed = await waitFor(async () => { const item = await apiFeature('lingo'); return item && !item.paused ? item : null; }, 15000, 'reanudar');
  check('Reanudar la reactiva', resumed.paused === false, `paused=${resumed.paused}`);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('docs/capturas/vista-features-light.png', Buffer.from(shot.data, 'base64'));
  const realErrors = errors.filter((e) => !/favicon|manifest/i.test(e));
  check('Sin errores de consola', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : failures + ' fallo(s)'}`);
  process.exit(failures ? 1 : 0);
}


/* E2E: botón «Acta» en una reunión → crea el DOCX y abre Documentos.
   Uso: node scripts/verify-meeting-acta.mjs http://127.0.0.1:3313 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3313';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}
const docs = async () => (await (await fetch(`${URL_APP}/api/docs`)).json()).items || [];

const profile = mkdtempSync(join(tmpdir(), 'agenda-acta-meeting-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  mkdirSync('docs/capturas', { recursive: true });
  // Asegura una reunión (los datos base pueden variar).
  const meetings = (await (await fetch(`${URL_APP}/api/meetings`)).json()).items || [];
  if (!meetings.length) {
    await fetch(`${URL_APP}/api/meetings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Reunión de prueba', cadence: 'SEMANAL', time: '10:00', durationMin: 30, purpose: 'Probar el acta automática', participants: 'Héctor, Ana' })
    });
  }

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
  const send = (method, params = {}) => new Promise((res, rej) => { const n = id++; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 30000); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await send('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1200);
  await evaluate(`document.querySelector('[data-nav="routines"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#view-routines.active'))`), 10000, 'rutinas');
  await evaluate(`document.querySelector('[data-routine-filter="meeting"]')?.click()`);
  const button = await waitFor(async () => evaluate(`Boolean(document.querySelector('#routinesList [data-act="meeting-acta"]'))`), 15000, 'boton acta');
  check('La reunión muestra el botón Acta', button === true);
  const before = (await docs()).length;
  const actasBefore = (await docs()).filter((doc) => doc.template === 'acta').length;
  await evaluate(`document.querySelector('#routinesList [data-act="meeting-acta"]').click()`);
  const created = await waitFor(async () => {
    const actas = (await docs()).filter((doc) => doc.template === 'acta');
    return actas.length > actasBefore ? actas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] : null;
  }, 25000, 'acta');
  check('Se crea el acta en Documentos', Boolean(created?.id), created?.filename);
  check('El acta es de reunión y DOCX', String(created?.filename || '').startsWith('acta-de-reunion') && String(created?.filename || '').endsWith('.docx'), created?.filename);
  check('Documentos aumenta en 1', (await docs()).length === before + 1);
  const docsActive = await waitFor(async () => evaluate(`Boolean(document.querySelector('#view-docs.active'))`), 10000, 'vista docs');
  check('Abre la vista Documentos', docsActive === true);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('docs/capturas/vista-acta-reunion.png', Buffer.from(shot.data, 'base64'));
  const realErrors = errors.filter((e) => !/favicon|manifest/i.test(e));
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


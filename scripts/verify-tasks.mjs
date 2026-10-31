/* E2E de Tareas: crear, editar, cerrar, reabrir, filtrar y borrar desde la UI.
   Uso: node scripts/verify-tasks.mjs http://127.0.0.1:3310 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3310';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}
const tasks = async () => (await (await fetch(`${URL_APP}/api/tasks`)).json()).items || [];
const byTitle = async (title) => (await tasks()).find((task) => task.title === title);

const profile = mkdtempSync(join(tmpdir(), 'agenda-tasks-'));
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
  await sleep(1200);
  await evaluate(`document.querySelector('[data-nav="tasks"]')?.click()`);
  check('La vista Tareas existe y es navegable', await evaluate(`Boolean(document.querySelector('#view-tasks.active') && document.querySelector('#taskList'))`));

  // Crear desde la UI.
  await evaluate(`document.querySelector('#taskNewBtn').click()`);
  await evaluate(`(() => {
    const form = document.querySelector('#taskForm');
    form.querySelector('input[name="title"]').value = 'Llamar a Ana';
    form.querySelector('input[name="due"]').value = '2026-10-30';
    form.requestSubmit();
  })()`);
  const created = await waitFor(async () => byTitle('Llamar a Ana'), 15000, 'crear');
  check('Crear tarea desde la UI', Boolean(created?.id), created?.id);
  const rowCount = await waitFor(async () => evaluate(`document.querySelectorAll('#taskList .task-row').length`), 10000, 'fila');
  check('La tarea aparece en el listado', rowCount >= 1, `filas=${rowCount}`);

  // Editar inline.
  await evaluate(`document.querySelector('#taskList .task-row [data-task-edit]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-edit-title]'))`), 5000, 'editor');
  await evaluate(`(() => {
    const input = document.querySelector('[data-edit-title]');
    input.value = 'Llamar a Ana (actualizada)';
    document.querySelector('[data-task-save]').click();
  })()`);
  const edited = await waitFor(async () => byTitle('Llamar a Ana (actualizada)'), 15000, 'editar');
  check('Editar el título persiste en la API', Boolean(edited?.id), edited?.id);

  // Cerrar y reabrir.
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#taskList .task-row [data-task-close]'))`), 10000, 'boton cerrar');
  await evaluate(`document.querySelector('#taskList .task-row [data-task-close]').click()`);
  const closed = await waitFor(async () => { const t = await byTitle('Llamar a Ana (actualizada)'); return t?.status === 'done' ? t : null; }, 15000, 'cerrar');
  check('Cerrar tarea', closed.status === 'done');
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#taskList .task-row [data-task-reopen]'))`), 10000, 'boton reabrir');
  await evaluate(`document.querySelector('#taskList .task-row [data-task-reopen]').click()`);
  const reopened = await waitFor(async () => { const t = await byTitle('Llamar a Ana (actualizada)'); return t?.status === 'open' ? t : null; }, 15000, 'reabrir');
  check('Reabrir tarea', reopened.status === 'open');

  // Filtro "Hechas" (vacío ahora) y búsqueda.
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-status="done"]'))`), 5000, 'filtro');
  await evaluate(`document.querySelector('[data-status="done"]').click()`);
  await sleep(800);
  const doneRows = await evaluate(`document.querySelectorAll('#taskList .task-row').length`);
  check('Filtro Hechas funciona', doneRows === 0, `filas=${doneRows}`);
  await evaluate(`document.querySelector('[data-status="all"]').click()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#taskList .task-row').length >= 1`), 10000, 'todas');

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('docs/capturas/vista-tareas-light.png', Buffer.from(shot.data, 'base64'));

  // Borrar.
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#taskList .task-row [data-task-delete]'))`), 10000, 'boton borrar');
  await evaluate(`window.confirm = () => true`);
  await evaluate(`document.querySelector('#taskList .task-row [data-task-delete]').click()`);
  await waitFor(async () => (await tasks()).length === 0, 15000, 'borrar');
  check('Eliminar tarea', (await tasks()).length === 0);

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



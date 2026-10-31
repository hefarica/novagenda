import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3347';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9381;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-search-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-search-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-search-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const api = async (method, path, body) => {
    const response = await fetch(`${URL_APP}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await response.json(); } catch { /* sin cuerpo */ }
    return { status: response.status, json };
  };
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const event = await api('POST', '/api/agenda', { title: 'Acta de liberación predio E2E', start: `${day}T14:00:00-05:00`, end: `${day}T15:30:00-05:00`, type: 'Compromiso', priority: 'P1', location: 'Palmira' });
  const task = await api('POST', '/api/tasks', { title: 'Radicar acta de liberación E2E', due: day, priority: 'P1', notes: 'Predio Palmira' });
  const taskId = task.json?.item?.id;
  const routine = await api('POST', '/api/routines', { title: 'Revisión semanal de actas E2E', frequency: 'SEMANAL', rule: 'LUN', time: '16:00', durationMin: 45 });
  const contact = await api('POST', '/api/identity/contacts', { name: 'Andrés Marmolejo', emails: ['andres@example.com', 'a.marmolejo@example.com'], aliases: ['Andrés M.'] });
  check('Crea cita, tarea, rutina y contacto', event.status === 201 && task.status === 201 && routine.status === 201 && contact.status === 200, `${event.status}/${task.status}/${routine.status}/${contact.status}`);
  const peopleSearch = await api('GET', '/api/search?q=Marmolejo');
  const peopleGroup = (peopleSearch.json?.groups || []).find((group) => group.key === 'people');
  const peopleId = peopleGroup?.items?.[0]?.id;
  check('La API busca personas por nombre y correo', Boolean(peopleGroup?.items?.length) && /andres@example\.com/.test(peopleGroup.items[0].subtitle || ''), peopleGroup?.items?.[0]?.title || ('sin persona '+JSON.stringify(peopleSearch.json).slice(0,500)));
  const search = await api('GET', '/api/search?q=acta');
  const groups = search.json?.groups || [];
  const labels = groups.map((group) => group.label).join(', ');
  check('La API agrupa resultados', search.status === 200 && groups.some((group) => group.key === 'agenda') && groups.some((group) => group.key === 'tasks'), labels || 'sin grupos');
  const routineSearch = await api('GET', '/api/search?q=revisi%C3%B3n');
  check('La búsqueda ignora tildes', (routineSearch.json?.groups || []).some((group) => group.key === 'routines'), (routineSearch.json?.total || 0) + ' resultados');

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
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#searchBtn'))`), 25000, 'app');
  await evaluate(`document.querySelector('#searchBtn')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-global-search')?.open)`), 8000, 'buscador abierto');
  check('El botón abre el buscador global', true);
  await evaluate(`(() => { const input = document.querySelector('#globalSearchInput'); input.value = 'acta'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#globalSearchResults .search-result').length >= 2`), 15000, 'resultados');
  const ui = await evaluate(`(() => ({ groups: document.querySelectorAll('#globalSearchResults .search-group').length, first: document.querySelector('#globalSearchResults .search-result')?.textContent || '', hint: document.querySelector('#globalSearchHint')?.textContent || '' }))()`);
  check('La interfaz muestra grupos y resultados', ui.groups >= 2 && /Acta de liberación predio E2E/.test(ui.first), JSON.stringify(ui).slice(0, 220));
  check('El membrete indica el total', /resultado\(s\)/.test(ui.hint), ui.hint);
  await evaluate(`document.querySelector('#globalSearchFilters [data-search-filter="tasks"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#globalSearchResults .search-group').length === 1 && document.querySelector('#globalSearchResults')?.textContent.includes('Radicar acta')`), 8000, 'filtro tareas');
  check('El filtro deja solo la sección elegida', await evaluate(`!document.querySelector('#globalSearchResults')?.textContent.includes('Acta de liberación predio E2E')`));
  await evaluate(`(() => { const input = document.querySelector('#globalSearchInput'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true; })()`);
  check('Flecha abajo enfoca el primer resultado', await evaluate(`Boolean(document.activeElement?.closest?.('.search-result'))`));
  await evaluate(`(() => { const input = document.querySelector('#globalSearchInput'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-tasks')?.classList.contains('active')`), 10000, 'salto a tareas');
  check('Enter abre el resultado enfocado', await evaluate(`!document.querySelector('#dlg-global-search')?.open`));
  await waitFor(async () => evaluate(`document.querySelector('#taskList [data-id="${taskId}"]')?.classList.contains('search-hit')`), 10000, 'resultado resaltado');
  check('El ítem exacto queda resaltado', await evaluate(`document.querySelector('#taskList [data-id="${taskId}"]')?.classList.contains('search-hit') === true`));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-global-search')?.open)`), 8000, 'Ctrl K');
  check('Ctrl K abre el buscador', true);
  await evaluate(`(() => { const input = document.querySelector('#globalSearchInput'); input.value = 'Marmolejo'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelector('#globalSearchResults')?.textContent.includes('Andrés Marmolejo')`), 15000, 'persona en búsqueda');
  await evaluate(`document.querySelector('#globalSearchFilters [data-search-filter="people"]')?.click()`);
  check('El filtro Personas muestra el contacto', await evaluate(`document.querySelector('#globalSearchResults')?.textContent.includes('andres@example.com')`));
  await evaluate(`document.querySelector('#globalSearchResults .search-result')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-identity')?.classList.contains('active')`), 10000, 'salto a identidades');
  await waitFor(async () => evaluate(`document.querySelector('#identityPeople [data-id="${peopleId}"]')?.classList.contains('search-hit')`), 10000, 'persona resaltada');
  check('La persona queda resaltada en Identidades', true);
  check('UI de búsqueda sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== BÚSQUEDA GLOBAL: PASS ==='}`);
process.exitCode = failures ? 1 : 0;




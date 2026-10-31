/* Verifica Salas: API, conflicto, alta, reserva, cancelación y borrado desde la UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3329';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9363;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-rooms-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-rooms-chrome-'));
const APP_SECRET = 'rooms-e2e-secret-fijo-0123456789';
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: {
    ...process.env, APP_SECRET, DATA_DIR: dataDir, PORT: port, NO_OPEN: '1',
    WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off'
  },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const api = async (method, path, body) => {
    const response = await fetch(`${URL_APP}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* sin cuerpo */ }
    return { status: response.status, json };
  };
  const day = new Date().toISOString().slice(0, 10);
  const seeded = await api('POST', '/api/rooms', { name: 'Sala API', location: 'Sede sur', capacity: 6 });
  const roomId = seeded.json?.item?.id;
  check('Crea sala por API', seeded.status === 201 && roomId === 'RM-0001', roomId);
  const reserved = await api('POST', `/api/rooms/${roomId}/reservations`, { title: 'Reunión API', date: day, start: '09:00', end: '10:00' });
  check('Reserva por API', reserved.status === 201 && reserved.json?.item?.status === 'active');
  const conflict = await api('POST', `/api/rooms/${roomId}/reservations`, { title: 'Choque', date: day, start: '09:30', end: '10:30' });
  check('API rechaza cruce', conflict.status === 409 && conflict.json?.code === 'ROOM_CONFLICT');
  const availability = await api('GET', `/api/rooms/availability?date=${day}`);
  check('Disponibilidad calculada', availability.json?.total === 1 && availability.json?.free === 0, `${availability.json?.free}/${availability.json?.total}`);

  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });
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
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.exception?.description || 'excepción');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      pageErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
    }
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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="rooms"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="rooms"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-rooms')?.classList.contains('active') && document.querySelectorAll('#roomsList .card').length >= 1`), 10000, 'vista salas');
  check('Salas abre y lista la sala API', true);

  await evaluate(`(() => {
    const form = document.querySelector('#roomForm');
    form.elements.name.value = 'Sala E2E';
    form.elements.location.value = 'Piso 2';
    form.elements.capacity.value = '10';
    form.elements.notes.value = 'Proyector';
    form.requestSubmit();
    return true;
  })()`);
  const uiRoom = await waitFor(async () => {
    const result = await api('GET', `/api/rooms?date=${day}`);
    return (result.json?.items || []).find((room) => room.name === 'Sala E2E') || null;
  }, 12000, 'sala UI');
  check('Crea sala desde la UI', !!uiRoom, uiRoom?.id);
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#roomsList .card')].some((node) => node.textContent.includes('Sala E2E') && node.querySelector('[data-room-action="edit-room"]')) && document.querySelector('#roomCreate')?.textContent.includes('Crear sala') && !document.querySelector('#roomCreate')?.disabled`), 10000, 'sala lista para editar');
  await evaluate(`[...document.querySelectorAll('#roomsList .card')].find((node) => node.textContent.includes('Sala E2E'))?.querySelector('[data-room-action="edit-room"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#roomForm')?.elements.name.value === 'Sala E2E'`), 8000, 'form sala');
  await evaluate(`(() => { const f = document.querySelector('#roomForm'); f.elements.name.value = 'Sala E2E editada'; f.elements.capacity.value = '12'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/rooms?date=${day}`);
    return (result.json?.items || []).some((room) => room.id === uiRoom.id && room.name === 'Sala E2E editada' && room.capacity === 12);
  }, 12000, 'sala editada');
  check('Edita la sala desde la UI', true);
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#roomsSelect option')].some((option) => option.value === '${uiRoom.id}')`), 10000, 'sala en selector');

  await evaluate(`(() => {
    const form = document.querySelector('#reservationForm');
    form.elements.room.value = '${uiRoom.id}';
    form.elements.title.value = 'Reunión E2E';
    form.elements.date.value = '${day}';
    form.elements.start.value = '14:00';
    form.elements.end.value = '15:00';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#roomsList .room-res')].some((row) => row.textContent.includes('Reunión E2E'))`), 12000, 'reserva UI');
  const reservationText = await evaluate(`[...document.querySelectorAll('#roomsList .room-res')].find((row) => row.textContent.includes('Reunión E2E'))?.textContent || ''`);
  check('Reserva desde la UI', /14:00/.test(reservationText) && /15:00/.test(reservationText), reservationText.replace(/\s+/g, ' ').trim().slice(0, 100));
  await evaluate(`[...document.querySelectorAll('#roomsList .room-res')].find((row) => row.textContent.includes('Reunión E2E'))?.querySelector('[data-room-action="edit-reservation"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#reservationForm')?.elements.title.value === 'Reunión E2E'`), 8000, 'form reserva');
  await evaluate(`(() => { const f = document.querySelector('#reservationForm'); f.elements.title.value = 'Reunión E2E (editada)'; f.elements.start.value = '14:30'; f.elements.end.value = '15:30'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#roomsList .room-res')].some((row) => row.textContent.includes('(editada)') && row.textContent.includes('14:30'))`), 12000, 'reserva editada');
  check('Edita la reserva desde la UI', true);
  await evaluate(`[...document.querySelectorAll('#roomsList .room-res')].find((row) => row.textContent.includes('Reunión E2E'))?.querySelector('[data-room-action="agenda-reservation"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-event')?.open)`), 8000, 'diálogo de agenda');
  const preset = await evaluate(`(() => { const f = document.querySelector('#eventForm'); return { title: f?.elements.title.value || '', start: f?.elements.start.value || '', location: f?.elements.location?.value || '', notes: f?.elements.notes?.value || '' }; })()`);
  check('Reserva abre cita prellenada', /Reunión E2E/.test(preset.title) && preset.start.includes('T14:30') && preset.notes.includes('Reserva'), JSON.stringify(preset).slice(0, 160));
  await evaluate(`document.querySelector('#dlg-event')?.close()`);

  await evaluate(`document.querySelector('#roomsList')?.scrollIntoView({ block: 'start' })`);
  await evaluate(`window.scrollBy(0, -80)`);
  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-salas-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#roomsList .room-res')].find((node) => node.textContent.includes('Reunión E2E'));
    row?.querySelector('[data-room-action="cancel-reservation"]')?.click();
    return true;
  })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar cancelación');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/rooms?date=${day}`);
    return !(result.json?.items || []).some((room) => (room.reservations || []).some((item) => item.title === 'Reunión E2E (editada)'));
  }, 12000, 'cancelada UI');
  check('Cancela la reserva desde la UI', true);

  await evaluate(`(() => {
    const card = [...document.querySelectorAll('#roomsList .card')].find((node) => node.textContent.includes('Sala E2E'));
    card?.querySelector('[data-room-action="delete-room"]')?.click();
    return true;
  })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar borrado');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/rooms?date=${day}`);
    return !(result.json?.items || []).some((room) => room.id === uiRoom.id);
  }, 12000, 'sala borrada UI');
  check('Borra la sala desde la UI', true);
  check('UI de salas sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== SALAS: PASS ==='}`);
process.exitCode = failures ? 1 : 0;



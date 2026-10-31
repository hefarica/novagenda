/* Verifica Objetivos (OKR): API, avance, estados y UI real. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3327';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9361;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-okr-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-okr-chrome-'));
const APP_SECRET = 'okr-e2e-secret-fijo-0123456789';
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

  const created = await api('POST', '/api/okr/objectives', { title: 'Cerrar actas 2026', owner: 'Héctor', quarter: '2026-Q4' });
  const objectiveId = created.json?.item?.id;
  check('Crea objetivo con trimestre', created.status === 201 && objectiveId === 'OK-0001' && created.json?.item?.quarter === '2026-Q4', JSON.stringify(created.json?.item || {}).slice(0, 120));
  const kr1 = await api('POST', `/api/okr/objectives/${objectiveId}/key-results`, { title: 'Actas firmadas', target: 3, current: 1, unit: 'actas' });
  check('Añade resultado clave', kr1.status === 201 && kr1.json?.item?.progress === 33, JSON.stringify(kr1.json?.item || {}).slice(0, 120));
  const kr2 = await api('POST', `/api/okr/objectives/${objectiveId}/key-results`, { title: 'Predios liberados', target: 2, current: 2 });
  check('Calcula el avance conjunto', kr2.json?.item?.progress === 67, `${kr2.json?.item?.progress}%`);
  const stats = await api('GET', '/api/okr/stats');
  check('Estadísticas del objetivo', stats.json?.total === 1 && stats.json?.averageProgress === 67 && stats.json?.active === 1, JSON.stringify(stats.json).slice(0, 120));
  const updated = await api('PATCH', `/api/okr/objectives/${objectiveId}/key-results/KR-0001`, { current: 2 });
  check('Actualiza avance y recalcula', updated.json?.item?.progress === 83, `${updated.json?.item?.progress}%`);
  const done = await api('PATCH', `/api/okr/objectives/${objectiveId}`, { status: 'done' });
  check('Marca el objetivo como cumplido', done.json?.item?.status === 'done');
  const bad = await api('POST', `/api/okr/objectives/${objectiveId}/key-results`, { title: 'Malo', target: 0 });
  check('Rechaza meta inválida', bad.status === 400);

  /* ------------------------------- UI real ------------------------------- */
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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="okr"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="okr"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-okr')?.classList.contains('active') && document.querySelectorAll('#okrList .card').length >= 1`), 10000, 'vista objetivos');
  check('Objetivos abre desde el menú', true);

  await evaluate(`(() => {
    const form = document.querySelector('#okrForm');
    form.elements.title.value = 'Abrir la oficina de Palmira';
    form.elements.owner.value = 'Héctor';
    form.elements.quarter.value = '2026-Q4';
    form.requestSubmit();
    return true;
  })()`);
  const uiObjective = await waitFor(async () => {
    const result = await api('GET', '/api/okr/objectives?q=Palmira');
    return result.json?.items?.[0] || null;
  }, 12000, 'objetivo UI');
  check('Crea objetivo desde la UI', !!uiObjective, uiObjective?.id);
  await waitFor(async () => evaluate(`[...document.querySelectorAll('#okrObjectiveSelect option')].some((option) => option.value === '${uiObjective.id}')`), 10000, 'objetivo en el selector');

  await evaluate(`(() => {
    const form = document.querySelector('#okrKrForm');
    form.elements.objective.value = '${uiObjective.id}';
    form.elements.title.value = 'Visitas realizadas';
    form.elements.target.value = '4';
    form.elements.current.value = '1';
    form.elements.unit.value = 'visitas';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/okr/objectives/${uiObjective.id}`);
    return (result.json?.item?.keyResults || []).some((kr) => kr.title === 'Visitas realizadas');
  }, 12000, 'KR UI');
  check('Añade resultado desde la UI', true);

  await waitFor(async () => evaluate(`(() => { const card = [...document.querySelectorAll('#okrList .card')].find((node) => node.textContent.includes('Abrir la oficina de Palmira')); return Boolean(card?.querySelector('.okr-kr [data-okr-current]')); })()`), 12000, 'fila KR del objetivo');
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('#okrList .card')].find((node) => node.textContent.includes('Abrir la oficina de Palmira'));
    const input = card?.querySelector('.okr-kr [data-okr-current]');
    input.value = '3';
    input.closest('.okr-kr').querySelector('[data-okr-action="save-kr"]')?.click();
    return true;
  })()`);
  const advanced = await waitFor(async () => {
    const result = await api('GET', `/api/okr/objectives/${uiObjective.id}`);
    return result.json?.item?.keyResults?.[0]?.current === 3 ? result.json.item : null;
  }, 12000, 'avance UI');
  check('Actualiza avance desde la UI', advanced?.progress === 75, `${advanced?.progress}%`);

  await evaluate(`document.querySelector('#okrList')?.scrollIntoView({ block: 'start' })`);
  await evaluate(`window.scrollBy(0, -70)`);
  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-objetivos-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`[...document.querySelectorAll('#okrList .card')].find((card) => card.textContent.includes('Abrir la oficina de Palmira'))?.querySelector('[data-okr-action="status"][data-okr-status="done"]')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/okr/objectives/${uiObjective.id}`);
    return result.json?.item?.status === 'done';
  }, 12000, 'completar UI');
  check('Completa el objetivo desde la UI', true);
  await evaluate(`[...document.querySelectorAll('#okrList .card')].find((card) => card.textContent.includes('Abrir la oficina de Palmira'))?.querySelector('[data-okr-action="edit-objective"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'editar objetivo');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Abrir la oficina de Palmira (editada)'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/okr/objectives/${uiObjective.id}`);
    return result.json?.item?.title === 'Abrir la oficina de Palmira (editada)';
  }, 12000, 'título objetivo editado');
  check('Edita el objetivo desde la UI', true);

  await evaluate(`[...document.querySelectorAll('#okrList .card')].find((card) => card.textContent.includes('Abrir la oficina de Palmira (editada)'))?.querySelector('[data-okr-action="edit-kr"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open)`), 8000, 'editar resultado');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = 'Cerrar contratos de arriendo'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt')?.open) && document.querySelector('#promptForm')?.elements.value.value !== ''`), 8000, 'meta resultado');
  await evaluate(`(() => { const f = document.querySelector('#promptForm'); f.elements.value.value = '10'; f.requestSubmit(); return true; })()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/okr/objectives/${uiObjective.id}`);
    const kr = result.json?.item?.keyResults?.[0];
    return kr?.title === 'Cerrar contratos de arriendo' && Number(kr?.target) === 10;
  }, 12000, 'resultado editado');
  check('Edita el resultado clave desde la UI', true);
  check('UI de objetivos sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== OKR: PASS ==='}`);
process.exitCode = failures ? 1 : 0;





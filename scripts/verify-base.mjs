/* Verifica la Base de tablas: API tipada y UI real (crear, editar, borrar).
   Uso: node scripts/verify-base.mjs [http://127.0.0.1:3320] */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3320';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9354;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-base-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-base-chrome-'));
const APP_SECRET = 'base-e2e-secret-fijo-0123456789';
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

  const created = await api('POST', '/api/base/tables', {
    name: 'Predios',
    columns: 'Predio:texto, Área:número, Fecha:fecha, Pagado:casilla'
  });
  const table = created.json?.item;
  check('Crea tabla tipada por API (201)', created.status === 201 && table?.id === 'TB-0001' && table.columns.length === 4, JSON.stringify(created.json).slice(0, 140));
  const cols = Object.fromEntries((table?.columns || []).map((column) => [column.name, column.id]));
  const row = await api('POST', '/api/base/tables/TB-0001/rows', {
    values: { [cols.Predio]: 'La Esperanza', [cols['Área']]: '1200.5', [cols.Fecha]: '2026-11-05', [cols.Pagado]: true }
  });
  check('Añade fila con tipos', row.status === 201 && row.json?.item?.values[cols['Área']] === 1200.5 && row.json?.item?.values[cols.Pagado] === true, JSON.stringify(row.json).slice(0, 140));
  const badNumber = await api('POST', '/api/base/tables/TB-0001/rows', { values: { [cols['Área']]: 'mucho' } });
  check('Rechaza número inválido (400)', badNumber.status === 400, JSON.stringify(badNumber.json).slice(0, 100));

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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate');
    return result.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="base"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="base"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-base')?.classList.contains('active') && Boolean(document.querySelector('#baseTableForm'))`), 10000, 'vista base');
  check('La Base abre desde el menú', true);

  await evaluate(`(() => {
    const form = document.querySelector('#baseTableForm');
    form.elements.name.value = 'Contactos';
    form.elements.columns.value = 'Nombre:texto, Correo:texto';
    form.requestSubmit();
    return true;
  })()`);
  const uiTable = await waitFor(async () => {
    const result = await api('GET', '/api/base/tables');
    return (result.json?.items || []).find((item) => item.name === 'Contactos') || null;
  }, 12000, 'tabla desde la UI');
  check('Crea una tabla desde la UI', !!uiTable, JSON.stringify(uiTable || {}).slice(0, 120));

  await waitFor(async () => evaluate(`document.querySelector('#baseTableTitle')?.textContent === 'Contactos'`), 10000, 'tabla seleccionada');
  await evaluate(`(() => {
    const form = document.querySelector('#baseRowForm');
    form.elements['col_c1'].value = 'Catastro';
    form.elements['col_c2'].value = 'notificaciones@catastro.test';
    form.requestSubmit();
    return true;
  })()`);
  const uiRow = await waitFor(async () => {
    const result = await api('GET', `/api/base/tables/${uiTable.id}`);
    return result.json?.item?.rows?.[0] || null;
  }, 12000, 'fila desde la UI');
  check('Añade una fila desde la UI', uiRow?.values?.c1 === 'Catastro' && uiRow?.values?.c2 === 'notificaciones@catastro.test', JSON.stringify(uiRow || {}).slice(0, 120));

  await evaluate(`document.querySelector('#baseRows [data-base-duplicate-row]')?.click()`);
  const duplicated = await waitFor(async () => {
    const result = await api('GET', `/api/base/tables/${uiTable.id}`);
    return (result.json?.item?.rows || []).length === 2 ? result.json.item.rows[1] : null;
  }, 12000, 'duplicar fila UI');
  check('Duplica una fila desde la UI', duplicated?.values?.c1 === 'Catastro' && duplicated?.id !== uiRow?.id, JSON.stringify(duplicated || {}).slice(0, 120));

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-base-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`document.querySelector('#baseRows [data-base-edit-row]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#baseRowSave')?.textContent.includes('Guardar')`), 8000, 'modo edición');
  await evaluate(`(() => { const input = document.querySelector('#baseRowForm [name="col_c1"]'); input.value = 'Catastro · oficina'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#baseRowForm').requestSubmit(); return true; })()`);
  const edited = await waitFor(async () => {
    const result = await api('GET', `/api/base/tables/${uiTable.id}`);
    return result.json?.item?.rows?.[0]?.values?.c1 === 'Catastro · oficina' ? result.json.item.rows[0] : null;
  }, 12000, 'edición UI');
  check('Edita una fila desde la UI', !!edited);

  await evaluate(`document.querySelector('#baseRows [data-base-delete-row]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar fila');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/base/tables/${uiTable.id}`);
    return (result.json?.item?.rows || []).length === 1;
  }, 12000, 'borrar primera fila UI');
  await evaluate(`document.querySelector('#baseRows [data-base-delete-row]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar última fila');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', `/api/base/tables/${uiTable.id}`);
    return (result.json?.item?.rows || []).length === 0;
  }, 12000, 'borrar última fila UI');
  check('Borra una fila desde la UI', true);

  await evaluate(`document.querySelector('#baseDeleteTable')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar tabla');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/base/tables');
    return !(result.json?.items || []).some((item) => item.id === uiTable.id);
  }, 12000, 'borrar tabla UI');
  check('Borra la tabla desde la UI', true);
  const left = await api('GET', '/api/base/tables');
  check('Queda la tabla inicial', left.json?.items?.length === 1 && left.json.items[0].name === 'Predios');
  check('UI Base sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== BASE: PASS ==='}`);
process.exitCode = failures ? 1 : 0;



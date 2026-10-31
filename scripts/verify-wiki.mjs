/* Verifica la Wiki interna: API (CRUD + búsqueda + validación) y UI real.
   Uso: node scripts/verify-wiki.mjs [http://127.0.0.1:3319] */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3319';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9351;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-wiki-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-wiki-chrome-'));
const APP_SECRET = 'wiki-e2e-secret-fijo-0123456789';
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

  const created = await api('POST', '/api/wiki/pages', {
    title: 'Acta de liberación de predio',
    body: 'Revisar linderos, escritura y paz y salvo antes de firmar.',
    tags: 'predios, actas'
  });
  check('Crea página por API (201)', created.status === 201 && created.json?.item?.id === 'WK-0001', JSON.stringify(created.json).slice(0, 120));
  const searched = await api('GET', '/api/wiki/pages?q=linderos');
  check('Busca por contenido sin cargar el cuerpo', searched.json?.total === 1 && !('body' in (searched.json?.items?.[0] || {})), JSON.stringify(searched.json).slice(0, 120));
  const listed = await api('GET', '/api/wiki/pages?tag=predios');
  check('Filtra por etiqueta', listed.json?.total === 1);
  const patched = await api('PATCH', '/api/wiki/pages/WK-0001', {
    title: 'Acta de liberación (procedimiento)',
    body: 'Paso 1: verificar matrícula.\nPaso 2: revisar linderos.'
  });
  check('Edita título y cuerpo', patched.status === 200 && /Paso 1/.test(patched.json?.item?.body || ''));
  const detail = await api('GET', '/api/wiki/pages/WK-0001');
  check('La lectura devuelve el cuerpo completo', /Paso 2/.test(detail.json?.item?.body || ''));
  const invalid = await api('POST', '/api/wiki/pages', { title: '  ', body: 'x' });
  check('Rechaza título vacío (400)', invalid.status === 400, JSON.stringify(invalid.json).slice(0, 100));

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="wiki"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="wiki"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-wiki')?.classList.contains('active') && Boolean(document.querySelector('#wikiForm'))`), 10000, 'vista wiki');
  check('La Wiki abre desde el menú', true);

  await evaluate(`(() => {
    const form = document.querySelector('#wikiForm');
    form.elements.title.value = 'Contactos de Catastro';
    form.elements.tags.value = 'contactos, catastro';
    form.elements.body.value = 'Correo: notificaciones@catastro.test';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/wiki/pages?q=Catastro');
    return result.json?.total >= 1;
  }, 12000, 'página creada desde la UI');
  check('Crea una página desde la UI', true);

  await evaluate(`(() => { const input = document.querySelector('#wikiSearch'); input.value = 'Catastro'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(async () => evaluate(`(document.querySelector('#wikiList')?.textContent || '').includes('Contactos de Catastro')`), 10000, 'búsqueda UI');
  await evaluate(`document.querySelector('#wikiList [data-wiki-id]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#wikiForm')?.elements?.body?.value.includes('catastro.test')`), 10000, 'detalle UI');

  await evaluate(`(() => {
    const form = document.querySelector('#wikiForm');
    form.elements.body.value += '\\nHorario: 8:00 a 16:00.';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/wiki/pages?q=Horario');
    return result.json?.total >= 1;
  }, 12000, 'edición UI');
  check('Edita una página desde la UI', true);

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-wiki-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`document.querySelector('#wikiDelete')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar borrado');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/wiki/pages?q=Catastro');
    return result.json?.total === 0;
  }, 12000, 'borrado UI');
  check('Borra una página desde la UI', true);
  const finalList = await api('GET', '/api/wiki/pages');
  check('Queda solo la página inicial', finalList.json?.total === 1);
  check('UI Wiki sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== WIKI: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

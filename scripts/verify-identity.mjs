/* Verifica Identidades: unir multicorreo, expandir destinatarios y UI. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3324';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9358;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-identity-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-identity-chrome-'));
const APP_SECRET = 'identity-e2e-secret-fijo-0123456789';
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

  const first = await api('POST', '/api/identity/contacts', {
    name: 'Andrés M.', emails: ['andres@empresa.test', 'andres@gmail.test'], aliases: ['Andrés'], note: 'Solicitante'
  });
  check('Crea persona con dos correos', first.status === 200 && first.json?.contact?.emails?.length === 2, JSON.stringify(first.json?.contact || {}).slice(0, 120));
  const second = await api('POST', '/api/identity/contacts', {
    name: 'Andrés P.', emails: ['andres.p@empresa.test', 'andres.p@gmail.test'], aliases: ['Andrés P.']
  });
  check('Crea segunda persona', second.status === 200 && second.json?.total === 2, `total ${second.json?.total}`);

  const ambiguous = await api('POST', '/api/identity/expand', { query: 'Andrés' });
  check('Expande dos personas a cuatro correos', ambiguous.json?.recipients?.length === 4 && ambiguous.json?.people?.length === 2, JSON.stringify(ambiguous.json?.recipients || []));
  check('Marca la ambigüedad para confirmar', ambiguous.json?.requiresConfirmation === true);

  const one = await api('POST', '/api/identity/expand', { query: 'andres@empresa.test' });
  check('Resuelve por correo exacto a sus direcciones', one.json?.recipients?.length === 2 && one.json.recipients.every((email) => /^andres/.test(email)), JSON.stringify(one.json?.recipients || []));


  const invalid = await api('POST', '/api/identity/contacts', { name: 'Malo', emails: ['no-es-correo'] });
  check('Rechaza correo inválido (400)', invalid.status === 400, JSON.stringify(invalid.json).slice(0, 90));

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="identity"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="identity"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-identity')?.classList.contains('active') && document.querySelectorAll('#identityPeople .doc-row').length >= 2`), 10000, 'vista identidades');
  check('Identidades abre desde el menú', true);

  await evaluate(`(() => {
    const form = document.querySelector('#identityForm');
    form.elements.name.value = 'Catastro';
    form.elements.emails.value = 'notificaciones@catastro.test, juridica@catastro.test';
    form.elements.aliases.value = 'Oficina de Catastro';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/identity/people?q=Catastro');
    return result.json?.items?.some((person) => person.name === 'Catastro' && person.emails.length === 2);
  }, 12000, 'persona UI');
  check('Crea persona desde la UI', true);

  await evaluate(`(() => {
    const form = document.querySelector('#identityExpandForm');
    form.elements.query.value = 'Andrés';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => evaluate(`document.querySelector('#identityExpandResult')?.textContent.includes('4 destinatario')`), 12000, 'expansión 4');
  const expandText = await evaluate(`document.querySelector('#identityExpandResult')?.textContent || ''`);
  check('Prueba cuatro destinatarios en la UI', /4\s*destinatario/.test(expandText) && expandText.includes('andres.p@gmail.test'), expandText.slice(0, 140));
  check('Avisa de ambigüedad', /ambigüedad|confirma/i.test(expandText));

  await evaluate(`(() => { const input = document.querySelector('#identitySearch'); input.value = 'Catastro'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#identityPeople .doc-row').length === 1 && document.querySelector('#identityPeople')?.textContent.includes('Catastro')`), 10000, 'filtro UI');
  check('Filtra personas por búsqueda', true);

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-identidades-light.png', Buffer.from(shot.data, 'base64'));
  const merged = await api('POST', '/api/identity/contacts', {
    name: 'Andrés M.', emails: ['andres@empresa.test', 'andres.m@personal.test'], aliases: ['Andresito']
  });
  check('Fusiona sin duplicar la persona', merged.status === 200 && merged.json?.total === 3 && merged.json?.contact?.emails?.length === 3, JSON.stringify(merged.json?.contact?.emails || []));
  check('UI Identidades sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== IDENTIDADES: PASS ==='}`);
process.exitCode = failures ? 1 : 0;







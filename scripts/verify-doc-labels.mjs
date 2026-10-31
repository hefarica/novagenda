/* Verifica etiquetas de seguridad en Documentos: reservado bloquea correo directo. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3328';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9362;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-acl-docs-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-acl-docs-chrome-'));
const APP_SECRET = 'acl-docs-e2e-secret-fijo-0123456789';
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
  const created = await api('POST', '/api/docs', {
    type: 'docx',
    title: 'Acta reservada E2E',
    sections: [{ heading: 'Acuerdo', paragraphs: ['Contenido reservado de prueba.'] }]
  });
  const docId = created.json?.item?.id || created.json?.id;
  check('Crea un documento', created.status === 201 && !!docId, `${docId}`);

  const initial = await api('GET', `/api/acl/documents/${docId}`);
  check('El documento nace interno', initial.json?.item?.effectiveLabel === 'interno', initial.json?.item?.effectiveLabel);
  const reserved = await api('PUT', `/api/acl/documents/${docId}`, { label: 'reservado', by: 'owner' });
  check('Marca el documento como reservado', reserved.status === 200 && reserved.json?.item?.label === 'reservado');
  const list = await api('GET', '/api/acl/documents?limit=10');
  check('La ACL lista la etiqueta', (list.json?.items || []).some((row) => row.docId === docId && row.label === 'reservado'));

  const blocked = await api('POST', '/api/channels/send-document', {
    docId, channel: 'simulator', to: 'cliente@example.com', caption: 'Acta'
  });
  check('Salida de reservado se bloquea', blocked.status === 403 && blocked.json?.code === 'ACL_DENIED', blocked.json?.code || blocked.status);

  await api('PUT', `/api/acl/documents/${docId}`, { label: 'público', by: 'owner' });
  const allowed = await api('POST', '/api/channels/send-document', {
    docId, channel: 'simulator', to: 'cliente@example.com', caption: 'Acta'
  });
  check('Público ya no se bloquea por ACL', allowed.status !== 403, `${allowed.status} ${allowed.json?.code || ''}`);

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="docs"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="docs"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-docs')?.classList.contains('active') && [...document.querySelectorAll('#docsList .doc-row')].some((row) => row.textContent.includes('Acta reservada E2E'))`), 12000, 'documento en lista');
  const label = await evaluate(`[...document.querySelectorAll('#docsList .doc-row')].find((row) => row.textContent.includes('Acta reservada E2E'))?.querySelector('[data-doc-label]')?.value || ''`);
  check('La UI muestra la clasificación actual', label === 'público', label);

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#docsList .doc-row')].find((node) => node.textContent.includes('Acta reservada E2E'));
    const select = row?.querySelector('[data-doc-label]');
    select.value = 'reservado';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(async () => {
    const rowTag = await evaluate(`[...document.querySelectorAll('#docsList .doc-row')].find((row) => row.textContent.includes('Acta reservada E2E'))?.querySelector('.doc-label-line .tag')?.textContent || ''`);
    const record = await api('GET', `/api/acl/documents/${docId}`);
    return rowTag.trim() === 'reservado' && record.json?.item?.label === 'reservado';
  }, 10000, 'etiqueta reservado UI');
  check('Cambia la clasificación desde la UI', true);

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#docsList .doc-row')].find((node) => node.textContent.includes('Acta reservada E2E'));
    row.querySelector('[data-doc-act="send"]')?.click();
    return true;
  })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-send-doc[open]'))`), 8000, 'diálogo de envío');
  const warning = await evaluate(`document.querySelector('#sendDocAlert')?.textContent || ''`);
  check('Avisa del bloqueo de reservado', /reservado/i.test(warning) && /N3|Oficina/i.test(warning), warning.slice(0, 140));

  await evaluate(`document.querySelector('#dlg-send-doc')?.close()`);
  await sleep(250);
  mkdirSync('docs/capturas', { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-documentos-etiquetas-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de etiquetas sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== ETIQUETAS DE DOCUMENTOS: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


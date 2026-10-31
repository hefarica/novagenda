/* Verifica Léxico (Lingo): API de términos y UI real (crear, aprobar, probar, rechazar). */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3321';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9355;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-lingo-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-lingo-chrome-'));
const APP_SECRET = 'lingo-e2e-secret-fijo-0123456789';
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

  const created = await api('POST', '/api/lingo/terms', {
    term: 'Héctor Fabio Riascos C.', variants: ['Hector Fabio', 'Héctor F.'], context: 'clientes'
  });
  check('Crea término en sombra (201)', created.status === 201 && created.json?.item?.status === 'shadow' && created.json?.item?.id === 'LG-0001', JSON.stringify(created.json).slice(0, 160));
  const shadowApply = await api('POST', '/api/lingo/apply', { text: 'Hector Fabio confirmó la reunión' });
  check('Sombra no se aplica por defecto', shadowApply.json?.changed === false && shadowApply.json?.text === 'Hector Fabio confirmó la reunión', JSON.stringify(shadowApply.json).slice(0, 120));
  const shadowApplyOn = await api('POST', '/api/lingo/apply', { text: 'Hector Fabio confirmó la reunión', includeShadow: true });
  check('Sombra se aplica al probar', shadowApplyOn.json?.changed === true && shadowApplyOn.json?.text.includes('Héctor Fabio Riascos C.'), shadowApplyOn.json?.text);
  const approved = await api('PATCH', '/api/lingo/terms/LG-0001', { status: 'approved' });
  check('Aprueba el término', approved.status === 200 && approved.json?.item?.status === 'approved', JSON.stringify(approved.json).slice(0, 100));
  const approvedApply = await api('POST', '/api/lingo/apply', { text: 'Héctor F. llegó a Palmira' });
  check('Aprobado se aplica por defecto', approvedApply.json?.changed === true && approvedApply.json?.text.includes('Héctor Fabio Riascos C.'), approvedApply.json?.text);
  const second = await api('POST', '/api/lingo/terms', { term: 'Palmira', variants: ['Palmitra'], context: 'ciudades' });
  check('Crea segundo término', second.status === 201 && second.json?.item?.id === 'LG-0002', JSON.stringify(second.json).slice(0, 100));

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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="lingo"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="lingo"]')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-lingo')?.classList.contains('active') && document.querySelectorAll('#lingoTerms [data-lingo-id]').length >= 2`), 10000, 'vista léxico');
  check('El Léxico abre desde el menú', true);

  await evaluate(`(() => {
    const form = document.querySelector('#lingoForm');
    form.elements.term.value = 'Catastro';
    form.elements.variants.value = 'Catrastro';
    form.elements.context.value = 'entidades';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/lingo/terms?q=Catastro');
    return result.json?.items?.some((item) => item.term === 'Catastro' && item.status === 'shadow');
  }, 12000, 'término desde la UI');
  check('Crea un término desde la UI', true);
  await waitFor(async () => evaluate(`(() => {
    const rows = [...document.querySelectorAll('#lingoTerms .doc-row')];
    const row = rows.find((item) => item.textContent.includes('Catastro'));
    return Boolean(row?.querySelector('[data-lingo-status="approved"]'));
  })()`), 12000, 'fila Catastro en la UI');

  const clickedApprove = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#lingoTerms .doc-row')];
    const row = rows.find((item) => item.textContent.includes('Catastro'));
    const button = row?.querySelector('[data-lingo-status="approved"]');
    button?.click();
    return Boolean(button);
  })()`);
  check('Botón Aprobar presente en la fila', clickedApprove === true);
  await waitFor(async () => {
    const result = await api('GET', '/api/lingo/terms?q=Catastro');
    return result.json?.items?.[0]?.status === 'approved';
  }, 12000, 'aprobar desde UI');
  check('Aprueba desde la UI', true);

  await evaluate(`(() => {
    const form = document.querySelector('#lingoApplyForm');
    form.elements.text.value = 'El Catrastro y Palmitra respondieron';
    form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => evaluate(`document.querySelector('#lingoApplyResult')?.textContent.includes('Catastro')`), 12000, 'prueba de canonicalización');
  const applyText = await evaluate(`document.querySelector('#lingoApplyResult')?.textContent || ''`);
  check('Prueba la canonicalización en la UI', /Catastro/.test(applyText) && /Palmira/.test(applyText), applyText.slice(0, 160));

  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-lingo-light.png', Buffer.from(shot.data, 'base64'));

  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#lingoTerms .doc-row')];
    const row = rows.find((item) => item.textContent.includes('Catastro'));
    row?.querySelector('[data-lingo-status="rejected"]')?.click();
    return Boolean(row);
  })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-confirm[open]'))`), 8000, 'confirmar rechazo');
  await evaluate(`document.querySelector('#confirmOk')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/lingo/terms?q=Catastro');
    return result.json?.items?.[0]?.status === 'rejected';
  }, 12000, 'rechazo UI');
  check('Rechaza desde la UI', true);

  await evaluate(`(() => { const search = document.querySelector('#lingoSearch'); search.value = 'Palmira'; search.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#lingoTerms .doc-row').length === 1 && document.querySelector('#lingoTerms')?.textContent.includes('Palmira')`), 10000, 'filtro');
  check('Filtra términos por búsqueda', true);
  check('UI Léxico sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== LINGO: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


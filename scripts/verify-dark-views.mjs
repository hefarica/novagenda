/* Verifica el tema oscuro en las vistas nuevas y captura pruebas visuales. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3325';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9359;
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

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-dark-new-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-dark-chrome-'));
const APP_SECRET = 'dark-new-views-0123456789abcdef';
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
  await api('POST', '/api/lingo/terms', { term: 'Héctor Fabio Riascos C.', variants: ['Hector Fabio'], context: 'clientes' });
  await api('PATCH', '/api/lingo/terms/LG-0001', { status: 'approved' });
  await api('POST', '/api/base/tables', { name: 'Predios', columns: 'Predio:texto, Área:número, Fecha:fecha, Pagado:casilla' });
  await api('POST', '/api/base/tables/TB-0001/rows', { values: { c1: 'La Esperanza', c2: '1200.5', c3: '2026-11-05', c4: true } });
  await api('POST', '/api/identity/contacts', { name: 'Andrés M.', emails: ['andres@empresa.test', 'andres@gmail.test'], aliases: ['Andrés'] });
  await api('POST', '/api/identity/contacts', { name: 'Andrés P.', emails: ['andres.p@empresa.test', 'andres.p@gmail.test'] });
  await api('POST', '/api/docs', { type: 'docx', title: 'Acta de prueba', template: 'acta', topic: 'Acta de prueba', date: '2026-11-05', attendees: [{ name: 'Andrés M.', role: 'Solicitante' }], agreements: [{ text: 'Enviar el acta', owner: 'Héctor', due: 'esta semana' }], summary: ['Se revisó el predio.', 'Se acordó enviar el acta.'] });

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
  await waitFor(async () => evaluate(`document.readyState === 'complete'`), 25000, 'app');
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1', 'dark'); location.reload(); true`);
  await waitFor(async () => evaluate(`document.readyState === 'complete' && document.documentElement.dataset.theme === 'dark'`), 25000, 'dark');
  await sleep(400);
  const base = await evaluate(`(() => {
    const body = getComputedStyle(document.body);
    const card = getComputedStyle(document.querySelector('.card') || document.body);
    const shell = getComputedStyle(document.querySelector('.shell') || document.body);
    return { bg: body.backgroundColor, cardBg: card.backgroundColor, blur: card.backdropFilter, radius: card.borderRadius, shellMax: shell.maxWidth, font: body.fontSize, overflow: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  check('Fondo oscuro plano', base.bg === 'rgb(6, 20, 38)', base.bg);
  check('Paneles heredan vidrio', /blur\(16px\)/.test(base.blur) && Number.parseFloat(base.radius) >= 14, `${base.blur} · ${base.radius}`);
  check('Ancho y tipografía del tema claro', base.shellMax === '1650px' && base.font === '14px', `${base.shellMax} · ${base.font}`);
  check('Sin desbordamiento horizontal', base.overflow === false);

  mkdirSync('docs/capturas', { recursive: true });
  const views = [
    ['base', '#view-base', 1],
    ['lingo', '#view-lingo', 1],
    ['identity', '#view-identity', 1],
    ['audit', '#view-audit', 2],
    ['docs', '#view-docs', 1]
  ];
  for (const [name, view, minimum] of views) {
    await evaluate(`document.querySelector('[data-nav="${name}"]')?.click()`);
    await waitFor(async () => evaluate(`document.querySelector('${view}')?.classList.contains('active')`), 10000, `vista ${name}`);
    await sleep(600);
    const rows = await evaluate(`document.querySelectorAll('${view} .doc-row, ${view} tbody tr, ${view} .card').length`);
    check(`Vista ${name} con contenido`, rows >= minimum, `elementos ${rows}`);
    if (name === 'docs') {
      await evaluate(`document.querySelector('#meetingCaptureCard')?.scrollIntoView({ block: 'start' })`);
      await evaluate(`window.scrollBy(0, -70)`);
      await sleep(250);
    } else {
      await evaluate(`window.scrollTo(0, 0)`);
    }
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`docs/capturas/dark-${name}.png`, Buffer.from(shot.data, 'base64'));
  }
  const contrast = await evaluate(`(() => {
    const card = document.querySelector('#view-audit .card') || document.querySelector('.card');
    if (!card) return null;
    const style = getComputedStyle(card);
    return { bg: style.backgroundColor, color: style.color };
  })()`);
  check('Auditoría legible en oscuro', !!contrast && contrast.color.includes('238, 245, 255'), JSON.stringify(contrast));
  check('Vistas nuevas sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== VISTAS NUEVAS EN OSCURO: PASS ==='}`);
process.exitCode = failures ? 1 : 0;

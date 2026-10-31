/* E2E del paso 4 del onboarding (prueba de chat) en Chrome headless.
   Comprueba que la respuesta se RENDERIZA (negrita, párrafos) y ya no muestra ** crudos.
   Uso: node scripts/verify-onboarding-chat.mjs [url]
   Pensado para una instancia temporal (DATA_DIR y usuarios de prueba). */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3306';
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 30000, label = 'espera') {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`Timeout en ${label}${last ? `: ${last.message}` : ''}`);
}

const profile = mkdtempSync(join(tmpdir(), 'agenda-onb-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' });

let ws;
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 20000, 'CDP');
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS')), { once: true });
  });

  let id = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') consoleErrors.push(m.params.entry.text || 'log');
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = id++;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 30000);
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval');
    return r.result?.value;
  };
  const waitLoad = async () => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000);
      const onMsg = (e) => {
        if (JSON.parse(e.data).method === 'Page.loadEventFired') {
          clearTimeout(timer); ws.removeEventListener('message', onMsg); resolve();
        }
      };
      ws.addEventListener('message', onMsg);
    });
    await sleep(1000);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: URL_APP });
  await waitLoad();

  // Abrir el asistente de inicio.
  const opened = await evaluate(`(() => {
    const btn = document.querySelector('#wizardBtn') || document.querySelector('#drawerWizard');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('Asistente de inicio accesible', opened);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#wizardNext'))`), 15000, 'wizard');

  // Avanzar hasta el paso 4 (prueba de chat).
  for (let step = 0; step < 3; step += 1) {
    await evaluate(`document.querySelector('#wizardNext').click()`);
    await sleep(1200);
  }
  const hasChat = await waitFor(async () => evaluate(`Boolean(document.querySelector('#onbChatText'))`), 15000, 'paso chat');
  check('Paso de prueba de chat visible', hasChat);

  // Enviar la frase del informe (saludo + hora).
  await evaluate(`(() => {
    const input = document.querySelector('#onbChatText');
    input.value = 'hola que hora es?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#onbChatForm').requestSubmit();
    return true;
  })()`);

  // Esperar la respuesta (LLM real).
  const html = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('#onbChatOut')?.innerHTML || ''`);
    const text = await evaluate(`document.querySelector('#onbChatOut')?.textContent || ''`);
    if (!text || /Pensando/.test(text)) return null;
    return value;
  }, 90000, 'respuesta del chat');

  const text = await evaluate(`document.querySelector('#onbChatOut')?.textContent || ''`);
  check('Responde algo útil', text.length > 20, text.slice(0, 120));
  check('Se renderiza como HTML (párrafos/negrita)', /<(p|strong)>/i.test(html), html.slice(0, 160));
  check('No muestra markdown crudo (**)', !html.includes('**') && !text.includes('**'), text.slice(0, 120));
  check('No muestra "Traza: list_day"', !/Traza:\s*\w/i.test(text), text.slice(0, 120));
  check('No vuelca la agenda para un saludo', !/carga:|foco:|riesgos:/i.test(text), text.slice(0, 120));
  check('Responde con la hora o saludo natural', /son las|hola|buenas|hora/i.test(text), text.slice(0, 120));

  const realErrors = consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
  check('Sin errores de consola', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (error) {
  failures += 1;
  console.log('FAIL  ejecución  —', error.message);
} finally {
  try { ws?.close(); } catch { /* ignorar */ }
  try { chrome.kill(); } catch { /* ignorar */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignorar */ }
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : `${failures} fallo(s)`}`);
  process.exit(failures ? 1 : 0);
}

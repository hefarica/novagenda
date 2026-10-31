/* Verifica que el dictado por voz está conectado y responde (aunque no haya micrófono).
   Uso: node scripts/verify-voice.mjs [url]
   Comprueba botones, inicialización, reacción al pulsar y ausencia de errores de consola. */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* reintento */ }
    await sleep(250);
  }
  throw new Error('timeout');
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const profile = mkdtempSync(join(tmpdir(), 'agenda-voice-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS')), { once: true });
  });
  let id = 1;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text || 'log');
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = id++;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 25000);
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval');
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1500);

  const buttons = await evaluate(`({
    fab: Boolean(document.querySelector('#voiceFab')),
    orb: Boolean(document.querySelector('#voiceBtn')),
    status: Boolean(document.querySelector('#voiceStatus')),
    api: typeof (window.SpeechRecognition || window.webkitSpeechRecognition)
  })`);
  check('Botón de dictado en la barra', buttons.orb);
  check('Botón flotante de dictado', buttons.fab);
  check('Zona de estado de voz', buttons.status);
  check('API de reconocimiento disponible en el navegador', buttons.api === 'function', `tipo ${buttons.api}`);

  // Pulsar el dictado: debe reaccionar (activar estado o explicar por qué no puede).
  await evaluate(`document.querySelector('#voiceFab').click()`);
  await sleep(2500);
  const after = await evaluate(`({
    pressed: document.querySelector('#voiceFab').getAttribute('aria-pressed'),
    status: (document.querySelector('#voiceStatus')?.textContent || '').trim(),
    hidden: document.querySelector('#voiceStatus')?.hidden,
    listening: document.body.dataset.listening || null
  })`);
  const reacted = after.pressed === 'true' || Boolean(after.status) || after.listening === '1' || after.hidden === false;
  check('El dictado reacciona al pulsar', reacted, JSON.stringify(after));
  check('Sin errores de consola', errors.filter((e) => !/favicon|manifest|microphone|permission/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));

  // Detener si quedó escuchando.
  await evaluate(`document.querySelector('#voiceFab').click()`);
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

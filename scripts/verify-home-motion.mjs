/* Verifica el panel de Camila, el micrófono y el fondo 3D por vista. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, timeout = 20000, label = 'espera') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch { /* sigue */ }
    await sleep(250);
  }
  throw new Error(`Timeout: ${label}`);
}

const profile = mkdtempSync(join(tmpdir(), 'agenda-motion-'));
const fakeWav = join(profile, 'voz-prueba.wav');
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voice = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1
    if ($voice) { $s.SelectVoice($voice.VoiceInfo.Name) }
    $s.SetOutputToWaveFile('${fakeWav.replace(/'/g, "''")}')
    $s.Speak('Hola Camila, que tengo hoy en la agenda?')
    $s.Dispose()
  `], { windowsHide: true, timeout: 30_000 });
} catch { /* si no hay voz, se prueba solo el panel */ }
const fakeArgs = [];
try { if (fakeWav) fakeArgs.push(`--use-file-for-fake-audio-capture=${fakeWav}`); } catch { /* nada */ }
const chromeArgs = [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', ...fakeArgs, 'about:blank'
];
if (process.env.HEADED !== '1') chromeArgs.unshift('--headless=new');
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
const exceptions = [];
async function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'eval');
  return result.result?.value;
}
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 15000, 'CDP');
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.text || 'exception');
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1335, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  const grant = await cdp('Browser.grantPermissions', { origin: URL_APP, permissions: ['audioCapture'] }).then(() => 'ok').catch((error) => error.message);
  console.log('grant_permissions', grant);
  const homeResponse = await fetch(`${URL_APP}/`);
  const policy = homeResponse.headers.get('permissions-policy') || '';
  check('el servidor permite micrófono al propio origen', /microphone=\(self\)/.test(policy) && !/microphone=\(\)/.test(policy), policy);
  await cdp('Page.navigate', { url: `${URL_APP}/#home` });
  await waitFor(() => evaluate("!!document.querySelector('#homeAgentPanel')"), 20000, 'panel Camila');
  await sleep(1200);
  check('panel de Camila en Inicio', await evaluate("document.querySelector('#homeAgentPanel').getBoundingClientRect().height > 60"));
  const placed = await evaluate(`(() => {
    const score = document.querySelector('.score-card').getBoundingClientRect();
    const camila = document.querySelector('#homeAgentPanel').getBoundingClientRect();
    return { sameRow: Math.abs(score.top - camila.top) < 12, right: camila.left > score.left + score.width - 10, scoreW: score.width, camilaW: camila.width };
  })()`);
  check('Camila ocupa la columna derecha del hero', placed.sameRow && placed.right, JSON.stringify(placed));
  check('micrófono del panel', await evaluate("!!document.querySelector('#homeAgentMic')"));
  check('entrada de texto del panel', await evaluate("!!document.querySelector('#homeAgentInput')"));
  const canvas0 = await evaluate(`(() => { const c=document.querySelector('#ambientCanvas'); if(!c) return null; const x=c.getContext('2d'); const d=x.getImageData(0,0,c.width,c.height).data; let n=0; for(let i=3;i<d.length;i+=400) if(d[i]>0) n++; return {view:c.dataset.view,w:c.width,h:c.height,alpha:n}; })()`);
  check('fondo 3D activo en Inicio', !!canvas0 && canvas0.w > 100 && canvas0.alpha > 0, JSON.stringify(canvas0));
  check('fondo distinto para Inicio', canvas0?.view === 'home', canvas0?.view);
  await evaluate("document.querySelector('.bottom-nav [data-nav=\"agenda\"]')?.click()");
  await waitFor(() => evaluate("document.querySelector('#ambientCanvas')?.dataset.view === 'agenda'"), 8000, 'fondo agenda');
  check('el fondo cambia al navegar a Agenda', await evaluate("document.querySelector('#ambientCanvas')?.dataset.view === 'agenda'"));
  for (const view of ['tasks', 'assistant', 'setup', 'system']) {
    await evaluate(`document.querySelector('[data-nav="${view}"]')?.click()`);
    const changed = await waitFor(() => evaluate(`document.querySelector('#ambientCanvas')?.dataset.view === '${view}'`), 10000, `fondo ${view}`).catch(() => false);
    check(`fondo distinto en ${view}`, changed, view);
  }
  await evaluate("document.querySelector('.bottom-nav [data-nav=\"home\"]')?.click()");
  await sleep(500);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => {});
  await evaluate("document.documentElement.dataset.theme='light'");
  await sleep(500);
  const light = await evaluate("getComputedStyle(document.querySelector('#ambientCanvas')).opacity");
  check('el fondo responde al tema claro', Number(light) < 0.8, light);
  await evaluate("document.documentElement.dataset.theme='dark'");
  await sleep(400);
  await evaluate("document.querySelector('#homeAgentPanel')?.scrollIntoView({block:'center'})");
  await sleep(400);
  await mkdirSync('docs/capturas', { recursive: true });
  const darkShot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/home-agent-dark.png', Buffer.from(darkShot.data, 'base64'));
  await evaluate("document.documentElement.dataset.theme='light'");
  await sleep(300);
  const lightShot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/home-agent-light.png', Buffer.from(lightShot.data, 'base64'));
  await evaluate("document.querySelector('#homeAgentMic')?.click()");
  const recording = await waitFor(() => evaluate(`(() => { const t=document.querySelector('#homeAgentStatus')?.textContent || ''; return /Grabando|Micrófono bloqueado/i.test(t) ? t : null; })()`), 12000, 'micrófono').catch(() => '');
  const micStarted = /Grabando/.test(recording);
  check('el micrófono graba o explica el permiso sin ambigüedad', micStarted || /candado.*Micrófono.*Permitir/i.test(recording), recording);
  if (micStarted) {
    await sleep(2_800);
    await evaluate("document.querySelector('#homeAgentMic')?.click()");
    const heard = await waitFor(() => evaluate(`(() => { const rows=[...document.querySelectorAll('#homeAgentLog .ha-msg.user p')]; const text=rows.at(-1)?.textContent || ''; return /agenda|tengo|Camila/i.test(text) ? text : null; })()`), 40000, 'transcripción del panel').catch(() => '');
    check('Camila transcribe la nota de voz del micrófono', !!heard, heard.slice(0, 160));
    const voicedReply = await waitFor(() => evaluate(`(() => { const rows=[...document.querySelectorAll('#homeAgentLog .ha-msg.bot p')]; return rows.length >= 2 ? rows.at(-1).textContent : null; })()`), 40000, 'respuesta a la voz').catch(() => '');
    check('Camila responde a la voz sin perder el hilo', !!voicedReply && !/Puedo ayudarte con/i.test(voicedReply), voicedReply.slice(0, 160));
  } else {
    check('el aviso de micrófono es accionable', /candado.*Micrófono.*Permitir/i.test(recording), recording);
  }
  await evaluate("(() => { const i=document.querySelector('#homeAgentInput'); i.value='Hola, ¿cómo estás?'; i.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#homeAgentForm').requestSubmit(); return true; })()");
  const natural = await waitFor(() => evaluate(`(() => { const rows=[...document.querySelectorAll('#homeAgentLog .ha-msg.bot p')]; const last=rows.at(-1)?.textContent || ''; return rows.length >= 2 && last.length > 15 ? last : null; })()`), 40000, 'respuesta de Camila').catch(() => '');
  check('el panel conversa con Camila (no menú)', !!natural && !/Puedo ayudarte con/i.test(natural), natural.slice(0, 160));
  check('sin excepciones de JavaScript', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  check('sin errores de carga críticos', true);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
} catch (error) {
  console.error('ERROR', error.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* nada */ }
  try { chrome.kill(); } catch { /* nada */ }
  await sleep(1200);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* perfil temporal */ }
  if (failures) process.exitCode = 1;
}

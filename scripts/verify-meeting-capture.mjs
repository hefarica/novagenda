/* Verifica Captura de reunión → acta de punta a punta (LLM simulado + Chrome). */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3323';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9357;
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

const { createMockLlmServer } = await import('../lib/llm/mock-server.mjs');
const llm = await createMockLlmServer();
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-capture-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-capture-chrome-'));
const APP_SECRET = 'capture-e2e-secret-fijo-0123456789';
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: {
    ...process.env, APP_SECRET, DATA_DIR: dataDir, PORT: port, NO_OPEN: '1',
    WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off',
    OPENAI_API_KEY: 'sk-mock-local', OPENAI_BASE_URL: `${llm.url}/v1`,
    OPENAI_MODEL: 'mock-agenda-1', LLM_PROVIDER: 'openai'
  },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;
const pageErrors = [];
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  const api = async (method, path, body) => {
    const response = await fetch(`${URL_APP}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* binario */ }
    return { status: response.status, json };
  };

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
  await waitFor(async () => evaluate(`document.querySelector('#view-docs')?.classList.contains('active') && Boolean(document.querySelector('#meetingCaptureForm'))`), 10000, 'vista documentos');
  check('La captura aparece en Documentos', true);
  const dictateButton = await evaluate(`document.querySelector('#captureDictate')?.textContent || ''`);
  check('Ofrece dictado de la transcripción', /Dictar transcripción/.test(dictateButton), dictateButton.trim());
  const liveButton = await evaluate(`document.querySelector('#captureLive')?.textContent || ''`);
  check('Ofrece captura en vivo de la reunión', /Captura en vivo/.test(liveButton), liveButton.trim());
  await evaluate(`(() => { const input = document.querySelector('#translateInput'); input.value = 'Hello, this is a test.'; input.dispatchEvent(new Event('input', { bubbles: true })); const select = document.querySelector('#translateTo'); select.value = 'es'; const form = document.querySelector('#translateForm'); form.requestSubmit(); })()`);
  await waitFor(async () => evaluate(`/Traducción \\(mock\\)/.test(document.querySelector('#translateOutput')?.value || '')`), 15000, 'traducción');
  const translated = await evaluate(`document.querySelector('#translateOutput')?.value || ''`);
  const translateStatus = await evaluate(`document.querySelector('#translateStatus')?.textContent || ''`);
  check('Traduce desde la interfaz', translated.includes('Hello, this is a test.'), translated.slice(0, 120));
  check('Muestra proveedor y modelo', /openai|mock-agenda-1/.test(translateStatus), translateStatus);
  await evaluate(`document.querySelector('#translateCard')?.scrollIntoView({ block: 'center' })`);
  await sleep(350);
  const translateShot = await cdp('Page.captureScreenshot', { format: 'png' });
  mkdirSync('docs/capturas', { recursive: true });
  writeFileSync('docs/capturas/vista-traduccion-light.png', Buffer.from(translateShot.data, 'base64'));

  await evaluate(`(() => {
    const form = document.querySelector('#meetingCaptureForm');
    form.elements.title.value = 'Liberación predio La Esperanza';
    form.elements.date.value = '2026-11-05';
    form.elements.time.value = '10:00';
    form.elements.location.value = 'Cali';
    form.elements.transcript.value = 'Reunión con Andrés M. sobre el predio La Esperanza. Se revisó la franja norte y se acordó enviar el acta a Catastro esta semana. Queda pendiente el número de matrícula.';
    form.elements.privateNotes.value = 'SECRETO: no revelar el acuerdo de la franja.';
    return true;
  })()`);
  await evaluate(`document.querySelector('#captureSaveTranscript')?.click()`);
  await waitFor(async () => {
    const docs = await api('GET', '/api/docs');
    return (docs.json?.items || []).some((item) => /Transcripción — Liberación predio La Esperanza/.test(item.title || ''));
  }, 15000, 'transcripción guardada');
  const transcriptDoc = (await api('GET', '/api/docs')).json?.items?.find((item) => /Transcripción — Liberación predio La Esperanza/.test(item.title || ''));
  check('Guarda la transcripción como DOCX', !!transcriptDoc && transcriptDoc.type === 'docx', JSON.stringify(transcriptDoc || {}).slice(0, 120));
  await evaluate(`document.querySelector('#meetingCaptureForm')?.requestSubmit()`);
  await waitFor(async () => evaluate(`document.querySelector('#capturePreview') && !document.querySelector('#capturePreview').hidden && document.querySelector('#capturePreview').textContent.includes('Enviar el acta a Catastro')`), 20000, 'extracción');
  check('Extrae y muestra los acuerdos', true);
  const preview = await evaluate(`document.querySelector('#capturePreview')?.textContent || ''`);
  check('Muestra asistentes y resumen', preview.includes('Andrés M.') && preview.includes('La Esperanza'), preview.slice(0, 120));
  const createVisible = await evaluate(`!document.querySelector('#captureCreateActa')?.hidden`);
  check('Habilita crear el acta', createVisible === true);

  await evaluate(`document.querySelector('#captureCreateActa')?.click()`);
  await waitFor(async () => evaluate(`document.querySelector('#captureStatus')?.textContent.includes('Acta creada')`), 20000, 'acta creada');
  check('Crea el acta desde la UI', true);

  const docs = await api('GET', '/api/docs');
  const doc = (docs.json?.items || []).find((item) => /Liberación predio La Esperanza/.test(item.title || ''));
  check('El acta queda registrada', !!doc && doc.type === 'docx' && doc.template === 'acta', JSON.stringify(doc || {}).slice(0, 140));
  const tasks = await api('GET', '/api/tasks');
  const task = (tasks.json?.items || []).find((item) => /Enviar el acta a Catastro/.test(item.title || ''));
  check('El acuerdo se convierte en tarea', !!task, JSON.stringify(task || {}).slice(0, 120));
  if (doc?.downloadUrl) {
    const download = await fetch(`${URL_APP}${doc.downloadUrl}`);
    check('El DOCX se puede descargar', download.status === 200 && /wordprocessingml/.test(download.headers.get('content-type') || ''), `HTTP ${download.status}`);
  } else {
    check('El DOCX se puede descargar', false, 'sin downloadUrl');
  }

  await evaluate(`document.querySelector('#meetingCaptureCard')?.scrollIntoView({ block: 'start' })`);
  await evaluate(`window.scrollBy(0, -80)`);
  mkdirSync('docs/capturas', { recursive: true });
  await sleep(300);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-captura-reunion-light.png', Buffer.from(shot.data, 'base64'));
  check('UI de captura sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.error(`FAIL  excepción — ${error.message}`);
} finally {
  try { ws?.close(); } catch { /* nada */ }
  try { chrome?.kill(); } catch { /* nada */ }
  try { app.kill(); } catch { /* nada */ }
  await llm.close();
  await sleep(400);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* nada */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* nada */ }
}
console.log(`\n${failures ? `${failures} fallo(s)` : '=== CAPTURA DE REUNIÓN: PASS ==='}`);
process.exitCode = failures ? 1 : 0;





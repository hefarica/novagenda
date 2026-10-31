/* Verifica Organización (24 perfiles) y Estudio (encargos/artefactos). */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch { /* sigue */ }
    await sleep(250);
  }
  throw new Error(`Timeout: ${label}`);
}
const profile = mkdtempSync(join(tmpdir(), 'agenda-studio-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank'
], { stdio: 'ignore' });
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
  const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval');
  return res.result?.value;
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1335, height: 950, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  await cdp('Page.navigate', { url: `${URL_APP}/#organization` });
  await waitFor(() => evaluate("document.querySelectorAll('#orgMembers .org-member').length >= 20"), 30000, '24 perfiles');
  await sleep(500);
  const org = await evaluate(`({
    members: document.querySelectorAll('#orgMembers .org-member').length,
    teams: document.querySelectorAll('#orgTeams .org-team').length,
    summary: document.querySelector('#orgSummary')?.innerText || '',
    dialog: !!document.querySelector('#dlg-org-agent'),
    overflow: document.documentElement.scrollWidth <= innerWidth + 1
  })`);
  check('Organización carga los 24 perfiles', org.members === 24, String(org.members));
  check('Organización carga los 4 equipos', org.teams === 4, String(org.teams));
  check('Resumen real de la organización', /24/.test(org.summary) && /4/.test(org.summary), org.summary.slice(0, 120));
  check('Formulario de agente disponible', org.dialog);
  check('Organización sin desbordamiento a 1335px', org.overflow);
  await evaluate("document.querySelector('[data-nav=\"studio\"]')?.click()");
  await waitFor(() => evaluate("document.querySelector('#studioBrief') && document.querySelectorAll('#studioJobs .studio-job').length >= 1"), 30000, 'Estudio');
  await sleep(500);
  const studio = await evaluate(`({
    type: !!document.querySelector('#studioType'),
    brief: !!document.querySelector('#studioBrief'),
    jobs: document.querySelectorAll('#studioJobs .studio-job').length,
    artifacts: document.querySelectorAll('#studioJobs .studio-artifact').length,
    preview: (document.querySelector('#studioPreviewBody')?.innerText || '').slice(0, 120),
    overflow: document.documentElement.scrollWidth <= innerWidth + 1
  })`);
  check('Estudio muestra el formulario de encargo', studio.type && studio.brief);
  check('Estudio lista encargos existentes', studio.jobs >= 1, String(studio.jobs));
  check('Estudio muestra artefactos descargables', studio.artifacts >= 1, String(studio.artifacts));
  check('Estudio sin desbordamiento a 1335px', studio.overflow);
  await mkdirSync('docs/capturas', { recursive: true });
  const orgToggle = await evaluate("document.querySelector('[data-nav=\"organization\"]')?.click(); true");
  await sleep(400);
  const s1 = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/organizacion.png', Buffer.from(s1.data, 'base64'));
  await evaluate("document.querySelector('[data-nav=\"studio\"]')?.click(); true");
  await sleep(400);
  const s2 = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/estudio.png', Buffer.from(s2.data, 'base64'));
  check('sin excepciones de JavaScript', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
  console.log(`\n${results.length - failures}/${results.length} PASS`);
} catch (error) {
  console.error('ERROR', error.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* nada */ }
  try { chrome.kill(); } catch { /* nada */ }
  await sleep(1000);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temporal */ }
  if (failures) process.exitCode = 1;
}

/* Verifica la puesta en marcha asistida en app temporal + Chrome headless. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3347';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9372;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-setup-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'agenda-setup-chrome-'));
const port = new URL(URL_APP).port;
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET: 'agenda-setup-secret-fijo-0123456789', DATA_DIR: dataDir, PORT: port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
let chrome = null;
let ws = null;

try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 30000, 'servidor');
  const overviewResponse = await fetch(`${URL_APP}/api/setup/overview`);
  const overview = await overviewResponse.json();
  check('El endpoint de puesta en marcha responde', overviewResponse.status === 200 && overview.ok === true && Array.isArray(overview.steps), `${overviewResponse.status} · ${overview.steps?.length} pasos`);
  check('Trae presets y URLs de retorno', overview.presets?.email?.length >= 6 && /\/api\/auth\/google\/callback/.test(overview.redirects?.google || ''), `${overview.presets?.email?.length || 0} correos`);
  const rawOverview = JSON.stringify(overview);
  check('No expone secretos en el estado', !/password|clientSecret|accessToken|botToken/i.test(rawOverview), `${rawOverview.length} bytes`);
  const assistResponse = await fetch(`${URL_APP}/api/setup/assist`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '¿Qué falta?' })
  });
  const assist = await assistResponse.json();
  check('Camila responde con el estado real', assistResponse.status === 200 && assist.ok === true && /falta|correo|conexi/i.test(assist.reply || ''), `${assist.source || ''} · ${String(assist.reply || '').slice(0, 80)}`);

  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
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
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.exception?.description || 'excepción');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') pageErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
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
  await waitFor(async () => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('[data-nav="setup"]'))`), 25000, 'app');
  await evaluate(`document.querySelector('[data-nav="setup"]').click()`);
  await waitFor(async () => evaluate(`document.querySelector('#view-setup.active') && document.querySelectorAll('#setupSteps .setup-step').length === 8`), 20000, 'vista puesta en marcha');
  check('La vista muestra los 8 pasos', await evaluate(`document.querySelectorAll('#setupSteps .setup-step').length`) === 8);
  check('Muestra progreso y equipo', await evaluate(`Boolean(document.querySelector('#setupScore')?.textContent.match(/%/)) && document.querySelectorAll('#setupTeam .setup-person').length >= 5`));
  check('Camila saluda con el siguiente paso', await evaluate(`document.querySelectorAll('#setupChat .setup-msg.bot').length >= 1 && document.querySelector('#setupChat').textContent.includes('Camila')`));

  await evaluate(`document.querySelector('[data-setup-open="email"]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-step="email"] [data-email-address]'))`), 8000, 'formulario correo');
  const emailForm = await evaluate(`(() => {
    const box = document.querySelector('[data-step="email"]');
    const address = box.querySelector('[data-email-address]');
    const password = box.querySelector('[data-email-password]');
    const advanced = box.querySelector('details.setup-advanced');
    return {
      hasAddress: Boolean(address), hasPassword: Boolean(password),
      advancedOpen: Boolean(advanced?.open),
      host: box.querySelector('[data-email-smtp-host]')?.value || '',
      gmailHelp: !box.querySelector('[data-email-gmail-help]')?.hidden
    };
  })()`);
  check('Correo pide solo usuario y contraseña', emailForm.hasAddress && emailForm.hasPassword, JSON.stringify(emailForm));
  check('Servidores vienen preconfigurados y plegados', emailForm.host === 'smtp.gmail.com' && emailForm.advancedOpen === false, `${emailForm.host} · avanzado=${emailForm.advancedOpen}`);
  check('Gmail muestra ayuda de contraseña de aplicación', emailForm.gmailHelp === true);
  await evaluate(`(() => {
    const box = document.querySelector('[data-step="email"]');
    box.querySelector('[data-email-address]').value = 'beticosa1@gmail.com';
    box.querySelector('[data-email-password]').value = 'corta123';
    box.querySelector('[data-setup-action="email-connect"]').click();
    return true;
  })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('[data-setup-result="email"]:not([hidden])'))`), 5000, 'aviso Gmail');
  const gmailWarning = await evaluate(`document.querySelector('[data-setup-result="email"]')?.textContent || ''`);
  check('Gmail avisa antes de enviar con una clave que no es de 16', /16 caracteres/.test(gmailWarning), gmailWarning.slice(0, 120));
  await evaluate(`(() => { const input = document.querySelector('[data-email-address]'); input.value = 'persona@outlook.com'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const detected = await evaluate(`(() => { const box = document.querySelector('[data-step="email"]'); return { provider: box.querySelector('[data-email-provider]').value, host: box.querySelector('[data-email-smtp-host]').value, imap: box.querySelector('[data-email-imap-host]').value, gmailHelp: !box.querySelector('[data-email-gmail-help]').hidden }; })()`);
  check('Detecta el proveedor por el dominio', detected.provider === 'outlook' && detected.host.includes('outlook') && detected.imap.includes('outlook'), JSON.stringify(detected));
  check('Oculta la ayuda de Gmail al cambiar de proveedor', detected.gmailHelp === false, String(detected.gmailHelp));
  mkdirSync('docs/capturas', { recursive: true });
  const setupShot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/setup-asistido.png', Buffer.from(setupShot.data, 'base64'));

  await cdp('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(async () => evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 5000, 'sin overflow móvil');
  check('Sin desbordamiento a 520 px', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  check('La asistente se apila en móvil', await evaluate(`getComputedStyle(document.querySelector('.setup-layout')).gridTemplateColumns.split(' ').length === 1`), await evaluate(`getComputedStyle(document.querySelector('.setup-layout')).gridTemplateColumns`));
  check('UI sin errores de consola', pageErrors.filter((error) => !/favicon|manifest/i.test(error)).length === 0, pageErrors.slice(0, 3).join(' | '));
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
console.log(`\n${failures ? `${failures} fallo(s)` : '=== PUESTA EN MARCHA: PASS ==='}`);
process.exitCode = failures ? 1 : 0;


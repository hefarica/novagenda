/* E2E de la tarjeta «Cuentas de correo (SMTP)»: alta desde la UI, prueba real
   contra un servidor SMTP local y listado con último envío.
   Uso: node scripts/verify-smtp-ui.mjs [http://127.0.0.1:3317] */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3317';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
async function waitFor(fn, timeout = 20000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

/* Mock SMTP mínimo */
const received = [];
const smtp = net.createServer((socket) => {
  let buffer = ''; let mode = 'command'; let current = null;
  const write = (line) => socket.write(`${line}\r\n`);
  write('220 mock listo');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (mode === 'data') {
        if (line === '.') { mode = 'command'; received.push(current); current = null; write('250 ok'); }
        else current += `${line}\r\n`;
        continue;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO')) { write('250-mock'); write('250 AUTH PLAIN LOGIN'); }
      else if (upper.startsWith('AUTH PLAIN')) write('235 ok');
      else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) write('250 ok');
      else if (upper === 'DATA') { mode = 'data'; current = ''; write('354 fin con .'); }
      else if (upper === 'QUIT') { write('221 adiós'); socket.end(); }
      else write('250 ok');
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const smtpPort = smtp.address().port;

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-smtp-ui-'));
const APP_SECRET = 'smtp-ui-secret';
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET, DATA_DIR: dataDir, PORT: new URL(URL_APP).port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
const profile = mkdtempSync(join(tmpdir(), 'agenda-smtp-ui-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok, 25000, 'servidor');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 20000, 'chrome');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text || 'log');
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = id++; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 25000); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await send('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1200);
  await evaluate(`document.querySelector('.drawer-nav [data-nav="integrations"], [data-nav="integrations"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#emailAccountForm [name="host"]'))`), 10000, 'formulario SMTP');
  check('La tarjeta SMTP aparece en Integraciones', true);

  const fill = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
  await evaluate(fill('#emailAccountForm [name="label"]', 'Cuenta de Héctor'));
  await evaluate(fill('#emailAccountForm [name="fromEmail"]', 'hector@test.local'));
  await evaluate(fill('#emailAccountForm [name="fromName"]', 'Héctor Fabio Riascos C.'));
  await evaluate(fill('#emailAccountForm [name="host"]', '127.0.0.1'));
  await evaluate(fill('#emailAccountForm [name="port"]', smtpPort));
  await evaluate(fill('#emailAccountForm [name="secure"]', 'false'));
  await evaluate(fill('#emailAccountForm [name="user"]', 'hector@test.local'));
  await evaluate(fill('#emailAccountForm [name="password"]', 'clave-ui-123'));
  await evaluate(`(() => { const el = document.querySelector('#emailAccountForm [name="allowInsecure"]'); if (!el) return false; el.checked = true; return true; })()`);
  await evaluate(`document.querySelector('#emailAccountForm button[type="submit"]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#emailAccountsList [data-mail-test]'))`), 15000, 'cuenta listada');
  check('La cuenta se crea desde la UI y aparece listada', true);
  const rowText = await evaluate(`document.querySelector('#emailAccountsList')?.textContent || ''`);
  check('Muestra remitente y host, sin contraseña', rowText.includes('hector@test.local') && rowText.includes('127.0.0.1') && !rowText.includes('clave-ui-123'), rowText.replace(/\s+/g, ' ').slice(0, 120));

  await evaluate(`document.querySelector('#emailAccountsList [data-mail-test]').click()`);
  await waitFor(async () => received.length >= 1, 12000, 'envío de prueba');
  const message = received[0] || '';
  check('El botón «Probar envío» manda correo real', /From:.*hector@test\.local/i.test(message) && /To:.*hector@test\.local/i.test(message));
  await waitFor(async () => evaluate(`!document.querySelector('#emailAccountsList')?.textContent.includes('nunca')`), 12000, 'último envío');
  check('La fila refleja el último envío', true);

  await evaluate(`document.querySelector('#emailAccountsCard')?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  mkdirSync('docs/capturas', { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-smtp-light.png', Buffer.from(shot.data, 'base64'));

  const realErrors = errors.filter((e) => !/favicon|manifest/i.test(e));
  check('Sin errores de consola', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.log('FAIL  excepción —', error?.message || error);
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { app.kill(); } catch {}
  try { smtp.close(); } catch {}
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : failures + ' fallo(s)'}`);
  process.exit(failures ? 1 : 0);
}


/* Verifica cuentas SMTP propias: CRUD por API, prueba de envío real contra un
   servidor SMTP local, y adjunto MIME. Sin Google.
   Uso: node scripts/verify-smtp.mjs [http://127.0.0.1:3316] */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3316';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

/* ------------------------- servidor SMTP de prueba ------------------------- */
const received = [];
const authSeen = [];
const smtp = net.createServer((socket) => {
  let buffer = '';
  let mode = 'command';
  let current = null;
  const write = (line) => socket.write(`${line}\r\n`);
  write('220 mock-smtp listo');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (mode === 'data') {
        if (line === '.') {
          mode = 'command';
          received.push(current);
          current = null;
          write('250 2.0.0 aceptado');
        } else {
          current += `${line}\r\n`;
        }
        continue;
      }
      if (mode === 'auth-login-user') { authSeen.push(Buffer.from(line, 'base64').toString()); mode = 'auth-login-pass'; write('334 UGFzc3dvcmQ6'); continue; }
      if (mode === 'auth-login-pass') { mode = 'command'; write('235 2.7.0 autenticado'); continue; }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO')) {
        write('250-mock-smtp');
        write('250-AUTH PLAIN LOGIN');
        write('250 8BITMIME');
      } else if (upper.startsWith('AUTH PLAIN')) {
        authSeen.push(Buffer.from(line.slice(10).trim(), 'base64').toString());
        write('235 2.7.0 autenticado');
      } else if (upper === 'AUTH LOGIN') {
        mode = 'auth-login-user';
        write('334 VXNlcm5hbWU6');
      } else if (upper.startsWith('MAIL FROM')) {
        write('250 2.1.0 ok');
      } else if (upper.startsWith('RCPT TO')) {
        write('250 2.1.5 ok');
      } else if (upper === 'DATA') {
        mode = 'data';
        current = '';
        write('354 fin con .');
      } else if (upper === 'QUIT') {
        write('221 adiós');
        socket.end();
      } else if (upper.startsWith('RSET') || upper.startsWith('NOOP')) {
        write('250 ok');
      } else {
        write('500 orden desconocida');
      }
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const smtpPort = smtp.address().port;

const dataDir = mkdtempSync(join(tmpdir(), 'agenda-smtp-'));
const APP_SECRET = 'smtp-e2e-secret-fijo';
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET, DATA_DIR: dataDir, PORT: new URL(URL_APP).port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off' },
  stdio: 'ignore'
});
async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}
const api = async (method, path, body) => {
  const res = await fetch(`${URL_APP}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, json };
};

try {
  await waitFor(async () => (await fetch(`${URL_APP}/api/health`)).ok);
  const created = await api('POST', '/api/email/accounts', {
    label: 'Cuenta de Héctor', host: '127.0.0.1', port: smtpPort, secure: false, allowInsecure: true,
    user: 'hector@test.local', password: 'clave-secreta-123', fromName: 'Héctor Fabio Riascos C.', fromEmail: 'hector@test.local'
  });
  check('Crea cuenta SMTP (201)', created.status === 201 && created.json?.item?.id, created.json?.item?.id || JSON.stringify(created.json).slice(0, 120));
  const account = created.json?.item;
  check('Nunca devuelve la contraseña', !JSON.stringify(created.json).includes('clave-secreta-123') && account?.hasPassword === true);
  const list = await api('GET', '/api/email/accounts');
  check('Lista la cuenta con remitente y host', list.json?.count === 1 && list.json.items[0].fromEmail === 'hector@test.local' && list.json.items[0].host === '127.0.0.1');

  const testSend = await api('POST', `/api/email/accounts/${account.id}/test`, { to: 'destino@test.local' });
  check('Prueba de envío por SMTP (200)', testSend.status === 200 && testSend.json?.via === 'smtp', JSON.stringify(testSend.json).slice(0, 160));
  await waitFor(async () => received.length >= 1, 8000, 'mensaje SMTP');
  const message = received[0] || '';
  check('El servidor SMTP recibió el mensaje', /Subject:/i.test(message) && /destino@test.local/i.test(message));
  check('Remitente con el nombre de Héctor', /From:.*Héctor|From:.*hector@test\.local/i.test(message), message.split('\r\n').find((line) => /^From:/i.test(line)) || '');
  check('Autenticó con usuario y clave', authSeen.some((entry) => entry.includes('hector@test.local')) && authSeen.some((entry) => entry.includes('clave-secreta-123')));
  check('Incluye Date y Message-ID', /Date:/i.test(message) && /Message-ID:/i.test(message));

  // Adjunto real por la misma ruta, en proceso aparte con el mismo DATA_DIR.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.APP_SECRET = ${JSON.stringify(APP_SECRET)};
    const { sendWithAccount } = await import('./lib/channel/smtp.mjs');
    const result = await sendWithAccount(null, {
      to: 'destino@test.local', subject: 'Acta adjunta', text: 'Adjunto el acta.',
      attachments: [{ filename: 'acta.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('DOCX-PRUEBA') }]
    });
    console.log(JSON.stringify(result));
  `], { cwd: process.cwd(), env: { ...process.env, APP_SECRET, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = ''; let childErr = '';
  child.stdout.on('data', (chunk) => { childOut += chunk; });
  child.stderr.on('data', (chunk) => { childErr += chunk; });
  const childCode = await new Promise((resolve) => child.on('exit', resolve));
  check('Envío con adjunto por SMTP', childCode === 0, childErr.slice(0, 160));
  await waitFor(async () => received.length >= 2, 8000, 'mensaje con adjunto');
  const attached = received[received.length - 1] || '';
  check('El adjunto llega con nombre y tipo', /acta\.docx/.test(attached) && /Content-Disposition: attachment/i.test(attached));

  // El adaptador de correo (propuestas aprobadas) debe usar SMTP, no Gmail.
  const adapter = spawn(process.execPath, ['--input-type=module', '-e', `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.APP_SECRET = ${JSON.stringify(APP_SECRET)};
    const { createEmailAdapter } = await import('./lib/channel/email.mjs');
    const sent = await createEmailAdapter().send({ to: 'destino@test.local', text: 'Salida del adaptador', meta: { subject: 'Adaptador SMTP' } });
    console.log(JSON.stringify(sent));
  `], { cwd: process.cwd(), env: { ...process.env, APP_SECRET, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let adapterOut = ''; let adapterErr = '';
  adapter.stdout.on('data', (chunk) => { adapterOut += chunk; });
  adapter.stderr.on('data', (chunk) => { adapterErr += chunk; });
  const adapterCode = await new Promise((resolve) => adapter.on('exit', resolve));
  check('El adaptador de correo envía por SMTP', adapterCode === 0 && /"via":"smtp"/.test(adapterOut), adapterErr.slice(0, 160) || adapterOut.slice(0, 120));
  await waitFor(async () => received.length >= 3, 8000, 'mensaje del adaptador');
  check('El mensaje del adaptador llega al servidor', /Adaptador SMTP/i.test(received[received.length - 1] || ''));
  const deleted = await api('DELETE', `/api/email/accounts/${account.id}`);
  check('Elimina la cuenta', deleted.status === 200 && (await api('GET', '/api/email/accounts')).json?.count === 0);
  const rejected = await api('POST', '/api/email/accounts', { host: '', user: '', fromEmail: 'no-es-correo' });
  check('Rechaza cuenta inválida', rejected.status >= 400 && rejected.json?.error);
} catch (error) {
  failures += 1;
  console.log('FAIL  excepción —', error?.message || error);
} finally {
  try { app.kill(); } catch {}
  try { smtp.close(); } catch {}
  await sleep(500);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : failures + ' fallo(s)'}`);
  process.exit(failures ? 1 : 0);
}




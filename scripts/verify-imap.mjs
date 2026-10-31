/* Verifica bandejas IMAP propias contra un servidor IMAP TLS local (certificado
   de prueba en scripts/fixtures). Solo lectura: no borra ni marca leído.
   Uso: node scripts/verify-imap.mjs [http://127.0.0.1:3318] */
import tls from 'node:tls';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3318';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9347;
const PFX = readFileSync('scripts/fixtures/imap-test.pfx');
const DER = readFileSync('scripts/fixtures/imap-test.cer');
const PFX_PASS = 'imap-test-pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

/* CA PEM para que el cliente confíe solo en este certificado de prueba. */
const base64 = DER.toString('base64').replace(/(.{64})/g, '$1\n').trim();
const caPath = join(mkdtempSync(join(tmpdir(), 'agenda-imap-ca-')), 'ca.pem');
writeFileSync(caPath, `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`);

/* Mensajes de prueba */
function encodeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}
const rawNew = [
  'From: "Andrés M." <Andres@Test.Local>',
  `To: ${encodeHeader('Héctor Fabio Riascos C.')} <hector@test.local>`,
  `Subject: ${encodeHeader('Acta del predio')}`,
  'Date: Wed, 28 Oct 2026 10:30:00 -0500',
  'Message-ID: <msg-12@test.local>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="alt-12"',
  '',
  '--alt-12',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Necesito el acta de liberación del predio para el jueves.', 'utf8').toString('base64'),
  '--alt-12',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>Necesito el <b>acta</b> del predio.</p>',
  '--alt-12--',
  ''
].join('\r\n');
const rawOld = [
  'From: Luis Pérez <luis@test.local>',
  'To: hector@test.local',
  `Subject: ${encodeHeader('Hola Héctor')}`,
  'Date: Tue, 27 Oct 2026 09:00:00 -0500',
  'Message-ID: <msg-11@test.local>',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hola, =C2=BFc=C3=B3mo est=C3=A1s? Te confirmo la reuni=C3=B3n del viernes.',
  ''
].join('\r\n');
const messages = { 11: Buffer.from(rawOld, 'utf8'), 12: Buffer.from(rawNew, 'utf8') };
const uids = [11, 12];
const commands = [];

/* Servidor IMAP TLS mínimo */
const imap = tls.createServer({ pfx: PFX, passphrase: PFX_PASS }, (socket) => {
  let buffer = '';
  socket.write('* OK mock IMAP listo\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (!line) continue;
      const [tag, ...rest] = line.split(' ');
      const command = rest.join(' ').toUpperCase();
      commands.push(command);
      if (command.startsWith('LOGIN')) socket.write(`${tag} OK LOGIN completado\r\n`);
      else if (command.startsWith('SELECT')) socket.write(`* 2 EXISTS\r\n* OK [UIDVALIDITY 1] válido\r\n${tag} OK [READ-ONLY] SELECT\r\n`);
      else if (command.startsWith('UID SEARCH')) socket.write(`* SEARCH ${uids.join(' ')}\r\n${tag} OK SEARCH\r\n`);
      else if (command.startsWith('UID FETCH')) {
        const uid = Number(/UID FETCH (\d+)/i.exec(rest.join(' '))?.[1] || 0);
        const raw = messages[uid];
        if (!raw) { socket.write(`${tag} OK FETCH vacío\r\n`); continue; }
        socket.write(`* 1 FETCH (UID ${uid} RFC822 {${raw.length}}\r\n`);
        socket.write(raw);
        socket.write(`)\r\n${tag} OK FETCH completado\r\n`);
      } else if (command.startsWith('LOGOUT')) socket.write(`* BYE adiós\r\n${tag} OK LOGOUT\r\n`);
      else socket.write(`${tag} NO orden desconocida\r\n`);
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => imap.listen(0, '127.0.0.1', resolve));
const imapPort = imap.address().port;

/* Servidor SMTP de prueba para cerrar el círculo aprobar → enviar. */
const smtpMessages = [];
const smtp = net.createServer((socket) => {
  let buffer = ''; let mode = 'command'; let current = '';
  const write = (line) => socket.write(`${line}\r\n`);
  write('220 mock SMTP listo');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (mode === 'data') {
        if (line === '.') { mode = 'command'; smtpMessages.push(current); current = ''; write('250 ok'); }
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
const dataDir = mkdtempSync(join(tmpdir(), 'agenda-imap-'));
const APP_SECRET = 'imap-e2e-secret';
const app = spawn(process.execPath, ['start.mjs', '--no-open'], {
  env: { ...process.env, APP_SECRET, DATA_DIR: dataDir, PORT: new URL(URL_APP).port, NO_OPEN: '1', WORKFLOWS_AUTOSTART: '0', CHANNELS_AUTOSTART: 'off', IMAP_CA_FILE: caPath, OPENAI_API_KEY: '' },
  stdio: 'ignore'
});
let chrome = null;
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
  const created = await api('POST', '/api/imap/accounts', {
    label: 'Bandeja de Héctor', email: 'hector@test.local', host: 'localhost', port: imapPort,
    user: 'hector@test.local', password: 'clave-imap-123'
  });
  check('Crea bandeja IMAP (201)', created.status === 201 && created.json?.item?.id, created.json?.item?.id || JSON.stringify(created.json).slice(0, 140));
  const account = created.json?.item;
  check('Nunca devuelve la contraseña', !JSON.stringify(created.json).includes('clave-imap-123') && account?.hasPassword === true);

  const smtpCreated = await api('POST', '/api/email/accounts', {
    label: 'Salida de Héctor', host: '127.0.0.1', port: smtpPort, secure: false, allowInsecure: true,
    user: 'hector@test.local', password: 'clave-smtp-123', fromName: 'Héctor Fabio Riascos C.', fromEmail: 'hector@test.local'
  });
  check('Cuenta SMTP lista para responder', smtpCreated.status === 201, JSON.stringify(smtpCreated.json).slice(0, 120));
  const test = await api('POST', `/api/imap/accounts/${account.id}/test`, {});
  check('Prueba de conexión IMAP (200)', test.status === 200 && test.json?.messages === 2, JSON.stringify(test.json).slice(0, 160));
  check('Último asunto decodificado', test.json?.lastSubject === 'Acta del predio', String(test.json?.lastSubject));

  const list = await api('GET', `/api/imap/accounts/${account.id}/messages?limit=2`);
  const items = list.json?.messages || [];
  check('Lee los últimos mensajes', list.status === 200 && items.length === 2, `items=${items.length}`);
  const newest = items[0] || {};
  check('Ordena del más reciente al más antiguo', newest.uid === 12, `uid=${newest.uid}`);
  check('Extrae remitente con nombre y correo', newest.from?.email === 'andres@test.local' && /Andrés/.test(newest.from?.name || ''), JSON.stringify(newest.from));
  check('Prefiere text/plain del multipart', /acta de liberación del predio/i.test(newest.text || ''), (newest.excerpt || '').slice(0, 100));
  check('Genera extracto para la lista', (newest.excerpt || '').length > 20);
  const older = items[1] || {};
  check('Decodifica quoted-printable y UTF-8', older.subject === 'Hola Héctor' && /cómo estás/i.test(older.text || ''), `${older.subject} · ${(older.text || '').slice(0, 60)}`);
  check('Solo lectura: usa BODY.PEEK o no marca leído', commands.every((command) => !command.includes('BODY[]')), commands.filter((c) => c.includes('FETCH')).join(' | ').slice(0, 100));

  const proposalsBefore = await api('GET', '/api/office/proposals');
  const preview = await api('POST', `/api/imap/accounts/${account.id}/messages/12/reply-proposal`, {
    instructions: 'Confirma que el acta estará lista el jueves.',
    preview: true
  });
  const proposalsAfterPreview = await api('GET', '/api/office/proposals');
  check('La previsualización no crea propuesta', preview.status === 200 && preview.json?.preview === true && !preview.json?.proposal && proposalsAfterPreview.json?.count === proposalsBefore.json?.count, JSON.stringify(preview.json).slice(0, 120));
  check('La previsualización trae asunto y cuerpo editables', /^Re:/.test(preview.json?.draft?.subject || '') && String(preview.json?.draft?.body || '').length > 20);

  const reply = await api('POST', `/api/imap/accounts/${account.id}/messages/12/reply-proposal`, {
    instructions: 'Confirma que el acta estará lista el jueves.'
  });
  const draft = reply.json?.draft || {};
  check('Propone respuesta sin enviar (202)', reply.status === 202 && reply.json?.status === 'pending_approval' && !!reply.json?.proposal?.id, JSON.stringify(reply.json).slice(0, 160));
  check('Mantiene el hilo en el asunto', /^Re: Acta del predio$/.test(draft.subject || ''), draft.subject);
  check('Firma con el nombre completo', /Héctor Fabio Riascos C\.\s*$/.test(String(draft.body || '').trim()), String(draft.body || '').slice(-80));  check('El borrador no filtra el encargo interno', !/(Instrucciones del jefe|Asunto:|Remitente:|Recibido:)/i.test(String(draft.body || '')), String(draft.body || '').replace(/\s+/g, ' ').slice(0, 110));
  check('El borrador es una respuesta natural', /Gracias por escribirme|Recibí tu mensaje/i.test(String(draft.body || '')) && /asunto|asunto/i.test('asunto'));
  check('El borrador va al destinatario del mensaje', reply.json?.proposal?.recipients?.includes('andres@test.local') || reply.json?.proposal?.to?.includes('andres@test.local'), JSON.stringify(reply.json?.proposal || {}).slice(0, 120));

  const proposalId = reply.json?.proposal?.id;
  const approved = await api('POST', `/api/office/proposals/${proposalId}/approve`, { by: 'jefe' });
  const executed = await api('POST', `/api/office/proposals/${proposalId}/execute`, approved.json?.code ? { code: approved.json.code } : {});
  check('Aprobar y ejecutar la respuesta', approved.status === 200 && executed.status === 200 && executed.json?.status === 'executed', JSON.stringify(executed.json).slice(0, 140));
  await waitFor(async () => smtpMessages.length >= 1, 8000, 'envío SMTP de la respuesta');
  const sent = smtpMessages[0] || '';
  check('La respuesta sale por SMTP al remitente', /To:.*andres@test\.local/i.test(sent) && /Subject:.*Re: Acta del predio/i.test(sent));  check('La respuesta va en el mismo hilo', /In-Reply-To:\s*<msg-12@test\.local>/i.test(sent) && /References:.*<msg-12@test\.local>/i.test(sent), (sent.split('\r\n').filter((line) => /^(In-Reply-To|References):/i.test(line)).join(' | ') || 'sin cabeceras'));
  check('El correo enviado lleva la firma de Héctor', /Héctor Fabio Riascos C\./i.test(Buffer.from((sent.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/) || [])[1] || '', 'base64').toString('utf8')) || /Héctor Fabio Riascos C\./i.test(sent));
  // UI: tarjeta IMAP, «Ver últimos» y «Crear tarea».
  const profileDir = mkdtempSync(join(tmpdir(), 'agenda-imap-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 20000, 'chrome');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let cdpId = 1;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params?.exceptionDetails?.text || 'exception');
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') pageErrors.push(message.params.entry.text || 'log');
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = cdpId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 25000);
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await cdp('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await cdp('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1200);
  await evaluate(`document.querySelector('.drawer-nav [data-nav="integrations"], [data-nav="integrations"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#imapAccountsList [data-imap-messages]'))`), 12000, 'tarjeta IMAP');
  check('La tarjeta IMAP lista la bandeja', true);
  const rowText = await evaluate(`document.querySelector('#imapAccountsList')?.textContent || ''`);
  check('Muestra el correo sin contraseña', rowText.includes('hector@test.local') && !rowText.includes('clave-imap-123'), rowText.replace(/\s+/g, ' ').slice(0, 110));
  await evaluate(`document.querySelector('#imapAccountsList [data-imap-messages]').click()`);
  await waitFor(async () => evaluate(`document.querySelectorAll('#imapMessages article').length >= 2`), 15000, 'mensajes');
  const inboxText = await evaluate(`document.querySelector('#imapMessages')?.textContent || ''`);
  check('«Ver últimos» muestra asuntos y remitente', inboxText.includes('Acta del predio') && inboxText.includes('Andrés'), inboxText.replace(/\s+/g, ' ').slice(0, 120));
  await evaluate(`document.querySelector('#imapMessages [data-imap-reply]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-prompt[open]'))`), 8000, 'diálogo de respuesta');
  await evaluate(`(() => { const input = document.querySelector('#promptForm [name="value"]'); if (!input) return false; input.value = 'Confirma que el acta estará lista el jueves.'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#promptForm').requestSubmit(); return true; })()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#imapReplyBody'))`), 20000, 'borrador editable');
  const draftText = await evaluate(`document.querySelector('#imapReplyBody')?.value || ''`);
  check('La UI previsualiza el borrador con firma', draftText.includes('Héctor Fabio Riascos C.'), draftText.slice(-80));  await evaluate(`document.querySelector('#imapReplyDraft')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const previewShot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-imap-borrador.png', Buffer.from(previewShot.data, 'base64'));
  await evaluate(`(() => { const body = document.querySelector('#imapReplyBody'); const subject = document.querySelector('#imapReplySubject'); if (!body || !subject) return false; body.value = 'Queda confirmado para el jueves. Te comparto el detalle en la mañana.\\n\\nHéctor Fabio Riascos C.'; body.dispatchEvent(new Event('input', { bubbles: true })); subject.value = 'Re: Acta del predio (jueves)'; return true; })()`);
  await evaluate(`document.querySelector('#imapReplyDraft [data-imap-create]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#imapReplyDraft [data-imap-office]'))`), 20000, 'propuesta creada');
  const createdText = await evaluate(`document.querySelector('#imapReplyDraft')?.textContent || ''`);
  check('La propuesta usa el texto editado', createdText.includes('Queda confirmado para el jueves') && /N2/.test(createdText) && /corregido por ti/.test(createdText), createdText.replace(/\s+/g, ' ').slice(0, 120));
  const proposals = await api('GET', '/api/office/proposals');
  check('El borrador editado llega a la Oficina', (proposals.json?.items || []).some((proposal) => String(proposal.body || '').includes('Queda confirmado para el jueves')));
  check('El borrador ofrece aprobarlo en Oficina', /Oficina/.test(createdText));
  await evaluate(`document.querySelector('#imapMessages [data-imap-task]').click()`);
  const tasks = await waitFor(async () => {
    const result = await api('GET', '/api/tasks');
    return result.json?.items?.length ? result.json.items : null;
  }, 12000, 'tarea');
  check('«Crear tarea» desde el correo', /^Responder:/.test(tasks[0]?.title || '') && tasks[0]?.origin === 'correo', JSON.stringify(tasks[0] || {}).slice(0, 140));
  await evaluate(`document.querySelector('#imapAccountsCard')?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  mkdirSync('docs/capturas', { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-imap-light.png', Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('#imapAccountsList [data-imap-auto]')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/imap/accounts');
    return result.json?.items?.[0]?.autoDraft === true;
  }, 10000, 'auto-borrador UI');
  check('La tarjeta activa el auto-borrador', true);
  check('La tarjeta ofrece redactar nuevos', await evaluate(`Boolean(document.querySelector('#imapAccountsList [data-imap-autodraft]'))`));
  await evaluate(`document.querySelector('[data-nav="office"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#officeProposals [data-office-act="edit"]'))`), 12000, 'Oficina con propuesta editable');
  check('La Oficina ofrece editar la propuesta', true);
  await evaluate(`document.querySelector('#officeProposals [data-office-act="edit"]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#dlg-proposal-edit[open]'))`), 8000, 'diálogo de revisión');  await sleep(300);
  const editShot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-oficina-revision.png', Buffer.from(editShot.data, 'base64'));
  await evaluate(`(() => { const form = document.querySelector('#proposalEditForm'); if (!form) return false; form.elements.subject.value = 'Re: Acta del predio (Oficina)'; form.elements.body.value = 'Texto revisado desde la Oficina.\\n\\nHéctor Fabio Riascos C.'; form.requestSubmit(); return true; })()`);
  const uiRevised = await waitFor(async () => {
    const result = await api('GET', '/api/office/proposals');
    const found = (result.json?.items || []).find((proposal) => String(proposal.body || '').includes('Texto revisado desde la Oficina.'));
    return found && Array.isArray(found.revisions) && found.revisions.length >= 1 ? found : null;
  }, 12000, 'revisión desde la Oficina');
  check('La Oficina guarda la revisión antes de aprobar', !!uiRevised && uiRevised.status === 'pending', JSON.stringify(uiRevised || {}).slice(0, 120));
  await evaluate(`document.querySelector('[data-nav="integrations"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#mailGuardCard #mailRuleForm'))`), 12000, 'tarjeta de reglas');
  await evaluate(`(() => {
    const form = document.querySelector('#mailRuleForm');
    form.elements.field.value = 'from';
    form.elements.match.value = 'domain';
    form.elements.value.value = 'spam.test';
    form.elements.action.value = 'quarantine';
    form.requestSubmit();
    return true;
  })()`);
  const uiRule = await waitFor(async () => {
    const result = await api('GET', '/api/mail/rules');
    return (result.json?.items || []).find((item) => item.value === 'spam.test') || null;
  }, 10000, 'regla desde la UI');
  check('La tarjeta crea reglas desde la UI', !!uiRule && uiRule.action === 'quarantine', JSON.stringify(uiRule || {}).slice(0, 120));
  await waitFor(async () => evaluate(`(document.querySelector('#mailRulesList')?.textContent || '').includes('spam.test') && Boolean(document.querySelector('#mailRulesList [data-mail-rule-delete]'))`), 10000, 'lista de reglas UI');
  await evaluate(`document.querySelector('#mailGuardCard')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const guardShot = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync('docs/capturas/vista-reglas-correo.png', Buffer.from(guardShot.data, 'base64'));  const ruleText = await evaluate(`document.querySelector('#mailRulesList')?.textContent || ''`);
  check('La regla aparece en la lista', /spam\.test/.test(ruleText) && /Dominio/i.test(ruleText));
  await evaluate(`document.querySelector('#mailRulesList [data-mail-rule-delete]')?.click()`);
  await waitFor(async () => {
    const result = await api('GET', '/api/mail/rules');
    return (result.json?.items || []).length === 0;
  }, 10000, 'quitar regla UI');
  check('La tarjeta quita reglas', true);
  const realErrors = pageErrors.filter((error) => !/favicon|manifest/i.test(error));
  check('UI IMAP sin errores de consola', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
  ws.close();

  // Correo nuevo: el chequeo lo detecta y "Ver últimos" lo reconoce.
  messages[13] = Buffer.from([
    'From: Nuevo Remitente <nuevo@test.local>',
    'To: hector@test.local',
    'Subject: Mensaje reciente',
    'Date: Wed, 28 Oct 2026 12:00:00 -0500',
    'Message-ID: <msg-13@test.local>',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Llegó un mensaje nuevo a la bandeja.',
    ''
  ].join('\r\n'), 'utf8');
  uids.push(13);
  const checked = await api('POST', `/api/imap/accounts/${account.id}/check`, {});
  check('Detecta correo nuevo sin leerlo', checked.status === 200 && checked.json?.newCount === 1 && checked.json?.lastUid === 13, JSON.stringify(checked.json).slice(0, 120));
  const listedNew = await api('GET', '/api/imap/accounts');
  check('La cuenta muestra el contador de nuevos', listedNew.json?.items?.[0]?.newCount === 1, JSON.stringify(listedNew.json?.items?.[0] || {}).slice(0, 140));
  const autoOn = await api('PATCH', `/api/imap/accounts/${account.id}`, { autoDraft: true });
  check('Activa el auto-borrador', autoOn.status === 200 && autoOn.json?.item?.autoDraft === true, JSON.stringify(autoOn.json?.item || {}).slice(0, 120));
  const badPatch = await api('PATCH', `/api/imap/accounts/${account.id}`, { autoDraft: 'si' });
  check('Rechaza un valor de autoDraft inválido', badPatch.status === 400 && badPatch.json?.error);
  const auto = await api('POST', `/api/imap/accounts/${account.id}/auto-draft`, {});
  const autoId = auto.json?.results?.[0]?.proposalId || null;
  check('Redacta una propuesta automática', auto.status === 200 && auto.json?.created === 1 && /^OF-/.test(autoId), JSON.stringify(auto.json).slice(0, 160));
  const autoProposals = await api('GET', '/api/office/proposals');
  const autoProposal = (autoProposals.json?.items || []).find((proposal) => proposal.id === autoId);
  check('La propuesta automática está en la Oficina y firmada', !!autoProposal && /Héctor Fabio Riascos C\./.test(String(autoProposal.body || '')), JSON.stringify(autoProposal || {}).slice(0, 140));
  const marker = 'Texto revisado por el jefe antes de aprobar.';
  const revisedAuto = await api('POST', `/api/office/proposals/${autoId}/revise`, {
    by: 'jefe',
    subject: 'Re: Mensaje reciente (revisado)',
    body: `${marker}\n\nHéctor Fabio Riascos C.`
  });
  check('Revisa el texto de la propuesta', revisedAuto.status === 200 && String(revisedAuto.json?.item?.body || '').includes(marker) && revisedAuto.json?.item?.revisions?.length === 1, JSON.stringify(revisedAuto.json?.item || {}).slice(0, 140));
  const revisedApprove = await api('POST', `/api/office/proposals/${autoId}/approve`, { by: 'jefe' });
  const revisedExecute = await api('POST', `/api/office/proposals/${autoId}/execute`, revisedApprove.json?.code ? { code: revisedApprove.json.code } : {});
  check('La versión revisada se aprueba y ejecuta', revisedApprove.status === 200 && revisedExecute.status === 200 && revisedExecute.json?.status === 'executed', JSON.stringify(revisedExecute.json).slice(0, 120));
  await waitFor(async () => smtpMessages.length >= 2, 8000, 'envío de la versión revisada');
  const revisedSent = smtpMessages.some((message) => {
    const encoded = (message.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/) || [])[1];
    const plain = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : message;
    return plain.includes(marker);
  });
  check('Sale el texto revisado, no el original', revisedSent);
  const autoAgain = await api('POST', `/api/imap/accounts/${account.id}/auto-draft`, {});
  check('No duplica propuestas en otra pasada', autoAgain.status === 200 && autoAgain.json?.created === 0);
  const latest = await api('GET', `/api/imap/accounts/${account.id}/messages?limit=1`);
  check('Ver el último reconoce el correo nuevo', latest.json?.messages?.[0]?.uid === 13);
  const afterRead = await api('GET', '/api/imap/accounts');
  check('Al leerlo el contador vuelve a cero', afterRead.json?.items?.[0]?.newCount === 0);
  messages[14] = Buffer.from([
    'From: Avisos <no-reply@test.local>',
    'To: hector@test.local',
    'Subject: Notificación automática',
    'Date: Wed, 28 Oct 2026 13:00:00 -0500',
    'Message-ID: <msg-14@test.local>',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Este es un aviso automático.',
    ''
  ].join('\r\n'), 'utf8');
  uids.push(14);
  await api('POST', `/api/imap/accounts/${account.id}/check`, {});
  const skipAuto = await api('POST', `/api/imap/accounts/${account.id}/auto-draft`, {});
  check('Omite remitentes automáticos', skipAuto.status === 200 && skipAuto.json?.created === 0 && /automático/i.test(String(skipAuto.json?.results?.[0]?.skipped || '')), JSON.stringify(skipAuto.json).slice(0, 140));
  await api('GET', `/api/imap/accounts/${account.id}/messages?limit=1`);

  // Reglas de correo y cuarentena: el auto-borrador no redacta spam.
  const rule = await api('POST', '/api/mail/rules', {
    field: 'from', match: 'contains', value: 'spam@', action: 'quarantine'
  });
  check('Crea una regla de correo', rule.status === 201 && /^MR-/.test(rule.json?.item?.id || ''), JSON.stringify(rule.json).slice(0, 120));
  messages[15] = Buffer.from([
    'From: Promo <spam@test.local>',
    'To: hector@test.local',
    'Subject: Gana dinero rápido',
    'Date: Wed, 28 Oct 2026 14:00:00 -0500',
    'Message-ID: <msg-15@test.local>',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Oferta irrepetible.',
    ''
  ].join('\r\n'), 'utf8');
  uids.push(15);
  await api('POST', `/api/imap/accounts/${account.id}/check`, {});
  const guarded = await api('POST', `/api/imap/accounts/${account.id}/auto-draft`, {});
  check('La regla evita redactar al spam', guarded.status === 200 && guarded.json?.created === 0 && guarded.json?.results?.[0]?.quarantined === true, JSON.stringify(guarded.json).slice(0, 160));
  const heldList = await api('GET', '/api/mail/quarantine?status=held');
  const held = heldList.json?.items?.[0];
  check('El mensaje queda en cuarentena', heldList.json?.total === 1 && /spam@test\.local/.test(held?.from?.email || '') && held?.status === 'held', JSON.stringify(held || {}).slice(0, 160));
  const released = await api('POST', `/api/mail/quarantine/${held?.id}/release`, { compose: true });
  check('Liberar redacta una propuesta', released.status === 200 && /^OF-/.test(released.json?.proposal?.id || '') && released.json?.item?.status === 'released', JSON.stringify(released.json).slice(0, 160));
  const releasedProposals = await api('GET', '/api/office/proposals');
  const releasedProposal = (releasedProposals.json?.items || []).find((proposal) => proposal.id === released.json?.proposal?.id);
  check('La propuesta liberada está firmada', !!releasedProposal && /Héctor Fabio Riascos C\./.test(String(releasedProposal.body || '')));
  await api('GET', `/api/imap/accounts/${account.id}/messages?limit=1`);
  const deleted = await api('DELETE', `/api/imap/accounts/${account.id}`);
  check('Elimina la bandeja', deleted.status === 200 && (await api('GET', '/api/imap/accounts')).json?.count === 0);
  const invalid = await api('POST', '/api/imap/accounts', { host: 'localhost', port: 143, email: 'x@y.com', user: 'x', password: 'z', secure: false });
  check('Rechaza IMAP sin TLS', invalid.status >= 400 && /TLS/i.test(invalid.json?.error || ''));
} catch (error) {
  failures += 1;
  console.log('FAIL  excepción —', error?.message || error);
} finally {
  try { chrome?.kill(); } catch {}
  try { app.kill(); } catch {}
  try { imap.close(); } catch {}
  try { smtp.close(); } catch {}
  await sleep(500);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { rmSync(join(caPath, '..'), { recursive: true, force: true }); } catch {}
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : failures + ' fallo(s)'}`);
  process.exit(failures ? 1 : 0);
}














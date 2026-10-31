#!/usr/bin/env node
/**
 * Autocheck de la Oficina (sin dependencias, sin red externa, sin tocar data/).
 *
 * Levanta la app real en proceso con un `DATA_DIR` temporal y un router aislado
 * que solo monta `lib/routes/office.mjs` (evita efectos de otros módulos), y
 * verifica el gate N0-N3, la firma HMAC, el código N3, el ledger y los modos.
 *
 * Uso: node lib/office/selfcheck.mjs
 * Salida: líneas PASS/FAIL + resumen; exit code 1 si algo falla.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TEMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-office-selfcheck-'));
const TEMP_ROUTES = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-office-routes-'));

// Entorno aislado ANTES de cargar store/app.
process.env.DATA_DIR = TEMP_DATA;
process.env.APP_SECRET = process.env.APP_SECRET || 'office-selfcheck-secret-1234';
process.env.HOST = '127.0.0.1';
process.env.LOG_LEVEL = 'error';
process.env.WA_ENABLED = 'false';
process.env.TELEGRAM_ENABLED = 'false';
process.env.EMAIL_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.OLLAMA_MODEL = '';

let pass = 0;
let fail = 0;

// El selfcheck provoca a propósito un 503 EXECUTOR_UNAVAILABLE; el logger de la
// app lo registra como error. Silenciamos solo ese caso esperado para que la
// salida PASS/FAIL quede limpia (el resto de errores sí se muestran).
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
  if (text.includes('EXECUTOR_UNAVAILABLE') || text.includes('No hay ejecutor disponible')) return;
  originalConsoleError(...args);
};

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

function writeIsolatedRouteModule() {
  const target = pathToFileURL(path.join(ROOT, 'lib', 'routes', 'office.mjs')).href;
  const file = path.join(TEMP_ROUTES, 'office.mjs');
  fs.writeFileSync(file, `export { name, priority, routes } from ${JSON.stringify(target)};\n`, 'utf8');
  return TEMP_ROUTES;
}

async function listenOnFreePort(handler, min = 3120, max = 3145) {
  for (let port = min; port <= max; port += 1) {
    const server = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return { server, port };
    } catch (error) {
      try { server.close(); } catch { /* ignore */ }
      if (error && error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No hay puerto libre entre 3120 y 3145');
}

let server = null;
let base = '';

async function request(method, route, body) {
  const init = { method, headers: { connection: 'close' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text, headers: response.headers };
}

async function create(input, extra = {}) {
  return request('POST', '/api/office/proposals', { ...input, ...extra });
}

function mutateStore(fn) {
  // store se importa dinámicamente tras fijar DATA_DIR.
  // eslint-disable-next-line no-undef
  return storeRef.mutate(fn, { label: 'office-selfcheck-tamper' });
}

let storeRef = null;

async function main() {
  writeIsolatedRouteModule();
  const { createApp } = await import('../http/app.mjs');
  storeRef = (await import('../store.mjs')).store;
  const { registerExecutor, unregisterExecutor } = await import('./executors.mjs');
  const app = await createApp({ rootDir: ROOT, routesDir: TEMP_ROUTES });
  const listening = await listenOnFreePort(app.handler);
  server = listening.server;
  base = `http://127.0.0.1:${listening.port}`;
  console.log(`Oficina selfcheck en ${base} (DATA_DIR temporal)`);

  /* 1. Organigrama ------------------------------------------------- */
  const roster = await request('GET', '/api/office/roster');
  check('GET /api/office/roster 200', roster.status === 200, roster.status);
  check('roster devuelve 7 roles', (roster.json?.items || []).length === 7, roster.json?.items?.length);
  const roles = roster.json?.items || [];
  const expectedRoles = ['chief_of_staff', 'agenda', 'correspondencia', 'documentos', 'research', 'qa', 'auditoria'];
  check('IDs de rol exactos', expectedRoles.every((id) => roles.some((role) => role.id === id)), roles.map((role) => role.id));
  check('cada rol tiene los campos declarativos', roles.every((role) => typeof role.nombre === 'string' && Array.isArray(role.capacidades) && typeof role.puede_proponer === 'boolean' && typeof role.puede_ejecutar === 'boolean' && typeof role.canal_de_salida === 'string'));

  /* 2. Modo por defecto ------------------------------------------- */
  const mode0 = await request('GET', '/api/office/mode');
  check('modo por defecto asistido', mode0.status === 200 && mode0.json?.mode === 'asistido', mode0.json?.mode);

  /* 3. N0 lectura automática -------------------------------------- */
  const n0 = await create({ kind: 'read', channel: 'none', recipients: [], subject: 'Resumen', body: 'Resume mi día.' });
  check('N0 creado 201', n0.status === 201, n0.status);
  check('N0 nivel y estado', n0.json?.item?.level === 'N0' && n0.json?.item?.status === 'executed', n0.json?.item && { level: n0.json.item.level, status: n0.json.item.status });
  check('N0 auto ejecutado con read-only', n0.json?.item?.execution?.executor === 'read', n0.json?.item?.execution);

  /* 4. N1 borrador automático + undo ------------------------------ */
  const n1 = await create({ kind: 'note', channel: 'document', recipients: [], subject: 'Nota interna', body: 'Borrador de nota.' });
  check('N1 nivel y auto-ejecutado', n1.json?.item?.level === 'N1' && n1.json?.item?.status === 'executed', n1.json?.item && { level: n1.json.item.level, status: n1.json.item.status });
  check('N1 tiene ventana de deshacer', typeof n1.json?.item?.undoUntil === 'string' && Date.parse(n1.json.item.undoUntil) > Date.now(), n1.json?.item?.undoUntil);
  const undone = await request('POST', `/api/office/proposals/${n1.json?.item?.id}/undo`, { by: 'jefe' });
  check('N1 undo → reverted', undone.status === 200 && undone.json?.item?.status === 'reverted', undone.json?.item?.status);

  /* 5. N2: sin approve no ejecuta; approve+execute OK; doble execute */
  const recipient = 'cliente@externo.com';
  const n2 = await create({ kind: 'document', channel: 'document', recipients: [recipient], subject: 'Propuesta comercial', body: 'Adjunto la propuesta para revisión.', attachments: ['propuesta.pdf'] });
  const n2id = n2.json?.item?.id;
  check('N2 nivel pending (asistido)', n2.json?.item?.level === 'N2' && n2.json?.item?.status === 'pending', n2.json?.item && { level: n2.json.item.level, status: n2.json.item.status });
  check('N2 flags explicables', ['EXTERNAL_RECIPIENT', 'NEW_CONTACT', 'ATTACHMENTS'].every((flag) => (n2.json?.item?.flags || []).includes(flag)), n2.json?.item?.flags);
  check('N2 tarjeta compacta', typeof n2.json?.item?.card?.text === 'string' && n2.json.item.card.actions.includes('approve'), n2.json?.item?.card);
  const early = await request('POST', `/api/office/proposals/${n2id}/execute`, {});
  check('N2 execute sin approve → 409 NOT_APPROVED', early.status === 409 && early.json?.code === 'NOT_APPROVED', early.json);
  const approved = await request('POST', `/api/office/proposals/${n2id}/approve`, { by: 'jefe', note: 'visto bueno' });
  check('N2 approve 200 con firma HMAC', approved.status === 200 && /^[a-f0-9]{64}$/.test(approved.json?.approval?.signature || '') && typeof approved.json?.approval?.nonce === 'string', approved.json?.approval);
  check('aprobación TTL ~30 min', (() => { const ms = Date.parse(approved.json?.approval?.expiresAt) - Date.parse(approved.json?.approval?.issuedAt); return ms >= 29 * 60 * 1000 && ms <= 31 * 60 * 1000; })(), approved.json?.approval);
  const executed = await request('POST', `/api/office/proposals/${n2id}/execute`, {});
  check('N2 execute tras approve 200', executed.status === 200 && executed.json?.item?.status === 'executed', executed.json?.item?.status);
  check('ejecutor document inyectado', executed.json?.item?.execution?.executor === 'document', executed.json?.item?.execution);
  const again = await request('POST', `/api/office/proposals/${n2id}/execute`, {});
  check('doble execute → 409 ALREADY_EXECUTED', again.status === 409 && again.json?.code === 'ALREADY_EXECUTED', again.json);

  /* 6. Payload alterado → firma inválida --------------------------- */
  const tamper = await create({ kind: 'document', channel: 'document', recipients: [recipient], subject: 'A revisar', body: 'Contenido original.', attachments: ['anexo.pdf'] });
  const tamperId = tamper.json?.item?.id;
  await request('POST', `/api/office/proposals/${tamperId}/approve`, { by: 'jefe' });
  await mutateStore((data) => {
    const proposal = data.office.proposals.find((item) => item.id === tamperId);
    if (proposal) proposal.body = 'Contenido ALTERADO después de aprobar.';
  });
  const tamperedExecute = await request('POST', `/api/office/proposals/${tamperId}/execute`, {});
  check('payload alterado → 409 SIGNATURE_INVALID', tamperedExecute.status === 409 && tamperedExecute.json?.code === 'SIGNATURE_INVALID', tamperedExecute.json);
  const tamperedState = await request('GET', `/api/office/proposals/${tamperId}`);
  check('payload alterado no se marca ejecutada', tamperedState.json?.item?.status === 'approved', tamperedState.json?.item?.status);

  /* 7. TTL de aprobación ------------------------------------------ */
  const expired = await create({ kind: 'document', channel: 'document', recipients: [recipient], subject: 'TTL', body: 'Prueba TTL.', attachments: ['x.pdf'] });
  const expiredId = expired.json?.item?.id;
  await request('POST', `/api/office/proposals/${expiredId}/approve`, { by: 'jefe' });
  await mutateStore((data) => {
    const proposal = data.office.proposals.find((item) => item.id === expiredId);
    if (proposal?.approval) proposal.approval.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
  const expiredExecute = await request('POST', `/api/office/proposals/${expiredId}/execute`, {});
  check('aprobación caducada → 409 APPROVAL_EXPIRED', expiredExecute.status === 409 && expiredExecute.json?.code === 'APPROVAL_EXPIRED', expiredExecute.json);

  /* 8. N3: código de 6 caracteres --------------------------------- */
  const n3 = await create({ kind: 'document', channel: 'document', recipients: [recipient], subject: 'Pago de factura', body: 'Adjunto contrato legal y factura por el pago del anticipo.' });
  const n3id = n3.json?.item?.id;
  check('N3 por dinero/legal', n3.json?.item?.level === 'N3' && ['MONEY', 'LEGAL'].every((flag) => (n3.json?.item?.flags || []).includes(flag)), n3.json?.item && { level: n3.json.item.level, flags: n3.json.item.flags });
  const n3approved = await request('POST', `/api/office/proposals/${n3id}/approve`, { by: 'jefe' });
  const code = n3approved.json?.code;
  check('N3 approve entrega código de 6', typeof code === 'string' && code.length === 6, code);
  const noCode = await request('POST', `/api/office/proposals/${n3id}/execute`, {});
  check('N3 sin código → 400 CODE_REQUIRED', noCode.status === 400 && noCode.json?.code === 'CODE_REQUIRED', noCode.json);
  const badCode = await request('POST', `/api/office/proposals/${n3id}/execute`, { code: 'XXXXXX' });
  check('N3 código incorrecto → 409 INVALID_CODE', badCode.status === 409 && badCode.json?.code === 'INVALID_CODE', badCode.json);
  const n3executed = await request('POST', `/api/office/proposals/${n3id}/execute`, { code });
  check('N3 código correcto → executed', n3executed.status === 200 && n3executed.json?.item?.status === 'executed', n3executed.json?.item?.status);
  const n3again = await request('POST', `/api/office/proposals/${n3id}/execute`, { code });
  check('N3 no reutiliza ejecución', n3again.status === 409, n3again.json?.code);

  /* 9. Sin ejecutor → 503 y no marca ejecutada -------------------- */
  const noExec = await create({ kind: 'email', channel: 'email', recipients: [recipient], subject: 'Correo', body: 'Mensaje sin Gmail conectado.' });
  const noExecId = noExec.json?.item?.id;
  await request('POST', `/api/office/proposals/${noExecId}/approve`, { by: 'jefe' });
  const unavailable = await request('POST', `/api/office/proposals/${noExecId}/execute`, {});
  check('sin ejecutor → 503 EXECUTOR_UNAVAILABLE', unavailable.status === 503 && unavailable.json?.code === 'EXECUTOR_UNAVAILABLE', unavailable.json);
  const noExecState = await request('GET', `/api/office/proposals/${noExecId}`);
  check('503 NO marca ejecutada', noExecState.json?.item?.status === 'approved', noExecState.json?.item?.status);

  /* 10. Rechazo --------------------------------------------------- */
  const reject = await create({ kind: 'document', channel: 'document', recipients: [recipient], subject: 'Rechazo', body: 'Esto se rechaza.', attachments: ['x.pdf'] });
  const rejectId = reject.json?.item?.id;
  const rejected = await request('POST', `/api/office/proposals/${rejectId}/reject`, { by: 'jefe', reason: 'no aplica' });
  check('reject 200', rejected.status === 200 && rejected.json?.item?.status === 'rejected', rejected.json?.item?.status);
  const rejectExecute = await request('POST', `/api/office/proposals/${rejectId}/execute`, {});
  check('execute rechazada → 409', rejectExecute.status === 409, rejectExecute.json?.code);

  /* 11. Modos cambian el comportamiento de la misma propuesta ----- */
  const sameInput = { kind: 'document', channel: 'document', recipients: [recipient], subject: 'Misma propuesta', body: 'Cuerpo idéntico.', attachments: ['x.pdf'] };
  const setMode = async (mode) => request('POST', '/api/office/mode', { mode, by: 'selfcheck' });
  await setMode('asistido');
  const asistido = await create(sameInput);
  check('asistido: N2 pending', asistido.json?.item?.status === 'pending', asistido.json?.item?.status);
  await setMode('total');
  const total = await create(sameInput);
  check('total: N2 automático ejecutado', total.json?.item?.status === 'executed' && total.json?.auto === true, { status: total.json?.item?.status, auto: total.json?.auto });
  await setMode('autonomo');
  const autonomo = await create(sameInput);
  check('autonomo: N2 auto (riesgo≤3, conocido, voz≥0.75)', autonomo.json?.item?.status === 'executed' && autonomo.json?.auto === true, { status: autonomo.json?.item?.status, risk: autonomo.json?.item?.risk?.score, voice: autonomo.json?.item?.voice });
  await setMode('sombra');
  const sombra = await create(sameInput);
  check('sombra: N2 retenida', sombra.json?.item?.status === 'held', sombra.json?.item?.status);
  const sombraExecute = await request('POST', `/api/office/proposals/${sombra.json?.item?.id}/execute`, {});
  check('sombra: execute bloqueado (SHADOW_MODE)', sombraExecute.status === 409 && sombraExecute.json?.code === 'SHADOW_MODE', sombraExecute.json);
  const modeView = await request('GET', '/api/office/mode');
  check('modo persistido en store (sombra)', modeView.json?.mode === 'sombra', modeView.json?.mode);
  await setMode('asistido');

  /* 12. Ejecutor inyectable --------------------------------------- */
  registerExecutor('webhook', {
    name: 'selfcheck-webhook',
    available: async () => true,
    execute: async (proposal) => ({ ok: true, executor: 'selfcheck-webhook', detail: 'enviado por fake', artifacts: [{ type: 'fake', id: proposal.id }] })
  });
  const fake = await create({ kind: 'webhook', channel: 'webhook', recipients: [recipient], subject: 'Webhook', body: 'Prueba de ejecutor inyectable.' });
  const fakeId = fake.json?.item?.id;
  await request('POST', `/api/office/proposals/${fakeId}/approve`, { by: 'jefe' });
  const fakeExecuted = await request('POST', `/api/office/proposals/${fakeId}/execute`, {});
  check('ejecutor inyectado ejecuta', fakeExecuted.status === 200 && fakeExecuted.json?.item?.execution?.executor === 'webhook', fakeExecuted.json?.item?.execution);
  unregisterExecutor('webhook');

  /* 13. Parseo humano --------------------------------------------- */
  const parseOk = await request('POST', '/api/office/parse', { text: 'dale' });
  check('parse "dale" → approve', parseOk.json?.decision === 'approve', parseOk.json);
  const parseNo = await request('POST', '/api/office/parse', { text: 'no' });
  check('parse "no" → reject', parseNo.json?.decision === 'reject', parseNo.json);
  const parseFix = await request('POST', '/api/office/parse', { text: 'corrige: pon 10:00' });
  check('parse "corrige:" → correct', parseFix.json?.decision === 'correct' && parseFix.json?.correction === 'pon 10:00', parseFix.json);

  /* 14. Ledger: verify, list, export ------------------------------ */
  const ledger = await request('GET', '/api/office/ledger?limit=10');
  check('GET ledger 200 con items', ledger.status === 200 && Array.isArray(ledger.json?.items) && ledger.json.items.length > 0 && ledger.json.total > 10, ledger.json && { count: ledger.json.count, total: ledger.json.total });
  const verify1 = await request('GET', '/api/office/ledger/verify');
  check('ledger verify OK (cadena íntegra)', verify1.status === 200 && verify1.json?.ok === true && verify1.json?.entries > 0 && Array.isArray(verify1.json?.broken) && verify1.json.broken.length === 0, verify1.json);
  const exported = await request('GET', '/api/office/ledger/export');
  check('ledger export descargable', exported.status === 200 && (exported.headers.get('content-disposition') || '').includes('attachment') && Array.isArray(exported.json?.entries), { status: exported.status, disposition: exported.headers.get('content-disposition') });

  /* 15. Ledger detecta manipulación ------------------------------- */
  await mutateStore((data) => {
    if (Array.isArray(data.office?.ledger) && data.office.ledger.length) {
      data.office.ledger[0].payloadHash = 'f'.repeat(64);
    }
  });
  const verify2 = await request('GET', '/api/office/ledger/verify');
  check('ledger detecta manipulación', verify2.status === 200 && verify2.json?.ok === false && verify2.json?.broken?.length > 0, verify2.json);

  /* 16. Validación de entrada ------------------------------------- */
  const invalidChannel = await create({ kind: 'email', channel: 'carrier-pigeon', recipients: ['a@b.com'], body: 'x' });
  check('canal inválido → 400', invalidChannel.status === 400, invalidChannel.json);
  const noRecipients = await create({ kind: 'email', channel: 'email', recipients: [], body: 'x' });
  check('email sin destinatarios → 400', noRecipients.status === 400 && noRecipients.json?.code === 'REQUIRED', noRecipients.json);
  const unknownField = await create({ kind: 'note', channel: 'document', body: 'x', hack: true });
  check('campo desconocido → 400', unknownField.status === 400 && unknownField.json?.code === 'UNKNOWN_FIELD', unknownField.json);
  const badStatus = await request('GET', '/api/office/proposals?status=inventado');
  check('status de filtro inválido → 400', badStatus.status === 400, badStatus.json);
  const missing = await request('GET', '/api/office/proposals/OF-9999');
  check('propuesta inexistente → 404', missing.status === 404, missing.status);

  const summary = await request('GET', '/api/office/status');
  check('GET /api/office/status 200', summary.status === 200 && summary.json?.proposals >= 10, summary.json && { proposals: summary.json.proposals });
}

try {
  await main();
} catch (error) {
  fail += 1;
  console.log(`FAIL  excepción no controlada :: ${error?.stack || error?.message || error}`);
  if (server) process.exitCode = 1;
} finally {
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch { /* ignore */ }
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(TEMP_ROUTES, { recursive: true, force: true }); } catch { /* ignore */ }
}

const total = pass + fail;
console.log(`\nSELFCHECK ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${total})`);
if (fail > 0) process.exitCode = 1;

#!/usr/bin/env node
/**
 * Autochequeo ACL t44: matriz de 10 casos, 0 escapes, etiquetas auditadas,
 * defaults, guard y rutas. Usa DATA_DIR temporal y nunca el dato real.
 *
 * Uso: node lib/acl/selfcheck.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmpRoot = path.join(os.tmpdir(), `agenda-acl-selfcheck-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.DATA_DIR = tmpRoot;
process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
process.env.APP_SECRET = process.env.APP_SECRET || 'acl-selfcheck-secret';
delete process.env.ACL_OWN_DOMAINS;
delete process.env.OFFICE_OWN_DOMAINS;
delete process.env.ACL_INTERNAL_CONTACTS;
delete process.env.OFFICE_INTERNAL_CONTACTS;

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const results = [];
function check(name, condition, evidence = '') {
  results.push({ name, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  [${evidence}]` : ''}`);
}

const { store } = await imp('lib/store.mjs');
const constants = await imp('lib/acl/constants.mjs');
const contextModule = await imp('lib/acl/context.mjs');
const policy = await imp('lib/acl/policy.mjs');
const state = await imp('lib/acl/state.mjs');
const guard = await imp('lib/acl/guard.mjs');
const aclRoutes = await imp('lib/routes/acl.mjs');

// Contexto de prueba: dominio propio, contacto interno explícito y un contacto
// externo "conocido" que NO debe promoverse a interno.
await store.mutate((data) => {
  data.acl = {
    documents: {},
    defaults: { document: 'interno', proposal: 'interno' },
    ownDomains: ['empresa.test'],
    internalContacts: ['jefe@empresa.test'],
    ledger: []
  };
  data.office = {
    ...(data.office && typeof data.office === 'object' ? data.office : {}),
    contacts: ['cliente@gmail.com']
  };
});

const own = 'ana@empresa.test';
const external = 'cliente@gmail.com';
const internalContact = 'jefe@empresa.test';

// ---------------------------------------------------------------------------
// 1. Clasificación
// ---------------------------------------------------------------------------
check('dominio propio → interno', policy.classifyRecipient(own) === 'interno', policy.classifyRecipient(own));
check('dominio externo → externo', policy.classifyRecipient(external) === 'externo', policy.classifyRecipient(external));
check('contacto interno explícito → interno', policy.classifyRecipient(internalContact) === 'interno', policy.classifyRecipient(internalContact));
check('contacto conocido externo NO se vuelve interno', policy.classifyRecipient(external) === 'externo' && contextModule.contextFromData(store.get()).knownContacts.size >= 1);
check('teléfono/URL se trata como externo', policy.classifyRecipient('+57 300 123 4567') === 'externo' && policy.classifyRecipient('https://example.com') === 'externo');
check('correo inválido → externo (seguro)', policy.classifyRecipient('no-es-correo') === 'externo');

// ---------------------------------------------------------------------------
// 2. Matriz de 10 casos
// ---------------------------------------------------------------------------
const cases = [
  {
    id: 'público→externo', input: { label: 'público', channel: 'email', recipients: [external] },
    expected: { allowed: true, level: 'N0', requiresConfirmation: false, audience: 'externo' }
  },
  {
    id: 'público→interno', input: { label: 'público', channel: 'document', recipients: [own] },
    expected: { allowed: true, level: 'N0', requiresConfirmation: false, audience: 'interno' }
  },
  {
    id: 'interno→interno', input: { label: 'interno', channel: 'email', recipients: [own] },
    expected: { allowed: true, level: 'N1', requiresConfirmation: false, audience: 'interno' }
  },
  {
    id: 'interno→externo', input: { label: 'interno', channel: 'email', recipients: [external] },
    expected: { allowed: true, level: 'N2', requiresConfirmation: true, audience: 'externo' }
  },
  {
    id: 'interno→mixto', input: { label: 'interno', channel: 'email', recipients: [own, external] },
    expected: { allowed: true, level: 'N2', requiresConfirmation: true, audience: 'mixto' }
  },
  {
    id: 'reservado→externo sin confirmar', input: { label: 'reservado', channel: 'email', recipients: [external], confirmedReserved: false },
    expected: { allowed: false, level: 'N3', requiresConfirmation: true, audience: 'externo' }
  },
  {
    id: 'reservado→externo confirmado', input: { label: 'reservado', channel: 'email', recipients: [external], confirmedReserved: true },
    expected: { allowed: true, level: 'N3', requiresConfirmation: false, audience: 'externo' }
  },
  {
    id: 'reservado→interno', input: { label: 'reservado', channel: 'email', recipients: [own] },
    expected: { allowed: true, level: 'N2', requiresConfirmation: false, audience: 'interno' }
  },
  {
    id: 'reservado→mixto sin confirmar', input: { label: 'reservado', channel: 'email', recipients: [own, external], confirmedReserved: false },
    expected: { allowed: false, level: 'N3', requiresConfirmation: true, audience: 'mixto' }
  },
  {
    id: 'sin etiqueta → default interno → externo', input: { channel: 'email', recipients: [external] },
    expected: { allowed: true, level: 'N2', requiresConfirmation: true, audience: 'externo', label: 'interno' }
  }
];

let matrixPassed = 0;
const decisions = [];
for (const testCase of cases) {
  const decision = policy.decide(testCase.input);
  decisions.push({ ...testCase, decision });
  const matches = Object.entries(testCase.expected).every(([key, expected]) => decision[key] === expected);
  if (matches) matrixPassed += 1;
  check(`matriz: ${testCase.id}`, matches,
    `allowed=${decision.allowed} level=${decision.level} conf=${decision.requiresConfirmation} audience=${decision.audience}`);
}
check('matriz 10/10 casos', matrixPassed === 10, `${matrixPassed}/10`);

// Cero escapes: cualquier reservado con externos y sin confirmación debe quedar bloqueado.
const reservedExternal = decisions.filter(({ decision }) => decision.label === 'reservado'
  && decision.externals.length > 0 && decision.confirmedReserved === false);
const escapes = reservedExternal.filter(({ decision }) => decision.allowed === true);
check('0 escapes reservado→externo sin confirmación', reservedExternal.length >= 2 && escapes.length === 0,
  `${reservedExternal.length} casos reservados-externos sin confirmar, ${escapes.length} allowed=true`);

// Confirmación por string también se normaliza.
check('confirmedReserved:"true" se normaliza', policy.decide({ label: 'reservado', recipients: [external], confirmedReserved: 'true' }).allowed === true);

// ---------------------------------------------------------------------------
// 3. API: etiquetar, auditar, defaults, guard
// ---------------------------------------------------------------------------
function makeCtx({ method = 'GET', pathname = '/', query = {}, params = {}, body = undefined }) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  return {
    method, path: pathname, params, query: search, requestId: 'acl-selfcheck',
    url: new URL(`http://localhost${pathname}${search.toString() ? `?${search}` : ''}`),
    _body: body,
    async body() { return this._body === undefined ? {} : this._body; },
    json(status, payload) { this.response = { status, payload }; return status; },
    text(status, payload, contentType, headers) { this.response = { status, payload, contentType, headers }; return status; }
  };
}
async function callRoute(method, pathname, options = {}) {
  const entry = aclRoutes.routes.find((item) => item.method === method && item.path === pathname);
  if (!entry) throw new Error(`Ruta no encontrada: ${method} ${pathname}`);
  const ctx = makeCtx({ method, pathname, ...options });
  await entry.handler(ctx);
  return ctx.response;
}

let response = await callRoute('PUT', '/api/acl/documents/:docId', {
  params: { docId: 'DOC-RESERVADO-1' },
  body: { label: 'reservado', owner: 'Ana', by: 'qa-acl' }
});
check('PUT etiqueta documento', response.status === 200 && response.payload.item.label === 'reservado', JSON.stringify(response.payload));
const stored = store.get().acl.documents['DOC-RESERVADO-1'];
check('modelo data.acl.documents guarda label/owner/by', stored?.label === 'reservado' && stored?.owner === 'Ana' && stored?.by === 'qa-acl');
check('ledger ACL registra acl.change', store.get().acl.ledger.some((entry) => entry.action === 'acl.change'
  && entry.payload.docId === 'DOC-RESERVADO-1' && entry.payload.label === 'reservado'));
check('ledger oficina registra acl.change', Array.isArray(store.get().office?.ledger)
  && store.get().office.ledger.some((entry) => entry.action === 'acl.change' && entry.payload.docId === 'DOC-RESERVADO-1'));

response = await callRoute('GET', '/api/acl/documents/:docId', { params: { docId: 'DOC-RESERVADO-1' } });
check('GET documento devuelve etiqueta efectiva', response.status === 200 && response.payload.item.effectiveLabel === 'reservado', JSON.stringify(response.payload));
response = await callRoute('GET', '/api/acl/documents/:docId', { params: { docId: 'DOC-SIN-ETIQUETA' } });
check('GET documento sin etiqueta aplica default', response.status === 200 && response.payload.item.label === null && response.payload.item.effectiveLabel === 'interno');

response = await callRoute('POST', '/api/acl/check', {
  body: { docId: 'DOC-RESERVADO-1', channel: 'email', recipients: [external] }
});
check('check doc reservado→externo bloquea', response.status === 200 && response.payload.allowed === false && response.payload.level === 'N3', JSON.stringify({ allowed: response.payload.allowed, level: response.payload.level }));
response = await callRoute('POST', '/api/acl/check', {
  body: { docId: 'DOC-RESERVADO-1', channel: 'email', recipients: [external], confirmedReserved: true }
});
check('check doc reservado→externo confirmado permite N3', response.status === 200 && response.payload.allowed === true && response.payload.level === 'N3');
response = await callRoute('POST', '/api/acl/check', {
  body: { label: 'público', channel: 'email', recipients: [external] }
});
check('check público→externo permite N0', response.status === 200 && response.payload.allowed === true && response.payload.level === 'N0');

response = await callRoute('POST', '/api/acl/defaults', { body: { document: 'público', by: 'qa-acl' } });
check('POST defaults público', response.status === 200 && response.payload.item.document === 'público');
check('ledger ACL registra acl.defaults', store.get().acl.ledger.some((entry) => entry.action === 'acl.defaults'));
response = await callRoute('POST', '/api/acl/check', {
  body: { docId: 'DOC-SIN-ETIQUETA-2', channel: 'email', recipients: [external] }
});
check('default público se respeta en check', response.status === 200 && response.payload.allowed === true && response.payload.level === 'N0');

// El documento etiquetado conserva su etiqueta aunque el default cambie.
response = await callRoute('POST', '/api/acl/check', {
  body: { docId: 'DOC-RESERVADO-1', channel: 'email', recipients: [external] }
});
check('documento conserva reservado ante default público', response.payload.allowed === false && response.payload.label === 'reservado');

response = await callRoute('GET', '/api/acl/status', {});
check('GET /api/acl/status', response.status === 200 && response.payload.item.defaults.document === 'público'
  && response.payload.item.documents >= 1 && response.payload.item.classification.ownDomains.includes('empresa.test'));
response = await callRoute('GET', '/api/acl/policy', {});
check('GET /api/acl/policy expone matriz y hardBlock', response.status === 200
  && response.payload.item.rules.some((rule) => rule.label === 'reservado' && rule.allowed === false)
  && /hardBlock/.test(JSON.stringify(response.payload.item.enforcement)));

// Guard reutilizable: docId manda sobre un label explícito para evitar bypass.
const guardBlocked = guard.guardOutbound({
  docId: 'DOC-RESERVADO-1', label: 'público', channel: 'email', recipients: [external]
});
check('guard: docId manda sobre label explícito', guardBlocked.allowed === false && guardBlocked.level === 'N3' && guardBlocked.label === 'reservado');
const guardConfirmed = guard.guardOutbound({
  docId: 'DOC-RESERVADO-1', channel: 'email', recipients: [external], confirmedReserved: true
});
check('guard: reservado confirmado N3 permitido', guardConfirmed.allowed === true && guardConfirmed.requiresCode === true);
try {
  guard.assertOutbound({ docId: 'DOC-RESERVADO-1', recipients: [external] });
  check('assertOutbound bloquea reservado sin confirmar', false);
} catch (error) {
  check('assertOutbound bloquea reservado sin confirmar', error.code === 'ACL_BLOCKED' && error.status === 403);
}

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------
try { await store.flush?.(); } catch { /* noop */ }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows puede retener handles */ }
const failed = results.filter((result) => !result.ok);
console.log(`\n=== ACL SELFCHECK === ${results.length} checks, ${failed.length} failed`);
if (failed.length) console.log(failed.map((result) => `- ${result.name}`).join('\n'));
process.exit(failed.length ? 1 : 0);

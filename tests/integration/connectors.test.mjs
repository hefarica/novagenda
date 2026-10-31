/**
 * Tests de conectores externos gobernados (t51).
 *
 * Cubre: catálogo, allowlist de endpoints, token cifrado y no expuesto,
 * prueba de salud contra fixture local, invocación de lectura, gate de la
 * Oficina para efectos, ejecución tras aprobación, borrado y conectores
 * delegados (Drive/MCP) sin ejecutar comandos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api, startMockServer } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-connectors-');
const { store } = await importLib('lib/store.mjs');
const app = await startTestApp();

const SECRET = 'QA-CONNECTOR-SECRET-9f3a2b7c';
const fixtureRequests = [];
let requireToken = false;

const fixture = await startMockServer(async (req, body, reply) => {
  const record = {
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization || null,
    body: body.toString('utf8')
  };
  fixtureRequests.push(record);
  if (requireToken && record.authorization !== `Bearer ${SECRET}`) {
    return reply(401, { error: 'token requerido' });
  }
  if (req.url === '/redirect') return reply(302, { redirect: '/otro' });
  if (req.url === '/big') return reply(200, { data: 'x'.repeat(4000) });
  return reply(200, { ok: true, method: record.method, path: record.url });
});

test.after(async () => {
  await app.close();
  await fixture.close();
});

async function createConnector(overrides = {}) {
  const response = await api(app.base, 'POST', '/api/studio/connectors', {
    kind: 'webhook',
    name: `Conector QA ${Math.random().toString(36).slice(2, 7)}`,
    endpoint: fixture.url,
    ...overrides
  });
  assert.equal(response.status, 201, response.text.slice(0, 400));
  return response.json.item;
}

function requestsTo(pathPart, method = null) {
  return fixtureRequests.filter((request) => request.url.startsWith(pathPart) && (!method || request.method === method));
}

test('catálogo inicial y validación de endpoints (allowlist)', async () => {
  const list = await api(app.base, 'GET', '/api/studio/connectors');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.items.length, 0);
  assert.equal(list.json.catalog.length, 4);
  assert.deepEqual(list.json.catalog.map((entry) => entry.kind).sort(), ['drive', 'github', 'mcp', 'webhook']);

  const httpExternal = await api(app.base, 'POST', '/api/studio/connectors', {
    kind: 'webhook', name: 'externo', endpoint: 'http://example.com/hook'
  });
  assert.equal(httpExternal.status, 400, httpExternal.text);
  assert.equal(httpExternal.json.code, 'CONNECTOR_ENDPOINT_NOT_ALLOWED');

  const fileUrl = await api(app.base, 'POST', '/api/studio/connectors', {
    kind: 'webhook', name: 'archivo', endpoint: 'file:///etc/passwd'
  });
  assert.equal(fileUrl.status, 400, fileUrl.text);
  assert.equal(fileUrl.json.code, 'CONNECTOR_ENDPOINT_NOT_ALLOWED');

  const credentials = await api(app.base, 'POST', '/api/studio/connectors', {
    kind: 'webhook', name: 'credenciales', endpoint: 'https://user:pass@example.com/hook'
  });
  assert.equal(credentials.status, 400, credentials.text);
  assert.equal(credentials.json.code, 'CONNECTOR_ENDPOINT_NOT_ALLOWED');

  const unknownField = await api(app.base, 'POST', '/api/studio/connectors', {
    kind: 'webhook', name: 'campo', endpoint: fixture.url, admin: true
  });
  assert.equal(unknownField.status, 400, unknownField.text);
  assert.equal(unknownField.json.code, 'UNKNOWN_FIELD');

  const driveNoRef = await api(app.base, 'POST', '/api/studio/connectors', { kind: 'drive', name: 'Drive sin ref' });
  assert.equal(driveNoRef.status, 400, driveNoRef.text);
  assert.equal(driveNoRef.json.code, 'CONNECTOR_AUTH_INVALID');

  const mcpNoRef = await api(app.base, 'POST', '/api/studio/connectors', { kind: 'mcp', name: 'MCP sin ref' });
  assert.equal(mcpNoRef.status, 400, mcpNoRef.text);
  assert.equal(mcpNoRef.json.code, 'CONNECTOR_AUTH_INVALID');

  const unknownVault = await api(app.base, 'POST', '/api/studio/connectors', {
    kind: 'github', name: 'Vault malo', endpoint: fixture.url, authRef: 'vault:no.existe'
  });
  assert.equal(unknownVault.status, 400, unknownVault.text);
  assert.equal(unknownVault.json.code, 'CONNECTOR_AUTH_INVALID');
});

test('token cifrado: health usa Bearer, no aparece en respuestas ni en el store', async () => {
  requireToken = true;
  const item = await createConnector({ kind: 'github', token: SECRET, capabilities: ['health', 'read'] });
  assert.equal(item.authKind, 'token');
  assert.equal(item.hasToken, true);
  assert.match(item.authRef, /^encrypted:CON-\d{4}$/);
  assert.equal(JSON.stringify(item).includes(SECRET), false);

  const detail = await api(app.base, 'GET', `/api/studio/connectors/${item.id}`);
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(detail.json).includes(SECRET), false);

  const list = await api(app.base, 'GET', '/api/studio/connectors');
  assert.equal(JSON.stringify(list.json).includes(SECRET), false);

  const health = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/test`, {});
  assert.equal(health.status, 200, health.text);
  assert.equal(health.json.test.ok, true, JSON.stringify(health.json.test));
  const healthRequests = requestsTo('/rate_limit', 'GET');
  assert.ok(healthRequests.length >= 1, 'el fixture debe recibir /rate_limit');
  assert.equal(healthRequests.at(-1).authorization, `Bearer ${SECRET}`);
  assert.equal(JSON.stringify(health.json).includes(SECRET), false);
  assert.equal(JSON.stringify(store.get()).includes(SECRET), false, 'el token no puede estar en claro en el store');
  assert.ok(store.get().connectors.secrets[item.id]?.box, 'el token debe estar cifrado');

  const refreshed = await api(app.base, 'GET', `/api/studio/connectors/${item.id}`);
  assert.equal(refreshed.json.item.lastTest.ok, true);
  requireToken = false;
  await api(app.base, 'DELETE', `/api/studio/connectors/${item.id}`);
});

test('invocación de lectura directa y rechazo de rutas peligrosas', async () => {
  const item = await createConnector({ kind: 'webhook', capabilities: ['health', 'read'] });
  const read = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
    method: 'GET', path: '/echo?x=1', capability: 'read'
  });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.read, true);
  assert.equal(read.json.status, 200);
  assert.equal(requestsTo('/echo?x=1', 'GET').length, 1);

  const traversal = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
    path: '/../secreto'
  });
  assert.equal(traversal.status, 400, traversal.text);
  assert.equal(traversal.json.code, 'CONNECTOR_INVALID_CONFIG');

  const absolute = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
    path: 'http://evil.example/x'
  });
  assert.equal(absolute.status, 400, absolute.text);

  const getWithBody = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
    method: 'GET', path: '/echo', body: { x: 1 }
  });
  assert.equal(getWithBody.status, 400, getWithBody.text);

  const redirect = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
    method: 'GET', path: '/redirect'
  });
  assert.equal(redirect.status, 502, redirect.text);
  assert.equal(redirect.json.code, 'CONNECTOR_REDIRECT_BLOCKED');

  const small = await createConnector({ kind: 'webhook', maxBytes: 1024, capabilities: ['health', 'read'] });
  const large = await api(app.base, 'POST', `/api/studio/connectors/${small.id}/invoke`, {
    method: 'GET', path: '/big'
  });
  assert.equal(large.status, 502, large.text);
  assert.equal(large.json.code, 'CONNECTOR_RESPONSE_TOO_LARGE');
  await api(app.base, 'DELETE', `/api/studio/connectors/${small.id}`);

  await api(app.base, 'DELETE', `/api/studio/connectors/${item.id}`);
});

test('gate de Oficina: efecto sin aprobación no ejecuta y tras aprobar se ejecuta', async () => {
  const item = await createConnector({ kind: 'webhook', token: SECRET, capabilities: ['health', 'read', 'write'] });
  requireToken = true;
  try {
    const before = requestsTo('/effect', 'POST').length;
    const invoke = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
      method: 'POST', path: '/effect', body: { hello: 'world' }, capability: 'write', purpose: 'prueba QA'
    });
    assert.equal(invoke.status, 202, invoke.text.slice(0, 400));
    assert.equal(invoke.json.pending, true);
    assert.equal(invoke.json.approvalRequired, true);
    assert.equal(requestsTo('/effect', 'POST').length, before, 'el efecto no puede ejecutarse antes de aprobar');
    assert.equal(JSON.stringify(invoke.json).includes(SECRET), false, 'la propuesta no puede contener el token');
    const proposalId = invoke.json.proposal?.id;
    assert.match(String(proposalId), /^OF-\d+/);
    assert.equal(invoke.json.proposal?.kind, 'connector');
    assert.equal(invoke.json.proposal?.status, 'pending');

    const executeBefore = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
    assert.equal(executeBefore.status, 409, executeBefore.text);
    assert.equal(executeBefore.json.code, 'NOT_APPROVED');
    assert.equal(requestsTo('/effect', 'POST').length, before);

    const approve = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/approve`, { by: 'qa', note: 'ok' });
    assert.equal(approve.status, 200, approve.text.slice(0, 300));
    const execute = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
    assert.equal(execute.status, 200, execute.text.slice(0, 400));
    assert.equal(execute.json.execution?.executor, 'connector');
    assert.equal(requestsTo('/effect', 'POST').length, before + 1, 'el efecto se ejecuta una vez aprobado');
    const executedRequest = requestsTo('/effect', 'POST').at(-1);
    assert.equal(executedRequest.authorization, `Bearer ${SECRET}`, 'el token se resuelve solo al ejecutar');
    assert.equal(executedRequest.body, JSON.stringify({ hello: 'world' }));
    assert.equal(JSON.stringify(execute.json).includes(SECRET), false);
    assert.equal(JSON.stringify(store.get()).includes(SECRET), false);
    const again = await api(app.base, 'POST', `/api/office/proposals/${proposalId}/execute`, {});
    assert.equal(again.status, 409, again.text);
  } finally {
    requireToken = false;
    await api(app.base, 'DELETE', `/api/studio/connectors/${item.id}`);
  }
});

test('gate: capacidad de efecto no declarada se rechaza sin propuesta', async () => {
  const item = await createConnector({ kind: 'webhook', capabilities: ['health', 'read'] });
  const invoke = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
    method: 'POST', path: '/effect', body: { x: 1 }, capability: 'write'
  });
  assert.equal(invoke.status, 403, invoke.text);
  assert.equal(invoke.json.code, 'CONNECTOR_CAPABILITY_NOT_ALLOWED');
  await api(app.base, 'DELETE', `/api/studio/connectors/${item.id}`);
});

test('gate: CONNECTOR_GATE_DISABLE=1 deniega efectos sin llamar al fixture', async () => {
  const item = await createConnector({ kind: 'webhook', capabilities: ['health', 'read', 'write'] });
  const before = requestsTo('/effect-disabled', 'POST').length;
  process.env.CONNECTOR_GATE_DISABLE = '1';
  try {
    const invoke = await api(app.base, 'POST', `/api/studio/connectors/${item.id}/invoke`, {
      method: 'POST', path: '/effect-disabled', body: { x: 1 }, capability: 'write'
    });
    assert.equal(invoke.status, 503, invoke.text);
    assert.equal(invoke.json.code, 'CONNECTOR_GATE_UNAVAILABLE');
    assert.equal(requestsTo('/effect-disabled', 'POST').length, before);
  } finally {
    delete process.env.CONNECTOR_GATE_DISABLE;
  }
  await api(app.base, 'DELETE', `/api/studio/connectors/${item.id}`);
});

test('health: fallo de red se registra, borrar elimina secretos y 404', async () => {
  const failing = await createConnector({ kind: 'webhook', endpoint: 'http://127.0.0.1:1/', token: SECRET });
  const health = await api(app.base, 'POST', `/api/studio/connectors/${failing.id}/test`, {});
  assert.equal(health.status, 200, health.text);
  assert.equal(health.json.test.ok, false);
  assert.match(String(health.json.test.code), /CONNECTOR_(NETWORK|TIMEOUT)/);
  assert.equal(JSON.stringify(health.json).includes(SECRET), false);

  const removed = await api(app.base, 'DELETE', `/api/studio/connectors/${failing.id}`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(store.get().connectors.secrets[failing.id], undefined);
  const gone = await api(app.base, 'GET', `/api/studio/connectors/${failing.id}`);
  assert.equal(gone.status, 404);
  const missing = await api(app.base, 'DELETE', `/api/studio/connectors/${failing.id}`);
  assert.equal(missing.status, 404);
});

test('delegados: Drive OAuth y MCP no ejecutan comandos', async () => {
  const drive = await createConnector({ kind: 'drive', name: 'Drive QA', authRef: 'google:NOPE', endpoint: undefined });
  const driveHealth = await api(app.base, 'POST', `/api/studio/connectors/${drive.id}/test`, {});
  assert.equal(driveHealth.status, 200, driveHealth.text);
  assert.equal(driveHealth.json.test.ok, false);
  assert.equal(driveHealth.json.test.code, 'CONNECTOR_GOOGLE_NOT_FOUND');

  await store.mutate((data) => {
    if (!data.mcp) data.mcp = {};
    if (!Array.isArray(data.mcp.servers)) data.mcp.servers = [];
    data.mcp.servers.push({
      id: 'MCP-QA-STDIO', name: 'MCP QA', transport: 'stdio', command: 'node', args: [],
      enabled: true, toolAllowlist: [], timeoutMs: 5000
    });
  });
  const mcp = await createConnector({ kind: 'mcp', name: 'MCP QA', authRef: 'mcp:MCP-QA-STDIO', endpoint: undefined });
  const mcpHealth = await api(app.base, 'POST', `/api/studio/connectors/${mcp.id}/test`, {});
  assert.equal(mcpHealth.status, 200, mcpHealth.text);
  assert.equal(mcpHealth.json.test.ok, false);
  assert.equal(mcpHealth.json.test.code, 'CONNECTOR_MCP_STDIO_DELEGATED');

  const invoke = await api(app.base, 'POST', `/api/studio/connectors/${mcp.id}/invoke`, {
    tool: 'echo', args: { text: 'hola' }, capability: 'read'
  });
  assert.equal(invoke.status, 400, invoke.text);
  assert.equal(invoke.json.code, 'CONNECTOR_MCP_STDIO_UNSUPPORTED');

  await api(app.base, 'DELETE', `/api/studio/connectors/${drive.id}`);
  await api(app.base, 'DELETE', `/api/studio/connectors/${mcp.id}`);
});

#!/usr/bin/env node
/**
 * Autocheck del conector MCP (sin dependencias).
 *
 * Levanta la app real en proceso con un DATA_DIR temporal y un router aislado
 * que solo monta `lib/routes/mcp.mjs`, usa `scripts/mock-mcp-server.mjs` por
 * stdio y un micro-servidor HTTP local. Verifica:
 *   - probe/initialize/tools/list = 3 herramientas;
 *   - echo, add, read_file;
 *   - allowlist 403, servidor deshabilitado 409, timeout tipado,
 *     comando inexistente tipado y sin cuelgue;
 *   - transporte HTTP con cabeceras secretas;
 *   - gate: herramienta con efectos no se ejecuta; propuesta N2 pendiente;
 *     aprobación+ejecución de Oficina escribe el archivo; gate deshabilitado
 *     devuelve MCP_GATE_UNAVAILABLE;
 *   - secretos y argumentos no aparecen en claro en el store;
 *   - procesos hijos limpiados.
 *
 * Uso: node lib/mcp/selfcheck.mjs
 * Salida: PASS/FAIL + resumen; exit 1 si falla.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TEMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-mcp-selfcheck-'));
const TEMP_ROUTES = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-mcp-routes-'));
const SANDBOX = path.join(TEMP_DATA, 'sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

process.env.DATA_DIR = TEMP_DATA;
process.env.APP_SECRET = 'mcp-selfcheck-secret-1234';
process.env.HOST = '127.0.0.1';
process.env.LOG_LEVEL = 'error';
delete process.env.MCP_GATE_DISABLE;
delete process.env.MCP_MAX_RESPONSE_BYTES;

let pass = 0;
let fail = 0;
let server = null;
let base = '';
let httpMock = null;
let httpMockPort = 0;

// Errores esperados (5xx) que el router loguea con stack; silenciamos solo esos.
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
  if (/Timeout de \d+ ms|No se pudo iniciar el proceso MCP|El gate de Oficina no está disponible|MCP_GATE_UNAVAILABLE/.test(text)) return;
  originalConsoleError(...args);
};

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
  }
}

function writeIsolatedRouteModule() {
  const target = pathToFileURL(path.join(ROOT, 'lib', 'routes', 'mcp.mjs')).href;
  fs.writeFileSync(path.join(TEMP_ROUTES, 'mcp.mjs'), `export { name, priority, routes } from ${JSON.stringify(target)};\n`, 'utf8');
}

async function listenApp(handler, min = 3260, max = 3285) {
  for (let port = min; port <= max; port += 1) {
    const candidate = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { candidate.off('listening', onListening); reject(error); };
        const onListening = () => { candidate.off('error', onError); resolve(); };
        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(port, '127.0.0.1');
      });
      return { server: candidate, port };
    } catch (error) {
      try { candidate.close(); } catch { /* ignore */ }
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No hay puerto libre entre 3260 y 3285');
}

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

async function startHttpMock() {
  httpMock = http.createServer(async (req, res) => {
    if (req.headers['x-mcp-secret'] !== 'header-secret-value') {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('cabecera secreta ausente');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let message = {};
    try { message = JSON.parse(body || '{}'); } catch { /* notification */ }
    if (message.id === undefined || message.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    const json = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (message.method === 'initialize') {
      json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-http-mcp', version: '1.0.0' }
        }
      });
      return;
    }
    if (message.method === 'tools/list') {
      json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'echo', description: 'Devuelve texto', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            { name: 'add', description: 'Suma', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            { name: 'read_file', description: 'Lee', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
          ]
        }
      });
      return;
    }
    if (message.method === 'tools/call') {
      const args = message.params?.arguments || {};
      const text = message.params?.name === 'add'
        ? String(Number(args.a) + Number(args.b))
        : String(args.text ?? '');
      json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], isError: false } });
      return;
    }
    json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'método no soportado' } });
  });
  await new Promise((resolve, reject) => {
    httpMock.once('error', reject);
    httpMock.listen(0, '127.0.0.1', () => {
      httpMock.off('error', reject);
      httpMockPort = httpMock.address().port;
      resolve();
    });
  });
}

async function main() {
  writeIsolatedRouteModule();
  const { createApp } = await import('../http/app.mjs');
  const app = await createApp({ rootDir: ROOT, routesDir: TEMP_ROUTES });
  const listening = await listenApp(app.handler);
  server = listening.server;
  base = `http://127.0.0.1:${listening.port}`;
  const { activeChildCount } = await import('./client.mjs');
  console.log(`MCP selfcheck en ${base} (DATA_DIR temporal)`);

  /* 0. Estado inicial --------------------------------------------- */
  const status = await request('GET', '/api/mcp/status');
  check('GET /api/mcp/status 200', status.status === 200 && status.json?.summary?.servers === 0, status.json);
  check('gate de Oficina disponible', status.json?.gate?.available === true, status.json?.gate);

  /* 1. CRUD y secretos ------------------------------------------- */
  const mockPath = path.join(ROOT, 'scripts', 'mock-mcp-server.mjs');
  const created = await request('POST', '/api/mcp/servers', {
    name: 'mock-stdio',
    transport: 'stdio',
    command: process.execPath,
    args: [mockPath],
    env: { MOCK_MCP_TMP: SANDBOX, MCP_TEST_SECRET: 'super-secret-value', MOCK_MCP_STDOUT_LOG: '1' },
    timeoutMs: 10000
  });
  const serverId = created.json?.item?.id || created.json?.id;
  check('POST /api/mcp/servers 201', created.status === 201 && !!serverId, created.json);
  check('envKeys visible sin valores', Array.isArray(created.json?.item?.envKeys) && created.json.item.envKeys.includes('MCP_TEST_SECRET') && !created.text.includes('super-secret-value'), created.json?.item?.envKeys);
  check('respuesta no incluye env/headers valores', !created.text.includes('super-secret-value') && !created.text.includes(SANDBOX), created.text.slice(0, 200));
  const list = await request('GET', '/api/mcp/servers');
  check('GET /api/mcp/servers lista', list.status === 200 && list.json?.items?.length === 1, list.json?.count);
  check('listado no filtra secretos', !list.text.includes('super-secret-value'), 'secret leak');
  const got = await request('GET', `/api/mcp/servers/${serverId}`);
  check('GET servidor 200', got.status === 200 && got.json?.item?.id === serverId, got.status);
  check('servidor no devuelve valores', !got.text.includes('super-secret-value'), 'secret leak');

  const metaOnly = await request('POST', '/api/mcp/servers', {
    name: 'solo-nombres',
    transport: 'stdio',
    command: process.execPath,
    args: [mockPath],
    envKeys: ['DECLARED_ONLY'],
    toolAllowlist: []
  });
  check('POST acepta envKeys (solo nombres) sin valores', metaOnly.status === 201 && metaOnly.json?.item?.envKeys?.includes('DECLARED_ONLY'), metaOnly.json?.item?.envKeys);
  if (metaOnly.json?.item?.id) await request('DELETE', `/api/mcp/servers/${metaOnly.json.item.id}`);

  /* 2. Probe contra mock: 3 herramientas ------------------------- */
  const probe = await request('POST', `/api/mcp/servers/${serverId}/probe`, {});
  check('probe 200', probe.status === 200, probe.json);
  check('probe initialize serverInfo', probe.json?.probe?.serverInfo?.name === 'mock-mcp-server', probe.json?.probe?.serverInfo);
  check('probe tools/list = 3', probe.json?.probe?.toolCount === 3 && probe.json?.count === 3, { count: probe.json?.count, names: probe.json?.tools?.map((tool) => tool.name) });
  check('probe nombres echo/add/read_file', ['echo', 'add', 'read_file'].every((name) => probe.json?.tools?.some((tool) => tool.name === name)), probe.json?.tools?.map((tool) => tool.name));
  check('probe clasifica solo lectura', probe.json?.tools?.every((tool) => tool.effect === false), probe.json?.tools);
  check('lastProbe persistido', probe.json?.item?.lastProbe?.toolCount === 3, probe.json?.item?.lastProbe);
  const toolsRoute = await request('GET', `/api/mcp/servers/${serverId}/tools`);
  check('GET tools 200 con 3', toolsRoute.status === 200 && toolsRoute.json?.count === 3, toolsRoute.json?.count);

  /* 3. Herramientas de solo lectura ------------------------------ */
  const echo = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'echo', args: { text: 'hola mcp' } });
  check('call echo directo 200', echo.status === 200 && echo.json?.gated === false && echo.json?.result?.text === 'hola mcp', echo.json);
  const add = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'add', args: { a: 2, b: 40 } });
  check('call add suma 42', add.status === 200 && add.json?.result?.text === '42', add.json?.result);
  fs.writeFileSync(path.join(SANDBOX, 'nota.txt'), 'contenido de prueba', 'utf8');
  const read = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'read_file', args: { path: 'nota.txt' } });
  check('call read_file dentro del sandbox', read.status === 200 && read.json?.result?.text === 'contenido de prueba', read.json?.result);
  const outside = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'read_file', args: { path: '../../../Windows/win.ini' } });
  check('read_file fuera del sandbox devuelve error de herramienta', outside.status === 200 && outside.json?.result?.isError === true, outside.json?.result);

  /* 4. Allowlist / deshabilitado / timeout / comando inexistente -- */
  await request('PATCH', `/api/mcp/servers/${serverId}`, { toolAllowlist: ['echo'] });
  const notAllowed = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'add', args: { a: 1, b: 2 } });
  check('tool no permitida → 403', notAllowed.status === 403 && notAllowed.json?.code === 'MCP_TOOL_NOT_ALLOWED', notAllowed.json);
  await request('PATCH', `/api/mcp/servers/${serverId}`, { toolAllowlist: [] });

  await request('PATCH', `/api/mcp/servers/${serverId}`, { enabled: false });
  const disabledProbe = await request('POST', `/api/mcp/servers/${serverId}/probe`, {});
  check('servidor deshabilitado probe → 409', disabledProbe.status === 409 && disabledProbe.json?.code === 'MCP_SERVER_DISABLED', disabledProbe.json);
  const disabledCall = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'echo', args: { text: 'x' } });
  check('servidor deshabilitado call → 409', disabledCall.status === 409 && disabledCall.json?.code === 'MCP_SERVER_DISABLED', disabledCall.json);
  await request('PATCH', `/api/mcp/servers/${serverId}`, { enabled: true });

  await request('PATCH', `/api/mcp/servers/${serverId}`, { timeoutMs: 1000 });
  const timeout = await request('POST', `/api/mcp/servers/${serverId}/call`, { tool: 'echo', args: { text: 'lento', delayMs: 4000 } });
  check('timeout simulado → 504 MCP_TIMEOUT', timeout.status === 504 && timeout.json?.code === 'MCP_TIMEOUT', timeout.json);
  await request('PATCH', `/api/mcp/servers/${serverId}`, { timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const broken = await request('POST', '/api/mcp/servers', {
    name: 'comando-inexistente',
    transport: 'stdio',
    command: 'definitely-not-a-real-mcp-command-98765',
    args: [],
    timeoutMs: 1500
  });
  const brokenId = broken.json?.item?.id;
  const brokenProbe = await request('POST', `/api/mcp/servers/${brokenId}/probe`, {});
  check('comando inexistente → 502 MCP_SPAWN_FAILED', brokenProbe.status === 502 && brokenProbe.json?.code === 'MCP_SPAWN_FAILED', brokenProbe.json);
  await request('DELETE', `/api/mcp/servers/${brokenId}`);
  check('comando inexistente no cuelga', true);

  /* 5. Transporte HTTP + cabeceras secretas ---------------------- */
  await startHttpMock();
  const httpCreated = await request('POST', '/api/mcp/servers', {
    name: 'mock-http',
    transport: 'http',
    url: `http://127.0.0.1:${httpMockPort}/mcp`,
    headers: { 'X-MCP-Secret': 'header-secret-value' },
    timeoutMs: 5000
  });
  const httpId = httpCreated.json?.item?.id;
  check('crear servidor HTTP 201', httpCreated.status === 201 && !!httpId, httpCreated.json);
  check('headers secretos no se devuelven', httpCreated.json?.item?.headerKeys?.includes('X-MCP-Secret') && !httpCreated.text.includes('header-secret-value'), httpCreated.json?.item?.headerKeys);
  const httpProbe = await request('POST', `/api/mcp/servers/${httpId}/probe`, {});
  check('probe HTTP 3 herramientas', httpProbe.status === 200 && httpProbe.json?.probe?.toolCount === 3, httpProbe.json?.probe);
  const httpEcho = await request('POST', `/api/mcp/servers/${httpId}/call`, { tool: 'echo', args: { text: 'http hola' } });
  check('call HTTP echo', httpEcho.status === 200 && httpEcho.json?.result?.text === 'http hola', httpEcho.json?.result);

  /* 6. Gate: efecto sin ejecutar, aprobación y ejecución ---------- */
  const writeCreated = await request('POST', '/api/mcp/servers', {
    name: 'mock-write',
    transport: 'stdio',
    command: process.execPath,
    args: [mockPath],
    env: { MOCK_MCP_TMP: SANDBOX, MOCK_MCP_ENABLE_WRITE: '1' },
    toolAllowlist: ['write_file'],
    timeoutMs: 10000
  });
  const writeId = writeCreated.json?.item?.id;
  const writeProbe = await request('POST', `/api/mcp/servers/${writeId}/probe`, {});
  check('mock write tiene 4 herramientas', writeProbe.status === 200 && writeProbe.json?.probe?.toolCount === 4, writeProbe.json?.probe?.toolCount);
  check('write_file clasificada con efectos', writeProbe.json?.tools?.find((tool) => tool.name === 'write_file')?.effect === true, writeProbe.json?.tools);

  const gatedFile = path.join(SANDBOX, 'gated.txt');
  process.env.MCP_GATE_DISABLE = '1';
  const gateUnavailable = await request('POST', `/api/mcp/servers/${writeId}/call`, { tool: 'write_file', args: { path: 'gated.txt', content: 'contenido-secreto-write' } });
  check('gate deshabilitado → 503 MCP_GATE_UNAVAILABLE', gateUnavailable.status === 503 && gateUnavailable.json?.code === 'MCP_GATE_UNAVAILABLE', gateUnavailable.json);
  check('gate deshabilitado NO ejecuta', !fs.existsSync(gatedFile), 'archivo creado sin gate');
  delete process.env.MCP_GATE_DISABLE;

  const gated = await request('POST', `/api/mcp/servers/${writeId}/call`, { tool: 'write_file', args: { path: 'gated.txt', content: 'contenido-secreto-write' } });
  check('efecto → 202 gated', gated.status === 202 && gated.json?.gated === true, { status: gated.status, body: gated.json });
  check('propuesta N2 pendiente', gated.json?.proposal?.level === 'N2' && gated.json?.proposal?.status === 'pending', gated.json?.proposal && { level: gated.json.proposal.level, status: gated.json.proposal.status });
  check('efecto NO se ejecuta sin aprobación', !fs.existsSync(gatedFile), 'archivo creado antes de aprobar');
  check('respuesta gate no incluye args en claro', !gated.text.includes('contenido-secreto-write'), 'args leak');

  const proposalId = gated.json?.proposal?.id;
  const office = await import('../office/proposals.mjs');
  const approved = await office.approveProposal({ id: proposalId, by: 'selfcheck' });
  check('Oficina aprueba propuesta MCP', approved.proposal?.status === 'approved', approved.proposal?.status);
  const executed = await office.executeProposal({ id: proposalId, actor: 'selfcheck' });
  check('Oficina ejecuta y llama a MCP', executed.proposal?.status === 'executed', executed.proposal?.status);
  check('write_file se ejecuta tras aprobación', fs.existsSync(gatedFile) && fs.readFileSync(gatedFile, 'utf8') === 'contenido-secreto-write', fs.existsSync(gatedFile));

  /* 7. Secretos fuera del store y limpieza ----------------------- */
  const storeText = fs.readFileSync(path.join(TEMP_DATA, 'agenda-data.json'), 'utf8');
  check('secreto env no está en claro', !storeText.includes('super-secret-value'), 'env secret leak');
  check('secreto header no está en claro', !storeText.includes('header-secret-value'), 'header secret leak');
  check('args de llamada aprobada no están en claro', !storeText.includes('contenido-secreto-write'), 'args leak');
  const stored = JSON.parse(storeText);
  check('store.mcp.servers existe', Array.isArray(stored.mcp?.servers) && stored.mcp.servers.length >= 3, stored.mcp?.servers?.length);
  const storedStdio = (stored.mcp?.servers || []).find((item) => item.id === serverId);
  check('servidor guarda envKeys sin valores', Array.isArray(storedStdio?.envKeys) && storedStdio.envKeys.includes('MCP_TEST_SECRET') && !JSON.stringify(storedStdio).includes('super-secret-value'), storedStdio?.envKeys);
  const secretEntries = Object.values(stored.mcp?.secrets || {}).flatMap((entry) => [
    ...Object.values(entry?.env || {}),
    ...Object.values(entry?.headers || {})
  ]);
  check('store.mcp.secrets cifrados (cajas objeto)', secretEntries.length >= 3 && secretEntries.every((box) => box && typeof box === 'object' && typeof box.data === 'string'), secretEntries.length);
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('procesos hijos MCP limpiados', activeChildCount() === 0, activeChildCount());

  const finalList = await request('GET', '/api/mcp/servers');
  check('listado final 3 servidores', finalList.status === 200 && finalList.json?.items?.length === 3, finalList.json?.count);
}

try {
  await main();
} catch (error) {
  fail += 1;
  console.log(`FAIL  excepción no controlada :: ${error?.stack || error?.message || error}`);
} finally {
  try { if (server) await new Promise((resolve) => server.close(resolve)); } catch { /* ignore */ }
  try { if (httpMock) await new Promise((resolve) => httpMock.close(resolve)); } catch { /* ignore */ }
  try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(TEMP_ROUTES, { recursive: true, force: true }); } catch { /* ignore */ }
}

const total = pass + fail;
console.log(`\nSELFCHECK ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${total})`);
if (fail > 0) process.exitCode = 1;

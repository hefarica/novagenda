/* E2E de Conectores MCP: añadir, probar, ver herramientas, pausar y eliminar.
   Uso: node scripts/verify-mcp.mjs http://127.0.0.1:3311 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_APP = process.argv[2] || 'http://127.0.0.1:3311';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function waitFor(fn, timeout = 25000, label = 'espera') {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`timeout ${label}${last ? `: ${last.message}` : ''}`);
}

// Servidor MCP simulado (JSON-RPC 2.0 por HTTP).
const mcp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let message = null;
    try { message = JSON.parse(body || '{}'); } catch { /* vacío */ }
    if (!message || message.id === undefined) { res.writeHead(202); res.end(); return; }
    const ok = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } });
    }
    if (message.method === 'tools/list') {
      return ok({ tools: [{ name: 'echo', description: 'Repite un texto', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    }
    ok({});
  });
});
await new Promise((resolve) => mcp.listen(0, '127.0.0.1', resolve));
const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;

const profile = mkdtempSync(join(tmpdir(), 'agenda-mcp-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  mkdirSync('docs/capturas', { recursive: true });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception');
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text || 'log');
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = id++; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 30000); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
  const servers = async () => (await (await fetch(`${URL_APP}/api/mcp/servers`)).json()).items || [];

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: URL_APP });
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await evaluate(`localStorage.setItem('agenda-p95.theme.v1','light')`);
  await send('Page.reload');
  await waitFor(async () => evaluate(`document.readyState === 'complete'`));
  await sleep(1200);
  await evaluate(`document.querySelector('[data-nav="integrations"]')?.click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#mcpBody'))`), 10000, 'panel MCP');

  // Añadir conector desde la UI.
  await evaluate(`document.querySelector('#mcpNewBtn').click()`);
  await evaluate(`(() => {
    const form = document.querySelector('#mcpForm');
    form.elements.name.value = 'Mock MCP';
    form.elements.url.value = ${JSON.stringify(mcpUrl)};
    form.requestSubmit();
  })()`);
  const created = await waitFor(async () => (await servers()).find((server) => server.name === 'Mock MCP'), 20000, 'crear conector');
  check('Añadir conector MCP desde la UI', Boolean(created?.id), created?.id);
  check('La URL queda registrada', created.url === mcpUrl, created.url);

  // Probar.
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#mcpBody .mcp-row [data-mcp-probe]'))`), 10000, 'boton probar');
  await evaluate(`document.querySelector('#mcpBody .mcp-row [data-mcp-probe]').click()`);
  const probed = await waitFor(async () => { const list = await servers(); const item = list.find((s) => s.name === 'Mock MCP'); return item?.lastProbe?.ok === true ? item : null; }, 20000, 'probe');
  check('Probar el conector', probed.lastProbe.toolCount === 1, `tools=${probed.lastProbe.toolCount} · ${probed.lastProbe.latencyMs}ms`);

  // Ver herramientas.
  await evaluate(`document.querySelector('#mcpBody .mcp-row [data-mcp-tools]').click()`);
  await waitFor(async () => evaluate(`Boolean(document.querySelector('#mcpBody .tool-list:not([hidden])'))`), 10000, 'herramientas');
  const toolsText = await evaluate(`document.querySelector('#mcpBody .tool-list')?.textContent || ''`);
  check('Lista las herramientas del microservicio', /echo/i.test(toolsText), toolsText.slice(0, 80));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('docs/capturas/vista-mcp-light.png', Buffer.from(shot.data, 'base64'));

  // Pausar / activar.
  await evaluate(`document.querySelector('#mcpBody .mcp-row [data-mcp-toggle]').click()`);
  const paused = await waitFor(async () => { const list = await servers(); const item = list.find((s) => s.name === 'Mock MCP'); return item?.enabled === false ? item : null; }, 15000, 'pausar');
  check('Pausar conector', paused.enabled === false);
  await evaluate(`document.querySelector('#mcpBody .mcp-row [data-mcp-toggle]').click()`);
  const enabled = await waitFor(async () => { const list = await servers(); const item = list.find((s) => s.name === 'Mock MCP'); return item?.enabled === true ? item : null; }, 15000, 'activar');
  check('Activar conector', enabled.enabled === true);

  // Eliminar.
  await evaluate(`window.confirm = () => true`);
  await evaluate(`document.querySelector('#mcpBody .mcp-row [data-mcp-delete]').click()`);
  await waitFor(async () => (await servers()).length === 0, 15000, 'eliminar');
  check('Eliminar conector', (await servers()).length === 0);

  const realErrors = errors.filter((e) => !/favicon|manifest/i.test(e));
  check('Sin errores de consola', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} catch (error) {
  failures += 1;
  console.log('FAIL  excepción —', error?.message || error);
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { mcp.close(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(`\nRESUMEN: ${failures === 0 ? 'PASS' : failures + ' fallo(s)'}`);
  process.exit(failures ? 1 : 0);
}

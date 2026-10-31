#!/usr/bin/env node
/**
 * Servidor MCP de prueba por stdio (JSON-RPC 2.0, sin dependencias).
 *
 * Herramientas:
 *   - echo      {text, delayMs?}  → devuelve el texto (delayMs para probar timeouts)
 *   - add       {a, b}            → suma numérica
 *   - read_file {path}            → lee un archivo DENTRO de MOCK_MCP_TMP
 *   - write_file {path, content}  → solo si MOCK_MCP_ENABLE_WRITE=1; escribe dentro de MOCK_MCP_TMP
 *
 * `read_file`/`write_file` están confinados a un directorio temporal para que
 * las pruebas no toquen archivos reales. Los logs van a stderr (stdout es
 * exclusivamente JSON-RPC).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SANDBOX = path.resolve(process.env.MOCK_MCP_TMP || os.tmpdir());
fs.mkdirSync(SANDBOX, { recursive: true });
const WRITE_ENABLED = process.env.MOCK_MCP_ENABLE_WRITE === '1';
const VERSION = '1.0.0';

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    /* stdout cerrado */
  }
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], isError };
}

function resolveSandbox(input) {
  const raw = String(input || '');
  const absolute = path.resolve(SANDBOX, raw);
  if (absolute !== SANDBOX && !absolute.startsWith(`${SANDBOX}${path.sep}`)) {
    throw new Error('ruta fuera del sandbox de prueba');
  }
  return absolute;
}

function assertInsideReal(realPath) {
  if (realPath !== SANDBOX && !realPath.startsWith(`${SANDBOX}${path.sep}`)) {
    throw new Error('ruta real fuera del sandbox de prueba');
  }
  return realPath;
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Devuelve el texto recibido. Acepta delayMs para simular lentitud.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a devolver' },
        delayMs: { type: 'number', description: 'Retardo artificial en milisegundos' }
      },
      required: ['text']
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  {
    name: 'add',
    description: 'Suma dos números.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    },
    annotations: { readOnlyHint: true, idempotentHint: true }
  },
  {
    name: 'read_file',
    description: 'Lee un archivo de texto dentro del sandbox de prueba.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta relativa o absoluta dentro del sandbox' } },
      required: ['path']
    },
    annotations: { readOnlyHint: true }
  }
];

if (WRITE_ENABLED) {
  TOOLS.push({
    name: 'write_file',
    description: 'Escribe un archivo dentro del sandbox de prueba (herramienta con efectos).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa o absoluta dentro del sandbox' },
        content: { type: 'string', description: 'Contenido a escribir' }
      },
      required: ['path', 'content']
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callTool(name, args) {
  const safeArgs = args && typeof args === 'object' ? args : {};
  if (name === 'echo') {
    const delay = Number(safeArgs.delayMs);
    if (Number.isFinite(delay) && delay > 0) await sleep(Math.min(20_000, delay));
    return toolResult(String(safeArgs.text ?? ''));
  }
  if (name === 'add') {
    const a = Number(safeArgs.a);
    const b = Number(safeArgs.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return toolResult('ERROR: a y b deben ser números', true);
    return toolResult(String(a + b));
  }
  if (name === 'read_file') {
    try {
      const requested = resolveSandbox(safeArgs.path);
      const file = assertInsideReal(fs.realpathSync(requested));
      const stat = fs.statSync(file);
      if (!stat.isFile()) return toolResult('ERROR: no es un archivo', true);
      if (stat.size > 65_536) return toolResult('ERROR: archivo demasiado grande (máx. 64 KiB)', true);
      return toolResult(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return toolResult(`ERROR: ${error.message}`, true);
    }
  }
  if (name === 'write_file' && WRITE_ENABLED) {
    try {
      const requested = resolveSandbox(safeArgs.path);
      fs.mkdirSync(path.dirname(requested), { recursive: true });
      const parent = assertInsideReal(fs.realpathSync(path.dirname(requested)));
      let target = path.join(parent, path.basename(requested));
      if (fs.existsSync(target)) target = assertInsideReal(fs.realpathSync(target));
      fs.writeFileSync(target, String(safeArgs.content ?? ''), 'utf8');
      return toolResult(`OK: ${path.relative(SANDBOX, target)}`);
    } catch (error) {
      return toolResult(`ERROR: ${error.message}`, true);
    }
  }
  return null;
}

async function handle(message) {
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;
  if (!hasId) {
    // notifications/initialized, notifications/cancelled, etc.
    if (method === 'notifications/initialized') return;
    return;
  }
  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mock-mcp-server', version: VERSION },
      instructions: 'Servidor de prueba de Agenda Copilot; sandbox=' + SANDBOX
    });
    return;
  }
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params?.name || '');
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const result = await callTool(name, args);
    if (result === null) {
      sendError(id, -32602, `Herramienta desconocida: ${name}`);
      return;
    }
    sendResult(id, result);
    return;
  }
  sendError(id, -32601, `Método no soportado: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write('[mock-mcp] JSON inválido ignorado\n');
    return;
  }
  if (!message || typeof message !== 'object') return;
  handle(message).catch((error) => {
    if (message.id !== undefined) sendError(message.id, -32603, String(error?.message || error));
  });
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stderr.write(`[mock-mcp] listo (sandbox=${SANDBOX}, write=${WRITE_ENABLED ? 'on' : 'off'})\n`);
if (process.env.MOCK_MCP_STDOUT_LOG === '1') {
  // Ruido deliberado por stdout: el cliente debe ignorar líneas que no son JSON-RPC.
  process.stdout.write('[mock-mcp] log de arranque por stdout (debe ser ignorado)\n');
}

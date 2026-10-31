/**
 * Cliente MCP JSON-RPC 2.0 con transportes stdio y HTTP/SSE.
 *
 * - stdio: `spawn(command, args, { shell:false })`, mensajes JSON por líneas,
 *   tolerancia a logs por stdout (las líneas que no son JSON se ignoran).
 * - http: POST JSON-RPC con `Accept: application/json, text/event-stream`;
 *   soporta respuesta JSON y SSE.
 * - sse: transporte legacy (GET SSE + endpoint descubierto + POST).
 *
 * Handshake: initialize → notifications/initialized → tools/list → tools/call.
 * Cada operación tiene timeout (10 s por defecto), respuesta acotada y el hijo
 * se mata con SIGTERM (SIGKILL de respaldo) al cerrar.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactString } from '../security/redact.mjs';
import {
  mcpError, MCP_CODES, spawnFailed, processExited, timeoutError, protocolError,
  rpcError, httpError, responseTooLarge
} from './errors.mjs';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = Number(process.env.MCP_MAX_RESPONSE_BYTES) > 0
  ? Number(process.env.MCP_MAX_RESPONSE_BYTES)
  : 1_000_000;
const MAX_TOOLS = 500;
const KILL_GRACE_MS = 2_000;

const activeChildren = new Set();

/** Nº de procesos hijos MCP vivos (para tests de limpieza). */
export function activeChildCount() {
  return activeChildren.size;
}

function killChild(child, signal) {
  try {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

function emergencyKillAll() {
  for (const child of activeChildren) killChild(child, 'SIGKILL');
  activeChildren.clear();
}

process.once('exit', emergencyKillAll);
process.once('SIGTERM', () => {
  for (const child of activeChildren) killChild(child, 'SIGTERM');
});
process.once('SIGINT', () => {
  for (const child of activeChildren) killChild(child, 'SIGTERM');
});

function baseEnv() {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ', 'NODE_PATH'];
  const env = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function buildChildEnv(server, resolvedEnv) {
  return {
    ...baseEnv(),
    ...(resolvedEnv && typeof resolvedEnv === 'object' ? resolvedEnv : {}),
    MCP_SERVER_ID: server.id,
    MCP_SERVER_NAME: server.name,
    MCP_TRANSPORT: 'stdio'
  };
}

function jsonRpcId() {
  return crypto.randomInt(1, 2_147_483_647);
}

function findWindowsShim(command) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const direct = path.resolve(command);
    return fs.existsSync(direct) ? direct : null;
  }
  const extensions = String(process.env.PATHEXT || '.CMD;.BAT')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext));
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const names = hasExtension ? [command] : extensions.map((ext) => `${command}${ext}`);
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * En Windows, `spawn('algo.cmd', ..., {shell:false})` falla con EINVAL.
 * Resolvemos el shim .cmd/.bat a su script .js interno (patrón npm `%~dp0`) y
 * lo ejecutamos con `node`, SIN usar shell ni interpolar argumentos.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{command:string,args:string[],shim?:string}}
 */
export function resolveLaunchCommand(command, args = []) {
  if (process.platform !== 'win32') return { command, args };
  const raw = String(command || '');
  const explicitShim = /\.(cmd|bat)$/i.test(raw);
  let shim = explicitShim ? findWindowsShim(raw) : null;
  if (!shim && !explicitShim && !path.extname(raw)) {
    // Permite configurar `npx` (sin extensión) en Windows: se resuelve a npx.cmd.
    const candidate = findWindowsShim(raw);
    if (candidate && /\.(cmd|bat)$/i.test(candidate)) shim = candidate;
  }
  if (!shim) return { command, args, shim: explicitShim ? null : undefined };
  let script = '';
  try {
    script = fs.readFileSync(shim, 'utf8').slice(0, 65_536);
  } catch {
    return { command, args, shim };
  }
  const targets = [];
  const re = /(?:%~dp0|%dp0%)[\\/]([^"\r\n]+?\.(?:js|cjs|mjs))/gi;
  let match;
  while ((match = re.exec(script))) {
    targets.push(path.resolve(path.dirname(shim), match[1]));
  }
  for (const target of targets.reverse()) {
    if (fs.existsSync(target)) {
      return { command: process.execPath, args: [target, ...args], shim };
    }
  }
  return { command, args, shim };
}

/** @param {unknown} message */
function rpcErrorFrom(message) {
  const error = message?.error;
  return rpcError(
    error?.message || 'error sin detalle',
    { rpcCode: error?.code ?? null, rpcData: error?.data ?? null }
  );
}

/* ------------------------------------------------------------------ */
/* stdio                                                               */
/* ------------------------------------------------------------------ */

export class StdioTransport {
  /**
   * @param {object} server
   * @param {{env?:object, timeoutMs?:number}} [options]
   */
  constructor(server, options = {}) {
    this.server = server;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.pending = new Map();
    this.closed = false;
    this.exited = false;
    this.terminalError = null;
    this.stderrTail = '';
    this.spawnError = null;

    const launch = resolveLaunchCommand(server.command, Array.isArray(server.args) ? server.args : []);
    const isWindowsShim = /\.(cmd|bat)$/i.test(String(server.command || '')) && launch.command === server.command;
    const unresolvedShim = !!launch.shim && launch.command === server.command;
    if (isWindowsShim || unresolvedShim) {
      throw spawnFailed(
        launch.shim
          ? 'No se pudo resolver el shim .cmd/.bat a un script .js; usa "node" + la ruta del script, sin shell.'
          : 'No se encontró el shim .cmd/.bat en el PATH; usa "node" + la ruta del script, sin shell.',
        { command: server.command }
      );
    }
    this.launch = launch;

    try {
      this.child = spawn(launch.command, launch.args, {
        shell: false,
        windowsHide: true,
        env: buildChildEnv(server, options.env),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      throw spawnFailed(redactString(error?.message || error), { code: error?.code || null, command: launch.command });
    }
    activeChildren.add(this.child);

    this.child.once('error', (error) => {
      this.spawnError = error;
      this.terminalError = spawnFailed(redactString(error?.message || error), {
        code: error?.code || null,
        command: server.command
      });
      activeChildren.delete(this.child);
      this.exited = true;
      this.failAll(this.terminalError);
    });

    this.child.once('exit', (code, signal) => {
      activeChildren.delete(this.child);
      this.exited = true;
      if (!this.closed) {
        this.terminalError = processExited(`código ${code ?? 'null'}${signal ? `, señal ${signal}` : ''}`, {
          code,
          signal,
          stderr: redactString(this.stderrTail.slice(-1500))
        });
        this.failAll(this.terminalError);
      }
    });

    this.child.stdin.on('error', () => { /* EPIPE al morir el hijo: lo cubre exit */ });
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4000);
    });

    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.onLine(line));
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /**
   * @param {string} line
   */
  onLine(line) {
    if (this.closed) return;
    const text = String(line || '').trim();
    if (!text) return;
    if (text.length > MAX_RESPONSE_BYTES) {
      this.failAll(responseTooLarge(MAX_RESPONSE_BYTES));
      this.close().catch(() => {});
      return;
    }
    if (!text.startsWith('{')) return; // log tolerated
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // línea no JSON: se ignora (logs del servidor)
    }
    if (!message || typeof message !== 'object') return;
    if (message.id === undefined || message.id === null) return; // notificación
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(rpcErrorFrom(message));
    else pending.resolve(message.result ?? {});
  }

  /**
   * @param {string} method
   * @param {object} params
   * @param {{timeoutMs?:number}} [options]
   */
  request(method, params = {}, options = {}) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed || this.exited) {
      return Promise.reject(this.spawnError ? spawnFailed(redactString(this.spawnError.message), { code: this.spawnError.code }) : processExited('transporte cerrado'));
    }
    const id = jsonRpcId();
    const timeoutMs = Math.max(500, Number(options.timeoutMs) || this.timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      if (this.terminalError) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.terminalError);
        return;
      }
      const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      try {
        this.child.stdin.write(line, 'utf8', (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(processExited(redactString(error.message), { code: error.code || null }));
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(processExited(redactString(error?.message || error)));
      }
    });
  }

  /** Notificación sin respuesta. */
  notify(method, params = {}) {
    if (this.closed || this.exited) return Promise.resolve();
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, 'utf8');
    } catch {
      /* el cierre lo detecta */
    }
    return Promise.resolve();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.rl.close(); } catch { /* ignore */ }
    if (this.exited || !this.child) {
      activeChildren.delete(this.child);
      return;
    }
    killChild(this.child, 'SIGTERM');
    await new Promise((resolve) => {
      let done = false;
      let termTimer = null;
      let hardTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (termTimer) clearTimeout(termTimer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve();
      };
      this.child.once('exit', finish);
      termTimer = setTimeout(() => {
        if (!this.exited) killChild(this.child, 'SIGKILL');
      }, KILL_GRACE_MS);
      // Si el hijo ignora SIGTERM, tras SIGKILL esperamos un poco a que muera.
      hardTimer = setTimeout(finish, KILL_GRACE_MS + 1000);
    });
    activeChildren.delete(this.child);
    this.failAll(processExited('transporte cerrado'));
  }
}

/* ------------------------------------------------------------------ */
/* HTTP/SSE                                                            */
/* ------------------------------------------------------------------ */

function buildHttpHeaders(server, resolvedHeaders) {
  const custom = resolvedHeaders && typeof resolvedHeaders === 'object' ? resolvedHeaders : {};
  return {
    ...custom,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'user-agent': 'agenda-copilot-p95-mcp/1.0'
  };
}

function withTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

async function readCappedText(response, limit = MAX_RESPONSE_BYTES) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw responseTooLarge(limit);
  return buffer.toString('utf8');
}

function extractJsonRpc(payload, id) {
  if (Array.isArray(payload)) {
    const match = payload.find((item) => item && item.id === id);
    if (!match) throw protocolError('respuesta JSON-RPC sin el id solicitado');
    return match;
  }
  if (payload && typeof payload === 'object' && payload.id !== undefined && payload.id !== id) {
    throw protocolError('respuesta JSON-RPC con id distinto');
  }
  return payload;
}

async function readSseResponse(response, id, limit = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) throw protocolError('respuesta SSE sin cuerpo legible');
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let bytes = 0;

  const handleEvent = () => {
    if (!dataLines.length) return null;
    const data = dataLines.join('\n');
    dataLines = [];
    if (!data.trim()) return null;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
    if (payload && payload.id !== undefined && payload.id !== null && payload.id === id) {
      if (payload.error) throw rpcErrorFrom(payload);
      return payload.result ?? {};
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw responseTooLarge(limit);
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') {
          const result = handleEvent();
          if (result !== null) return result;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^\s/, ''));
        }
        index = buffer.indexOf('\n');
      }
    }
    const result = handleEvent();
    if (result !== null) return result;
    throw protocolError('el stream SSE terminó sin respuesta JSON-RPC');
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

/**
 * Transporte HTTP Streamable (POST JSON-RPC, respuesta JSON o SSE).
 */
export class HttpTransport {
  constructor(server, options = {}) {
    this.server = server;
    this.headers = buildHttpHeaders(server, options.headers);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  }

  async request(method, params = {}, options = {}) {
    const timeoutMs = Math.max(500, Number(options.timeoutMs) || this.timeoutMs);
    const id = jsonRpcId();
    const timer = withTimeoutSignal(timeoutMs);
    try {
      let response;
      try {
        response = await fetch(this.server.url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: timer.signal,
          redirect: 'error'
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw timeoutError(method, timeoutMs);
        throw httpError(redactString(error?.message || error), { method });
      }
      if (!response.ok) {
        const detail = redactString((await response.text().catch(() => '')).slice(0, 500));
        throw httpError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status, method });
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/event-stream')) return await readSseResponse(response, id);
      const text = await readCappedText(response);
      if (!text.trim()) throw protocolError('respuesta HTTP vacía');
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw protocolError('respuesta HTTP no es JSON');
      }
      const message = extractJsonRpc(payload, id);
      if (message?.error) throw rpcErrorFrom(message);
      return message?.result ?? {};
    } catch (error) {
      if (error?.name === 'AbortError') throw timeoutError(method, timeoutMs);
      throw error;
    } finally {
      timer.cancel();
    }
  }

  async notify(method, params = {}) {
    const timeoutMs = this.timeoutMs;
    const timer = withTimeoutSignal(timeoutMs);
    try {
      await fetch(this.server.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: timer.signal,
        redirect: 'error'
      });
    } catch {
      /* la notificación es best-effort; el siguiente request fallará si el servidor no está */
    } finally {
      timer.cancel();
    }
  }

  async close() {
    /* sin recursos persistentes */
  }
}

/**
 * Transporte SSE legacy: GET al stream, evento `endpoint`, POST al endpoint.
 * Se activa con `transport: 'sse'`.
 */
export class LegacySseTransport {
  constructor(server, options = {}) {
    this.server = server;
    this.headers = buildHttpHeaders(server, options.headers);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.pending = new Map();
    this.closed = false;
    this.endpoint = null;
    this.controller = new AbortController();
    this.ready = this.connect();
  }

  async connect() {
    const timer = withTimeoutSignal(this.timeoutMs);
    try {
      let response;
      try {
        response = await fetch(this.server.url, {
          method: 'GET',
          headers: { ...this.headers, accept: 'text/event-stream' },
          signal: this.controller.signal
        });
      } catch (error) {
        throw httpError(redactString(error?.message || error), { method: 'GET SSE' });
      }
      if (!response.ok) throw httpError(`HTTP ${response.status} al abrir SSE`, { status: response.status });
      const endpointPromise = new Promise((resolve, reject) => {
        this.endpointResolve = resolve;
        this.endpointReject = reject;
      });
      this.readLoop(response).catch((error) => {
        this.failAll(error);
        this.endpointReject?.(error);
      });
      const endpoint = await Promise.race([
        endpointPromise,
        new Promise((_, reject) => setTimeout(() => reject(timeoutError('SSE endpoint', this.timeoutMs)), this.timeoutMs))
      ]);
      this.endpoint = new URL(String(endpoint), this.server.url).toString();
      return this.endpoint;
    } finally {
      timer.cancel();
    }
  }

  async readLoop(response) {
    const reader = response.body?.getReader();
    if (!reader) throw protocolError('SSE sin cuerpo');
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    let eventName = 'message';
    let bytes = 0;
    const dispatch = () => {
      const data = dataLines.join('\n');
      dataLines = [];
      const name = eventName || 'message';
      eventName = 'message';
      if (!data) return;
      if (name === 'endpoint') {
        this.endpointResolve?.(data);
        return;
      }
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (!payload || payload.id === undefined || payload.id === null) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(rpcErrorFrom(payload));
      else pending.resolve(payload.result ?? {});
    };
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw responseTooLarge(MAX_RESPONSE_BYTES);
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') dispatch();
        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
        index = buffer.indexOf('\n');
      }
    }
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async request(method, params = {}, options = {}) {
    await this.ready;
    const timeoutMs = Math.max(500, Number(options.timeoutMs) || this.timeoutMs);
    const id = jsonRpcId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.post(JSON.stringify({ jsonrpc: '2.0', id, method, params })).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async post(body) {
    if (!this.endpoint) throw protocolError('SSE sin endpoint descubierto');
    const timer = withTimeoutSignal(this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: timer.signal
      });
      if (!response.ok) throw httpError(`HTTP ${response.status} al enviar por SSE`, { status: response.status });
    } finally {
      timer.cancel();
    }
  }

  async notify(method, params = {}) {
    try {
      await this.ready;
      await this.post(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {
      /* best-effort */
    }
  }

  async close() {
    this.closed = true;
    try { this.controller.abort(); } catch { /* ignore */ }
    this.failAll(processExited('transporte SSE cerrado'));
  }
}

/* ------------------------------------------------------------------ */
/* Cliente                                                             */
/* ------------------------------------------------------------------ */

export class McpClient {
  /**
   * @param {{request:Function, notify:Function, close:Function}} transport
   * @param {{timeoutMs?:number, protocolVersion?:string}} [options]
   */
  constructor(transport, options = {}) {
    this.transport = transport;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.protocolVersion = options.protocolVersion || '2024-11-05';
    this.serverInfo = null;
    this.capabilities = null;
    this.clientInfo = { name: 'agenda-copilot-p95', version: '1.1.0' };
  }

  async initialize() {
    const result = await this.transport.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: this.clientInfo
    }, { timeoutMs: this.timeoutMs });
    if (!result || typeof result !== 'object') throw protocolError('initialize sin resultado');
    this.serverInfo = result.serverInfo && typeof result.serverInfo === 'object' ? result.serverInfo : null;
    this.capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
    if (typeof result.protocolVersion === 'string') this.protocolVersion = result.protocolVersion;
    await this.transport.notify('notifications/initialized', {});
    return { protocolVersion: this.protocolVersion, serverInfo: this.serverInfo, capabilities: this.capabilities };
  }

  async listTools() {
    const tools = [];
    let cursor = null;
    for (let page = 0; page < 5; page += 1) {
      const params = cursor ? { cursor } : {};
      const result = await this.transport.request('tools/list', params, { timeoutMs: this.timeoutMs });
      const list = Array.isArray(result?.tools) ? result.tools : [];
      for (const tool of list) {
        if (tool && typeof tool.name === 'string') tools.push(tool);
        if (tools.length >= MAX_TOOLS) break;
      }
      if (tools.length >= MAX_TOOLS || !result?.nextCursor) break;
      cursor = String(result.nextCursor);
    }
    return tools.slice(0, MAX_TOOLS);
  }

  async callTool(name, args = {}) {
    const result = await this.transport.request('tools/call', { name, arguments: args || {} }, { timeoutMs: this.timeoutMs });
    return normalizeToolResult(result);
  }

  async close() {
    return this.transport.close();
  }
}

/**
 * @param {unknown} result
 */
export function normalizeToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content.slice(0, 50) : [];
  const texts = [];
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  }
  return {
    content: content.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const copy = { ...item };
      if (typeof copy.text === 'string' && copy.text.length > 100_000) copy.text = `${copy.text.slice(0, 100_000)}…`;
      if (typeof copy.data === 'string' && copy.data.length > 100_000) copy.data = '[recortado]';
      return copy;
    }),
    text: texts.join('\n').slice(0, 200_000),
    structuredContent: result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : null,
    isError: result?.isError === true
  };
}

/** @param {object} server */
export function createTransport(server, options = {}) {
  if (server.transport === 'stdio') {
    return new StdioTransport(server, { env: options.env, timeoutMs: server.timeoutMs || options.timeoutMs });
  }
  if (server.transport === 'sse') {
    return new LegacySseTransport(server, { headers: options.headers, timeoutMs: server.timeoutMs || options.timeoutMs });
  }
  return new HttpTransport(server, { headers: options.headers, timeoutMs: server.timeoutMs || options.timeoutMs });
}

/**
 * Abre una sesión MCP, ejecuta `fn` y siempre cierra el transporte.
 * @template T
 * @param {object} server
 * @param {{env?:object, headers?:object, timeoutMs?:number}} options
 * @param {(client:McpClient)=>Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSession(server, options, fn) {
  const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || Number(server.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const transport = createTransport(server, { ...options, timeoutMs });
  const client = new McpClient(transport, { timeoutMs });
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Handshake + tools/list.
 * @param {object} server
 * @param {{env?:object, headers?:object, timeoutMs?:number}} [options]
 */
export async function probeServer(server, options = {}) {
  const started = Date.now();
  return withSession(server, options, async (client) => {
    const tools = await client.listTools();
    return {
      ok: true,
      protocolVersion: client.protocolVersion,
      serverInfo: client.serverInfo,
      capabilities: client.capabilities,
      tools,
      toolCount: tools.length,
      latencyMs: Date.now() - started
    };
  });
}

/**
 * Llama una herramienta directamente (sin gate). Solo debe usarse después de
 * que el gate haya aprobado la acción o para herramientas de solo lectura.
 * @param {object} server
 * @param {{tool:string,args?:object,env?:object,headers?:object,timeoutMs?:number}} options
 */
export async function callToolDirect(server, options = {}) {
  return withSession(server, options, async (client) => {
    const result = await client.callTool(options.tool, options.args || {});
    return { ...result, tool: options.tool, serverId: server.id, latencyMs: null };
  });
}

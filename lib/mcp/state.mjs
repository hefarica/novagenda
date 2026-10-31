/**
 * Estado persistente del conector MCP dentro del store de la app.
 *
 * `data.mcp`:
 *   {
 *     version: 1,
 *     servers: [ {id, name, transport, command, args, url, enabled,
 *                 toolAllowlist, timeoutMs, createdAt, updatedAt, lastProbe} ],
 *     secrets: { [serverId]: { env: {KEY: <box cifrado>}, headers: {Name: <box>} } },
 *     pendingCalls: { [token]: {box, serverId, tool, createdAt, expiresAt} },
 *     createdAt, updatedAt
 *   }
 *
 * Los valores de `env`/`headers` y los argumentos de llamadas pendientes se
 * cifran con AES-256-GCM (misma clave maestra que la bóveda de t1). La API solo
 * expone `envKeys` / `headerKeys`; nunca los valores.
 */
import crypto from 'node:crypto';
import { store, nextId, encryptJSON, decryptJSON } from '../store.mjs';
import { isPlainObject } from '../validate.mjs';
import { mcpError, pendingCallMissing, MCP_CODES } from './errors.mjs';
import { validateServerRecord } from './schema.mjs';

export const MCP_STATE_VERSION = 1;
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING = 200;
const MAX_SERVERS = 100;

/**
 * @param {any} [data]
 */
export function ensureMcp(data = store.get()) {
  if (!isPlainObject(data.mcp)) data.mcp = {};
  const mcp = data.mcp;
  if (!Number.isFinite(Number(mcp.version))) mcp.version = MCP_STATE_VERSION;
  if (!Array.isArray(mcp.servers)) mcp.servers = [];
  if (!isPlainObject(mcp.secrets)) mcp.secrets = {};
  if (!isPlainObject(mcp.pendingCalls)) mcp.pendingCalls = {};
  if (!mcp.createdAt) mcp.createdAt = new Date().toISOString();
  mcp.updatedAt = mcp.updatedAt || mcp.createdAt;
  return mcp;
}

function secretsOf(data, serverId) {
  const mcp = ensureMcp(data);
  const entry = mcp.secrets[serverId];
  return isPlainObject(entry) ? entry : { env: {}, headers: {} };
}

function syncSecretKeys(data, server) {
  const secrets = secretsOf(data, server.id);
  const envKeys = new Set([...(Array.isArray(server.envKeys) ? server.envKeys : []), ...Object.keys(secrets.env || {})]);
  const headerKeys = new Set([...(Array.isArray(server.headerKeys) ? server.headerKeys : []), ...Object.keys(secrets.headers || {})]);
  server.envKeys = [...envKeys].sort();
  server.headerKeys = [...headerKeys].sort();
}

/**
 * Copia pública de un servidor: sin valores de secretos.
 * @param {any} server
 * @param {any} [data]
 */
export function publicServer(server, data = store.get()) {
  if (!server || typeof server !== 'object') return null;
  const secrets = secretsOf(data, server.id);
  const envKeys = [...new Set([...(Array.isArray(server.envKeys) ? server.envKeys : []), ...Object.keys(secrets.env || {})])].sort();
  const headerKeys = [...new Set([...(Array.isArray(server.headerKeys) ? server.headerKeys : []), ...Object.keys(secrets.headers || {})])].sort();
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command || null,
    args: Array.isArray(server.args) ? [...server.args] : [],
    url: server.url || null,
    enabled: server.enabled !== false,
    toolAllowlist: Array.isArray(server.toolAllowlist) ? [...server.toolAllowlist] : [],
    timeoutMs: Number(server.timeoutMs) || 10000,
    envKeys,
    headerKeys,
    secretCount: envKeys.length + headerKeys.length,
    createdAt: server.createdAt || null,
    updatedAt: server.updatedAt || null,
    lastProbe: server.lastProbe ? JSON.parse(JSON.stringify(server.lastProbe)) : null
  };
}

/**
 * @param {any} [data]
 */
export function listServers(data = store.get()) {
  const mcp = ensureMcp(data);
  const items = mcp.servers.map((server) => publicServer(server, data));
  return { items, count: items.length, total: items.length };
}

/**
 * Registro interno (sin secretos inline, pero con todos los campos operativos).
 * @param {string} id
 * @param {any} [data]
 */
export function findServerRecord(id, data = store.get()) {
  const mcp = ensureMcp(data);
  const server = mcp.servers.find((item) => item && item.id === id);
  return server || null;
}

/** @param {string} id @param {any} [data] */
export function getServerPublic(id, data = store.get()) {
  const server = findServerRecord(id, data);
  return server ? publicServer(server, data) : null;
}

function writeSecretBoxes(target, patch) {
  if (!isPlainObject(patch)) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
      continue;
    }
    target[key] = encryptJSON(String(value));
  }
}

/**
 * @param {any} data
 * @param {string} serverId
 * @param {{env?:object, headers?:object}} input
 */
function applySecrets(data, serverId, input) {
  const mcp = ensureMcp(data);
  if (!isPlainObject(mcp.secrets[serverId])) mcp.secrets[serverId] = { env: {}, headers: {} };
  const box = mcp.secrets[serverId];
  if (!isPlainObject(box.env)) box.env = {};
  if (!isPlainObject(box.headers)) box.headers = {};
  if (input.env !== undefined) writeSecretBoxes(box.env, input.env);
  if (input.headers !== undefined) writeSecretBoxes(box.headers, input.headers);
}

/**
 * Crea un servidor. `input` viene normalizado por `schema.validateServerCreate`.
 * @param {object} input
 */
export async function createServer(input) {
  let created = null;
  await store.mutate((data) => {
    const mcp = ensureMcp(data);
    if (mcp.servers.length >= MAX_SERVERS) {
      throw mcpError(409, 'MCP_SERVER_LIMIT', `Máximo ${MAX_SERVERS} servidores MCP.`);
    }
    const now = new Date().toISOString();
    const server = {
      id: nextId('MCP', mcp.servers),
      name: input.name,
      transport: input.transport,
      command: input.transport === 'stdio' ? input.command : null,
      args: input.transport === 'stdio' ? [...input.args] : [],
      url: input.transport === 'stdio' ? null : input.url,
      enabled: input.enabled !== false,
      toolAllowlist: [...input.toolAllowlist],
      timeoutMs: Number(input.timeoutMs) || 10000,
      envKeys: [...new Set([...(input.envKeys || []), ...Object.keys(input.env || {})])].sort(),
      headerKeys: [...new Set([...(input.headerKeys || []), ...Object.keys(input.headers || {})])].sort(),
      createdAt: now,
      updatedAt: now,
      lastProbe: null
    };
    validateServerRecord(server);
    applySecrets(data, server.id, input);
    syncSecretKeys(data, server);
    mcp.servers.push(server);
    mcp.updatedAt = now;
    created = server;
  }, { label: 'mcp-server-create' });
  return publicServer(created);
}

/**
 * @param {string} id
 * @param {object} patch normalizado por `schema.validateServerPatch`
 */
export async function updateServer(id, patch) {
  let output = null;
  await store.mutate((data) => {
    const mcp = ensureMcp(data);
    const server = mcp.servers.find((item) => item && item.id === id);
    if (!server) throw mcpError(404, MCP_CODES.SERVER_NOT_FOUND, `Servidor MCP ${id} no encontrado.`, { id });
    const candidate = { ...server };
    for (const field of ['name', 'transport', 'command', 'args', 'url', 'enabled', 'toolAllowlist', 'timeoutMs', 'envKeys', 'headerKeys']) {
      if (patch[field] !== undefined) candidate[field] = Array.isArray(patch[field]) ? [...patch[field]] : patch[field];
    }
    if (candidate.transport === 'stdio') {
      candidate.url = null;
    } else {
      candidate.command = null;
      candidate.args = [];
    }
    const removedEnv = patch.env ? Object.keys(patch.env).filter((key) => patch.env[key] === null) : [];
    const removedHeaders = patch.headers ? Object.keys(patch.headers).filter((name) => patch.headers[name] === null) : [];
    if (removedEnv.length && Array.isArray(candidate.envKeys)) candidate.envKeys = candidate.envKeys.filter((key) => !removedEnv.includes(key));
    if (removedHeaders.length && Array.isArray(candidate.headerKeys)) candidate.headerKeys = candidate.headerKeys.filter((name) => !removedHeaders.includes(name));
    validateServerRecord(candidate);
    applySecrets(data, id, patch);
    Object.assign(server, candidate);
    syncSecretKeys(data, server);
    server.updatedAt = new Date().toISOString();
    mcp.updatedAt = server.updatedAt;
    output = server;
  }, { label: 'mcp-server-update' });
  return publicServer(output);
}

/** @param {string} id */
export async function deleteServer(id) {
  let removed = false;
  await store.mutate((data) => {
    const mcp = ensureMcp(data);
    const index = mcp.servers.findIndex((item) => item && item.id === id);
    if (index < 0) throw mcpError(404, MCP_CODES.SERVER_NOT_FOUND, `Servidor MCP ${id} no encontrado.`, { id });
    mcp.servers.splice(index, 1);
    delete mcp.secrets[id];
    for (const [token, call] of Object.entries(mcp.pendingCalls)) {
      if (call && call.serverId === id) delete mcp.pendingCalls[token];
    }
    mcp.updatedAt = new Date().toISOString();
    removed = true;
  }, { label: 'mcp-server-delete' });
  return { ok: removed, id };
}

/**
 * Guarda el resultado del último probe (sin secretos).
 * @param {string} id
 * @param {object} probe
 */
export async function recordProbe(id, probe) {
  await store.mutate((data) => {
    const mcp = ensureMcp(data);
    const server = mcp.servers.find((item) => item && item.id === id);
    if (!server) return;
    server.lastProbe = {
      at: new Date().toISOString(),
      ok: probe.ok === true,
      toolCount: Number(probe.toolCount) || 0,
      tools: Array.isArray(probe.tools) ? probe.tools.slice(0, 200) : [],
      serverInfo: probe.serverInfo || null,
      protocolVersion: probe.protocolVersion || null,
      latencyMs: probe.latencyMs ?? null,
      errorCode: probe.errorCode || null
    };
    server.updatedAt = server.lastProbe.at;
    mcp.updatedAt = server.lastProbe.at;
  }, { label: 'mcp-probe' });
}

function decryptValue(box, label) {
  try {
    const value = decryptJSON(box);
    if (typeof value !== 'string') throw new Error('valor no textual');
    return value;
  } catch {
    throw mcpError(500, MCP_CODES.SECRET_ERROR, `No se pudo descifrar ${label} (¿cambió la clave maestra?).`);
  }
}

/**
 * Resuelve las variables de entorno de un servidor (valores descifrados).
 * @param {any} server
 * @param {any} [data]
 */
export function resolveEnv(server, data = store.get()) {
  const secrets = secretsOf(data, server.id);
  const out = {};
  for (const [key, box] of Object.entries(secrets.env || {})) {
    out[key] = decryptValue(box, `env.${key} de ${server.id}`);
  }
  return out;
}

/**
 * Resuelve las cabeceras HTTP de un servidor.
 * @param {any} server
 * @param {any} [data]
 */
export function resolveHeaders(server, data = store.get()) {
  const secrets = secretsOf(data, server.id);
  const out = {};
  for (const [name, box] of Object.entries(secrets.headers || {})) {
    out[name] = decryptValue(box, `headers.${name} de ${server.id}`);
  }
  return out;
}

function prunePending(mcp) {
  const now = Date.now();
  for (const [token, call] of Object.entries(mcp.pendingCalls)) {
    if (!call || Date.parse(call.expiresAt) <= now) delete mcp.pendingCalls[token];
  }
  const tokens = Object.keys(mcp.pendingCalls);
  while (tokens.length > MAX_PENDING) {
    const oldest = tokens.shift();
    if (oldest) delete mcp.pendingCalls[oldest];
  }
}

/**
 * Guarda una llamada con efectos pendiente de aprobación (args cifrados).
 * @param {{serverId:string, tool:string, args:object}} input
 * @returns {Promise<string>} token
 */
export async function createPendingCall({ serverId, tool, args }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const box = encryptJSON(isPlainObject(args) ? args : {});
  await store.mutate((data) => {
    const mcp = ensureMcp(data);
    prunePending(mcp);
    const now = Date.now();
    mcp.pendingCalls[token] = {
      box,
      serverId,
      tool,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PENDING_TTL_MS).toISOString()
    };
    mcp.updatedAt = new Date(now).toISOString();
  }, { label: 'mcp-pending-call' });
  return token;
}

/**
 * @param {string} token
 * @param {any} [data]
 * @returns {{token:string, serverId:string, tool:string, args:object}}
 */
export function readPendingCall(token, data = store.get()) {
  const mcp = ensureMcp(data);
  const call = mcp.pendingCalls[token];
  if (!call) throw pendingCallMissing(token);
  if (Date.parse(call.expiresAt) <= Date.now()) {
    delete mcp.pendingCalls[token];
    throw pendingCallMissing(token);
  }
  let payload;
  try {
    payload = decryptJSON(call.box);
  } catch {
    throw mcpError(500, MCP_CODES.SECRET_ERROR, 'No se pudieron descifrar los argumentos pendientes de la llamada MCP.');
  }
  return { token, serverId: call.serverId, tool: call.tool, args: isPlainObject(payload) ? payload : {} };
}

/** @param {string} token */
export async function deletePendingCall(token) {
  await store.mutate((data) => {
    const mcp = ensureMcp(data);
    delete mcp.pendingCalls[token];
  }, { label: 'mcp-pending-call-consume' });
}

/** Resumen sin secretos para /api/mcp/status. */
export function mcpSummary(data = store.get()) {
  const mcp = ensureMcp(data);
  return {
    servers: mcp.servers.length,
    enabled: mcp.servers.filter((server) => server.enabled !== false).length,
    pendingCalls: Object.keys(mcp.pendingCalls).length,
    version: mcp.version,
    updatedAt: mcp.updatedAt || null
  };
}

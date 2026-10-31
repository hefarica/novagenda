/**
 * Conectores externos gobernados (t51).
 *
 * Registro homogéneo de herramientas fuera de la agenda (MCP local, webhook,
 * GitHub, Google Drive) con:
 *   - endpoints allowlist: HTTPS o HTTP solo loopback,
 *   - tokens NUNCA en claro: cifrados en `data.connectors.secrets` con la
 *     misma clave maestra del store (o referencia a la bóveda existente),
 *   - prueba de salud sin exponer secretos,
 *   - adaptador HTTP JSON con timeout, límite de bytes y sin comandos,
 *   - gate de aprobación de la Oficina para cualquier efecto externo.
 *
 * Persistencia (`data.connectors`):
 *   { version, items[], secrets{}, pendingCalls{}, createdAt, updatedAt }
 *
 * `authRef` es una REFERENCIA pública, nunca el token:
 *   - `none`
 *   - `encrypted:<connectorId>` (token cifrado en este módulo)
 *   - `vault:<nombreConocido>` (bóveda de t1)
 *   - `google:<connectionId>` (OAuth existente, para Drive)
 *   - `mcp:<serverId>` (servidor MCP existente)
 */
import crypto from 'node:crypto';
import { store, nextId, encryptJSON, decryptJSON } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';
import { redactString } from '../security/redact.mjs';
import { getSecret, isKnownSecret } from '../security/vault.mjs';
import {
  arrayOf, assertObject, boolean, enumValue, integer, isPlainObject, pickFields, text
} from '../validate.mjs';

export const CONNECTOR_STATE_VERSION = 1;
export const CONNECTOR_CAPABILITIES = Object.freeze(['health', 'read', 'write', 'send', 'execute']);
export const EFFECT_CAPABILITIES = Object.freeze(['write', 'send', 'execute']);
const EFFECT_SET = new Set(EFFECT_CAPABILITIES);
const MAX_ITEMS = 100;
const MAX_BYTES_LIMIT = 1_048_576;
const MAX_BODY_BYTES = 65_536;
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING = 200;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 262_144;
const USER_AGENT = 'AgendaCopilot-Connectors/1.0';

/** Catálogo inicial de tipos de conector. */
export const CONNECTOR_KINDS = Object.freeze([
  {
    kind: 'mcp',
    label: 'MCP local',
    description: 'Referencia a un servidor MCP ya registrado (HTTP/SSE). No se ejecutan comandos desde este conector.',
    delegated: true,
    auth: ['mcp'],
    defaultCapabilities: ['health', 'read'],
    endpointDefault: null,
    healthPath: null
  },
  {
    kind: 'webhook',
    label: 'Webhook genérico',
    description: 'Endpoint HTTP JSON propio (n8n, Slack, Zapier, servicio interno).',
    delegated: false,
    auth: ['none', 'encrypted', 'vault'],
    defaultCapabilities: ['health', 'read'],
    endpointDefault: null,
    healthPath: ''
  },
  {
    kind: 'github',
    label: 'GitHub API',
    description: 'API REST de GitHub; token opcional como Bearer.',
    delegated: false,
    auth: ['none', 'encrypted', 'vault'],
    defaultCapabilities: ['health', 'read'],
    endpointDefault: 'https://api.github.com',
    healthPath: '/rate_limit'
  },
  {
    kind: 'drive',
    label: 'Google Drive',
    description: 'Referencia a una conexión OAuth de Google ya existente.',
    delegated: true,
    auth: ['google'],
    defaultCapabilities: ['health', 'read'],
    endpointDefault: 'https://www.googleapis.com/drive/v3',
    healthPath: null
  }
]);

const KIND_MAP = new Map(CONNECTOR_KINDS.map((entry) => [entry.kind, entry]));

export function connectorCatalog() {
  return CONNECTOR_KINDS.map((entry) => ({
    ...entry,
    auth: [...entry.auth],
    defaultCapabilities: [...entry.defaultCapabilities]
  }));
}

function kindEntry(kind) {
  const entry = KIND_MAP.get(String(kind || '').toLowerCase());
  if (!entry) throw new ValidationError('kind', 'CONNECTOR_INVALID_CONFIG', `kind debe ser uno de: ${CONNECTOR_KINDS.map((item) => item.kind).join(', ')}.`);
  return entry;
}

function connectorError(status, code, message, details = null) {
  return new HttpError(status, code, message, { details });
}

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

function emptyState() {
  return {
    version: CONNECTOR_STATE_VERSION,
    items: [],
    secrets: {},
    pendingCalls: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Garantiza `data.connectors` (muta el store; usar dentro de mutate).
 * @param {any} [data]
 */
export function ensureConnectors(data = store.get()) {
  if (!isPlainObject(data.connectors)) data.connectors = emptyState();
  const state = data.connectors;
  if (!Number.isFinite(Number(state.version))) state.version = CONNECTOR_STATE_VERSION;
  if (!Array.isArray(state.items)) state.items = [];
  if (!isPlainObject(state.secrets)) state.secrets = {};
  if (!isPlainObject(state.pendingCalls)) state.pendingCalls = {};
  if (!state.createdAt) state.createdAt = new Date().toISOString();
  state.updatedAt = state.updatedAt || state.createdAt;
  prunePending(state);
  return state;
}

/** Lectura pura (sin mutar) para GET/diagnóstico. */
function readConnectors(data = store.get()) {
  const raw = isPlainObject(data.connectors) ? data.connectors : null;
  if (!raw) return emptyState();
  return {
    version: Number(raw.version) || CONNECTOR_STATE_VERSION,
    items: Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item === 'object') : [],
    secrets: isPlainObject(raw.secrets) ? raw.secrets : {},
    pendingCalls: isPlainObject(raw.pendingCalls) ? raw.pendingCalls : {},
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null
  };
}

function prunePending(state) {
  const now = Date.now();
  for (const [token, call] of Object.entries(state.pendingCalls || {})) {
    if (!call || !Number.isFinite(Date.parse(call.expiresAt || '')) || Date.parse(call.expiresAt) <= now) {
      delete state.pendingCalls[token];
    }
  }
  const tokens = Object.keys(state.pendingCalls);
  while (tokens.length > MAX_PENDING) delete state.pendingCalls[tokens.shift()];
}

function secretBoxOf(data, id) {
  const state = isPlainObject(data.connectors) ? data.connectors : null;
  const secrets = state && isPlainObject(state.secrets) ? state.secrets : {};
  return secrets[id] || null;
}

function authKindOf(authRef) {
  const ref = String(authRef || 'none');
  if (ref === 'none') return 'none';
  if (ref.startsWith('encrypted:')) return 'token';
  if (ref.startsWith('vault:')) return 'vault';
  if (ref.startsWith('google:')) return 'google-oauth';
  if (ref.startsWith('mcp:')) return 'mcp';
  return 'unknown';
}

/** Vista pública: sin tokens, sin cajas cifradas. */
export function publicConnector(item, data = store.get()) {
  if (!item || typeof item !== 'object') return null;
  const box = secretBoxOf(data, item.id);
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    description: item.description || '',
    endpoint: item.endpoint || null,
    authRef: item.authRef || 'none',
    authKind: authKindOf(item.authRef),
    hasToken: !!box,
    capabilities: Array.isArray(item.capabilities) ? [...item.capabilities] : [],
    effectful: Array.isArray(item.capabilities) && item.capabilities.some((capability) => EFFECT_SET.has(capability)),
    enabled: item.enabled !== false,
    timeoutMs: Number(item.timeoutMs) || DEFAULT_TIMEOUT_MS,
    maxBytes: Number(item.maxBytes) || DEFAULT_MAX_BYTES,
    healthPath: item.healthPath ?? null,
    lastTest: item.lastTest ? JSON.parse(JSON.stringify(item.lastTest)) : null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    secretCount: box ? 1 : 0
  };
}

export function listConnectors() {
  const state = readConnectors();
  const items = state.items.map((item) => publicConnector(item, store.get()));
  return { items, count: items.length, total: items.length, catalog: connectorCatalog() };
}

export function findConnectorRecord(id, data = store.get()) {
  return readConnectors(data).items.find((item) => item && item.id === id) || null;
}

export function getConnectorPublic(id, data = store.get()) {
  const item = findConnectorRecord(id, data);
  return item ? publicConnector(item, data) : null;
}

/* ------------------------------------------------------------------ */
/* Validación                                                          */
/* ------------------------------------------------------------------ */

const CONNECTOR_FIELDS = Object.freeze([
  'kind', 'name', 'description', 'endpoint', 'authRef', 'token', 'capabilities',
  'enabled', 'timeoutMs', 'maxBytes', 'healthPath'
]);
const AUTH_REF_RE = /^(none|vault:[A-Za-z0-9_.-]{1,120}|google:[A-Za-z0-9_-]{1,64}|mcp:[A-Za-z0-9_-]{1,64})$/;
const ID_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Allowlist de endpoints: HTTPS siempre; HTTP SOLO loopback.
 * Sin credenciales embebidas ni esquemas raros.
 */
export function assertEndpointAllowed(raw, field = 'endpoint') {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new ValidationError(field, 'CONNECTOR_ENDPOINT_NOT_ALLOWED', `${field} debe ser una URL http(s) válida.`);
  }
  if (url.username || url.password) {
    throw new ValidationError(field, 'CONNECTOR_ENDPOINT_NOT_ALLOWED', `${field} no puede incluir credenciales; usa authRef/token.`);
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new ValidationError(field, 'CONNECTOR_ENDPOINT_NOT_ALLOWED', 'HTTP solo se permite contra loopback (localhost/127.0.0.1/::1); usa HTTPS para hosts externos.');
    }
    return url;
  }
  if (url.protocol === 'https:') return url;
  throw new ValidationError(field, 'CONNECTOR_ENDPOINT_NOT_ALLOWED', `${field} debe usar https (o http solo loopback).`);
}

function normalizeHealthPath(raw, field = 'healthPath') {
  if (raw === undefined || raw === null || raw === '') return '';
  const value = text(raw, { field, max: 300, allowEmpty: true, trim: true });
  if (!value) return '';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('..') || /[?#]/.test(value) || /[\u0000\r\n]/.test(value)) {
    throw new ValidationError(field, 'CONNECTOR_INVALID_CONFIG', `${field} debe ser una ruta relativa simple que empiece por "/" y sin .., ? ni #.`);
  }
  return value;
}

function validateAuthRef(raw, kindInfo) {
  const value = String(raw || '').trim();
  if (!value) {
    if (kindInfo.auth.includes('none')) return 'none';
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', `kind ${kindInfo.kind} requiere authRef (${kindInfo.auth.join(', ')}).`);
  }
  if (value.startsWith('encrypted:')) {
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', 'authRef "encrypted:" es interna; envía el token en el campo token.');
  }
  if (!AUTH_REF_RE.test(value)) {
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', 'authRef debe ser none, vault:<nombre>, google:<connectionId> o mcp:<serverId>.');
  }
  const [scheme, ref] = value.split(':');
  if (kindInfo.kind === 'drive' && scheme !== 'google') {
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', 'Drive requiere una referencia google:<connectionId>.');
  }
  if (kindInfo.kind === 'mcp' && scheme !== 'mcp') {
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', 'MCP requiere una referencia mcp:<serverId>.');
  }
  if (scheme === 'vault') {
    if (!ID_REF_RE.test(ref) || !isKnownSecret(ref)) {
      throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', `La bóveda no conoce el secreto ${ref}.`);
    }
  }
  if ((scheme === 'google' || scheme === 'mcp') && !ID_REF_RE.test(ref)) {
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', 'La referencia tiene un identificador inválido.');
  }
  return value;
}

function validateToken(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ValidationError('token', 'CONNECTOR_AUTH_INVALID', 'token debe ser texto.');
  const value = raw.trim();
  if (!value) throw new ValidationError('token', 'CONNECTOR_AUTH_INVALID', 'token no puede estar vacío.');
  if (value.length > 4000) throw new ValidationError('token', 'CONNECTOR_AUTH_INVALID', 'token supera 4000 caracteres.');
  if (/[\u0000\r\n]/.test(value)) throw new ValidationError('token', 'CONNECTOR_AUTH_INVALID', 'token no puede contener saltos de línea.');
  return value;
}

function normalizeCapabilities(raw, kindInfo) {
  const values = arrayOf(raw, (value, index) => enumValue(
    String(value || '').toLowerCase(),
    CONNECTOR_CAPABILITIES,
    { field: `capabilities[${index}]` }
  ), { field: 'capabilities', max: 5, defaultValue: kindInfo.defaultCapabilities });
  const unique = [...new Set(values || kindInfo.defaultCapabilities)];
  if (!unique.length) throw new ValidationError('capabilities', 'CONNECTOR_INVALID_CONFIG', 'capabilities no puede estar vacío.');
  return unique;
}

/**
 * Valida y normaliza el cuerpo de creación.
 * @param {unknown} body
 * @param {any} [data]
 */
export function validateConnectorCreate(body, data = store.get()) {
  const input = pickFields(assertObject(body), CONNECTOR_FIELDS, { field: 'body' });
  const info = kindEntry(input.kind);
  const kind = info.kind;
  const name = text(input.name, { field: 'name', required: true, min: 1, max: 80, allowEmpty: false });
  const description = text(input.description, { field: 'description', max: 500, defaultValue: '' });
  const enabled = boolean(input.enabled, { field: 'enabled', defaultValue: true });
  const timeoutMs = integer(input.timeoutMs, { field: 'timeoutMs', min: 1000, max: 30000, defaultValue: DEFAULT_TIMEOUT_MS });
  const maxBytes = integer(input.maxBytes, { field: 'maxBytes', min: 1024, max: MAX_BYTES_LIMIT, defaultValue: DEFAULT_MAX_BYTES });

  const endpointRaw = input.endpoint === undefined || input.endpoint === null || input.endpoint === ''
    ? (info.endpointDefault || null)
    : input.endpoint;
  if (!endpointRaw && kind !== 'mcp') {
    throw new ValidationError('endpoint', 'CONNECTOR_INVALID_CONFIG', `kind ${kind} requiere endpoint (http(s)).`);
  }
  if (endpointRaw) assertEndpointAllowed(endpointRaw);
  const endpoint = endpointRaw ? String(endpointRaw).trim() : null;

  const healthPath = kind === 'webhook' || kind === 'github'
    ? normalizeHealthPath(input.healthPath === undefined ? info.healthPath : input.healthPath)
    : null;

  const token = validateToken(input.token);
  if (token !== undefined && input.authRef !== undefined && input.authRef !== null && input.authRef !== '') {
    throw new ValidationError('authRef', 'CONNECTOR_AUTH_INVALID', 'Envía token o authRef, no ambos.');
  }
  const authRef = token !== undefined ? 'encrypted:auto' : validateAuthRef(input.authRef, info);
  const capabilities = normalizeCapabilities(input.capabilities, info);

  void data;
  return {
    kind,
    name,
    description,
    endpoint,
    authRef,
    token,
    capabilities,
    enabled,
    timeoutMs,
    maxBytes,
    healthPath
  };
}

export function validateTestInput(body = {}) {
  const input = pickFields(assertObject(body), ['timeoutMs'], { field: 'body', allowEmpty: true });
  return {
    timeoutMs: integer(input.timeoutMs, { field: 'timeoutMs', min: 1000, max: 30000, defaultValue: null })
  };
}

export function validateInvokeInput(body = {}, kind = 'webhook') {
  const input = pickFields(assertObject(body), ['method', 'path', 'capability', 'body', 'payload', 'purpose', 'tool', 'args', 'annotations'], { field: 'body', allowEmpty: true });
  const method = enumValue(
    String(input.method || 'GET').toUpperCase(),
    ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    { field: 'method', defaultValue: 'GET' }
  );
  const path = text(input.path, { field: 'path', max: 2000, defaultValue: '', allowEmpty: true });
  if (/[\u0000\r\n\\]/.test(path) || /%00/i.test(path) || path.includes('://') || path.startsWith('//') || path.includes('..') || /%2e%2e/i.test(path)) {
    throw new ValidationError('path', 'CONNECTOR_INVALID_CONFIG', 'path debe ser una ruta relativa del endpoint, sin URL absoluta, //, .. ni caracteres de control.');
  }
  if (path && !path.startsWith('/')) {
    throw new ValidationError('path', 'CONNECTOR_INVALID_CONFIG', 'path debe empezar por "/" o ir vacío.');
  }
  const capability = input.capability === undefined
    ? (method === 'GET' || method === 'HEAD' ? 'read' : 'write')
    : enumValue(String(input.capability).toLowerCase(), CONNECTOR_CAPABILITIES, { field: 'capability' });
  const payload = input.body !== undefined ? input.body : input.payload;
  let bodyValue = null;
  if (payload !== undefined && payload !== null) {
    if (!isPlainObject(payload) && !Array.isArray(payload)) {
      throw new ValidationError('body', 'CONNECTOR_INVALID_CONFIG', 'body debe ser un objeto o lista JSON.');
    }
    const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (size > MAX_BODY_BYTES) throw new ValidationError('body', 'CONNECTOR_INVALID_CONFIG', `body supera ${MAX_BODY_BYTES} bytes.`);
    bodyValue = payload;
  }
  if (bodyValue !== null && (method === 'GET' || method === 'HEAD')) {
    throw new ValidationError('body', 'CONNECTOR_INVALID_CONFIG', `${method} no admite body.`);
  }
  const purpose = text(input.purpose, { field: 'purpose', max: 300, defaultValue: '' });
  let tool = null;
  let args = {};
  if (kind === 'mcp') {
    tool = text(input.tool, { field: 'tool', required: true, max: 120, allowEmpty: false });
    if (input.args !== undefined) {
      if (!isPlainObject(input.args)) throw new ValidationError('args', 'CONNECTOR_INVALID_CONFIG', 'args debe ser un objeto.');
      if (Buffer.byteLength(JSON.stringify(input.args), 'utf8') > 16_384) {
        throw new ValidationError('args', 'CONNECTOR_INVALID_CONFIG', 'args supera 16 KB.');
      }
      args = input.args;
    }
  }
  const annotations = isPlainObject(input.annotations) ? input.annotations : {};
  return { method, path, capability, body: bodyValue, purpose, tool, args, annotations };
}

/* ------------------------------------------------------------------ */
/* Autorización                                                        */
/* ------------------------------------------------------------------ */

async function resolveAuth(connector, data = store.get()) {
  const ref = String(connector.authRef || 'none');
  if (ref === 'none') return { kind: 'none', headers: {} };
  if (ref.startsWith('encrypted:')) {
    const id = ref.slice('encrypted:'.length);
    const box = secretBoxOf(data, id);
    if (!box || !box.box) throw connectorError(400, 'CONNECTOR_AUTH_REQUIRED', 'El conector no tiene token cifrado; vuelve a crearlo con token.');
    let token;
    try {
      token = decryptJSON(box.box);
    } catch {
      throw connectorError(500, 'CONNECTOR_SECRET_ERROR', 'No se pudo descifrar el token del conector.');
    }
    return { kind: 'token', headers: { authorization: `Bearer ${token}` } };
  }
  if (ref.startsWith('vault:')) {
    const name = ref.slice('vault:'.length);
    if (!isKnownSecret(name)) throw connectorError(400, 'CONNECTOR_AUTH_INVALID', `La bóveda no conoce ${name}.`);
    const token = getSecret(name);
    if (!token) throw connectorError(400, 'CONNECTOR_AUTH_REQUIRED', `El secreto de la bóveda ${name} no está configurado.`);
    return { kind: 'vault', headers: { authorization: `Bearer ${token}` } };
  }
  if (ref.startsWith('google:')) {
    const connectionId = ref.slice('google:'.length);
    const connection = (store.get().googleConnections || []).find((item) => item.id === connectionId);
    if (!connection) throw connectorError(400, 'CONNECTOR_GOOGLE_NOT_FOUND', `Conexión Google ${connectionId} no encontrada.`);
    let token;
    try {
      token = decryptJSON(connection.token);
    } catch {
      throw connectorError(500, 'CONNECTOR_SECRET_ERROR', 'No se pudo leer el token OAuth de Google.');
    }
    const access = token?.access_token;
    if (!access) throw connectorError(400, 'CONNECTOR_AUTH_REQUIRED', 'La conexión Google no tiene access_token.');
    if (token.expires_at && token.expires_at <= Date.now() + 30_000) {
      throw connectorError(401, 'CONNECTOR_AUTH_EXPIRED', 'El access_token de Google expiró; reconecta la cuenta o usa el módulo de Google.');
    }
    return { kind: 'google-oauth', headers: { authorization: `Bearer ${access}` } };
  }
  if (ref.startsWith('mcp:')) {
    return { kind: 'mcp', headers: {} };
  }
  throw connectorError(400, 'CONNECTOR_AUTH_INVALID', 'authRef desconocido.');
}

/* ------------------------------------------------------------------ */
/* Adaptador HTTP JSON                                                 */
/* ------------------------------------------------------------------ */

function mapNetworkError(error) {
  if (error instanceof HttpError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return connectorError(504, 'CONNECTOR_TIMEOUT', 'La petición al conector superó el timeout.');
  }
  return connectorError(502, 'CONNECTOR_NETWORK', `No se pudo conectar con el conector: ${redactString(String(error?.message || error || 'error')).slice(0, 240)}`);
}

async function readLimited(response, maxBytes, controller) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { controller.abort(); } catch { /* ignore */ }
        throw connectorError(502, 'CONNECTOR_RESPONSE_TOO_LARGE', `La respuesta supera el límite de ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks);
}

/**
 * Petición HTTP JSON con timeout, límite de bytes y sin seguir redirecciones.
 * No registra headers ni cuerpos (pueden contener tokens).
 */
async function requestJson(url, options = {}) {
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1024, Math.min(MAX_BYTES_LIMIT, Number(options.maxBytes) || DEFAULT_MAX_BYTES));
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch { /* ignore */ }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(options.body !== undefined && options.body !== null ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      body: options.body !== undefined && options.body !== null ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) {
      throw connectorError(502, 'CONNECTOR_REDIRECT_BLOCKED', 'El conector intentó redirigir; no se siguen redirecciones por seguridad.');
    }
    const buffer = await readLimited(response, maxBytes, controller);
    const textBody = buffer.toString('utf8');
    let json = null;
    if (textBody.trim()) {
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('json') || /^[\[{]/.test(textBody.trim())) {
        try { json = JSON.parse(textBody); } catch { json = null; }
      }
    }
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      contentType: response.headers.get('content-type') || null,
      bytes: buffer.length,
      latencyMs: Date.now() - started,
      json,
      text: textBody.slice(0, 4000)
    };
  } catch (error) {
    throw mapNetworkError(error);
  } finally {
    clearTimeout(timer);
  }
}

function joinEndpointPath(endpoint, suffix) {
  const url = new URL(endpoint);
  const base = url.pathname.replace(/\/+$/, '');
  if (suffix) {
    url.pathname = `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}` || '/';
  }
  url.hash = '';
  assertEndpointAllowed(url.href);
  return url;
}

function healthUrl(connector) {
  const suffix = connector.healthPath ?? '';
  return joinEndpointPath(connector.endpoint, suffix);
}

function invokeUrl(connector, path) {
  if (!connector.endpoint) throw connectorError(400, 'CONNECTOR_INVALID_CONFIG', 'El conector no tiene endpoint HTTP.');
  const raw = String(path || '');
  const queryIndex = raw.indexOf('?');
  const pathname = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const search = queryIndex >= 0 ? raw.slice(queryIndex + 1) : null;
  const url = joinEndpointPath(connector.endpoint, pathname);
  if (search !== null) url.search = search;
  assertEndpointAllowed(url.href);
  return url;
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

function testRecord(result) {
  return {
    at: new Date().toISOString(),
    ok: result.ok === true,
    status: typeof result.status === 'number' && Number.isFinite(result.status) ? result.status : null,
    latencyMs: Number(result.latencyMs) || 0,
    bytes: Number(result.bytes) || 0,
    code: result.code || null,
    error: result.error ? redactString(String(result.error)).slice(0, 300) : null,
    detail: result.detail ? redactString(String(result.detail)).slice(0, 300) : null,
    delegated: result.delegated === true
  };
}

async function healthOf(connector, data, timeoutMs) {
  const started = Date.now();
  if (connector.kind === 'drive') {
    const connectionId = String(connector.authRef || '').startsWith('google:') ? connector.authRef.slice('google:'.length) : null;
    const connection = connectionId ? (data.googleConnections || []).find((item) => item.id === connectionId) : null;
    if (!connection) {
      return { ok: false, code: 'CONNECTOR_GOOGLE_NOT_FOUND', detail: 'La conexión OAuth referenciada no existe.', latencyMs: Date.now() - started, delegated: true };
    }
    if (connection.reconnectRequired === true) {
      return { ok: false, code: 'CONNECTOR_GOOGLE_RECONNECT', detail: 'La conexión Google requiere reconexión.', latencyMs: Date.now() - started, delegated: true };
    }
    return { ok: true, status: null, bytes: 0, detail: `OAuth ${connection.email || connection.id} referenciado.`, latencyMs: Date.now() - started, delegated: true };
  }

  if (connector.kind === 'mcp') {
    const serverId = String(connector.authRef || '').startsWith('mcp:') ? connector.authRef.slice('mcp:'.length) : null;
    const server = serverId ? (data.mcp?.servers || []).find((item) => item.id === serverId) : null;
    if (!server) {
      return { ok: false, code: 'CONNECTOR_MCP_NOT_FOUND', detail: 'El servidor MCP referenciado no existe.', latencyMs: Date.now() - started, delegated: true };
    }
    if (server.enabled === false) {
      return { ok: false, code: 'CONNECTOR_MCP_DISABLED', detail: 'El servidor MCP está deshabilitado.', latencyMs: Date.now() - started, delegated: true };
    }
    if (server.transport === 'stdio') {
      return { ok: false, code: 'CONNECTOR_MCP_STDIO_DELEGATED', detail: 'Servidor stdio: la prueba de salud se hace desde /api/mcp (este conector no ejecuta comandos).', latencyMs: Date.now() - started, delegated: true };
    }
    try {
      const { probeServer } = await import('../mcp/client.mjs');
      const { resolveHeaders } = await import('../mcp/state.mjs');
      const probe = await probeServer(server, {
        headers: resolveHeaders(server),
        timeoutMs: Math.min(30000, Math.max(1000, Number(timeoutMs) || 10000))
      });
      return { ok: true, status: null, bytes: 0, detail: `MCP ${server.transport}: ${probe.toolCount} herramienta(s).`, latencyMs: Date.now() - started, delegated: true };
    } catch (error) {
      return { ok: false, code: error?.code || 'CONNECTOR_MCP_PROBE_FAILED', detail: redactString(String(error?.message || error)).slice(0, 300), latencyMs: Date.now() - started, delegated: true };
    }
  }

  try {
    const auth = await resolveAuth(connector, data);
    const result = await requestJson(healthUrl(connector), {
      method: 'GET',
      headers: auth.headers,
      timeoutMs,
      maxBytes: Math.min(connector.maxBytes, 262_144)
    });
    return {
      ok: result.ok,
      status: result.status,
      bytes: result.bytes,
      latencyMs: Date.now() - started,
      detail: `HTTP ${result.status}`
    };
  } catch (error) {
    const mapped = mapNetworkError(error);
    return {
      ok: false,
      status: null,
      bytes: 0,
      latencyMs: Date.now() - started,
      code: mapped.code || 'CONNECTOR_HEALTH_FAILED',
      error: redactString(mapped.message || 'error')
    };
  }
}

/**
 * Prueba de salud de un conector y persiste `lastTest` (sin secretos).
 * @param {string} id
 * @param {{timeoutMs?:number}} [options]
 */
export async function testConnector(id, options = {}) {
  const connector = findConnectorRecord(id);
  if (!connector) throw connectorError(404, 'CONNECTOR_NOT_FOUND', `Conector ${id} no encontrado.`);
  if (connector.enabled === false) throw connectorError(409, 'CONNECTOR_DISABLED', `El conector ${id} está deshabilitado.`);
  const timeoutMs = Number(options.timeoutMs) || connector.timeoutMs || DEFAULT_TIMEOUT_MS;
  const test = testRecord(await healthOf(connector, store.get(), timeoutMs));
  let updated = null;
  await store.mutate((data) => {
    const state = ensureConnectors(data);
    const item = state.items.find((entry) => entry && entry.id === id);
    if (!item) return;
    item.lastTest = test;
    item.updatedAt = new Date().toISOString();
    state.updatedAt = item.updatedAt;
    updated = item;
  }, { label: 'connector-test' });
  if (!updated) throw connectorError(404, 'CONNECTOR_NOT_FOUND', `Conector ${id} no encontrado.`);
  return { item: publicConnector(updated), test };
}

/* ------------------------------------------------------------------ */
/* Gate de aprobación y ejecución diferida                             */
/* ------------------------------------------------------------------ */

let officeProposalsPromise = null;
let officeExecutorsPromise = null;
let executorRegistered = false;
let executorPromise = null;

function gateDisabled() {
  return String(process.env.CONNECTOR_GATE_DISABLE || '') === '1';
}

async function loadOfficeProposals() {
  if (!officeProposalsPromise) {
    officeProposalsPromise = import('../office/proposals.mjs')
      .then((module) => (typeof module.createProposal === 'function' ? module : null))
      .catch(() => null);
  }
  return officeProposalsPromise;
}

async function loadOfficeExecutors() {
  if (!officeExecutorsPromise) {
    officeExecutorsPromise = import('../office/executors.mjs').catch(() => null);
  }
  return officeExecutorsPromise;
}

export async function connectorGateStatus() {
  if (gateDisabled()) {
    return { available: false, disabledByEnv: true, module: 'lib/office/proposals.mjs', executorRegistered };
  }
  const office = await loadOfficeProposals();
  return {
    available: !!office,
    disabledByEnv: false,
    module: 'lib/office/proposals.mjs',
    executorRegistered
  };
}

function readPending(connectorId, token, data = store.get()) {
  const state = readConnectors(data);
  const pending = state.pendingCalls[token];
  if (!pending || !pending.box) throw connectorError(409, 'CONNECTOR_PENDING_CALL_MISSING', 'La llamada pendiente no existe o caducó.');
  if (Date.parse(pending.expiresAt || '') <= Date.now()) throw connectorError(409, 'CONNECTOR_PENDING_CALL_MISSING', 'La llamada pendiente caducó.');
  if (pending.connectorId !== connectorId) throw connectorError(409, 'CONNECTOR_PENDING_CALL_MISSING', 'La llamada pendiente no corresponde a este conector.');
  let payload;
  try {
    payload = decryptJSON(pending.box);
  } catch {
    throw connectorError(500, 'CONNECTOR_SECRET_ERROR', 'No se pudieron descifrar los argumentos pendientes.');
  }
  return payload;
}

async function deletePending(token) {
  await store.mutate((data) => {
    if (isPlainObject(data.connectors?.pendingCalls)) delete data.connectors.pendingCalls[token];
  }, { label: 'connector-pending-delete' }).catch(() => {});
}

async function executePendingConnector(connectorId, payload) {
  const connector = findConnectorRecord(connectorId);
  if (!connector) throw new Error(`Conector ${connectorId} no encontrado.`);
  if (connector.enabled === false) throw new Error(`El conector ${connectorId} está deshabilitado.`);
  if (connector.kind === 'mcp') {
    const serverId = String(connector.authRef || '').startsWith('mcp:') ? connector.authRef.slice('mcp:'.length) : null;
    const server = serverId ? (store.get().mcp?.servers || []).find((item) => item.id === serverId) : null;
    if (!server) throw new Error(`Servidor MCP ${serverId} no encontrado.`);
    if (server.enabled === false) throw new Error(`Servidor MCP ${serverId} deshabilitado.`);
    if (server.transport === 'stdio') throw new Error('Este conector no ejecuta servidores MCP stdio; usa el módulo MCP con su gate.');
    const { callToolDirect } = await import('../mcp/client.mjs');
    const { resolveHeaders } = await import('../mcp/state.mjs');
    const result = await callToolDirect(server, {
      tool: payload.tool,
      args: payload.args || {},
      headers: resolveHeaders(server),
      timeoutMs: server.timeoutMs
    });
    if (result.isError) throw new Error(`La herramienta MCP ${payload.tool} devolvió error.`);
    return {
      ok: true,
      executor: 'connector-mcp',
      detail: `Herramienta MCP ${payload.tool} ejecutada tras aprobación.`,
      artifacts: [{ type: 'connector', kind: 'mcp', id: connector.id, tool: payload.tool, text: String(result.text || '').slice(0, 1000) }]
    };
  }

  const auth = await resolveAuth(connector, store.get());
  const url = invokeUrl(connector, payload.path);
  const result = await requestJson(url, {
    method: payload.method,
    headers: auth.headers,
    body: payload.body,
    timeoutMs: connector.timeoutMs,
    maxBytes: connector.maxBytes
  });
  if (!result.ok) throw new Error(`El conector respondió HTTP ${result.status}.`);
  return {
    ok: true,
    executor: 'connector-http',
    detail: `${payload.method} ${url.pathname} → HTTP ${result.status}.`,
    artifacts: [{ type: 'connector', id: connector.id, kind: connector.kind, status: result.status, bytes: result.bytes }]
  };
}

/** Registra el ejecutor `connector` en la Oficina (idempotente). */
export async function registerConnectorExecutor() {
  if (executorRegistered) return true;
  if (executorPromise) return executorPromise;
  executorPromise = (async () => {
    try {
      if (gateDisabled()) return false;
      const office = await loadOfficeProposals();
      if (!office) return false;
      const executors = await loadOfficeExecutors();
      if (!executors || typeof executors.registerExecutor !== 'function') return false;
      executors.registerExecutor('connector', {
        name: 'connector-http',
        available: async () => true,
        execute: async (proposal) => {
          const meta = proposal?.meta?.connector;
          if (!meta || proposal?.kind !== 'connector' || !meta.connectorId || !meta.gateToken) {
            throw new Error('La propuesta no es una llamada de conector válida.');
          }
          const payload = readPending(meta.connectorId, meta.gateToken, store.get());
          const result = await executePendingConnector(meta.connectorId, payload);
          await deletePending(meta.gateToken);
          return result;
        }
      });
      executorRegistered = true;
      return true;
    } catch {
      return false;
    } finally {
      executorPromise = null;
    }
  })();
  return executorPromise;
}

function publicPendingProposal(result) {
  const proposal = result?.proposal || null;
  return {
    ok: true,
    pending: true,
    status: 202,
    approvalRequired: true,
    proposal,
    level: proposal?.level || null,
    proposalStatus: proposal?.status || null,
    auto: result?.auto === true,
    executed: result?.executed === true
  };
}

/**
 * Crea la propuesta de aprobación para una operación con efectos.
 * Nunca ejecuta la llamada externa: eso solo ocurre cuando la Oficina aprueba
 * y ejecuta la propuesta (ejecutor `connector`).
 */
async function gateConnectorCall(connector, input, { actor = 'api' } = {}) {
  const status = await connectorGateStatus();
  if (!status.available) {
    throw connectorError(503, 'CONNECTOR_GATE_UNAVAILABLE', status.disabledByEnv
      ? 'El gate de conectores está deshabilitado por CONNECTOR_GATE_DISABLE=1.'
      : 'La Oficina no está disponible; los efectos externos están denegados.');
  }
  if (!(await registerConnectorExecutor())) {
    throw connectorError(503, 'CONNECTOR_GATE_UNAVAILABLE', 'No se pudo registrar el ejecutor de conectores en la Oficina.');
  }
  const office = await loadOfficeProposals();
  if (!office) throw connectorError(503, 'CONNECTOR_GATE_UNAVAILABLE', 'La Oficina no está disponible.');

  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const payload = {
    kind: connector.kind,
    method: input.method,
    path: input.path || '',
    body: input.body ?? null,
    capability: input.capability,
    tool: input.tool || null,
    args: input.args || {}
  };
  await store.mutate((data) => {
    const state = ensureConnectors(data);
    state.pendingCalls[token] = {
      connectorId: connector.id,
      box: encryptJSON(payload),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString()
    };
    prunePending(state);
  }, { label: 'connector-pending' });

  const safePath = String(input.path || '').split('?')[0].slice(0, 300);
  const subject = `Conector ${connector.name}: ${input.method} ${safePath || '/'}`.slice(0, 300);
  const body = [
    `Operación externa con efectos a través del conector "${connector.name}" (${connector.kind}).`,
    `Método: ${input.method} ${safePath || '/'}`,
    input.purpose ? `Propósito: ${String(input.purpose).slice(0, 300)}` : 'Propósito no declarado.',
    'Requiere aprobación de la Oficina antes de ejecutarse; el token de autorización no se incluye aquí.'
  ].join('\n').slice(0, 2000);
  const meta = {
    connector: {
      connectorId: connector.id,
      name: connector.name,
      kind: connector.kind,
      method: input.method,
      path: safePath,
      capability: input.capability,
      tool: input.tool || null,
      gateToken: token,
      effect: true
    },
    effect: true,
    readOnly: false
  };

  let result;
  try {
    result = await office.createProposal({
      input: {
        kind: 'connector',
        channel: 'connector',
        recipients: [],
        subject,
        body,
        attachments: [`connector:${connector.id}`.slice(0, 500)],
        meta
      },
      actor: String(actor || 'api').slice(0, 80),
      forceApproval: true
    });
  } catch (error) {
    await deletePending(token);
    if (error instanceof HttpError) {
      throw connectorError(error.status >= 500 ? 502 : error.status, error.code || 'CONNECTOR_GATE_FAILED', `Gate de conector: ${redactString(error.message || '')}`, error.details || null);
    }
    throw connectorError(502, 'CONNECTOR_GATE_FAILED', `No se pudo crear la propuesta de aprobación: ${redactString(String(error?.message || error)).slice(0, 200)}`);
  }
  return publicPendingProposal(result);
}

/* ------------------------------------------------------------------ */
/* Invocación                                                          */
/* ------------------------------------------------------------------ */

function requireCapability(connector, capability) {
  const list = Array.isArray(connector.capabilities) ? connector.capabilities : [];
  if (!list.includes(capability)) {
    throw connectorError(403, 'CONNECTOR_CAPABILITY_NOT_ALLOWED', `El conector no declara la capacidad "${capability}".`);
  }
}

async function invokeMcp(connector, input, { actor }) {
  const serverId = String(connector.authRef || '').startsWith('mcp:') ? connector.authRef.slice('mcp:'.length) : null;
  const server = serverId ? (store.get().mcp?.servers || []).find((item) => item.id === serverId) : null;
  if (!server) throw connectorError(404, 'CONNECTOR_MCP_NOT_FOUND', `Servidor MCP ${serverId} no encontrado.`);
  if (server.enabled === false) throw connectorError(409, 'CONNECTOR_MCP_DISABLED', `El servidor MCP ${serverId} está deshabilitado.`);
  if (server.transport === 'stdio') {
    throw connectorError(400, 'CONNECTOR_MCP_STDIO_UNSUPPORTED', 'Este conector no ejecuta servidores MCP stdio. Usa /api/mcp/servers/:id/call con su gate.');
  }
  const { classifyTool } = await import('../mcp/tools.mjs');
  const classification = classifyTool({ name: input.tool, annotations: input.annotations });
  if (classification.effect) {
    requireCapability(connector, 'execute');
    return gateConnectorCall(connector, input, { actor });
  }
  requireCapability(connector, 'read');
  const { callToolDirect } = await import('../mcp/client.mjs');
  const { resolveHeaders } = await import('../mcp/state.mjs');
  const started = Date.now();
  const result = await callToolDirect(server, {
    tool: input.tool,
    args: input.args || {},
    headers: resolveHeaders(server),
    timeoutMs: server.timeoutMs
  });
  if (result.isError) throw connectorError(502, 'CONNECTOR_MCP_TOOL_ERROR', 'La herramienta MCP devolvió error.');
  return {
    ok: true,
    read: true,
    kind: 'mcp',
    tool: input.tool,
    latencyMs: Date.now() - started,
    data: String(result.text || '').slice(0, 4000)
  };
}

/**
 * Invoca un conector.
 *
 * - Lectura (`GET/HEAD` con capacidad read/health): se ejecuta directa.
 * - Efectos (`write/send/execute` o métodos no seguros): NUNCA se ejecutan
 *   aquí; se crea una propuesta de la Oficina y se devuelve 202.
 *
 * @param {string} id
 * @param {object} input validado por validateInvokeInput (o equivalente)
 * @param {{actor?:string}} [options]
 */
export async function invokeConnector(id, input = {}, options = {}) {
  const connector = findConnectorRecord(id);
  if (!connector) throw connectorError(404, 'CONNECTOR_NOT_FOUND', `Conector ${id} no encontrado.`);
  if (connector.enabled === false) throw connectorError(409, 'CONNECTOR_DISABLED', `El conector ${id} está deshabilitado.`);
  const actor = String(options.actor || 'api').slice(0, 80);
  const parsed = validateInvokeInput(input, connector.kind);

  if (connector.kind === 'mcp') {
    return invokeMcp(connector, parsed, { actor });
  }

  const { method, capability } = parsed;
  const effect = EFFECT_SET.has(capability) || !['GET', 'HEAD'].includes(method);

  if (effect) {
    requireCapability(connector, capability);
    return gateConnectorCall(connector, parsed, { actor });
  }

  requireCapability(connector, capability);
  const auth = await resolveAuth(connector, store.get());
  const url = invokeUrl(connector, parsed.path);
  const result = await requestJson(url, {
    method,
    headers: auth.headers,
    body: parsed.body,
    timeoutMs: connector.timeoutMs,
    maxBytes: connector.maxBytes
  });
  if (!result.ok) {
    throw connectorError(502, 'CONNECTOR_HTTP_ERROR', `El conector respondió HTTP ${result.status}.`, { status: result.status });
  }
  return {
    ok: true,
    read: true,
    kind: connector.kind,
    status: result.status,
    contentType: result.contentType,
    bytes: result.bytes,
    latencyMs: result.latencyMs,
    data: result.json !== null ? result.json : result.text.slice(0, 2000)
  };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

/**
 * Crea un conector. El token (si llega) se cifra y nunca se devuelve.
 * @param {unknown} body
 * @param {{actor?:string}} [options]
 */
export async function createConnector(body, options = {}) {
  const input = validateConnectorCreate(body);
  let item = null;
  await store.mutate((data) => {
    const state = ensureConnectors(data);
    if (state.items.length >= MAX_ITEMS) {
      throw connectorError(409, 'CONNECTOR_LIMIT', `Máximo ${MAX_ITEMS} conectores.`);
    }
    const id = nextId('CON', state.items);
    const stamp = new Date().toISOString();
    const storedAuthRef = input.token !== undefined ? `encrypted:${id}` : input.authRef;
    item = {
      id,
      kind: input.kind,
      name: input.name,
      description: input.description,
      endpoint: input.endpoint,
      authRef: storedAuthRef,
      capabilities: [...input.capabilities],
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
      healthPath: input.healthPath,
      createdBy: String(options.actor || 'api').slice(0, 80),
      createdAt: stamp,
      updatedAt: stamp,
      lastTest: null
    };
    state.items.push(item);
    if (input.token !== undefined) {
      state.secrets[id] = {
        box: encryptJSON(input.token),
        createdAt: stamp
      };
    }
    state.updatedAt = stamp;
  }, { label: 'connector-create' });
  return publicConnector(item);
}

/**
 * Elimina un conector, su token cifrado y sus llamadas pendientes.
 * @param {string} id
 */
export async function deleteConnector(id) {
  const existing = findConnectorRecord(id);
  if (!existing) throw connectorError(404, 'CONNECTOR_NOT_FOUND', `Conector ${id} no encontrado.`);
  await store.mutate((data) => {
    const state = ensureConnectors(data);
    state.items = state.items.filter((item) => item && item.id !== id);
    delete state.secrets[id];
    for (const [token, pending] of Object.entries(state.pendingCalls || {})) {
      if (!pending || pending.connectorId === id) delete state.pendingCalls[token];
    }
    state.updatedAt = new Date().toISOString();
  }, { label: 'connector-delete' });
  return { deleted: true, id };
}

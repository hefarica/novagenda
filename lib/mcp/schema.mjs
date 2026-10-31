/**
 * Validación estricta de la API MCP (sin dependencias).
 *
 * Reglas clave:
 * - `env` y `headers` llegan con valores para guardarlos cifrados, pero la API
 *   nunca los devuelve (solo `envKeys` / `headerKeys`).
 * - stdio exige `command`; http/sse exigen URL http(s) sin credenciales embebidas.
 * - args de herramientas: objeto JSON ≤ 8000 bytes.
 */
import { pickFields, text, integer, boolean, arrayOf, enumValue, assertObject, isPlainObject } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';

export const TRANSPORTS = Object.freeze(['stdio', 'http', 'sse']);
export const SERVER_FIELDS = Object.freeze([
  'name', 'transport', 'command', 'args', 'url', 'env', 'headers',
  'envKeys', 'headerKeys', 'enabled', 'toolAllowlist', 'timeoutMs'
]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,40}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive']);

function noControl(value, field, { allowNewlines = false } = {}) {
  const pattern = allowNewlines ? /[\u0000]/ : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  if (pattern.test(value)) throw new ValidationError(field, 'INVALID_CHARS', `${field} contiene caracteres de control.`);
  return value;
}

function validateEnv(value, { partial = false } = {}) {
  if (value === undefined) return undefined;
  const container = assertObject(value, 'env');
  const entries = Object.entries(container);
  if (entries.length > 50) throw new ValidationError('env', 'TOO_LONG', 'env admite como máximo 50 variables.');
  const out = {};
  for (const [key, raw] of entries) {
    if (!ENV_KEY_RE.test(key)) throw new ValidationError(`env.${key}`, 'INVALID_FORMAT', 'Nombre de variable inválido (A-Z, _, 0-9).');
    if (raw === null && partial) {
      out[key] = null;
      continue;
    }
    if (typeof raw !== 'string') throw new ValidationError(`env.${key}`, 'INVALID_TYPE', 'El valor de la variable debe ser texto.');
    if (raw.length > 4000) throw new ValidationError(`env.${key}`, 'TOO_LONG', 'El valor supera 4000 caracteres.');
    if (raw.length === 0) throw new ValidationError(`env.${key}`, 'REQUIRED', 'El valor no puede estar vacío (usa null para borrarlo en PATCH).');
    noControl(raw, `env.${key}`, { allowNewlines: true });
    out[key] = raw;
  }
  return out;
}

function validateHeadersMap(value, { partial = false } = {}) {
  if (value === undefined) return undefined;
  const container = assertObject(value, 'headers');
  const entries = Object.entries(container);
  if (entries.length > 30) throw new ValidationError('headers', 'TOO_LONG', 'headers admite como máximo 30 cabeceras.');
  const out = {};
  for (const [name, raw] of entries) {
    if (!HEADER_NAME_RE.test(name)) throw new ValidationError(`headers.${name}`, 'INVALID_FORMAT', 'Nombre de cabecera inválido.');
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new ValidationError(`headers.${name}`, 'INVALID_VALUE', `La cabecera ${name} la gestiona el conector.`);
    if (raw === null && partial) {
      out[name] = null;
      continue;
    }
    if (typeof raw !== 'string') throw new ValidationError(`headers.${name}`, 'INVALID_TYPE', 'El valor de la cabecera debe ser texto.');
    if (raw.length > 2000) throw new ValidationError(`headers.${name}`, 'TOO_LONG', 'El valor supera 2000 caracteres.');
    if (raw.length === 0) throw new ValidationError(`headers.${name}`, 'REQUIRED', 'El valor no puede estar vacío (usa null para borrarlo en PATCH).');
    if (/[\r\n\u0000]/.test(raw)) throw new ValidationError(`headers.${name}`, 'INVALID_CHARS', 'La cabecera no puede contener saltos de línea.');
    out[name] = raw;
  }
  return out;
}

function validateCommand(value) {
  const command = text(value, { field: 'command', required: true, max: 300, allowEmpty: false });
  if (/[\r\n\u0000]/.test(command)) throw new ValidationError('command', 'INVALID_CHARS', 'command no puede contener saltos de línea.');
  return command;
}

function validateArgs(value) {
  return arrayOf(value, (item, index) => {
    const arg = text(item, { field: `args[${index}]`, required: true, trim: false, max: 500, allowEmpty: true });
    if (/[\u0000]/.test(arg)) throw new ValidationError(`args[${index}]`, 'INVALID_CHARS', 'Los argumentos no pueden contener NUL.');
    return arg;
  }, { field: 'args', max: 50, defaultValue: [] });
}

function validateUrl(value, field = 'url') {
  const raw = text(value, { field, required: true, max: 1000, allowEmpty: false });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(field, 'INVALID_URL', `${field} debe ser una URL válida.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ValidationError(field, 'INVALID_URL', `${field} debe usar http o https.`);
  if (url.username || url.password) throw new ValidationError(field, 'INVALID_URL', `${field} no puede incluir credenciales; usa headers.`);
  return raw;
}

function validateToolAllowlist(value) {
  return arrayOf(value, (item, index) => {
    const name = text(item, { field: `toolAllowlist[${index}]`, required: true, max: 120, allowEmpty: false });
    if (name !== '*' && !TOOL_NAME_RE.test(name)) throw new ValidationError(`toolAllowlist[${index}]`, 'INVALID_FORMAT', 'Nombre de herramienta inválido.');
    return name;
  }, { field: 'toolAllowlist', max: 100, defaultValue: [] });
}

function validateKeyNames(value, field, regex, max) {
  return arrayOf(value, (item, index) => {
    const name = text(item, { field: `${field}[${index}]`, required: true, max: 64, allowEmpty: false });
    if (!regex.test(name)) throw new ValidationError(`${field}[${index}]`, 'INVALID_FORMAT', `Nombre inválido en ${field}.`);
    return name;
  }, { field, max, defaultValue: [] });
}

/**
 * @param {unknown} body
 */
export function validateServerCreate(body) {
  const input = pickFields(body, SERVER_FIELDS);
  const name = text(input.name, { field: 'name', required: true, max: 80, allowEmpty: false });
  const transport = enumValue(input.transport, TRANSPORTS, { field: 'transport', defaultValue: 'stdio' });
  const args = validateArgs(input.args);
  const timeoutMs = integer(input.timeoutMs, { field: 'timeoutMs', min: 1000, max: 60000, defaultValue: 10000 });
  const enabled = boolean(input.enabled, { field: 'enabled', defaultValue: true });
  const toolAllowlist = validateToolAllowlist(input.toolAllowlist);
  const env = validateEnv(input.env);
  const headers = validateHeadersMap(input.headers);
  const envKeys = validateKeyNames(input.envKeys, 'envKeys', ENV_KEY_RE, 50);
  const headerKeys = validateKeyNames(input.headerKeys, 'headerKeys', HEADER_NAME_RE, 30);
  let command = null;
  let url = null;
  if (transport === 'stdio') {
    command = validateCommand(input.command);
    if (input.url !== undefined) throw new ValidationError('url', 'INVALID_VALUE', 'transport stdio no admite url.');
  } else {
    url = validateUrl(input.url);
    if (input.command !== undefined) throw new ValidationError('command', 'INVALID_VALUE', `transport ${transport} no admite command.`);
  }
  return { name, transport, command, args: transport === 'stdio' ? args : [], url, env: env || {}, headers: headers || {}, envKeys, headerKeys, enabled, toolAllowlist, timeoutMs };
}

/**
 * Valida un PATCH. El resultado se fusiona con el servidor actual y se vuelve a
 * validar con `validateServerRecord`.
 * @param {unknown} body
 */
export function validateServerPatch(body) {
  const input = pickFields(body, SERVER_FIELDS);
  const patch = {};
  if (input.name !== undefined) patch.name = text(input.name, { field: 'name', required: true, max: 80, allowEmpty: false });
  if (input.transport !== undefined) patch.transport = enumValue(input.transport, TRANSPORTS, { field: 'transport', required: true });
  if (input.command !== undefined) patch.command = validateCommand(input.command);
  if (input.args !== undefined) patch.args = validateArgs(input.args);
  if (input.url !== undefined) patch.url = validateUrl(input.url);
  if (input.timeoutMs !== undefined) patch.timeoutMs = integer(input.timeoutMs, { field: 'timeoutMs', min: 1000, max: 60000, required: true });
  if (input.enabled !== undefined) patch.enabled = boolean(input.enabled, { field: 'enabled', required: true });
  if (input.toolAllowlist !== undefined) patch.toolAllowlist = validateToolAllowlist(input.toolAllowlist);
  if (input.env !== undefined) patch.env = validateEnv(input.env, { partial: true });
  if (input.headers !== undefined) patch.headers = validateHeadersMap(input.headers, { partial: true });
  if (input.envKeys !== undefined) patch.envKeys = validateKeyNames(input.envKeys, 'envKeys', ENV_KEY_RE, 50);
  if (input.headerKeys !== undefined) patch.headerKeys = validateKeyNames(input.headerKeys, 'headerKeys', HEADER_NAME_RE, 30);
  return patch;
}

/**
 * Valida la coherencia del registro final (tras fusionar un PATCH).
 * @param {object} server
 */
export function validateServerRecord(server) {
  const transport = enumValue(server.transport, TRANSPORTS, { field: 'transport', required: true });
  if (transport === 'stdio') {
    validateCommand(server.command);
  } else {
    validateUrl(server.url);
  }
  if (!Array.isArray(server.args)) throw new ValidationError('args', 'INVALID_VALUE', 'args debe ser una lista.');
  if (!Array.isArray(server.toolAllowlist)) throw new ValidationError('toolAllowlist', 'INVALID_VALUE', 'toolAllowlist debe ser una lista.');
  if (server.envKeys !== undefined && !Array.isArray(server.envKeys)) throw new ValidationError('envKeys', 'INVALID_VALUE', 'envKeys debe ser una lista.');
  if (server.headerKeys !== undefined && !Array.isArray(server.headerKeys)) throw new ValidationError('headerKeys', 'INVALID_VALUE', 'headerKeys debe ser una lista.');
  if (!Number.isFinite(Number(server.timeoutMs))) throw new ValidationError('timeoutMs', 'INVALID_VALUE', 'timeoutMs inválido.');
  return true;
}

/** @param {unknown} body */
export function validateCall(body) {
  const input = pickFields(body, ['tool', 'args']);
  const tool = text(input.tool, { field: 'tool', required: true, max: 120, allowEmpty: false });
  if (!TOOL_NAME_RE.test(tool)) throw new ValidationError('tool', 'INVALID_FORMAT', 'Nombre de herramienta inválido.');
  const args = input.args === undefined ? {} : assertObject(input.args, 'args');
  const size = Buffer.byteLength(JSON.stringify(args), 'utf8');
  if (size > 8000) throw new ValidationError('args', 'TOO_LONG', 'args supera 8000 bytes serializados.');
  return { tool, args };
}

/** @param {unknown} body */
export function validateProbe(body) {
  const input = body === undefined || body === null ? {} : body;
  if (!isPlainObject(input)) throw new ValidationError('body', 'INVALID_BODY', 'El cuerpo debe ser un objeto JSON.');
  for (const key of Object.keys(input)) {
    if (!['timeoutMs'].includes(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`);
  }
  return {
    timeoutMs: input.timeoutMs === undefined ? null : integer(input.timeoutMs, { field: 'timeoutMs', min: 1000, max: 60000, required: true })
  };
}

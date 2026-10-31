/**
 * Errores tipados del conector MCP.
 *
 * Todos heredan de HttpError para integrarse con el router de la app y con el
 * contrato `{error, code, field?, details?, requestId}`.
 */
import { HttpError } from '../http/errors.mjs';
import { redactString } from '../security/redact.mjs';

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {HttpError}
 */
export function mcpError(status, code, message, details = null) {
  return new HttpError(status, code, redactString(String(message || code)), { details });
}

export const MCP_CODES = Object.freeze({
  INVALID_CONFIG: 'MCP_INVALID_CONFIG',
  SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  SERVER_DISABLED: 'MCP_SERVER_DISABLED',
  TOOL_NOT_ALLOWED: 'MCP_TOOL_NOT_ALLOWED',
  TOOL_NOT_FOUND: 'MCP_TOOL_NOT_FOUND',
  SPAWN_FAILED: 'MCP_SPAWN_FAILED',
  PROCESS_EXITED: 'MCP_PROCESS_EXITED',
  TIMEOUT: 'MCP_TIMEOUT',
  PROTOCOL_ERROR: 'MCP_PROTOCOL_ERROR',
  RPC_ERROR: 'MCP_RPC_ERROR',
  HTTP_ERROR: 'MCP_HTTP_ERROR',
  RESPONSE_TOO_LARGE: 'MCP_RESPONSE_TOO_LARGE',
  SECRET_ERROR: 'MCP_SECRET_ERROR',
  GATE_UNAVAILABLE: 'MCP_GATE_UNAVAILABLE',
  GATE_FAILED: 'MCP_GATE_FAILED',
  PENDING_CALL_MISSING: 'MCP_PENDING_CALL_MISSING'
});

export function invalidConfig(message, details = null) {
  return mcpError(400, MCP_CODES.INVALID_CONFIG, message, details);
}

export function serverNotFound(id) {
  return mcpError(404, MCP_CODES.SERVER_NOT_FOUND, `Servidor MCP ${id} no encontrado.`, { id });
}

export function serverDisabled(id) {
  return mcpError(409, MCP_CODES.SERVER_DISABLED, `El servidor MCP ${id} está deshabilitado.`, { id });
}

export function toolNotAllowed(tool, allowlist) {
  return mcpError(403, MCP_CODES.TOOL_NOT_ALLOWED, `La herramienta "${tool}" no está permitida en este servidor.`, {
    tool,
    allowlist: Array.isArray(allowlist) ? allowlist : []
  });
}

export function toolNotFound(tool, serverId) {
  return mcpError(404, MCP_CODES.TOOL_NOT_FOUND, `La herramienta "${tool}" no existe en el servidor ${serverId}.`, { tool, serverId });
}

export function timeoutError(operation, timeoutMs) {
  return mcpError(504, MCP_CODES.TIMEOUT, `Timeout de ${timeoutMs} ms en la operación MCP "${operation}".`, { operation, timeoutMs });
}

export function spawnFailed(message, details = null) {
  return mcpError(502, MCP_CODES.SPAWN_FAILED, `No se pudo iniciar el proceso MCP: ${message}`, details);
}

export function processExited(message, details = null) {
  return mcpError(502, MCP_CODES.PROCESS_EXITED, `El proceso MCP terminó: ${message}`, details);
}

export function protocolError(message, details = null) {
  return mcpError(502, MCP_CODES.PROTOCOL_ERROR, `Protocolo MCP inválido: ${message}`, details);
}

export function rpcError(message, details = null) {
  return mcpError(502, MCP_CODES.RPC_ERROR, `Error JSON-RPC del servidor MCP: ${message}`, details);
}

export function httpError(message, details = null) {
  return mcpError(502, MCP_CODES.HTTP_ERROR, `Error HTTP del servidor MCP: ${message}`, details);
}

export function responseTooLarge(limit) {
  return mcpError(502, MCP_CODES.RESPONSE_TOO_LARGE, `La respuesta MCP supera el límite de ${limit} bytes.`, { limit });
}

export function gateUnavailable(detail = '') {
  return mcpError(503, MCP_CODES.GATE_UNAVAILABLE, `El gate de Oficina no está disponible; la llamada con efectos se deniega.${detail ? ` ${detail}` : ''}`);
}

export function gateFailed(message) {
  return mcpError(502, MCP_CODES.GATE_FAILED, `No se pudo crear la propuesta de aprobación MCP: ${message}`);
}

export function pendingCallMissing(token) {
  return mcpError(409, MCP_CODES.PENDING_CALL_MISSING, 'La llamada MCP pendiente no existe o caducó; vuelve a solicitarla.', { token });
}

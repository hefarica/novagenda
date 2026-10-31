/**
 * Logging con redacción obligatoria de secretos.
 * Niveles: debug < info < warn < error (LOG_LEVEL=info por defecto).
 */
import { redactString, redactObject, safeMessage, safeStack, installConsoleRedaction, MARKER } from '../security/redact.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export { installConsoleRedaction, MARKER };

function threshold() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {unknown} message
 * @param {unknown} [meta]
 */
export function log(level, message, meta) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold()) return;
  const text = redactString(typeof message === 'string' ? message : String(message));
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}`;
  const args = meta === undefined ? [line] : [line, redactObject(meta)];
  try {
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else if (level === 'debug') console.debug(...args);
    else console.info(...args);
  } catch {
    /* nunca fallar por logging */
  }
}

export const logger = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
};

/**
 * Registra un error con contexto. El stack también se redacta.
 * @param {string} context
 * @param {unknown} error
 * @param {object} [meta]
 */
export function logError(context, error, meta = {}) {
  const payload = {
    ...meta,
    code: error && typeof error === 'object' ? error.code ?? null : null,
    stack: safeStack(error)
  };
  log('error', `${context}: ${safeMessage(error)}`, payload);
}

/**
 * Log de acceso HTTP.
 * @param {{requestId:string, method:string, path:string, status:number, ms:number, ip?:string}} entry
 */
export function accessLog(entry) {
  const level = entry.path === '/api/health' || entry.method === 'GET' ? 'debug' : 'info';
  const line = `${entry.method} ${entry.path} → ${entry.status} (${entry.ms} ms) id=${entry.requestId}`;
  log(level, line, entry.ip ? { ip: entry.ip } : undefined);
}

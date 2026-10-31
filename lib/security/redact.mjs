/**
 * Redacción de secretos para logs, trazas de error y respuestas HTTP.
 *
 * Estrategia en capas:
 *   1. Valores exactos registrados por la bóveda (`registerSecretValue`).
 *   2. Patrones conocidos de credenciales (Bearer, JWT, sk-*, AIza*, bot tokens…).
 *   3. Claves sensibles en objetos (`apiKey`, `token`, `authorization`, `password`…).
 *
 * El objetivo es que una API key nunca aparezca en un log, en un stack ni en
 * una respuesta al frontend, incluso si un módulo la serializa por error.
 */

export const MARKER = '«secreto»';
const MIN_SECRET_LENGTH = 6;
const MAX_DEPTH = 12;
const MAX_ARRAY = 2000;

/** @type {Set<string>} valores exactos a ocultar */
const secretValues = new Set();

const SECRET_KEY_RE = /(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|auth[_-]?token|app[_-]?secret|client[_-]?secret|webhook[_-]?secret|verify[_-]?token|password|passwd|authorization|cookie|credential|private[_-]?key|secret|token)$/i;

const PATTERNS = [
  // Authorization header / valores "Bearer xxx" o "Basic xxx"
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=:\\-]{8,}/gi, `$1 ${MARKER}`],
  // JSON o query con claves sensibles: "api_key":"..." / token=...
  [/(["']?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|auth[_-]?token|app[_-]?secret|client[_-]?secret|webhook[_-]?secret|verify[_-]?token|password|passwd|authorization|secret)["']?\s*[:=]\s*)(["']?)([^\s"',;}\]]{4,})\2/gi, `$1$2${MARKER}$2`],
  // Query string en URLs
  [/([?&](?:key|token|secret|access_token|api_key|apikey|auth|password)=)[^&\s"'#]{4,}/gi, `$1${MARKER}`],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, MARKER],
  // Claves estilo OpenAI / Anthropic / Stripe
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, MARKER],
  // API keys de Google
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, MARKER],
  // Tokens de bot de Telegram
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, MARKER],
  // GitHub
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, MARKER],
  // AWS access key
  [/\bAKIA[0-9A-Z]{16}\b/g, MARKER],
  // Bloque PEM privado
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY-----${MARKER}-----END PRIVATE KEY-----`]
];

/**
 * Registra un valor exacto que debe ocultarse siempre (API keys, tokens, etc.).
 * @param {unknown} value
 */
export function registerSecretValue(value) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH) return;
  secretValues.add(v);
}

/** @param {unknown} value */
export function unregisterSecretValue(value) {
  if (typeof value !== 'string') return;
  secretValues.delete(value.trim());
}

export function clearSecretValues() {
  secretValues.clear();
}

export function secretValueCount() {
  return secretValues.size;
}

/**
 * Redacta un texto plano.
 * @param {unknown} input
 * @param {string} [marker]
 * @returns {string}
 */
export function redactString(input, marker = MARKER) {
  if (input === null || input === undefined) return '';
  let out = typeof input === 'string' ? input : String(input);
  if (!out) return out;

  for (const value of secretValues) {
    if (out.includes(value)) out = out.split(value).join(marker);
  }
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function redactedKeyName(key) {
  return SECRET_KEY_RE.test(String(key));
}

function walk(value, depth, seen) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return redactString(value);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return '[no-serializable]';
  if (type !== 'object') return String(value);

  if (depth > MAX_DEPTH) return '[demasiado profundo]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
  if (value instanceof Error) {
    return { name: value.name, code: value.code, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1, seen));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (redactedKeyName(key) && typeof item === 'string' && item) {
      out[key] = MARKER;
      continue;
    }
    out[key] = walk(item, depth + 1, seen);
  }
  return out;
}

/**
 * Clona un valor JSON-safe redactando strings y claves sensibles.
 * No modifica el original.
 * @param {unknown} value
 */
export function redactObject(value) {
  try {
    return walk(value, 0, new WeakSet());
  } catch {
    return '[no-serializable]';
  }
}

/** @param {unknown} err */
export function safeMessage(err) {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return redactString(err);
  const message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
  return redactString(message);
}

/** @param {unknown} err */
export function safeStack(err) {
  const stack = err && typeof err === 'object' && err.stack ? String(err.stack) : '';
  return stack ? redactString(stack) : '';
}

/**
 * Envuelve console.log/info/warn/error/debug para que todo lo que se escriba
 * en la consola pase por la redacción (incluidos los módulos heredados que
 * llaman console.error directamente).
 * @param {Console} [target]
 */
export function installConsoleRedaction(target = console) {
  if (!target || target.__agendaRedacted) return;
  const wrap = (original) => function redactedConsole(...args) {
    try {
      const safe = args.map((arg) => {
        if (typeof arg === 'string') return redactString(arg);
        if (arg instanceof Error) return { name: arg.name, code: arg.code, message: redactString(arg.message), stack: arg.stack ? redactString(arg.stack) : undefined };
        if (arg && typeof arg === 'object') return redactObject(arg);
        return arg;
      });
      return original.apply(target, safe);
    } catch {
      try { return original.call(target, '[log no serializable]'); } catch { /* nunca romper por logging */ }
    }
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof target[method] === 'function') target[method] = wrap(target[method]);
  }
  Object.defineProperty(target, '__agendaRedacted', { value: true, enumerable: false, configurable: false });
}

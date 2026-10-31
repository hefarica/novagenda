/**
 * Bóveda de secretos.
 *
 * Los valores se guardan cifrados con AES-256-GCM en `store.secrets[name]`
 * usando una subclave derivada de la clave maestra. La variable de entorno
 * asociada tiene prioridad (override) y, al arrancar, los valores guardados se
 * materializan en `process.env` para que los módulos heredados (canales,
 * Google) sigan funcionando sin cambios.
 *
 * Regla de oro: el valor en claro NUNCA se devuelve al frontend ni se escribe
 * en logs. La API solo expone `configured`, `source` y un `hint` con los
 * últimos 4 caracteres.
 */
import crypto from 'node:crypto';
import { store } from '../store.mjs';
import { deriveKey } from './keys.mjs';
import { registerSecretValue, redactString } from './redact.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';

/** Catálogo de claves configurables. */
export const SECRET_REGISTRY = Object.freeze([
  // --- LLM / agente -------------------------------------------------------
  { name: 'llm.provider', env: 'LLM_PROVIDER', label: 'Proveedor LLM', group: 'llm', secret: false, default: 'auto', maxLength: 32 },
  { name: 'llm.openai.apiKey', env: 'OPENAI_API_KEY', label: 'OpenAI API Key', group: 'llm', secret: true, maxLength: 512 },
  { name: 'llm.openai.baseUrl', env: 'OPENAI_BASE_URL', label: 'OpenAI Base URL', group: 'llm', secret: false, default: 'https://api.openai.com/v1', maxLength: 300 },
  { name: 'llm.openai.model', env: 'OPENAI_MODEL', label: 'Modelo OpenAI', group: 'llm', secret: false, default: 'gpt-4o-mini', maxLength: 120 },
  { name: 'llm.ollama.url', env: 'OLLAMA_URL', label: 'Ollama URL', group: 'llm', secret: false, default: 'http://127.0.0.1:11434', maxLength: 300 },
  { name: 'llm.ollama.model', env: 'OLLAMA_MODEL', label: 'Modelo Ollama', group: 'llm', secret: false, default: 'llama3.2:3b', maxLength: 120 },
  { name: 'llm.timeoutMs', env: 'LLM_TIMEOUT_MS', label: 'Timeout LLM (ms)', group: 'llm', secret: false, default: '20000', maxLength: 8 },

  // --- WhatsApp Cloud API -------------------------------------------------
  { name: 'channels.whatsapp.enabled', env: 'WA_ENABLED', label: 'WhatsApp activo', group: 'channels', secret: false, default: 'false', maxLength: 8 },
  { name: 'channels.whatsapp.accessToken', env: 'WA_ACCESS_TOKEN', label: 'WhatsApp Access Token', group: 'channels', secret: true, maxLength: 1024 },
  { name: 'channels.whatsapp.verifyToken', env: 'WA_VERIFY_TOKEN', label: 'WhatsApp Verify Token', group: 'channels', secret: true, maxLength: 512 },
  { name: 'channels.whatsapp.appSecret', env: 'WA_APP_SECRET', label: 'WhatsApp App Secret', group: 'channels', secret: true, maxLength: 512 },
  { name: 'channels.whatsapp.phoneNumberId', env: 'WA_PHONE_NUMBER_ID', label: 'WhatsApp Phone Number ID', group: 'channels', secret: false, maxLength: 64 },
  { name: 'channels.whatsapp.defaultTo', env: 'WA_DEFAULT_TO', label: 'WhatsApp destino por defecto', group: 'channels', secret: true, maxLength: 40 },
  { name: 'channels.whatsapp.templateName', env: 'WA_TEMPLATE_NAME', label: 'Plantilla WhatsApp', group: 'channels', secret: false, maxLength: 120 },
  { name: 'channels.whatsapp.templateLanguage', env: 'WA_TEMPLATE_LANGUAGE', label: 'Idioma plantilla WhatsApp', group: 'channels', secret: false, default: 'es_CO', maxLength: 12 },

  // --- Telegram -----------------------------------------------------------
  { name: 'channels.telegram.enabled', env: 'TELEGRAM_ENABLED', label: 'Telegram activo', group: 'channels', secret: false, default: 'false', maxLength: 8 },
  { name: 'channels.telegram.botToken', env: 'TELEGRAM_BOT_TOKEN', label: 'Telegram Bot Token', group: 'channels', secret: true, maxLength: 256 },
  { name: 'channels.telegram.webhookSecret', env: 'TELEGRAM_WEBHOOK_SECRET', label: 'Telegram Webhook Secret', group: 'channels', secret: true, maxLength: 256 },
  { name: 'channels.telegram.defaultChatId', env: 'TELEGRAM_DEFAULT_CHAT_ID', label: 'Telegram Chat ID por defecto', group: 'channels', secret: true, maxLength: 64 },

  // --- Correo -------------------------------------------------------------
  { name: 'channels.email.enabled', env: 'EMAIL_ENABLED', label: 'Correo activo', group: 'channels', secret: false, default: 'false', maxLength: 8 },
  { name: 'channels.email.to', env: 'NOTIFY_EMAIL_TO', label: 'Correo de notificaciones', group: 'channels', secret: true, maxLength: 254 },

  // --- Webhook genérico ---------------------------------------------------
  { name: 'webhooks.generic.secret', env: 'WEBHOOK_SECRET', label: 'Secreto webhook genérico', group: 'webhooks', secret: true, maxLength: 512 },

  // --- Google -------------------------------------------------------------
  { name: 'google.clientId', env: 'GOOGLE_CLIENT_ID', label: 'Google Client ID', group: 'google', secret: false, maxLength: 256 },
  { name: 'google.clientSecret', env: 'GOOGLE_CLIENT_SECRET', label: 'Google Client Secret', group: 'google', secret: true, maxLength: 512 },

  // --- App ----------------------------------------------------------------
  { name: 'app.publicUrl', env: 'APP_URL', label: 'URL pública de la app', group: 'app', secret: false, maxLength: 300 }
]);

const byName = new Map(SECRET_REGISTRY.map((entry) => [entry.name, entry]));
const materializedFromVault = new Set();
const explicitEnv = new Set();
const decryptFailures = new Map();

for (const entry of SECRET_REGISTRY) {
  if (typeof process.env[entry.env] === 'string' && process.env[entry.env].trim() !== '') explicitEnv.add(entry.name);
}

/** @param {string} name */
export function isKnownSecret(name) {
  return byName.has(String(name));
}

/** Metadatos del catálogo (sin valores). */
export function listSecretDefinitions() {
  return SECRET_REGISTRY.map(({ name, env, label, group, secret, default: defaultValue }) => ({ name, env, label, group, secret, default: defaultValue ?? null }));
}

function encryptValue(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('vault-v1'), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url')
  };
}

function decryptValue(box) {
  if (!box || typeof box !== 'object' || typeof box.iv !== 'string' || typeof box.tag !== 'string' || typeof box.data !== 'string') {
    throw new Error('Formato de secreto inválido');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('vault-v1'), Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64url')), decipher.final()]);
  return plain.toString('utf8');
}

function storedEntry(name) {
  const secrets = store.get().secrets;
  if (!secrets || typeof secrets !== 'object') return null;
  const box = secrets[name];
  return box && typeof box === 'object' ? box : null;
}

function envValue(entry) {
  const raw = process.env[entry.env];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function entryOrThrow(name) {
  const entry = byName.get(String(name || ''));
  if (!entry) throw new HttpError(404, 'UNKNOWN_SECRET', `Secreto desconocido: ${redactString(String(name || ''))}.`, { field: 'name' });
  return entry;
}

/**
 * Valor resuelto (entorno primero, luego bóveda, luego default).
 * @param {string} name
 * @returns {string|null}
 */
export function getSecret(name) {
  const entry = byName.get(String(name || ''));
  if (!entry) return null;
  const fromEnv = envValue(entry);
  if (fromEnv) return fromEnv;
  const box = storedEntry(entry.name);
  if (box) {
    try {
      const value = decryptValue(box);
      decryptFailures.delete(entry.name);
      return value;
    } catch (err) {
      decryptFailures.set(entry.name, redactString(err.message));
      return entry.default ?? null;
    }
  }
  return entry.default ?? null;
}

/** @param {string} name @returns {'env'|'store'|'default'|null} */
export function secretSource(name) {
  const entry = byName.get(String(name || ''));
  if (!entry) return null;
  if (envValue(entry) && !materializedFromVault.has(entry.name)) return 'env';
  if (envValue(entry)) return 'store';
  if (entry.default !== undefined) return 'default';
  return null;
}

function hintFor(entry, value) {
  if (typeof value !== 'string' || !value) return null;
  if (!entry.secret) return value;
  return value.length >= 4 ? `••••${value.slice(-4)}` : '••••';
}

/**
 * Guarda (cifra) un secreto y actualiza el entorno del proceso.
 * @param {string} name
 * @param {unknown} value
 */
export async function setSecret(name, value) {
  const entry = entryOrThrow(name);
  if (typeof value !== 'string') throw new ValidationError('value', 'INVALID_TYPE', 'El valor debe ser texto.');
  const clean = value.trim();
  if (!clean) throw new ValidationError('value', 'REQUIRED', 'El valor no puede estar vacío.');
  if (clean.length > (entry.maxLength || 8192)) {
    throw new ValidationError('value', 'TOO_LONG', `El valor supera el máximo de ${entry.maxLength || 8192} caracteres.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) {
    throw new ValidationError('value', 'INVALID_CHARS', 'El valor contiene caracteres de control.');
  }
  const box = encryptValue(clean);
  const updatedAt = new Date().toISOString();
  const hint = hintFor(entry, clean);
  await store.mutate((data) => {
    if (!data.secrets || typeof data.secrets !== 'object') data.secrets = {};
    data.secrets[entry.name] = { ...box, updatedAt, hint };
  }, { label: `secreto:${entry.name}` });

  if (!explicitEnv.has(entry.name)) {
    // Una variable de entorno definida por el usuario tiene prioridad y no se pisa.
    process.env[entry.env] = clean;
    materializedFromVault.add(entry.name);
  }
  if (entry.secret) registerSecretValue(clean);
  return secretStatus(entry.name);
}

/**
 * Elimina el valor guardado. Si el valor venía de la bóveda, también se limpia
 * del entorno del proceso (la variable real definida por el usuario no se toca).
 * @param {string} name
 */
export async function deleteSecret(name) {
  const entry = entryOrThrow(name);
  const existed = !!storedEntry(entry.name);
  await store.mutate((data) => {
    if (data.secrets && typeof data.secrets === 'object') delete data.secrets[entry.name];
  }, { label: `secreto-eliminado:${entry.name}` });
  if (materializedFromVault.has(entry.name)) {
    delete process.env[entry.env];
    materializedFromVault.delete(entry.name);
  }
  return { deleted: existed, ...secretStatus(entry.name) };
}

/**
 * Estado público de un secreto (sin valor para los marcados como secretos).
 * @param {string} name
 */
export function secretStatus(name) {
  const entry = entryOrThrow(name);
  const source = secretSource(entry.name);
  const value = source ? getSecret(entry.name) : null;
  const stored = storedEntry(entry.name);
  const configured = source !== null && (entry.secret ? !!value || !!stored : value !== null);
  const out = {
    name: entry.name,
    env: entry.env,
    label: entry.label,
    group: entry.group,
    secret: entry.secret,
    configured,
    source: source === 'default' ? 'default' : configured ? source : null,
    hint: configured ? hintFor(entry, value) : null,
    updatedAt: stored?.updatedAt || null
  };
  if (!entry.secret) out.value = configured ? value : null;
  if (decryptFailures.has(entry.name)) out.error = 'SECRET_DECRYPT_FAILED';
  return out;
}

/** Estado de todo el catálogo. Nunca incluye valores de entradas secretas. */
export function publicSecretStatus({ includeValues = false } = {}) {
  return SECRET_REGISTRY.map((entry) => {
    const status = secretStatus(entry.name);
    if (!includeValues || entry.secret) delete status.value;
    return status;
  });
}

/** Agrupado por `group`, útil para el centro de integraciones del frontend. */
export function groupedSecretStatus() {
  /** @type {Record<string, any[]>} */
  const groups = {};
  for (const status of publicSecretStatus()) {
    if (!groups[status.group]) groups[status.group] = [];
    groups[status.group].push(status);
  }
  return groups;
}

/**
 * Materializa en process.env los valores guardados en la bóveda que no tengan
 * override por entorno. Idempotente.
 * @returns {{applied:number, failures:{name:string,error:string}[]}}
 */
export function applyVaultToEnv() {
  let applied = 0;
  const failures = [];
  const secrets = store.get().secrets;
  for (const entry of SECRET_REGISTRY) {
    const fromEnv = typeof process.env[entry.env] === 'string' && process.env[entry.env].trim() !== '';
    if (fromEnv && !materializedFromVault.has(entry.name)) {
      if (entry.secret) registerSecretValue(process.env[entry.env]);
      continue;
    }
    const box = secrets && typeof secrets === 'object' ? secrets[entry.name] : null;
    if (!box) continue;
    try {
      const value = decryptValue(box);
      if (typeof value !== 'string' || !value) continue;
      process.env[entry.env] = value;
      materializedFromVault.add(entry.name);
      decryptFailures.delete(entry.name);
      if (entry.secret) registerSecretValue(value);
      applied += 1;
    } catch (err) {
      decryptFailures.set(entry.name, redactString(err.message));
      failures.push({ name: entry.name, error: 'SECRET_DECRYPT_FAILED' });
    }
  }
  return { applied, failures };
}

/** Reindexa todos los valores secretos resolubles para la redacción de logs. */
export function refreshRedactionIndex() {
  for (const entry of SECRET_REGISTRY) {
    if (!entry.secret) continue;
    const value = getSecret(entry.name);
    if (value) registerSecretValue(value);
  }
}

/** Diagnóstico sin valores, para /api/health. */
export function vaultDiagnostics() {
  let stored = 0;
  const secrets = store.get().secrets;
  if (secrets && typeof secrets === 'object') stored = Object.keys(secrets).length;
  return {
    catalog: SECRET_REGISTRY.length,
    stored,
    configured: SECRET_REGISTRY.filter((entry) => secretStatus(entry.name).configured).length,
    fromEnv: SECRET_REGISTRY.filter((entry) => secretSource(entry.name) === 'env').length,
    decryptFailures: [...decryptFailures.keys()]
  };
}

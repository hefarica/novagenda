/**
 * Gestión de la clave maestra de la aplicación (Agenda Copilot P95).
 *
 * Orden de resolución:
 *   1. `AGENDA_MASTER_KEY` (recomendada) o `APP_SECRET` (compatibilidad).
 *   2. Archivo persistente `DATA_DIR/.master-key` (32 bytes, permisos 0600).
 *
 * Nunca se registra en logs ni se devuelve por la API. El archivo se crea la
 * primera vez que arranca la app sin variable de entorno.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const KEY_FILE = path.join(DATA_DIR, '.master-key');

let cachedKey = null;
let cachedSource = null;

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* Si el directorio no se puede crear, masterKey() fallará más adelante de forma explícita. */
  }
}

function readKeyFile() {
  try {
    if (!fs.existsSync(KEY_FILE)) return null;
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const buf = Buffer.from(raw, 'base64url');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Resuelve la clave maestra. Es determinista durante la vida del proceso.
 * @returns {Buffer} 32 bytes
 */
export function masterKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = String(process.env.AGENDA_MASTER_KEY || process.env.APP_SECRET || '').trim();
  if (fromEnv.length >= 8) {
    cachedKey = crypto.createHash('sha256').update(`agenda-p95|master|v1|${fromEnv}`).digest();
    cachedSource = 'env';
    return cachedKey;
  }

  ensureDir();
  const fromFile = readKeyFile();
  if (fromFile) {
    cachedKey = fromFile;
    cachedSource = 'file';
    return cachedKey;
  }

  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, generated.toString('base64url'), { mode: 0o600 });
    try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows ignora chmod */ }
    cachedKey = generated;
    cachedSource = 'file';
    return cachedKey;
  } catch (err) {
    throw new Error(`No se pudo crear la clave maestra en ${KEY_FILE}: ${err.message}`);
  }
}

/**
 * Deriva una subclave específica de dominio (HKDF-like con HMAC) para no
 * reutilizar la misma clave en sesiones, bóveda y cifrado JSON.
 * @param {string} label
 * @returns {Buffer} 32 bytes
 */
export function deriveKey(label) {
  return crypto.createHmac('sha256', masterKey()).update(`agenda-p95|${label}`).digest();
}

/** @returns {{source: 'env'|'file'|null, keyFile: string, dataDir: string}} */
export function keyInfo() {
  return { source: cachedSource, keyFile: KEY_FILE, dataDir: DATA_DIR };
}

/** Solo para pruebas: olvida la clave cacheada (no borra el archivo). */
export function resetKeyCacheForTests() {
  cachedKey = null;
  cachedSource = null;
}

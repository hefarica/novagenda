/**
 * Hash y verificación de contraseñas con scrypt (Node nativo).
 * Formato persistido:
 *   { algorithm:'scrypt', params:{N,r,p}, salt:'base64', hash:'base64', createdAt:'ISO' }
 */
import crypto from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

/**
 * @param {unknown} password
 * @returns {string|null} mensaje de error o null si es válida
 */
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'La contraseña debe ser texto.';
  if (password.length < PASSWORD_MIN_LENGTH) return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`;
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'La contraseña contiene caracteres de control.';
  if (password.trim().length === 0) return 'La contraseña no puede ser solo espacios.';
  return null;
}

/**
 * @param {string} password
 * @returns {{algorithm:'scrypt', params:{N:number,r:number,p:number}, salt:string, hash:string, createdAt:string}}
 */
export function hashPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('Contraseña vacía');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, PARAMS);
  return {
    algorithm: 'scrypt',
    params: { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p },
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: new Date().toISOString()
  };
}

/**
 * Comparación en tiempo constante.
 * @param {string} password
 * @param {{salt?:string, hash?:string, params?:{N?:number,r?:number,p?:number}}} record
 * @returns {boolean}
 */
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || !record || typeof record !== 'object') return false;
  if (typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(record.salt, 'base64');
    expected = Buffer.from(record.hash, 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const params = {
    N: Number(record.params?.N) || PARAMS.N,
    r: Number(record.params?.r) || PARAMS.r,
    p: Number(record.params?.p) || PARAMS.p,
    maxmem: PARAMS.maxmem
  };
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, params);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Hash señuelo para igualar tiempos cuando el usuario no existe.
 * @param {string} password
 */
export function dummyVerify(password) {
  try {
    const salt = Buffer.from('agenda-copilot-dummy-salt', 'utf8');
    crypto.scryptSync(String(password || ''), salt, KEY_LENGTH, PARAMS);
  } catch { /* irrelevante */ }
  return false;
}

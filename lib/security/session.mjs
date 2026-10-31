/**
 * Autenticación y sesiones.
 *
 * Modos:
 *   - `local`    : HOST es loopback y APP_AUTH no está activo → acceso directo sin fricción.
 *   - `session`  : HOST≠loopback o APP_AUTH=on → toda /api/* exige cookie de sesión válida.
 *
 * La cookie es un token firmado con HMAC-SHA256 (clave derivada de la clave
 * maestra): `ac_sid=<payload>.<firma>`, HttpOnly, SameSite=Strict y Secure
 * cuando la petición llega por HTTPS. Los tokens caducan a los 30 días y se
 * revocan con logout o al cambiar la contraseña (epoch).
 */
import crypto from 'node:crypto';
import { store } from '../store.mjs';
import { deriveKey } from './keys.mjs';
import { hashPassword, verifyPassword, passwordProblem, dummyVerify } from './passwords.mjs';
import { safeEqual } from './compare.mjs';
import { HttpError, Errors } from '../http/errors.mjs';

export const AUTH_COOKIE_NAME = 'ac_sid';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_REVOKED = 5000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_BLOCK_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

const revokedSids = new Set();
const revokedOrder = [];
const loginAttempts = new Map();

function authRecord() {
  const auth = store.get().auth;
  return auth && typeof auth === 'object' ? auth : { configured: false, epoch: 0 };
}

/**
 * Configuración de red/auth derivada del entorno.
 * `HOST` es la variable estándar; `APP_HOST` la puede sobrescribir.
 */
export function hostConfig() {
  const raw = String(process.env.APP_HOST || process.env.HOST || '127.0.0.1').trim();
  const host = raw.replace(/^\[|\]$/g, '');
  const loopback = LOOPBACK_HOSTS.has(host.toLowerCase());
  const forced = /^(1|true|on|yes|s[ií])$/i.test(String(process.env.APP_AUTH || '').trim());
  const required = forced || !loopback;
  return { host, loopback, forced, required, mode: required ? 'session' : 'local' };
}

/** @param {import('node:http').IncomingMessage} req */
export function peerIsLoopback(req) {
  const address = String(req?.socket?.remoteAddress || '');
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.') || LOOPBACK_HOSTS.has(address.toLowerCase());
}

/** @param {import('node:http').IncomingMessage} req */
export function isHttps(req) {
  if (req?.socket?.encrypted) return true;
  return /^https/i.test(String(req?.headers?.['x-forwarded-proto'] || ''));
}

/** @param {import('node:http').IncomingMessage} req */
export function parseCookies(req) {
  const header = req?.headers?.cookie;
  if (!header || typeof header !== 'string') return {};
  /** @type {Record<string,string>} */
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function signTokenBody(body) {
  return crypto.createHmac('sha256', deriveKey('session-v1')).update(body).digest('base64url');
}

/**
 * @param {string} subject
 * @returns {{token:string, payload:{v:1,sid:string,sub:string,iat:number,exp:number,ep:number}}}
 */
export function createSessionToken(subject) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sid: crypto.randomUUID(),
    sub: String(subject || 'owner'),
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SECONDS,
    ep: Number(authRecord().epoch) || 0
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${body}.${signTokenBody(body)}`, payload };
}

/**
 * @param {string} token
 * @returns {{v:1,sid:string,sub:string,iat:number,exp:number,ep:number}|null}
 */
export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  if (!safeEqual(signature, signTokenBody(body))) return null;
  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.sid !== 'string' || !payload.sid) return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (!Number.isFinite(payload.iat) || payload.iat > Math.floor(Date.now() / 1000) + 300) return null;
  if (revokedSids.has(payload.sid)) return null;
  return payload;
}

/** @param {import('node:http').IncomingMessage} req */
export function sessionFromRequest(req) {
  const raw = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!raw) return { valid: false, reason: 'missing', payload: null };
  const payload = verifySessionToken(raw);
  if (!payload) return { valid: false, reason: 'invalid', payload: null };
  const auth = authRecord();
  if (!auth.configured) return { valid: false, reason: 'not-configured', payload: null };
  if (Number(payload.ep) !== (Number(auth.epoch) || 0)) return { valid: false, reason: 'epoch', payload: null };
  return { valid: true, reason: null, payload };
}

/**
 * Estado de autenticación de una petición, tal como lo ve el router.
 * @param {import('node:http').IncomingMessage} req
 */
export function requestAuth(req) {
  const config = hostConfig();
  const session = sessionFromRequest(req);
  const auth = authRecord();
  const configured = auth.configured === true;
  const authenticated = config.required ? session.valid : true;
  return {
    required: config.required,
    mode: config.mode,
    host: config.host,
    configured,
    authenticated,
    user: session.valid ? session.payload.sub : config.required ? null : 'local',
    session: session.valid ? session.payload : null,
    sessionReason: session.reason,
    ttlSeconds: SESSION_TTL_SECONDS
  };
}

/** @param {import('node:http').IncomingMessage} req @param {string} token */
export function buildSessionCookie(req, token) {
  const parts = [`${AUTH_COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_SECONDS}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/** @param {import('node:http').IncomingMessage} req */
export function buildClearSessionCookie(req) {
  const parts = [`${AUTH_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Emite una sesión y fija la cookie en la respuesta.
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} req
 * @param {string} subject
 */
export function issueSession(res, req, subject) {
  const { token, payload } = createSessionToken(subject);
  res.setHeader('Set-Cookie', buildSessionCookie(req, token));
  return { token, payload, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/**
 * Revoca la sesión actual (si existe) y limpia la cookie.
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} req
 */
export function destroySession(res, req) {
  const session = sessionFromRequest(req);
  if (session.valid && session.payload) {
    revokedSids.add(session.payload.sid);
    revokedOrder.push(session.payload.sid);
    while (revokedOrder.length > MAX_REVOKED) {
      const oldest = revokedOrder.shift();
      if (oldest) revokedSids.delete(oldest);
    }
  }
  res.setHeader('Set-Cookie', buildClearSessionCookie(req));
  return { revoked: session.valid };
}

export function validateUsername(username) {
  const value = typeof username === 'string' ? username.trim() : '';
  if (!value) return { ok: true, username: 'owner' };
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(value)) {
    return { ok: false, error: 'El usuario debe tener 3-64 caracteres: letras, números, . _ @ -' };
  }
  return { ok: true, username: value };
}

/**
 * Crea la cuenta inicial (solo si no hay ninguna configurada).
 * @param {{username?:string, password:string}} input
 */
export async function setupAccount({ username, password } = {}) {
  const auth = authRecord();
  if (auth.configured) throw Errors.conflict('AUTH_ALREADY_CONFIGURED', 'La autenticación ya está configurada.');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, 'WEAK_PASSWORD', problem, { field: 'password' });
  const name = validateUsername(username);
  if (!name.ok) throw new HttpError(400, 'INVALID_USERNAME', name.error, { field: 'username' });
  const passwordRecord = hashPassword(password);
  const now = new Date().toISOString();
  await store.mutate((data) => {
    data.auth = {
      configured: true,
      username: name.username,
      password: passwordRecord,
      epoch: Number(data.auth?.epoch) || 0,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null
    };
  }, { label: 'auth-setup' });
  return { username: name.username };
}

/**
 * @param {{username?:string, password:string, ip?:string}} input
 */
export async function loginAccount({ username, password, ip = 'unknown' } = {}) {
  const gate = loginGate(ip);
  if (!gate.allowed) throw Errors.tooManyRequests(gate.retryAfterSec);
  const auth = authRecord();
  if (!auth.configured) throw Errors.conflict('AUTH_NOT_CONFIGURED', 'Configura primero el usuario y la contraseña con POST /api/auth/setup.');

  const attempted = typeof username === 'string' && username.trim() ? username.trim() : auth.username;
  const userMatches = typeof attempted === 'string' && attempted.toLowerCase() === String(auth.username || '').toLowerCase();
  const passwordOk = userMatches ? verifyPassword(password, auth.password) : dummyVerify(password);
  if (!userMatches || !passwordOk) {
    noteLoginFailure(ip);
    throw Errors.unauthorized('Usuario o contraseña incorrectos.');
  }
  noteLoginSuccess(ip);
  await store.mutate((data) => {
    if (data.auth) data.auth.lastLoginAt = new Date().toISOString();
  }, { label: 'auth-login' });
  return { username: auth.username };
}

/**
 * Cambia la contraseña y revoca todas las sesiones previas.
 * @param {{currentPassword:string, newPassword:string}} input
 */
export async function changePassword({ currentPassword, newPassword } = {}) {
  const auth = authRecord();
  if (!auth.configured) throw Errors.conflict('AUTH_NOT_CONFIGURED', 'La autenticación no está configurada.');
  if (!verifyPassword(currentPassword, auth.password)) throw Errors.unauthorized('Contraseña actual incorrecta.');
  const problem = passwordProblem(newPassword);
  if (problem) throw new HttpError(400, 'WEAK_PASSWORD', problem, { field: 'newPassword' });
  if (verifyPassword(newPassword, auth.password)) throw new HttpError(400, 'SAME_PASSWORD', 'La nueva contraseña debe ser distinta.', { field: 'newPassword' });
  const passwordRecord = hashPassword(newPassword);
  await store.mutate((data) => {
    if (!data.auth) return;
    data.auth.password = passwordRecord;
    data.auth.updatedAt = new Date().toISOString();
    data.auth.epoch = (Number(data.auth.epoch) || 0) + 1;
  }, { label: 'auth-password' });
  return { username: auth.username };
}

/** El setup está permitido si no hay cuenta y la petición es local o trae el token de setup. */
export function setupPolicy(req, providedToken = '') {
  const auth = authRecord();
  if (auth.configured) return { allowed: false, reason: 'already-configured', requiresToken: false };
  const expected = String(process.env.APP_SETUP_TOKEN || '').trim();
  const loopback = peerIsLoopback(req);
  if (loopback) return { allowed: true, reason: 'loopback', requiresToken: false };
  if (!expected) return { allowed: false, reason: 'remote-without-setup-token', requiresToken: true };
  if (typeof providedToken === 'string' && providedToken && safeEqual(providedToken, expected)) return { allowed: true, reason: 'setup-token', requiresToken: true };
  return { allowed: false, reason: 'invalid-setup-token', requiresToken: true };
}

/** @param {import('node:http').IncomingMessage} req */
export function authSnapshot(req) {
  const auth = requestAuth(req);
  const config = hostConfig();
  const authData = authRecord();
  const setup = setupPolicy(req, '');
  return {
    authRequired: config.required,
    mode: config.mode,
    host: config.host,
    configured: auth.configured,
    authenticated: auth.authenticated,
    user: auth.user,
    sessionExpiresAt: auth.session ? new Date(auth.session.exp * 1000).toISOString() : null,
    setupRequired: config.required && !auth.configured,
    setupAvailable: !auth.configured,
    setupRequiresToken: !config.loopback,
    setupPolicyReason: setup.reason,
    username: authData.configured ? authData.username || null : null,
    lastLoginAt: authData.lastLoginAt || null,
    cookieSecure: isHttps(req),
    ttlSeconds: SESSION_TTL_SECONDS
  };
}

/* ------------------------------------------------------------------ */
/* Limitación de intentos de login (en memoria, por IP)                */
/* ------------------------------------------------------------------ */

function pruneAttempts(now) {
  if (loginAttempts.size < 2000) return;
  for (const [ip, entry] of loginAttempts) {
    if (!entry || (entry.blockedUntil || 0) < now && now - (entry.firstAt || 0) > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}

/**
 * @param {string} ip
 * @returns {{allowed:boolean, retryAfterSec:number}}
 */
export function loginGate(ip) {
  const now = Date.now();
  pruneAttempts(now);
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true, retryAfterSec: 0 };
  if (entry.blockedUntil && entry.blockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed: true, retryAfterSec: 0 };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function noteLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { firstAt: now, count: 1, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
    entry.count = 0;
    entry.firstAt = now;
  }
}

export function noteLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

/** Solo pruebas: limpia revocaciones y límites. */
export function resetAuthStateForTests() {
  revokedSids.clear();
  revokedOrder.length = 0;
  loginAttempts.clear();
}

/**
 * Utilidades de test de Agenda Copilot P95.
 *
 * REGLA DE ORO: `createTempDataDir()` debe llamarse ANTES de importar
 * `lib/store.mjs` (o cualquier módulo que lo importe). Nunca se prueba contra
 * `data/` real.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = process.env.AGENDA_REPO_ROOT
  ? path.resolve(process.env.AGENDA_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const UNSET_ENV = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_ENABLED',
  'WA_ACCESS_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET', 'WA_ENABLED',
  'EMAIL_ENABLED', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET',
  'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'OLLAMA_HOST', 'OPENAI_API_KEY',
  'NOTIFY_EMAIL_TO', 'APP_AUTH', 'APP_SETUP_TOKEN'
];

/**
 * Crea un DATA_DIR temporal y fija el entorno determinista del test.
 * @param {string} [prefix]
 * @returns {string} ruta del DATA_DIR temporal
 */
export function createTempDataDir(prefix = 'agenda-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dir;
  process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
  process.env.APP_SECRET = process.env.APP_SECRET || 'test-only-secret-no-real';
  process.env.NODE_ENV = 'test';
  // El scheduler de workflows no debe disparar notificaciones durante los tests.
  process.env.WORKFLOWS_AUTOSTART = '0';
  process.env.CHANNELS_AUTOSTART = 'off';
  for (const name of UNSET_ENV) delete process.env[name];
  delete process.env.WA_GRAPH_BASE;
  delete process.env.TELEGRAM_API_BASE;
  delete process.env.GMAIL_API_BASE;
  delete process.env.GOOGLE_TOKEN_URL;
  return dir;
}

/** URL de importación de un módulo del repo. */
export function libUrl(relativePath) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

/** Importa un módulo del repo (después de createTempDataDir). */
export function importLib(relativePath) {
  return import(libUrl(relativePath));
}

/**
 * Arranca la app real en un puerto efímero de loopback.
 * Devuelve `{ base, server, app, close }`.
 */
export async function startTestApp(options = {}) {
  const { createApp } = await importLib('lib/http/app.mjs');
  const app = await createApp(options);
  const server = http.createServer(app.handler);
  // Mismos timeouts que server.mjs (el keep-alive real del lanzamiento).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    app,
    server,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** fetch JSON con helpers de test. */
export async function api(base, method, apiPath, body, headers = {}) {
  const response = await fetch(`${base}${apiPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
  return { status: response.status, headers: response.headers, text, json };
}

/** Espera hasta que `predicate()` sea verdadero o venza el timeout. */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error(`waitFor: no se cumplió en ${timeoutMs} ms`);
}

/** Copia profunda JSON (fixtures mutables sin tocar el store). */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Assert de igualdad JSON legible. */
export function deepEqual(actual, expected, label = 'valor') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: ${a} !== ${b}`);
}

/** Servidor HTTP mínimo para mockear proveedores (Telegram/WhatsApp/LLM). */
export async function startMockServer(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const reply = async (status, payload) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      await handler(req, body, reply);
    } catch (error) {
      await reply(500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

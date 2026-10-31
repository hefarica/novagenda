/**
 * Utilidades del set dorado (t48).
 *
 * Cada categoría corre en su propio proceso con DATA_DIR temporal. El runner
 * `scripts/golden.mjs` lanza los 6 ficheros y agrega los resultados.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function prepare(prefix = 'agenda-golden-') {
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }
  process.env.TIMEZONE = process.env.TIMEZONE || 'America/Bogota';
  process.env.APP_SECRET = process.env.APP_SECRET || 'golden-only-secret';
  process.env.NODE_ENV = 'test';
  process.env.WORKFLOWS_AUTOSTART = '0';
  process.env.CHANNELS_AUTOSTART = 'off';
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'WA_ACCESS_TOKEN', 'WA_APP_SECRET', 'TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'LLM_PROVIDER']) {
    delete process.env[name];
  }
    return process.env.DATA_DIR;
}

export async function runCategory(category, cases) {
  const results = [];
  for (const c of cases) {
    try {
      await c.run();
      results.push({ id: c.id, name: c.name, ok: true });
    } catch (error) {
      results.push({ id: c.id, name: c.name, ok: false, error: String(error?.message || error).slice(0, 300) });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const summary = { category, total: results.length, passed, failed: results.length - passed, cases: results };
  console.log(JSON.stringify(summary));
  process.exitCode = summary.failed ? 1 : 0;
  return summary;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert');
}

export function equal(actual, expected, label = 'valor') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

export async function expectHttpError(fn, { status, code } = {}) {
  try {
    await fn();
    throw new Error(`se esperaba error ${code || status || ''} y no lanzó`);
  } catch (error) {
    if (error && error.__expected) throw error;
    if (!(error && (error.status || error.code))) throw error;
    if (status !== undefined && Number(error.status) !== Number(status)) {
      throw new Error(`status ${error.status} != ${status} (${error.message})`);
    }
    if (code !== undefined && String(error.code) !== String(code)) {
      throw new Error(`code ${error.code} != ${code} (${error.message})`);
    }
    return error;
  }
}

/**
 * Regresión E2E de las funciones recientes, en un solo comando.
 * Cada prueba levanta su propia app temporal y Chrome headless; no toca
 * los datos de producción. Si una falla, sigue con las demás y resume.
 *
 * Uso: npm run e2e:regression
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TESTS = [
  'verify-agenda-print.mjs',
  'verify-base-print.mjs',
  'verify-task-print.mjs',
  'verify-routine-print.mjs',
  'verify-attendance-print.mjs',
  'verify-okr-print.mjs',
  'verify-global-search.mjs',
  'verify-meeting-recording.mjs',
  'verify-agenda-duplicate.mjs',
  'verify-routine-duplicate.mjs',
  'verify-task-duplicate.mjs',
  'verify-setup.mjs',
  'verify-backup.mjs'
];

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 240000);

function runOne(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join('scripts', script)], {
      cwd: process.cwd(),
      env: { ...process.env, CHROME_PATH: CHROME },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const append = (chunk) => { output += chunk.toString(); if (output.length > 16000) output = output.slice(-16000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (code, reason = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ script, code, reason, output });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ya terminó */ }
      finish(124, `timeout ${TIMEOUT_MS} ms`);
    }, TIMEOUT_MS);
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code ?? 1));
  });
}

function tail(text, lines = 3) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(' | ');
}

const started = Date.now();
console.log(`Regresión E2E: ${TESTS.length} pruebas · Chrome ${CHROME}`);
if (!existsSync(CHROME)) {
  console.error('No encuentro Chrome. Define CHROME_PATH con la ruta real.');
  process.exit(2);
}

const results = [];
for (const script of TESTS) {
  process.stdout.write(`\n▶ ${script}\n`);
  const result = await runOne(script);
  const ok = result.code === 0;
  results.push(result);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${script} — ${tail(result.output) || result.reason || `exit ${result.code}`}`);
}

const failed = results.filter((result) => result.code !== 0);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n=== E2E: ${results.length - failed.length}/${results.length} PASS · ${seconds}s ===`);
if (failed.length) {
  for (const result of failed) {
    console.log(`\n--- ${result.script} (exit ${result.code}) ---\n${result.output}`);
  }
  process.exitCode = 1;
}

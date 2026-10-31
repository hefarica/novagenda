/**
 * Ejecuta todos los selfchecks de los subsistemas y resume el resultado.
 * No toca datos de producción: cada módulo usa su propio DATA_DIR temporal.
 *
 * Uso: npm run selfchecks
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function discover(dir = 'lib') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...discover(full));
    else if (entry.name === 'selfcheck.mjs') found.push(full);
  }
  return found.sort();
}

const checks = discover();
const TIMEOUT_MS = Number(process.env.SELFCHECK_TIMEOUT_MS || 180000);

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const append = (chunk) => { output += chunk.toString(); if (output.length > 16000) output = output.slice(-16000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ file, code: code ?? 1, output });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ya terminó */ }
      finish(124);
    }, TIMEOUT_MS);
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code));
  });
}

function tail(text, lines = 2) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(' | ');
}

console.log(`Selfchecks: ${checks.length} subsistemas`);
const started = Date.now();
const results = [];
for (const file of checks) {
  const result = await runOne(file);
  results.push(result);
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${file}${result.code === 0 ? '' : ` (exit ${result.code})`} — ${tail(result.output)}`);
}

const failed = results.filter((result) => result.code !== 0);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n=== SELFCHECKS: ${results.length - failed.length}/${results.length} PASS · ${seconds}s ===`);
if (failed.length) {
  for (const result of failed) console.log(`\n--- ${result.file} (exit ${result.code}) ---\n${result.output}`);
  process.exitCode = 1;
}

/**
 * Runner del set dorado (t48).
 *
 * Ejecuta las 6 categorías (10 casos cada una) en procesos aislados con su
 * propio DATA_DIR temporal y resume PASS/FAIL por categoría.
 *
 * Uso:
 *   node scripts/golden.mjs           # resumen y exit code
 *   node scripts/golden.mjs --verbose # además imprime el detalle de fallos
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden');
const CATEGORIES = ['approvals', 'docs', 'agenda', 'style', 'lingo', 'acl'];
const EXPECTED = { categories: 6, cases: 60 };
const verbose = process.argv.includes('--verbose');

function parseSummary(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.category) return parsed;
    } catch {
      // línea de log, seguir buscando
    }
  }
  return null;
}

const envBase = { ...process.env };
delete envBase.DATA_DIR;
delete envBase.PORT;
delete envBase.WORKFLOWS_AUTOSTART;
delete envBase.CHANNELS_AUTOSTART;
envBase.NODE_ENV = 'test';
envBase.TIMEZONE = envBase.TIMEZONE || 'America/Bogota';

const results = [];
const started = Date.now();
for (const category of CATEGORIES) {
  const file = path.join(GOLDEN_DIR, `${category}.mjs`);
  if (!fs.existsSync(file)) {
    results.push({ category, total: 0, passed: 0, failed: 1, cases: [{ id: '-', name: 'fichero ausente', ok: false, error: file }] });
    continue;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `agenda-golden-${category}-`));
  const run = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    env: { ...envBase, DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 120_000
  });
  const summary = parseSummary(run.stdout) || {
    category,
    total: 0,
    passed: 0,
    failed: 1,
    cases: [{ id: '-', name: 'sin resumen JSON', ok: false, error: (run.stderr || run.stdout || '').slice(-500) }]
  };
  results.push(summary);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const totalCases = results.reduce((sum, item) => sum + item.total, 0);
const totalPassed = results.reduce((sum, item) => sum + item.passed, 0);
const totalFailed = results.reduce((sum, item) => sum + item.failed, 0);

console.log('=== SET DORADO (t48) ===');
for (const item of results) {
  const mark = item.failed === 0 && item.total === 10 ? 'PASS' : 'FAIL';
  console.log(`${mark} ${String(item.category).padEnd(10)} ${item.passed}/${item.total}`);
  if (item.failed && item.failed > 0) {
    for (const testCase of item.cases || []) {
      if (!testCase.ok) console.log(`     ✖ ${testCase.id} ${testCase.name}${testCase.error ? ` — ${testCase.error}` : ''}`);
    }
  }
}
console.log(`Total: ${totalPassed}/${totalCases} casos en ${((Date.now() - started) / 1000).toFixed(1)} s`);

const structural = results.length === EXPECTED.categories && totalCases === EXPECTED.cases;
if (!structural) {
  console.log(`FAIL estructura del set: categorías=${results.length}/${EXPECTED.categories} casos=${totalCases}/${EXPECTED.cases}`);
}
const ok = structural && totalFailed === 0;
if (verbose && !ok) {
  for (const item of results) {
    for (const testCase of item.cases || []) {
      if (!testCase.ok) console.log(`detalle ${item.category}/${testCase.id}: ${testCase.error}`);
    }
  }
}
console.log(ok ? 'GOLDEN PASS' : 'GOLDEN FAIL');
process.exitCode = ok ? 0 : 1;

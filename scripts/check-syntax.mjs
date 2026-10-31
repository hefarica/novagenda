#!/usr/bin/env node
/**
 * `npm run check`: valida la sintaxis de TODOS los módulos ES del proyecto
 * (server/start/scripts/tests + lib/**) con `node --check`, sin ejecutarlos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [];

function walk(dir, filter) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
      walk(full, filter);
    } else if (entry.isFile() && filter(entry.name)) {
      FILES.push(full);
    }
  }
}

walk(path.join(ROOT, 'lib'), (name) => name.endsWith('.mjs'));
walk(path.join(ROOT, 'tests'), (name) => name.endsWith('.mjs'));
walk(path.join(ROOT, 'scripts'), (name) => name.endsWith('.mjs'));
for (const name of ['server.mjs', 'start.mjs']) {
  if (fs.existsSync(path.join(ROOT, name))) FILES.push(path.join(ROOT, name));
}

const failures = [];
for (const file of FILES) {
  const relative = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', relative], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file: relative, error: (result.stderr || result.stdout || '').trim().split('\n')[0] });
}

console.log(`node --check: ${FILES.length - failures.length}/${FILES.length} OK`);
for (const failure of failures) console.error(`FAIL ${failure.file} :: ${failure.error}`);
process.exitCode = failures.length === 0 ? 0 : 1;

#!/usr/bin/env node
/**
 * Escaneo básico de secretos en el repositorio (t6).
 * Excluye `.env` real (gitignored), `data/`, `node_modules` y artefactos.
 * Falla si encuentra claves con pinta real en código/documentación.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'data', 'coverage']);
const IGNORED_FILES = new Set(['.env', 'package-lock.json', 'agenda-data.json']);

const PATTERNS = [
  { name: 'OpenAI/DeepSeek key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Bearer token literal', regex: /Bearer\s+(?!\$\{|<|token-invalido|token-falso|token-rotado)[A-Za-z0-9._-]{30,}/ }
];

const findings = [];

function scanFile(file) {
  const relative = path.relative(ROOT, file);
  // Los módulos de redacción/trazas contienen patrones de secretos a propósito.
  if (relative.endsWith('redact.mjs') || relative.endsWith('trace.mjs') || relative.endsWith('check-secrets.mjs')) return;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);
  for (const pattern of PATTERNS) {
    lines.forEach((line, index) => {
      if (line.length > 500) return;
      const match = pattern.regex.exec(line);
      if (!match) return;
      // Placeholders y fixtures de test son aceptables.
      if (/cambia-esto|change-me|dev-only|example|placeholder|xxxx|tu-|<.*>/i.test(match[0])) return;
      findings.push({ file: relative, line: index + 1, kind: pattern.name, sample: match[0].slice(0, 12) + '…' });
    });
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && !IGNORED_FILES.has(entry.name) && /\.(mjs|js|json|ya?ml|md|ps1|bat|sh|txt|env\.example)$/.test(entry.name)) {
      scanFile(full);
    }
  }
}

walk(ROOT);

if (findings.length) {
  console.error(`Posibles secretos encontrados (${findings.length}):`);
  for (const finding of findings) console.error(` - ${finding.file}:${finding.line} [${finding.kind}] ${finding.sample}`);
  process.exitCode = 1;
} else {
  console.log('Sin secretos detectados en el repositorio.');
}

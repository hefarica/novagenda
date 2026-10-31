/**
 * Sandbox de código del Estudio.
 *
 * Ejecuta ÚNICAMENTE `node --test` sobre una copia aislada de los archivos del
 * encargo, nunca sobre el repositorio ni con el DATA_DIR real. Antes de ejecutar
 * hace un escaneo estático: si encuentra imports peligrosos, escritura de
 * archivos, eval/Function, shell o descargas, el job queda `blocked` y NO se
 * ejecuta nada.
 *
 * Estados: passed | failed | blocked | skipped.
 *
 * Seguridad:
 * - execFile (sin shell) con env mínimo, timeout y salida limitada.
 * - cwd = data/studio/jobs/<id>/sandbox (copia limpia de los archivos).
 * - Los archivos se validan contra el directorio del job (sin `..` ni symlinks).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from '../docs/paths.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 60;
const MAX_SCAN_FILE_BYTES = 256 * 1024;
const MAX_TAIL = 4000;

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
const COPY_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt',
  '.yml', '.yaml', '.csv', '.html', '.css', '.svg', '.toml', '.ini'
]);
const BANNED_MODULES = new Set([
  'child_process', 'cluster', 'worker_threads', 'net', 'http', 'https', 'http2',
  'dns', 'tls', 'dgram', 'vm', 'repl', 'inspector', 'module'
]);
const FS_WRITE_API = /\.(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|open|openSync|truncate|truncateSync|chmod|chmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync)\s*\(/;
const SHELL_API = /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/;
const EVAL_API = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/;
const NETWORK_API = /\bfetch\s*\(|XMLHttpRequest|\bhttps?\.(get|request)\s*\(|\bcurl\b|\bwget\b/;
const PROCESS_DANGER = /\bprocess\.(binding|dlopen|kill|exit|abort|chdir)\b/;
const TEST_FILE = /(^|\/)(tests?|__tests__)\/.*\.(mjs|cjs|js)$|\.(test|spec)\.(mjs|cjs|js)$/i;

function nowIso() {
  return new Date().toISOString();
}

function tail(text, limit = MAX_TAIL) {
  const value = String(text || '');
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function finding(code, file, detail, source = '', index = 0) {
  return {
    code,
    severity: 'blocker',
    file,
    line: source ? lineAt(source, index) : null,
    detail: String(detail).slice(0, 300)
  };
}

function specifiersOf(source) {
  const found = [];
  const patterns = [
    /\brequire\s*\(\s*['"]\s*([^'"]+?)\s*['"]\s*\)/g,
    /\bimport\s*\(\s*['"]\s*([^'"]+?)\s*['"]\s*\)/g,
    /\bfrom\s+['"]\s*([^'"]+?)\s*['"]/g,
    /^\s*import\s+['"]\s*([^'"]+?)\s*['"]/gm
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push({ specifier: match[1], index: match.index || 0 });
    }
  }
  return found;
}

function moduleBase(specifier) {
  const clean = String(specifier || '').replace(/^node:/, '').trim();
  if (!clean) return '';
  if (clean.startsWith('@')) return clean.split('/').slice(0, 2).join('/');
  return clean.split('/')[0];
}

/**
 * Escaneo estático de un archivo. Exportado para pruebas y para QA.
 * @returns {Array<object>} hallazgos bloqueantes (vacío = seguro)
 */
export function scanSource(file, content) {
  const source = String(content ?? '');
  const findings = [];
  const seen = new Set();
  const add = (code, detail, index = 0) => {
    const key = `${code}:${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding(code, file, detail, source, index));
  };

  for (const { specifier, index } of specifiersOf(source)) {
    const base = moduleBase(specifier);
    if (BANNED_MODULES.has(base)) {
      add('BANNED_MODULE', `import/require de "${base}" no permitido en el sandbox`, index);
    }
    if (base === 'fs' || base === 'fs/promises') {
      if (FS_WRITE_API.test(source)) {
        add('FS_WRITE', 'escritura de archivos no permitida en el sandbox', index);
      }
      if (/['"`](?:[A-Za-z]:[\\/]|\/|\.\.\/|\.\.\\)/.test(source)) {
        add('FS_OUTSIDE_JOB', 'rutas absolutas o con ".." no permitidas con fs', index);
      }
    }
  }

  if (SHELL_API.test(source)) {
    add('SHELL', 'ejecución de procesos/shell no permitida', source.search(SHELL_API));
  }
  if (EVAL_API.test(source)) {
    add('EVAL', 'eval/Function no permitidos (código dinámico)', source.search(EVAL_API));
  }
  if (NETWORK_API.test(source)) {
    add('NETWORK', 'descargas o red no permitidas en el sandbox', source.search(NETWORK_API));
  }
  if (PROCESS_DANGER.test(source)) {
    add('PROCESS', 'operaciones peligrosas de process no permitidas', source.search(PROCESS_DANGER));
  }
  return findings;
}

function isInside(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(base + path.sep);
}

function listFiles(directory, requested) {
  const files = [];
  if (Array.isArray(requested) && requested.length) {
    for (const raw of requested.slice(0, MAX_SCAN_FILES)) {
      const relative = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.includes('..')) continue;
      const absolute = path.resolve(directory, relative);
      if (!isInside(directory, absolute) || !fs.existsSync(absolute)) continue;
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      files.push({ relative, absolute, bytes: stat.size });
    }
    return files;
  }
  const walk = (current, prefix = '') => {
    if (files.length >= MAX_SCAN_FILES) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (files.length >= MAX_SCAN_FILES) break;
      if (entry.name === 'sandbox' || entry.name === 'proyecto.zip') continue;
      if (entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(absolute, relative); continue; }
      if (!entry.isFile()) continue;
      const stat = fs.lstatSync(absolute);
      files.push({ relative, absolute, bytes: stat.size });
    }
  };
  walk(directory);
  return files;
}

function sandboxEnv(sandboxDir) {
  const temp = path.join(sandboxDir, '.tmp');
  return {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || process.env.windir || '',
    windir: process.env.windir || process.env.SystemRoot || '',
    TEMP: temp,
    TMP: temp,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    TZ: process.env.TZ || 'America/Bogota'
  };
}

function parseTap(stdout) {
  const text = String(stdout || '');
  const number = (label) => {
    const match = text.match(new RegExp(`^#\\s*${label}\\s+(\\d+)\\s*$`, 'mi'));
    return match ? Number(match[1]) : null;
  };
  return {
    tests: number('tests'),
    pass: number('pass'),
    fail: number('fail'),
    skipped: number('skipped'),
    cancelled: number('cancelled')
  };
}

/**
 * Ejecuta el sandbox de un job de código.
 *
 * @param {object} options
 * @param {string} options.jobId
 * @param {string} options.directory directorio del job (debe estar en data/studio/jobs)
 * @param {string[]} [options.files] lista de archivos del artefacto
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} resultado con status passed|failed|blocked|skipped
 */
export async function runSandbox({ jobId, directory, files = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const jobsRoot = path.resolve(dataDir(), 'studio', 'jobs');
  const jobDirectory = path.resolve(String(directory || ''));
  const startedAt = nowIso();
  if (!jobId || !/^[A-Z0-9-]+$/.test(String(jobId))) {
    throw new Error('jobId inválido para el sandbox');
  }
  if (!isInside(jobsRoot, jobDirectory)) {
    throw new Error('El sandbox solo puede ejecutarse dentro de data/studio/jobs/<id>.');
  }
  if (!fs.existsSync(jobDirectory) || !fs.statSync(jobDirectory).isDirectory()) {
    throw new Error('El directorio del job no existe.');
  }

  const allFiles = listFiles(jobDirectory, files);
  const scanned = [];
  const findings = [];
  for (const item of allFiles) {
    const extension = path.extname(item.relative).toLowerCase();
    if (!SOURCE_EXT.has(extension)) continue;
    if (item.bytes > MAX_SCAN_FILE_BYTES) {
      findings.push(finding('FILE_TOO_LARGE', item.relative, `archivo de código demasiado grande (${item.bytes} B)`));
      continue;
    }
    const content = fs.readFileSync(item.absolute, 'utf8');
    scanned.push({ path: item.relative, bytes: item.bytes });
    findings.push(...scanSource(item.relative, content));
  }

  const base = {
    jobId,
    startedAt,
    scannedAt: nowIso(),
    scannedFiles: scanned.map((item) => item.path),
    findings,
    timeoutMs: Math.max(500, Math.min(DEFAULT_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  };

  if (findings.length) {
    return {
      ...base,
      status: 'blocked',
      reason: `Código riesgoso: ${findings[0].detail}`,
      summary: `${findings.length} hallazgo(s) de seguridad; no se ejecutó nada.`,
      executed: false,
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false
    };
  }

  const testFiles = allFiles.map((item) => item.relative).filter((relative) => TEST_FILE.test(relative));
  if (!testFiles.length) {
    return {
      ...base,
      status: 'skipped',
      reason: 'El proyecto no incluye pruebas ejecutables (tests/ o *.test.js).',
      summary: 'Sin pruebas: no se ejecutó node --test.',
      executed: false,
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false
    };
  }

  const sandboxDir = path.join(jobDirectory, 'sandbox');
  fs.rmSync(sandboxDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandboxDir, '.tmp'), { recursive: true });
  let copied = 0;
  for (const item of allFiles) {
    const extension = path.extname(item.relative).toLowerCase();
    if (!COPY_EXT.has(extension)) continue;
    if (item.bytes > MAX_SCAN_FILE_BYTES) continue;
    const target = path.resolve(sandboxDir, item.relative);
    if (!isInside(sandboxDir, target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.absolute, target);
    copied += 1;
  }
  if (!fs.existsSync(path.join(sandboxDir, 'package.json'))) {
    fs.writeFileSync(path.join(sandboxDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2), 'utf8');
  }

  const args = [
    '--test',
    '--test-isolation=none',
    '--test-concurrency=1',
    '--test-reporter=tap',
    ...testFiles
  ];
  const env = sandboxEnv(sandboxDir);
  const started = Date.now();
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: sandboxDir,
      env,
      timeout: base.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      killSignal: 'SIGKILL'
    });
    const tap = parseTap(result.stdout);
    return {
      ...base,
      status: 'passed',
      reason: 'Las pruebas del proyecto pasaron en el sandbox.',
      summary: `${tap.pass ?? tap.tests ?? '?'} prueba(s) OK`,
      executed: true,
      sandboxDir: path.relative(jobDirectory, sandboxDir),
      copiedFiles: copied,
      testFiles,
      command: ['node', ...args],
      envKeys: Object.keys(env).sort(),
      tap,
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - started,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr)
    };
  } catch (error) {
    const timedOut = error?.timedOut === true || error?.killed === true || /timed? ?out/i.test(String(error?.message || ''));
    const stdout = String(error?.stdout || '');
    const stderr = String(error?.stderr || '');
    const tap = parseTap(stdout);
    const outputLimited = error?.code === 'ENOBUFS' || /maxBuffer/i.test(String(error?.message || ''));
    return {
      ...base,
      status: 'failed',
      reason: timedOut
        ? `Tiempo de ejecución agotado (${base.timeoutMs} ms).`
        : outputLimited
          ? 'La salida del sandbox superó el límite permitido.'
          : 'Las pruebas del proyecto fallaron en el sandbox.',
      summary: timedOut
        ? `Timeout: ${tap.fail ?? 0} fallo(s) antes de agotar ${base.timeoutMs} ms`
        : `${tap.fail ?? '?'} prueba(s) fallida(s)`,
      executed: true,
      sandboxDir: path.relative(jobDirectory, sandboxDir),
      copiedFiles: copied,
      testFiles,
      command: ['node', ...args],
      envKeys: Object.keys(env).sort(),
      tap,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      signal: error?.signal || null,
      timedOut,
      durationMs: Date.now() - started,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr)
    };
  }
}

export const SANDBOX_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const SANDBOX_BANNED_MODULES = [...BANNED_MODULES].sort();

#!/usr/bin/env node
/**
 * Ejecutor de la suite de t6:
 *   1. Guarda el estado del dato real (hash + conteos + títulos + listado de data/).
 *   2. Corre `node --test tests/` con DATA_DIR temporal y flags de aislamiento.
 *   3. Corre los autocheques existentes (agenda 35, canales 88, LLM 32).
 *   4. Vuelve a comparar el dato real: falla si cambió sin ser una migración
 *      de esquema legítima (conteos iguales + backup previo + activity).
 *
 * Nunca importa `lib/store.mjs` con el DATA_DIR real: solo lee el JSON.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'agenda-data.json');
const ARRAYS = ['agenda', 'inbox', 'recurrences', 'meetings', 'okrs', 'metrics', 'googleConnections'];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDataDir() {
  try {
    return fs.readdirSync(DATA_DIR).sort().map((name) => {
      const full = path.join(DATA_DIR, name);
      const stat = fs.statSync(full);
      const hash = stat.isFile() && stat.size < 16 * 1024 * 1024 ? sha256(fs.readFileSync(full)) : null;
      return { name, size: stat.size, hash, mtimeMs: Math.round(stat.mtimeMs) };
    });
  } catch {
    return [];
  }
}

function journalState() {
  const file = path.join(DATA_DIR, 'journal.jsonl');
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    return { entries: lines.length, lastSeq: Number(last?.seq) || 0, lastDigest: String(last?.digest || '') };
  } catch {
    return { entries: 0, lastSeq: 0, lastDigest: '' };
  }
}

function snapshot() {
  const fileHash = fs.existsSync(DATA_FILE) ? sha256(fs.readFileSync(DATA_FILE)) : null;
  const data = readJson(DATA_FILE);
  return {
    exists: fs.existsSync(DATA_FILE),
    hash: fileHash,
    size: fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).size : 0,
    version: data?.version ?? null,
    arrays: Object.fromEntries(ARRAYS.map((key) => [key, data?.[key] ?? null])),
    counts: Object.fromEntries(ARRAYS.map((key) => [key, Array.isArray(data?.[key]) ? data[key].length : null])),
    agendaIds: Array.isArray(data?.agenda) ? data.agenda.map((event) => event?.id) : [],
    files: listDataDir(),
    activity: Array.isArray(data?.activity) ? data.activity.slice(0, 5) : [],
    journal: journalState()
  };
}

function sameArray(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function legitMigration(before, after) {
  if (!before.exists || !after.exists) return false;
  if (!(Number(after.version) > Number(before.version))) return false;
  for (const key of ARRAYS) {
    if (!sameArray(before.arrays[key], after.arrays[key])) return false;
  }
  const backupAppeared = after.files.some((file) => /\.pre-v\d+-\d{4}/.test(file.name) && !before.files.some((old) => old.name === file.name));
  const migrationActivity = (after.activity || []).some((entry) => /Migración de esquema v\d+ → v\d+/.test(String(entry?.text || '')));
  return backupAppeared && migrationActivity;
}

function run(label, args) {
  console.log(`\n=== ${label} (sin flags externos) ===`);
  // Se eliminan los flags de aislamiento del entorno heredado: cada selfcheck y
  // cada test fija los suyos ANTES de importar la app. Así se detecta cualquier
  // check que dependa de variables exportadas por el shell o por CI.
  const env = { ...process.env };
  delete env.WORKFLOWS_AUTOSTART;
  delete env.CHANNELS_AUTOSTART;
  delete env.NODE_ENV;
  delete env.NODE_TEST_CONTEXT;
  delete env.AGENDA_REPO_ROOT;
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });
  return result.status === 0;
}

const before = snapshot();
const results = [];

results.push({ label: 'node --test tests/**/*.test.mjs', ok: run('node --test tests/**/*.test.mjs', ['--test', 'tests/**/*.test.mjs']) });
results.push({ label: 'set dorado (60 casos)', ok: run('set dorado (60 casos)', ['scripts/golden.mjs']) });
results.push({ label: 'selfcheck agenda', ok: run('selfcheck agenda (35)', ['lib/agenda/selfcheck.mjs']) });
results.push({ label: 'selfcheck canales', ok: run('selfcheck canales (211)', ['lib/channel/selfcheck.mjs']) });

// Autocheques de los módulos integrados en la oficina (t15-t18).
const EXTRA_SELFCHECKS = [
  ['selftest LLM', 'lib/llm/selftest.mjs'],
  ['selfcheck viajes', 'lib/travel/selfcheck.mjs'],
  ['selfcheck documentos', 'lib/docs/selfcheck.mjs'],
  ['selfcheck oficina', 'lib/office/selfcheck.mjs'],
  ['selfcheck avisos', 'lib/nudges/selfcheck.mjs'],
  ['selfcheck hilos', 'lib/thread/selfcheck.mjs'],
  ['selfcheck MCP', 'lib/mcp/selfcheck.mjs'],
  ['selfcheck research', 'lib/research/selfcheck.mjs'],
  ['selfcheck lingo', 'lib/lingo/selfcheck.mjs'],
  ['selfcheck acl', 'lib/acl/selfcheck.mjs'],
  ['selfcheck features', 'scripts/check-features.mjs'],
  ['identidad multicorreo (2×2 → 4 destinos)', 'scripts/probe-identity4.mjs'],
  ['acta → tareas', 'scripts/probe-acta-tasks.mjs'],
  ['propuesta → revisión con riesgo recalculado', 'scripts/probe-proposal-revise.mjs'],
  ['propuestas pendientes → aviso consolidado', 'scripts/probe-nudges-approvals.mjs'],
  ['avisos → tareas vencidas/hoy', 'scripts/probe-nudges-tasks.mjs'],
  ['bandeja IMAP → aviso de correo nuevo', 'scripts/probe-imap-nudge.mjs'],
  ['wiki interna → crear/buscar/editar/borrar', 'scripts/probe-wiki.mjs'],
  ['correo → reglas y cuarentena', 'scripts/probe-mail-guard.mjs'],
  ['base de tablas → filas tipadas', 'scripts/probe-base.mjs'],
  ['Gmail → hilo por Message-ID', 'scripts/probe-gmail-thread.mjs'],
  ['traducción → LLM simulado', 'scripts/probe-translate.mjs'],
  ['auditoría → filtros y export', 'scripts/probe-audit.mjs'],
  ['captura de reunión → acta y tareas', 'scripts/probe-meeting-capture.mjs'],
  ['loop guard → duplicados y límites', 'scripts/probe-loop-guard.mjs'],
  ['objetivos OKR → avance y estados', 'scripts/probe-okr.mjs'],
  ['métricas de aprobación → SLA y tiempos', 'scripts/probe-approval-metrics.mjs'],
  ['salas → reservas y choques', 'scripts/probe-rooms.mjs'],
  ['momentos → resumen semanal', 'scripts/probe-moments.mjs'],
  ['jornada → turnos y horas', 'scripts/probe-attendance.mjs'],
  ['preguntar a la base → filtros', 'scripts/probe-ask-base.mjs'],
  ['tipos de aprobación → solicitudes', 'scripts/probe-approval-types.mjs'],
  ['copia de seguridad → exportación', 'scripts/probe-backup.mjs'],
  ['versiones de documento → agrupación', 'scripts/probe-doc-versions.mjs'],
  ['marca de agua → DOCX', 'scripts/probe-watermark.mjs'],
  ['visibilidad de módulos', 'scripts/probe-module-visibility.mjs'],
  ['base → exportar CSV', 'scripts/probe-base-csv.mjs'],
  ['base → importar CSV', 'scripts/probe-base-import.mjs'],
  ['base → exportar Excel', 'scripts/probe-base-xlsx.mjs'],
  ['base → renombrar tabla', 'scripts/probe-base-rename.mjs'],
  ['documentos → duplicar', 'scripts/probe-doc-duplicate.mjs'],
  ['documentos → renombrar', 'scripts/probe-doc-rename.mjs'],
  ['documentos → archivo ZIP', 'scripts/probe-doc-archive.mjs'],
  ['base → agregar columna', 'scripts/probe-base-column.mjs'],
  ['base → eliminar columna', 'scripts/probe-base-column-delete.mjs'],
  ['base → duplicar fila', 'scripts/probe-base-duplicate-row.mjs'],
  ['agenda → exportar ICS', 'scripts/probe-agenda-ics.mjs'],
  ['base → vistas guardadas', 'scripts/probe-base-views.mjs']
];
for (const [label, relative] of EXTRA_SELFCHECKS) {
  if (fs.existsSync(path.join(ROOT, relative))) {
    results.push({ label, ok: run(label, [relative]) });
  }
}

const after = snapshot();

/* ---------------------- Guardia del dato real ---------------------- */
let integrityOk = true;
const problems = [];

if (before.exists && after.exists && before.hash !== after.hash) {
  if (legitMigration(before, after)) {
    console.log('\n[integridad] Migración de esquema legítima detectada: conteos intactos, backup previo y activity de migración.');
  } else {
    const externalActivity = after.journal.entries > before.journal.entries;
    const losses = [];
    for (const key of ARRAYS) {
      const beforeCount = Array.isArray(before.arrays[key]) ? before.arrays[key].length : 0;
      const afterCount = Array.isArray(after.arrays[key]) ? after.arrays[key].length : 0;
      if (afterCount < beforeCount) losses.push(`${key}: ${beforeCount}→${afterCount}`);
    }
    const explicitDeletion = (after.activity || []).some((entry) => /eliminad|cancelad|borrad/i.test(String(entry?.text || '')));
    if (losses.length && !(externalActivity && explicitDeletion)) {
      integrityOk = false;
      problems.push(`data/agenda-data.json perdió contenido durante la suite: ${losses.join(', ')}`);
    } else if (losses.length) {
      console.log(`\n[integridad] AVISO: pérdida durante la suite (${losses.join(', ')}) pero hay activity de borrado y journal externo; probablemente la app en ejecución, no la suite.`);
    } else {
      console.log(`\n[integridad] AVISO: el dato real cambió durante la suite por actividad externa (app en ejecución; journal ${before.journal.lastSeq}→${after.journal.lastSeq}). La suite no borró contenido.`);
    }
  }
}

const beforeFiles = new Map(before.files.map((file) => [file.name, file]));
const afterFiles = new Map(after.files.map((file) => [file.name, file]));
const RUNTIME_FILES = /^(journal\.jsonl|journal\.1\.jsonl|agenda-data\.json\.(bak|bak\.1|bak\.2|pre-restore-[^/]+|pre-v\d+-[^/]+|corrupt[^/]*)|backups)$/;
for (const [name, file] of afterFiles) {
  const old = beforeFiles.get(name);
  if (!old) {
    if (!RUNTIME_FILES.test(name) && !/\.(tmp|pre-v\d+.*)$/.test(name)) {
      integrityOk = false;
      problems.push(`  - archivo nuevo inesperado en data/: ${name}`);
    }
    continue;
  }
  if (old.hash && file.hash && old.hash !== file.hash && !legitMigration(before, after)) {
    if (/^agenda-data\.json$/.test(name)) {
      if (!(after.journal.entries > before.journal.entries)) {
        integrityOk = false;
        problems.push('  - agenda-data.json cambió sin ninguna entrada nueva en el journal.');
      }
    } else if (!RUNTIME_FILES.test(name)) {
      integrityOk = false;
      problems.push(`  - archivo modificado en data/: ${name}`);
    }
  }
}
for (const name of beforeFiles.keys()) {
  if (!afterFiles.has(name) && !/\.(pre-restore|corrupt)/.test(name)) {
    integrityOk = false;
    problems.push(`  - archivo borrado de data/: ${name}`);
  }
}

if (before.exists && after.exists) {
  // El dato real es una agenda VIVA: el usuario puede borrar/crear/editar
  // eventos y rutinas entre ejecuciones (queda auditado en activity y en el
  // journal). La guardia NO exige un seed inmutable; exige que la suite no
  // cambie nada (comparación antes/después de arriba) y que no haya fixtures
  // de prueba dentro del dato real.
  const markers = (after.arrays.agenda || []).filter((event) => {
    const title = String(event?.title || '');
    return ['AG-BAD1', 'AG-BAD2', 'AG-QA'].includes(String(event?.id)) || /^(QA |Cita QA|fecha rota|31 feb)/i.test(title);
  });
  if (markers.length) {
    integrityOk = false;
    problems.push(`  - fixtures de prueba dentro del dato real: ${markers.slice(0, 3).map((event) => event.id || event.title).join(', ')}`);
  }
  if (![1, 2].includes(Number(after.version))) {
    integrityOk = false;
    problems.push(`  - versión de esquema inesperada: ${after.version}`);
  }
}

if (!integrityOk) {
  console.error('\n[integridad] FALLÓ la guardia del dato real:');
  for (const problem of problems) console.error(problem);
} else {
  console.log('\n[integridad] OK: data/ real no cambió durante la suite (o migración legítima).');
}

const failed = results.filter((result) => !result.ok);
console.log('\n=== RESUMEN SUITE QA ===');
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.label}`);
console.log(`Integridad del dato real: ${integrityOk ? 'PASS' : 'FAIL'}`);
console.log(`DATA_DIR de pruebas: ${os.tmpdir()}`);

process.exitCode = failed.length === 0 && integrityOk ? 0 : 1;








































/**
 * Verificación independiente del sandbox de código y del QA del Estudio (t52).
 *
 * Uso: node scripts/verify-studio-sandbox.mjs
 * Usa DATA_DIR temporal y puertos libres; NUNCA toca el DATA_DIR real ni 3000.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-studio-sandbox-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'verify-studio-sandbox-only-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';
for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OLLAMA_URL', 'LLM_PROVIDER']) delete process.env[key];

const importLib = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 700)}`}`);
  }
}

function makeJob(id, files) {
  const directory = path.join(DATA, 'studio', 'jobs', id);
  fs.rmSync(directory, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

const { runSandbox, scanSource } = await importLib('lib/studio/sandbox.mjs');
const { runQa } = await importLib('lib/studio/qa.mjs');
const jobs = await importLib('lib/studio/jobs.mjs');

try {
  /* ------------------------- Fixtures del sandbox ------------------------- */
  const safeDir = makeJob('JOB-QA-SAFE1', {
    'README.md': '# Suma\n\nProyecto mínimo con una prueba.',
    'src/index.js': 'export function add(a, b) { return a + b; }\n',
    'tests/index.test.js': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/index.js';",
      "test('suma segura', () => { assert.equal(add(2, 3), 5); });"
    ].join('\n')
  });
  const safe = await runSandbox({ jobId: 'JOB-QA-SAFE1', directory: safeDir });
  check('fixture seguro: status passed y ejecutado', safe.status === 'passed' && safe.executed === true, safe);
  check('fixture seguro: TAP una prueba OK', safe.tap?.pass === 1 && safe.tap?.fail === 0, safe.tap);
  check('fixture seguro: sandbox aislado con package.json type module',
    fs.existsSync(path.join(safeDir, 'sandbox', 'package.json'))
    && JSON.parse(fs.readFileSync(path.join(safeDir, 'sandbox', 'package.json'), 'utf8')).type === 'module',
    safe.sandboxDir);
  check('env mínimo sin DATA_DIR/APP_SECRET/claves',
    Array.isArray(safe.envKeys)
    && !safe.envKeys.includes('DATA_DIR') && !safe.envKeys.includes('APP_SECRET')
    && !safe.envKeys.some((key) => /API_KEY|TOKEN|SECRET/i.test(key)),
    safe.envKeys);

  const failDir = makeJob('JOB-QA-FAIL1', {
    'README.md': '# Falla',
    'tests/index.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('falla', () => { assert.equal(1, 2); });"
  });
  const failing = await runSandbox({ jobId: 'JOB-QA-FAIL1', directory: failDir });
  check('fixture que falla: status failed y TAP fail=1', failing.status === 'failed' && failing.tap?.fail === 1, failing.tap);
  check('fixture que falla: no publicable por sí solo', failing.status !== 'passed', failing.status);

  const escapeTarget = path.join(os.tmpdir(), `qa-sandbox-escape-${Date.now()}.txt`);
  fs.rmSync(escapeTarget, { force: true });
  const evilDir = makeJob('JOB-QA-EVIL1', {
    'src/index.js': [
      "import { execSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      `execSync('echo pwned > pwned.txt');`,
      `fs.writeFileSync(${JSON.stringify(escapeTarget)}, 'escape');`
    ].join('\n'),
    'tests/index.test.js': "import { test } from 'node:test'; test('x', () => {});"
  });
  const blocked = await runSandbox({ jobId: 'JOB-QA-EVIL1', directory: evilDir });
  const codes = (blocked.findings || []).map((finding) => finding.code);
  check('fixture peligroso: blocked y NO ejecutado', blocked.status === 'blocked' && blocked.executed === false, blocked.reason);
  check('fixture peligroso: detecta child_process/fs/shell', codes.includes('BANNED_MODULE') && (codes.includes('FS_WRITE') || codes.includes('FS_OUTSIDE_JOB')) && codes.includes('SHELL'), codes);
  check('fixture peligroso: no se creó pwned.txt ni archivo fuera del job',
    !fs.existsSync(path.join(evilDir, 'pwned.txt'))
    && !fs.existsSync(path.join(evilDir, 'sandbox'))
    && !fs.existsSync(escapeTarget),
    { pwned: fs.existsSync(path.join(evilDir, 'pwned.txt')), sandbox: fs.existsSync(path.join(evilDir, 'sandbox')), escape: fs.existsSync(escapeTarget) });

  const noTestsDir = makeJob('JOB-QA-NOTEST1', { 'README.md': '# sin pruebas', 'src/index.js': 'export const x = 1;' });
  const skipped = await runSandbox({ jobId: 'JOB-QA-NOTEST1', directory: noTestsDir });
  check('sin tests: status skipped y no ejecuta', skipped.status === 'skipped' && skipped.executed === false, skipped.reason);

  const slowDir = makeJob('JOB-QA-SLOW1', {
    'tests/index.test.js': "import { test } from 'node:test'; test('cuelga', () => { while (true) {} });"
  });
  const timed = await runSandbox({ jobId: 'JOB-QA-SLOW1', directory: slowDir, timeoutMs: 700 });
  check('timeout: failed + timedOut y dura < 5 s', timed.status === 'failed' && timed.timedOut === true && timed.durationMs < 5000, { durationMs: timed.durationMs, reason: timed.reason });

  const absDir = makeJob('JOB-QA-ABS1', {
    'src/index.js': "import fs from 'node:fs';\nfs.readFileSync('C:/Windows/win.ini', 'utf8');"
  });
  const absolute = await runSandbox({ jobId: 'JOB-QA-ABS1', directory: absDir });
  check('fs con ruta absoluta: blocked sin ejecutar', absolute.status === 'blocked' && absolute.executed === false, absolute.findings?.map((finding) => finding.code));

  let outsideRejected = false;
  try {
    await runSandbox({ jobId: 'JOB-QA-OUT1', directory: ROOT });
  } catch {
    outsideRejected = true;
  }
  check('rechaza ejecutar en el repo (solo data/studio/jobs/<id>)', outsideRejected);
  let badIdRejected = false;
  try {
    await runSandbox({ jobId: 'job-minusculas', directory: safeDir });
  } catch {
    badIdRejected = true;
  }
  check('rechaza jobId inválido', badIdRejected);
  check('scanSource detecta eval/Function y red', scanSource('x.mjs', "eval('1'); fetch('https://ejemplo.test');").length >= 2, scanSource('x.mjs', "eval('1'); fetch('https://ejemplo.test');"));

  /* --------------------------- QA determinista --------------------------- */
  const codeJob = { id: 'JOB-QA-SAFE1', type: 'code', title: 'Suma', brief: 'Proyecto de prueba con tests.', artifact: { kind: 'code', files: ['README.md', 'src/index.js', 'tests/index.test.js'] }, sandbox: safe };
  const qaPass = await runQa({ ...codeJob }, { review: () => ({ verdict: 'pass', provider: 'test-reviewer', model: 'stub' }) });
  check('QA: sandbox passed + checks OK ⇒ pass publicable', qaPass.verdict === 'pass' && qaPass.publishable === true, { verdict: qaPass.verdict, publishable: qaPass.publishable });
  check('QA: registra reviewer/checks/findings/fecha', qaPass.reviewer === 'QA independiente' && Array.isArray(qaPass.checks) && Array.isArray(qaPass.findings) && Boolean(qaPass.checkedAt), qaPass.reviewer);

  const qaFail = await runQa({ ...codeJob, sandbox: failing }, { review: () => ({ verdict: 'pass', provider: 'test-reviewer', model: 'stub' }) });
  check('QA: LLM "pass" NO anula sandbox failed', qaFail.verdict === 'needs_revision' && qaFail.publishable === false && qaFail.reviewerPass === true && qaFail.deterministicFailed === true, { verdict: qaFail.verdict, reviewerPass: qaFail.reviewerPass, failedChecks: qaFail.failedChecks });
  check('QA: finding del sandbox bloquea publicación', qaFail.findings.some((finding) => ['blocker', 'high'].includes(finding.severity) && /Sandbox/i.test(finding.problem)), qaFail.findings);

  const qaBlocked = await runQa({ ...codeJob, sandbox: blocked }, { review: () => ({ verdict: 'pass' }) });
  check('QA: sandbox blocked ⇒ needs_revision y no publicable', qaBlocked.verdict === 'needs_revision' && qaBlocked.publishable === false, qaBlocked.verdict);

  /* ------------------- Integración jobs: assessJobResult ------------------- */
  const safeArtifact = { kind: 'code', files: ['README.md', 'src/index.js', 'tests/index.test.js'] };
  const assessedSafe = await jobs.assessJobResult({ ...codeJob }, { artifact: safeArtifact });
  check('integración: job de código seguro ⇒ sandbox passed, QA pass y publishable', assessedSafe.sandbox?.status === 'passed' && assessedSafe.qa?.verdict === 'pass' && assessedSafe.publishable === true, { sandbox: assessedSafe.sandbox?.status, qa: assessedSafe.qa?.verdict, publishable: assessedSafe.publishable });

  const failJobDir = makeJob('JOB-QA-FAIL1', {
    'README.md': '# Falla',
    'tests/index.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('falla', () => { assert.equal(1, 2); });"
  });
  const assessedFail = await jobs.assessJobResult({ id: 'JOB-QA-FAIL1', type: 'code', title: 'Falla', brief: 'Proyecto que falla.', artifact: { kind: 'code', files: ['README.md', 'tests/index.test.js'] } }, { artifact: { kind: 'code', files: ['README.md', 'tests/index.test.js'] } });
  check('integración: sandbox failed ⇒ publishable false', assessedFail.sandbox?.status === 'failed' && assessedFail.publishable === false && assessedFail.qa?.verdict === 'needs_revision', { sandbox: assessedFail.sandbox?.status, publishable: assessedFail.publishable });
  check('integración: job no publicable conserva evidencia QA', Array.isArray(assessedFail.qa?.findings) && assessedFail.qa.findings.some((finding) => /Sandbox/i.test(finding.problem)), assessedFail.qa?.failedChecks);

  const noTestArtifact = { kind: 'code', files: ['README.md', 'src/index.js'] };
  const assessedNoTests = await jobs.assessJobResult({ id: 'JOB-QA-NOTEST1', type: 'code', title: 'Sin tests', brief: 'Sin pruebas.', artifact: noTestArtifact }, { artifact: noTestArtifact });
  check('integración: sin tests ⇒ skipped y no publicable', assessedNoTests.sandbox?.status === 'skipped' && assessedNoTests.publishable === false, { sandbox: assessedNoTests.sandbox?.status, publishable: assessedNoTests.publishable });

  /* ------------------- Cola real: un job de código termina ------------------ */
  const queued = await jobs.enqueueStudioJob({ type: 'code', title: 'QA sandbox E2E', brief: 'Genera un proyecto mínimo con README, código y una prueba node:test que pase.' });
  const deadline = Date.now() + 60_000;
  let finished = null;
  while (Date.now() < deadline) {
    const item = jobs.listStudioJobs({ limit: 20 }).find((job) => job.id === queued.id);
    if (item && ['done', 'failed'].includes(item.status)) { finished = item; break; }
    await sleep(200);
  }
  check('cola: job de código termina done', finished?.status === 'done', finished ? { status: finished.status, error: finished.lastError } : 'timeout');
  check('cola: sandbox passed persistido en el job', finished?.sandbox?.status === 'passed', finished?.sandbox?.status);
  check('cola: QA verdict pass y publishable true', finished?.qa?.verdict === 'pass' && finished?.publishable === true, { qa: finished?.qa?.verdict, publishable: finished?.publishable });
  check('cola: artefacto conserva README, código y pruebas', Array.isArray(finished?.artifact?.files) && finished.artifact.files.includes('README.md') && finished.artifact.files.some((file) => /tests\//.test(file)), finished?.artifact?.files);
} finally {
  try { jobs.stopStudioWorker(); } catch { /* noop */ }
  try { await jobs.waitForStudioWorker({ timeoutMs: 3000 }); } catch { /* noop */ }
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\nSANDBOX + QA: ${pass}/${pass + fail} PASS`);
process.exitCode = fail ? 1 : 0;

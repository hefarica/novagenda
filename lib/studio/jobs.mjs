/**
 * Encargos del Estudio: la organización produce artefactos reales.
 *
 * - presentación: guion + PPTX descargable.
 * - código: archivos fuente en ZIP (no se ejecutan; quedan como borrador).
 * - documento: se apoya en el generador DOCX local.
 *
 * La creación de un encargo es la autorización del Owner para escribir en el
 * área local de trabajo; nunca concede shell, red ni credenciales.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createDocument } from '../docs/index.mjs';
import { createZip } from '../docs/zip.mjs';
import { dataDir, resolveInside } from '../docs/paths.mjs';
import { extractJson, llmComplete, wrapUserData } from '../llm/client.mjs';
import { HttpError } from '../http/errors.mjs';
import { log, logError } from '../http/logger.mjs';
import { store } from '../store.mjs';
import { getOrganization } from './org.mjs';
import { generatePresentation } from './presentation.mjs';
import { runSandbox } from './sandbox.mjs';
import { runQa } from './qa.mjs';

const TYPES = new Set(['presentation', 'document', 'code']);
const MAX_FILES = 18;
const MAX_FILE_BYTES = 120_000;
const MAX_ATTEMPTS = 3;
const MAX_JOBS = 200;
const DEFAULT_WORKER_INTERVAL_MS = 1000;

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function jobId() {
  return `JOB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

let mutationChain = Promise.resolve();
let workerTimer = null;
let workerIntervalMs = DEFAULT_WORKER_INTERVAL_MS;
let workerStartedAt = null;
let workerLastTickAt = null;
let workerLastError = null;
let workerRecovery = null;
let tickInFlight = false;

function withJobsLock(fn) {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => {});
  return next;
}

/**
 * Lee+modifica+persiste `organization` de forma serializada y esperando el
 * flush del store. El callback debe devolver `{changed,value}`; si `changed`
 * es false no se escribe y el enqueue/worker no tocan disco por una lectura.
 */
async function mutateJobs(fn, label = 'studio-jobs') {
  return withJobsLock(async () => {
    const organization = getOrganization();
    const outcome = fn(organization) || {};
    if (outcome.changed !== false) {
      organization.jobs = Array.isArray(organization.jobs) ? organization.jobs.slice(-MAX_JOBS) : [];
      await store.mutate((state) => { state.organization = organization; }, { label });
    }
    return outcome.value;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function errorText(error) {
  return String(error?.message || error || 'No se pudo completar el encargo.').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function retryDelayMs(attempts) {
  // Backoff exponencial acotado: 1s, 2s, 4s… máx 30s.
  return Math.min(30_000, 1000 * (2 ** Math.max(0, Math.min(5, Number(attempts) - 1))));
}

function publicJob(job) {
  return {
    ...job,
    brief: String(job.brief || '').slice(0, 500),
    artifact: job.artifact ? { ...job.artifact, slides: job.artifact.slides || undefined } : null
  };
}

export function listStudioJobs({ limit = 20 } = {}) {
  const organization = getOrganization();
  return organization.jobs.slice(-Math.max(1, Math.min(100, Number(limit) || 20))).reverse().map(publicJob);
}

function normalizeFiles(raw) {
  const files = Array.isArray(raw) ? raw.slice(0, MAX_FILES) : [];
  return files.map((file, index) => {
    const relative = String(file?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || relative.includes('..') || relative.includes('\0')) {
      throw new HttpError(400, 'CODE_FILE_PATH_INVALID', `Ruta inválida en archivo ${index + 1}.`);
    }
    const content = String(file?.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new HttpError(400, 'CODE_FILE_TOO_LARGE', `El archivo ${relative} supera 120 KB.`);
    }
    return { path: relative, content };
  }).filter((file) => file.path);
}

async function generateCode(job) {
  const planPrompt = `Eres un ingeniero de software senior. Planifica un proyecto mínimo y ejecutable para este brief.
Devuelve SOLO JSON: {"summary":"...","files":[{"path":"README.md","purpose":"..."},{"path":"src/index.js","purpose":"..."}]}
Reglas: máximo 6 archivos, rutas relativas sin "..", incluye README y al menos una prueba. No inventes credenciales.
Brief: ${wrapUserData(job.brief, 4000)}`;
  const fallbackFiles = [
    { path: 'README.md', content: `# ${job.title}\n\n${job.brief}\n\n> Borrador local: revisa requisitos, stack y criterios antes de implementar.\n` },
    { path: 'src/index.js', content: `// ${job.title}\n// ${job.brief.slice(0, 500)}\nexport function run() {\n  return { ok: false, reason: 'implementación pendiente' };\n}\n` },
    { path: 'tests/index.test.js', content: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('contrato pendiente', () => { assert.ok(true); });\n` }
  ];
  let provider = null;
  let model = null;
  let usedFallback = false;
  let files = [];
  try {
    const planResult = await llmComplete({
      profile: 'chat',
      messages: [
        { role: 'system', content: 'Eres ingeniero de software senior. Planificas proyectos pequeños con criterios verificables. Respondes JSON válido.' },
        { role: 'user', content: planPrompt }
      ],
      json: true,
      fallback: null,
      scope: 'studio:code-plan',
      workflow: 'code',
      maxTokens: 1800,
      deadlineMs: 45_000
    });
    provider = planResult.provider || null;
    model = planResult.model || null;
    const plan = planResult.ok && planResult.text ? extractJson(planResult.text) : null;
    const planned = Array.isArray(plan?.files) ? plan.files.slice(0, 6) : [];
    for (const item of planned) {
      const relative = String(item.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relative || relative.includes('..')) continue;
      try {
        const fileResult = await llmComplete({
          profile: 'chat',
          messages: [
            { role: 'system', content: 'Escribes un solo archivo de código. Devuelve únicamente el contenido, sin explicaciones ni vallas markdown.' },
            { role: 'user', content: `Brief del proyecto: ${wrapUserData(job.brief, 2500)}\nArchivo: ${relative}\nPropósito: ${String(item.purpose || '').slice(0, 400)}\nEscribe el contenido completo y ejecutable de este archivo.` }
          ],
          json: false,
          fallback: null,
          scope: 'studio:code-file',
          workflow: 'code',
          maxTokens: 2600,
          deadlineMs: 45_000
        });
        const content = String(fileResult.text || '').replace(/^```[a-z0-9]*\s*/i, '').replace(/```\s*$/i, '').trim();
        if (!content) throw new Error('vacío');
        files.push({ path: relative, content });
        provider = fileResult.provider || provider;
        model = fileResult.model || model;
      } catch {
        usedFallback = true;
        files.push({ path: relative, content: `// ${job.title}\n// ${relative}\n// Contenido pendiente; el brief está en README.md\n` });
      }
    }
  } catch {
    usedFallback = true;
  }
  if (!files.length) {
    files = fallbackFiles;
    usedFallback = true;
  }
  files = normalizeFiles(files);
  const directory = path.join(dataDir(), 'studio', 'jobs', job.id);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) {
    const target = resolveInside(directory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  const zipPath = path.join(directory, 'proyecto.zip');
  fs.writeFileSync(zipPath, createZip(files.map((file) => ({ name: file.path, data: file.content }))));
  return {
    provider,
    model,
    fallback: usedFallback,
    files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) })),
    artifact: {
      kind: 'code',
      filename: `${job.id}-proyecto.zip`,
      downloadUrl: `/api/studio/jobs/${job.id}/download`,
      files: files.map((file) => file.path)
    }
  };
}

async function generateDocument(job) {
  const prompt = `Redacta un documento ejecutivo para Héctor Fabio Riascos C. sobre el brief.
Devuelve SOLO JSON: {"title":"...","subtitle":"...","sections":[{"heading":"...","paragraph":"..."}]}
Máximo 10 secciones, 180 palabras por sección. No inventes cifras ni fuentes; si falta un dato, escribe "[dato por confirmar]".
Brief: ${wrapUserData(job.brief, 5000)}`;
  let parsed = null;
  let provider = null;
  let model = null;
  let fallback = true;
  try {
    const result = await llmComplete({
      profile: 'chat',
      messages: [
        { role: 'system', content: 'Eres redactor ejecutivo. Respondes JSON válido y no inventas datos.' },
        { role: 'user', content: prompt }
      ],
      json: true,
      fallback: null,
      scope: 'studio:document',
      workflow: 'document',
      maxTokens: 3000,
      deadlineMs: 60_000
    });
    provider = result.provider || null;
    model = result.model || null;
    parsed = result.ok && result.text ? extractJson(result.text) : null;
    fallback = !parsed;
  } catch { fallback = true; }
  const title = clean(parsed?.title, 200) || job.title;
  const sections = (Array.isArray(parsed?.sections) ? parsed.sections : []).slice(0, 10)
    .map((section) => ({
      heading: clean(section.heading, 200),
      paragraph: clean(section.paragraph, 8000)
    })).filter((section) => section.heading || section.paragraph);
  if (!sections.length) {
    sections.push({ heading: 'Resumen', paragraph: job.brief });
    sections.push({ heading: 'Siguientes pasos', paragraph: 'Revisar alcance, responsables y criterios de aceptación.' });
  }
  const doc = await createDocument({
    type: 'docx',
    title,
    subtitle: clean(parsed?.subtitle, 300) || 'Documento de trabajo',
    author: 'Héctor Fabio Riascos C.',
    subject: job.brief.slice(0, 300),
    sections: sections.flatMap((section) => [
      { heading: section.heading, level: 1 },
      { paragraph: section.paragraph }
    ])
  });
  return {
    provider,
    model,
    fallback,
    artifact: {
      kind: 'document',
      docId: doc.id,
      filename: doc.filename,
      downloadUrl: `/api/docs/${doc.id}/download`,
      sections
    }
  };
}

function normalizeJobInput(input = {}) {
  const type = String(input.type || 'presentation').toLowerCase();
  if (!TYPES.has(type)) throw new HttpError(400, 'STUDIO_BAD_TYPE', 'type debe ser presentation, document o code.');
  const brief = clean(input.brief, 6000);
  if (brief.length < 10) throw new HttpError(400, 'STUDIO_BRIEF_REQUIRED', 'Escribe un brief de al menos 10 caracteres.');
  const title = clean(input.title, 200) || brief.split(/[.\n]/)[0].slice(0, 100);
  return {
    type,
    title,
    brief,
    teamId: clean(input.teamId, 64) || null,
    audience: clean(input.audience, 200) || null,
    style: clean(input.style, 80) || null,
    slideCount: input.slideCount
  };
}

/**
 * Encola un encargo. No genera nada: responde antes de que el worker lo tome.
 * El worker del proceso se encarga de ejecutarlo fuera de la petición HTTP.
 */
export async function enqueueStudioJob(input = {}) {
  const normalized = normalizeJobInput(input);
  const now = nowIso();
  const job = {
    id: jobId(),
    type: normalized.type,
    title: normalized.title,
    brief: normalized.brief,
    teamId: normalized.teamId,
    audience: normalized.audience,
    style: normalized.style,
    slideCount: normalized.slideCount,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
    error: null,
    artifact: null,
    sandbox: null,
    qa: null,
    publishable: false,
    provider: null,
    model: null,
    fallback: false,
    createdAt: now,
    updatedAt: now
  };
  await mutateJobs((organization) => {
    organization.jobs.push(job);
    return { changed: true, value: undefined };
  }, 'studio-enqueue');
  return publicJob(job);
}

/** Compatibilidad con llamadas antiguas; ahora encola, no ejecuta. */
export const createStudioJob = enqueueStudioJob;

async function runGeneration(job) {
  if (job.type === 'presentation') {
    const generated = await generatePresentation({
      brief: job.brief, title: job.title, audience: job.audience, style: job.style, slideCount: job.slideCount
    });
    return {
      provider: generated.provider,
      model: generated.model,
      fallback: generated.fallback,
      artifact: {
        kind: 'presentation',
        docId: generated.doc.id,
        filename: generated.doc.filename,
        downloadUrl: generated.downloadUrl,
        title: generated.title,
        subtitle: generated.subtitle,
        slides: generated.slides,
        ...(generated.preset ? { preset: generated.preset } : {}),
        ...(generated.preview ? { preview: generated.preview } : {}),
        ...(generated.visual ? { visual: generated.visual } : {})
      }
    };
  }
  if (job.type === 'code') return generateCode(job);
  if (job.type === 'document') return generateDocument(job);
  throw new HttpError(400, 'STUDIO_BAD_TYPE', 'type debe ser presentation, document o code.');
}

/**
 * Sandbox + QA independiente sobre el resultado generado.
 *
 * - Código: se escanea y ejecuta en data/studio/jobs/<id>/sandbox (nunca el repo).
 * - Presentación/documento: solo QA estructural + revisión LLM opcional.
 * - `publishable` exige veredicto QA `pass` y sandbox distinto de failed/blocked.
 */
export async function assessJobResult(job, result = {}) {
  const artifact = result.artifact || null;
  let sandbox = null;
  if (artifact?.kind === 'code') {
    sandbox = await runSandbox({
      jobId: job.id,
      directory: path.join(dataDir(), 'studio', 'jobs', job.id),
      files: artifact.files
    });
  }
  let qa;
  try {
    qa = await runQa({ ...job, artifact, sandbox });
  } catch (error) {
    qa = {
      verdict: 'needs_revision',
      checks: [],
      findings: [{ severity: 'blocker', problem: `QA no pudo ejecutarse: ${errorText(error)}`, requiredFix: 'Reintentar la revisión.' }],
      reviewer: 'QA independiente',
      reviewerId: 'studio-qa',
      deterministicFailed: true,
      failedChecks: [],
      reviewerPass: null,
      provider: null,
      model: null,
      llmError: errorText(error),
      sandboxStatus: sandbox?.status || null,
      checkedAt: nowIso(),
      publishable: false
    };
  }
  const sandboxBlocked = Boolean(sandbox && ['failed', 'blocked'].includes(String(sandbox.status)));
  const publishable = qa.verdict === 'pass' && !sandboxBlocked;
  return {
    ...result,
    sandbox,
    qa: { ...qa, publishable },
    publishable
  };
}

async function markJobDone(id, result) {
  return mutateJobs((organization) => {
    const job = organization.jobs.find((item) => item.id === id);
    if (!job || job.status === 'done') return { changed: false, value: job ? publicJob(job) : null };
    const now = nowIso();
    Object.assign(job, {
      status: 'done',
      updatedAt: now,
      finishedAt: now,
      nextAttemptAt: null,
      lastError: null,
      error: null,
      provider: result?.provider || null,
      model: result?.model || null,
      fallback: result?.fallback === true,
      artifact: result?.artifact || null,
      sandbox: result?.sandbox || null,
      qa: result?.qa || null,
      publishable: result?.publishable === true
    });
    return { changed: true, value: publicJob(job) };
  }, 'studio-job-done');
}

async function markJobFailed(id, error) {
  const message = errorText(error);
  return mutateJobs((organization) => {
    const job = organization.jobs.find((item) => item.id === id);
    if (!job) return { changed: false, value: null };
    const attempts = Math.max(1, Number(job.attempts) || 1);
    const now = nowIso();
    job.updatedAt = now;
    job.lastError = message;
    job.error = message;
    if (attempts < MAX_ATTEMPTS) {
      job.status = 'retrying';
      job.nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
    } else {
      job.status = 'failed';
      job.nextAttemptAt = null;
      job.finishedAt = now;
    }
    return { changed: true, value: publicJob(job) };
  }, 'studio-job-fail');
}

async function executeJob(job) {
  try {
    const generated = await runGeneration(job);
    const result = await assessJobResult(job, generated);
    await markJobDone(job.id, result);
    log('info', `Studio: job ${job.id} done (intento ${job.attempts}); publishable=${result.publishable} sandbox=${result.sandbox?.status || 'n/a'} qa=${result.qa?.verdict || 'n/a'}`);
  } catch (error) {
    const message = errorText(error);
    workerLastError = message;
    logError(`studio:job:${job.id}`, error);
    await markJobFailed(job.id, error);
  }
}

function shouldRun(job, now = Date.now()) {
  if (!['queued', 'retrying'].includes(String(job.status || ''))) return false;
  const attempts = Number(job.attempts) || 0;
  if (attempts >= MAX_ATTEMPTS) return false;
  const next = Date.parse(String(job.nextAttemptAt || ''));
  return !Number.isFinite(next) || next <= now;
}

async function claimNextJob() {
  return mutateJobs((organization) => {
    const now = Date.now();
    const candidates = organization.jobs
      .filter((job) => shouldRun(job, now))
      .sort((a, b) => {
        const at = Date.parse(String(a.createdAt || '')) || 0;
        const bt = Date.parse(String(b.createdAt || '')) || 0;
        return at - bt;
      });
    const job = candidates[0];
    if (!job) return { changed: false, value: null };
    const nowText = nowIso();
    job.status = 'running';
    job.attempts = (Number(job.attempts) || 0) + 1;
    job.startedAt = nowText;
    job.updatedAt = nowText;
    job.nextAttemptAt = null;
    job.lastError = null;
    job.error = null;
    return { changed: true, value: JSON.parse(JSON.stringify(job)) };
  }, 'studio-job-start');
}

async function recoverJobs() {
  return mutateJobs((organization) => {
    let changed = false;
    const now = nowIso();
    for (const job of organization.jobs) {
      const attempts = Number(job.attempts) || 0;
      if (job.status === 'running') {
        changed = true;
        job.updatedAt = now;
        if (attempts >= MAX_ATTEMPTS) {
          job.status = 'failed';
          job.nextAttemptAt = null;
          job.lastError = 'Worker reiniciado tras agotar los 3 intentos.';
          job.error = job.lastError;
          job.finishedAt = now;
        } else {
          job.status = 'retrying';
          job.nextAttemptAt = now;
          job.lastError = 'Worker reiniciado; el encargo se retomará.';
          job.error = job.lastError;
        }
      } else if (['queued', 'retrying'].includes(job.status)) {
        if (attempts >= MAX_ATTEMPTS) {
          changed = true;
          job.status = 'failed';
          job.nextAttemptAt = null;
          job.lastError = job.lastError || 'Se agotaron los 3 intentos.';
          job.error = job.lastError;
          job.finishedAt = now;
          job.updatedAt = now;
        } else if (!job.nextAttemptAt) {
          changed = true;
          job.nextAttemptAt = now;
          job.updatedAt = now;
        }
      }
    }
    return { changed, value: null };
  }, 'studio-worker-recover');
}

export function studioWorkerStatus() {
  return {
    running: workerTimer !== null,
    intervalMs: workerIntervalMs,
    startedAt: workerStartedAt,
    lastTickAt: workerLastTickAt,
    lastError: workerLastError,
    tickInFlight
  };
}

export function startStudioWorker({ intervalMs = DEFAULT_WORKER_INTERVAL_MS } = {}) {
  if (workerTimer) return studioWorkerStatus();
  if (/^(off|0|false|no)$/i.test(String(process.env.STUDIO_WORKER || ''))) {
    return studioWorkerStatus();
  }
  workerIntervalMs = Math.max(100, Math.min(60_000, Number(intervalMs) || DEFAULT_WORKER_INTERVAL_MS));
  workerStartedAt = nowIso();
  workerLastError = null;
  workerRecovery = recoverJobs().catch((error) => {
    workerLastError = errorText(error);
    logError('studio:worker-recover', error);
  });
  workerTimer = setInterval(() => { void tick(); }, workerIntervalMs);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  setImmediate(() => { void tick(); });
  log('info', `Studio worker iniciado (${workerIntervalMs} ms); vivo mientras la app está encendida`);
  return studioWorkerStatus();
}

export function stopStudioWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  return studioWorkerStatus();
}

/** Espera a que recovery/tick terminen antes de cerrar o borrar un DATA_DIR temporal. */
export async function waitForStudioWorker({ timeoutMs = 5000 } = {}) {
  if (workerRecovery) await workerRecovery.catch(() => {});
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (tickInFlight && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function tick() {
  if (!workerTimer) return;
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    if (workerRecovery) await workerRecovery.catch(() => {});
    const job = await claimNextJob();
    if (job) await executeJob(job);
  } catch (error) {
    workerLastError = errorText(error);
    logError('studio:worker-tick', error);
  } finally {
    tickInFlight = false;
    workerLastTickAt = nowIso();
  }
}

/**
 * Worker del proceso: se arranca al importar el módulo (la ruta del Estudio lo
 * importa al montar la app) y vive mientras el proceso está encendido. El timer
 * es `unref()` para no impedir un cierre limpio. `STUDIO_WORKER=off` lo desactiva
 * en pruebas/scripts que quieran controlar el worker manualmente.
 */
if (!/^(off|0|false|no)$/i.test(String(process.env.STUDIO_WORKER || ''))) {
  startStudioWorker();
}

export function readJobFile(id) {
  const org = getOrganization();
  const job = org.jobs.find((item) => item.id === String(id || '').toUpperCase());
  if (!job) throw new HttpError(404, 'STUDIO_JOB_NOT_FOUND', 'No existe el encargo.');
  if (job.artifact?.kind !== 'code') throw new HttpError(400, 'STUDIO_NOT_FILE_JOB', 'Este encargo no produce un ZIP.');
  const target = path.join(dataDir(), 'studio', 'jobs', job.id, 'proyecto.zip');
  if (!fs.existsSync(target)) throw new HttpError(404, 'STUDIO_ARTIFACT_MISSING', 'El ZIP ya no está en disco.');
  return { job, buffer: fs.readFileSync(target), filename: job.artifact.filename || `${job.id}.zip` };
}


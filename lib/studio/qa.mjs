/**
 * QA independiente de entregables del Estudio.
 *
 * Orden de autoridad:
 *   1. Checks deterministas (estructura del artefacto + sandbox de código).
 *   2. Revisión LLM opcional (solo puede EMPEORAR el veredicto, nunca aprobar
 *      un check objetivo fallido).
 *
 * Un fallo determinista (check false o finding blocker/high) ⇒ needs_revision,
 * aunque el LLM diga "pass". El sandbox failed/blocked ⇒ no publicable.
 */
import { llmComplete, extractJson } from '../llm/client.mjs';

function issue(severity, problem, requiredFix) {
  return { severity, problem, requiredFix };
}

function sandboxCheck(job) {
  const sandbox = job.sandbox || null;
  const status = String(sandbox?.status || '').toLowerCase();
  const ok = status === 'passed';
  return {
    ok,
    status,
    check: {
      id: 'sandbox',
      ok,
      detail: sandbox ? `${status}${sandbox.reason ? ` · ${sandbox.reason}` : ''}` : 'sandbox no ejecutado'
    }
  };
}

export async function runQa(job, options = {}) {
  const artifact = job.artifact || {};
  const sandbox = job.sandbox || null;
  const checks = [];
  const findings = [];

  if (!artifact.kind) {
    findings.push(issue('blocker', 'El encargo no produjo un artefacto.', 'Reintentar la generación.'));
  }

  if (artifact.kind === 'presentation') {
    const slides = Array.isArray(artifact.slides) ? artifact.slides : [];
    checks.push({ id: 'slides-count', ok: slides.length >= 6, detail: `${slides.length} diapositivas` });
    checks.push({ id: 'cover', ok: slides[0]?.layout === 'cover', detail: slides[0]?.title || 'sin portada' });
    checks.push({ id: 'notes', ok: slides.every((slide) => String(slide.notes || '').trim().length > 0), detail: 'notas del orador' });
    checks.push({ id: 'downloadable', ok: Boolean(artifact.docId && artifact.downloadUrl), detail: artifact.filename || 'sin archivo' });
    if (slides.length < 6) findings.push(issue('high', 'La presentación tiene menos de 6 diapositivas.', 'Ampliar el guion a al menos 6.'));
    if (slides[0]?.layout !== 'cover') findings.push(issue('high', 'Falta una portada.', 'Añadir una diapositiva cover.'));
    if (!artifact.docId) findings.push(issue('blocker', 'La presentación no tiene PPTX descargable.', 'Reintentar la generación.'));
  } else if (artifact.kind === 'document') {
    checks.push({ id: 'document', ok: Boolean(artifact.docId), detail: artifact.filename || '' });
    checks.push({ id: 'sections', ok: Array.isArray(artifact.sections) && artifact.sections.length > 0, detail: `${artifact.sections?.length || 0} secciones` });
    if (!artifact.docId) findings.push(issue('blocker', 'No se registró el DOCX.', 'Reintentar la generación.'));
    if (!Array.isArray(artifact.sections) || !artifact.sections.length) {
      findings.push(issue('high', 'El documento no tiene secciones.', 'Reintentar la redacción.'));
    }
  } else if (artifact.kind === 'code') {
    const files = Array.isArray(artifact.files) ? artifact.files : [];
    const hasTests = files.some((file) => /(^|\/)(test|tests)(\/|$)/i.test(file) || /\.(test|spec)\.(mjs|cjs|js)$/i.test(file));
    checks.push({ id: 'files', ok: files.length > 0, detail: `${files.length} archivos` });
    checks.push({ id: 'readme', ok: files.includes('README.md'), detail: 'README' });
    checks.push({ id: 'tests', ok: hasTests, detail: 'pruebas' });
    const sandboxResult = sandboxCheck(job);
    checks.push(sandboxResult.check);
    if (!sandboxResult.ok) {
      const blocked = sandboxResult.status === 'blocked';
      findings.push(issue(
        blocked ? 'blocker' : 'high',
        `Sandbox ${sandboxResult.status || 'no ejecutado'}: ${sandbox?.reason || 'el código no superó las pruebas.'}`,
        blocked ? 'Retirar el código riesgoso antes de publicar.' : 'Corregir el código y volver a ejecutar el sandbox.'
      ));
    }
    if (!hasTests) {
      findings.push(issue('medium', 'No hay archivos de prueba.', 'Añadir una prueba ejecutable (node:test).'));
    }
    if (sandboxResult.status === 'skipped') {
      findings.push(issue('high', 'El proyecto no incluye pruebas ejecutables; no se puede validar.', 'Añadir tests y volver a generar.'));
    }
  }

  const deterministicFailed = findings.some((item) => ['blocker', 'high'].includes(item.severity))
    || checks.some((check) => !check.ok);
  const failedChecks = checks.filter((check) => !check.ok).map((check) => check.id);

  let reviewerPass = null;
  let provider = null;
  let model = null;
  let llmError = null;
  try {
    if (typeof options.review === 'function') {
      // Inyección para pruebas: demuestra que un revisor que dice "pass" no
      // puede anular checks deterministas fallidos.
      const review = await options.review({ job, checks, findings, deterministicFailed });
      reviewerPass = review?.verdict === 'pass';
      provider = review?.provider || 'test-reviewer';
      model = review?.model || 'stub';
      if (review?.verdict === 'needs_revision' && Array.isArray(review.findings)) {
        for (const finding of review.findings.slice(0, 6)) {
          findings.push(issue('medium', String(finding).slice(0, 400), 'Revisar y corregir antes de publicar.'));
        }
      }
    } else {
      const result = await llmComplete({
        profile: 'chat',
        messages: [
          { role: 'system', content: 'Eres QA independiente. Revisas un entregable y respondes SOLO JSON: {"verdict":"pass|needs_revision","findings":["..."]}. No puedes aprobar fallos objetivos; si los checks deterministas fallan, tu veredicto debe ser needs_revision.' },
          { role: 'user', content: `Entregable: ${JSON.stringify({ type: job.type, title: job.title, brief: job.brief, artifact: { kind: artifact.kind, files: artifact.files, slides: artifact.slides?.map((slide) => ({ title: slide.title, layout: slide.layout, bullets: slide.bullets?.length || 0 })) }, checks, findings, sandbox: sandbox ? { status: sandbox.status, reason: sandbox.reason, summary: sandbox.summary } : null, deterministicFailed }).slice(0, 6000)}` }
        ],
        json: true,
        fallback: null,
        scope: 'studio:qa',
        workflow: 'qa',
        maxTokens: 1200,
        deadlineMs: 30_000
      });
      provider = result.provider || null;
      model = result.model || null;
      const parsed = result.ok && result.text ? extractJson(result.text) : null;
      // Sin respuesta válida del revisor NO se degrada: reviewerPass queda null.
      reviewerPass = parsed?.verdict === 'pass' ? true : parsed?.verdict === 'needs_revision' ? false : null;
      if (parsed?.verdict === 'needs_revision' && Array.isArray(parsed.findings)) {
        for (const finding of parsed.findings.slice(0, 6)) {
          findings.push(issue('medium', String(finding).slice(0, 400), 'Revisar y corregir antes de publicar.'));
        }
      }
    }
  } catch (error) {
    llmError = String(error?.message || error).slice(0, 200);
  }

  // El LLM solo puede bajar el veredicto: `deterministicFailed` manda.
  const verdict = deterministicFailed ? 'needs_revision' : reviewerPass === false ? 'needs_revision' : 'pass';
  const sandboxBlocked = Boolean(sandbox && ['failed', 'blocked'].includes(String(sandbox.status)));
  const publishable = verdict === 'pass' && !sandboxBlocked;

  return {
    verdict,
    checks,
    findings,
    reviewer: 'QA independiente',
    reviewerId: 'studio-qa',
    deterministicFailed,
    failedChecks,
    reviewerPass,
    provider,
    model,
    llmError,
    sandboxStatus: sandbox?.status || null,
    checkedAt: new Date().toISOString(),
    publishable
  };
}

/**
 * Estudio: brief → presentación/documento/código, con vista previa y descarga.
 */
import { api } from './api.js';
import { $, esc, toast } from './core.js';
import { loadOrganization } from './organization.js';

let initialized = false;
let busy = false;
let jobs = [];

function setStatus(text, kind = '') {
  const el = $('#studioEngine');
  if (!el) return;
  el.textContent = text;
  el.className = `tag${kind ? ` ${kind}` : ''}`;
}

function fillTeams(org) {
  const select = $('#studioTeam');
  if (!select) return;
  select.innerHTML = '<option value="">Equipo completo / Camila</option>' + (org?.teams || [])
    .map((team) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('');
}

function slidePreview(slides = []) {
  if (!Array.isArray(slides) || !slides.length) return '<p class="muted small">Sin diapositivas todavía.</p>';
  return `<div class="studio-slides">${slides.map((slide, index) => `
    <article class="studio-slide">
      <span class="studio-slide-number">${String(index + 1).padStart(2, '0')}</span>
      <div>
        <p class="eyebrow">${esc(slide.layout || 'content')}</p>
        <h4>${esc(slide.title || 'Sin título')}</h4>
        ${slide.subtitle ? `<p class="muted small">${esc(slide.subtitle)}</p>` : ''}
        ${Array.isArray(slide.bullets) && slide.bullets.length ? `<ul>${slide.bullets.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
        ${slide.table ? `<p class="small muted">Tabla: ${esc((slide.table.headers || []).join(' · '))}</p>` : ''}
        ${slide.notes ? `<details><summary>Notas del orador</summary><p class="small">${esc(slide.notes)}</p></details>` : ''}
      </div>
    </article>`).join('')}</div>`;
}

function artifactView(job) {
  const artifact = job.artifact;
  if (!artifact) return '';
  if (artifact.kind === 'presentation') {
    return `<div class="studio-artifact"><div><p class="eyebrow">PRESENTACIÓN</p><h4>${esc(artifact.title || job.title)}</h4><p class="muted small">${esc(artifact.subtitle || '')} · ${artifact.slides?.length || 0} diapositivas</p></div>
      <a class="primary small" href="${esc(artifact.downloadUrl)}" download>Descargar PPTX</a></div>`;
  }
  if (artifact.kind === 'document') {
    return `<div class="studio-artifact"><div><p class="eyebrow">DOCUMENTO</p><h4>${esc(artifact.filename || job.title)}</h4></div><a class="primary small" href="${esc(artifact.downloadUrl)}" download>Descargar DOCX</a></div>`;
  }
  if (artifact.kind === 'code') {
    return `<div class="studio-artifact"><div><p class="eyebrow">PROYECTO DE CÓDIGO${job.fallback ? ' · BORRADOR PARCIAL' : ''}</p><h4>${esc(artifact.filename || job.title)}</h4><p class="muted small">${(artifact.files || []).length} archivos · no se ejecutó</p><div class="caps">${(artifact.files || []).slice(0, 12).map((file) => `<span>${esc(file)}</span>`).join('')}</div></div><a class="primary small" href="${esc(artifact.downloadUrl)}" download>Descargar ZIP</a></div>`;
  }
  return '';
}

function renderJobs() {
  const box = $('#studioJobs');
  const meta = $('#studioJobsMeta');
  if (meta) meta.textContent = `${jobs.length} encargo(s)`;
  if (!box) return;
  if (!jobs.length) { box.innerHTML = '<p class="muted small">Todavía no hay encargos. Describe uno y pulsa “Generar encargo”.</p>'; return; }
  box.innerHTML = jobs.map((job) => `<article class="studio-job">
    <div class="studio-job-head"><div><p class="eyebrow">${esc(job.type)}</p><h4>${esc(job.title)}</h4><p class="muted small">${esc(job.brief)}</p></div><span class="tag ${job.status === 'done' ? (job.fallback ? 'warn' : 'ok') : job.status === 'failed' ? 'bad' : 'warn'}">${esc(job.status)}${job.fallback && job.status === 'done' ? ' · borrador' : ''}</span></div>
    ${job.error ? `<p class="notice error">${esc(job.error)}</p>` : ''}
    ${artifactView(job)}
    <small class="muted">${esc(job.createdAt ? new Date(job.createdAt).toLocaleString('es-CO') : '')}</small>
  </article>`).join('');
}

function renderPreview(job) {
  const box = $('#studioPreviewBody');
  const meta = $('#studioPreviewMeta');
  if (!box) return;
  if (!job) { box.innerHTML = '<p class="muted small">El guion de la presentación aparecerá aquí antes de descargar el PPTX.</p>'; if (meta) meta.textContent = ''; return; }
  const artifact = job.artifact || {};
  if (meta) meta.textContent = artifact.kind === 'presentation' ? `${artifact.slides?.length || 0} diapositivas` : artifact.kind || job.type;
  box.innerHTML = `
    ${artifact.kind === 'presentation' ? slidePreview(artifact.slides) : ''}
    ${artifact.kind === 'presentation' ? `<a class="primary" href="${esc(artifact.downloadUrl)}" download>Descargar PPTX</a>` : artifactView(job)}`;
}

async function generate() {
  if (busy) return;
  const brief = $('#studioBrief')?.value.trim() || '';
  if (brief.length < 10) { toast('Escribe un brief más completo.', 'warn'); return; }
  busy = true;
  const button = $('#studioGenerate');
  if (button) { button.disabled = true; button.textContent = 'El equipo está trabajando…'; }
  setStatus('Generando…', 'warn');
  const payload = {
    type: $('#studioType')?.value || 'presentation',
    title: $('#studioTitleInput')?.value.trim() || '',
    brief,
    teamId: $('#studioTeam')?.value || null,
    style: $('#studioStyle')?.value || 'ejecutivo',
    slideCount: Number($('#studioSlides')?.value || 10),
    audience: $('#studioAudience')?.value.trim() || ''
  };
  try {
    const result = await api.post('/api/studio/jobs', payload, { timeoutMs: 120000 });
    const job = result?.job;
    if (job) {
      jobs = [job, ...jobs];
      renderJobs();
      renderPreview(job);
      setStatus('Entregado', 'ok');
      toast('Encargo completado.', 'ok');
    }
  } catch (error) {
    setStatus('Error', 'bad');
    toast(error?.message || 'No pude completar el encargo.', 'bad');
  } finally {
    busy = false;
    if (button) { button.disabled = false; button.textContent = 'Generar encargo'; }
  }
}

export async function renderStudio() {
  fillTeams(await loadOrganization().catch(() => null));
  try {
    const data = await api.get('/api/studio/jobs', { timeoutMs: 20000 });
    jobs = Array.isArray(data?.items) ? data.items : [];
    renderJobs();
    if (jobs[0]) renderPreview(jobs[0]);
  } catch (error) {
    setStatus('Sin conexión', 'bad');
    const box = $('#studioJobs');
    if (box) box.innerHTML = `<p class="muted">No pude cargar los encargos: ${esc(error?.message || 'error')}</p>`;
  }
}

export function initStudio() {
  if (initialized) return;
  initialized = true;
  $('#studioGenerate')?.addEventListener('click', generate);
  $('#studioClear')?.addEventListener('click', () => {
    for (const id of ['studioTitleInput', 'studioBrief', 'studioAudience']) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    renderPreview(null);
    setStatus('Listo', '');
  });
}

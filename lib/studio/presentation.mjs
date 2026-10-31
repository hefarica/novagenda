/**
 * Estudio de presentaciones: brief → guion → PPTX real.
 *
 * No usa una API de diapositivas propietaria: el contenido se genera con el
 * LLM configurado y se renderiza con el generador PPTX local (sin dependencias).
 */
import { createDocument } from '../docs/index.mjs';
import { extractJson, llmComplete, wrapUserData } from '../llm/client.mjs';
import { HttpError } from '../http/errors.mjs';
import {
  buildCoverPreview, normalizePresetName, presetSummary, resolvePreset
} from './visuals.mjs';

const MAX_SLIDES = 18;

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bulletList(value, max = 6) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item, 280)).filter(Boolean).slice(0, max);
}

function normalizeOutline(raw, brief) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const title = clean(source.title, 200) || clean(brief, 100) || 'Presentación ejecutiva';
  const subtitle = clean(source.subtitle, 300) || 'Propuesta para decisión';
  const slides = [];
  for (const slide of Array.isArray(source.slides) ? source.slides.slice(0, MAX_SLIDES) : []) {
    if (!slide || typeof slide !== 'object') continue;
    const layout = slide.layout === 'cover' || slide.cover === true
      ? 'cover'
      : slide.layout === 'section' ? 'section' : slide.layout === 'table' ? 'table' : 'content';
    if (layout === 'cover') {
      slides.push({
        layout: 'cover',
        title: clean(slide.title, 200) || title,
        subtitle: clean(slide.subtitle, 300) || subtitle,
        notes: clean(slide.notes, 2000)
      });
      continue;
    }
    if (layout === 'section') {
      slides.push({ layout: 'section', title: clean(slide.title, 200), subtitle: clean(slide.subtitle, 300), notes: clean(slide.notes, 2000) });
      continue;
    }
    if (layout === 'table' && slide.table && Array.isArray(slide.table.headers) && Array.isArray(slide.table.rows)) {
      slides.push({
        layout: 'table',
        title: clean(slide.title, 200),
        table: {
          headers: slide.table.headers.slice(0, 8).map((item) => clean(item, 80)),
          rows: slide.table.rows.slice(0, 16).map((row) => (Array.isArray(row) ? row.slice(0, 8).map((cell) => clean(cell, 160)) : []))
        },
        notes: clean(slide.notes, 2000)
      });
      continue;
    }
    const bullets = bulletList(slide.bullets);
    if (!bullets.length) continue;
    slides.push({
      layout: 'content',
      title: clean(slide.title, 200),
      bullets,
      notes: clean(slide.notes, 2000)
    });
  }
  return { title, subtitle, slides };
}

function fallbackOutline(brief, title) {
  const subject = clean(title, 120) || clean(brief, 120) || 'Propuesta ejecutiva';
  return {
    title: subject,
    subtitle: 'Síntesis ejecutiva para decisión',
    slides: [
      { layout: 'cover', title: subject, subtitle: 'Síntesis ejecutiva · Agenda Copilot' },
      { layout: 'section', title: 'Contexto', subtitle: 'Dónde estamos y por qué importa' },
      { layout: 'content', title: 'El reto', bullets: ['La situación actual exige una decisión concreta.', 'Hay oportunidades y riesgos que conviene separar.', 'El objetivo es avanzar con evidencia y sin abrir frentes innecesarios.'] },
      { layout: 'content', title: 'Propuesta', bullets: ['Un plan por fases con entregables verificables.', 'Responsables y dependencias explícitas.', 'Criterios de aceptación antes de escalar.'] },
      { layout: 'table', title: 'Hoja de ruta', table: { headers: ['Fase', 'Entregable', 'Ventana'], rows: [['1. Diagnóstico', 'Línea base y decisiones', 'Semana 1'], ['2. Piloto', 'Primer entregable validado', 'Semanas 2-3'], ['3. Escala', 'Operación y métricas', 'Semana 4']] } },
      { layout: 'content', title: 'Indicadores', bullets: ['Resultado principal y métrica de adopción.', 'Calidad y trazabilidad de la evidencia.', 'Coste, tiempo y riesgos residuales.'] },
      { layout: 'content', title: 'Riesgos y mitigación', bullets: ['Dependencia de datos incompletos.', 'Cambios de alcance sin control.', 'Capacidad limitada en la ventana crítica.'] },
      { layout: 'content', title: 'Decisión solicitada', bullets: ['Aprobar el piloto y su presupuesto acotado.', 'Nombrar responsable y fecha de revisión.', 'Autorizar solo la siguiente fase.'] }
    ]
  };
}

function outlinePrompt(brief, { title, audience, style, slideCount, preset }) {
  const tone = preset?.llmStyle || style || 'ejecutivo';
  const composition = preset
    ? `${preset.label} (${preset.description})`
    : 'ejecutivo sobrio';
  return `Diseña una presentación ejecutiva de altísima calidad para Héctor Fabio Riascos C.
Devuelve SOLO JSON válido, sin markdown ni explicaciones:
{"title":"...","subtitle":"...","slides":[
 {"layout":"cover","title":"...","subtitle":"...","notes":"..."},
 {"layout":"section","title":"...","subtitle":"...","notes":"..."},
 {"layout":"content","title":"...","bullets":["...","..."],"notes":"..."},
 {"layout":"table","title":"...","table":{"headers":["..."],"rows":[["..."]]},"notes":"..."}
]}
Reglas:
- Entre 8 y 12 diapositivas; la primera es portada.
- Tono ${tone}, audiencia ${audience || 'dirección'}.
- Composición visual: ${composition}. Aprovecha la portada y usa secciones para separar bloques.
- Cada content tiene 3-5 viñetas breves, concretas, sin relleno.
- Incluye una tabla de hoja de ruta o indicadores.
- Cada diapositiva lleva notes para el orador.
- No inventes cifras, fuentes ni compromisos. Si faltan datos, usa “[dato por confirmar]”.
- El objetivo es que el CEO pueda decidir, no leer un documento.
Brief del usuario: ${wrapUserData(brief, 6000)}
Título de trabajo: ${clean(title, 200) || '(propón uno)'}
Número objetivo de diapositivas: ${slideCount || 10}`;
}

/**
 * Genera una presentación PPTX y devuelve también el guion para previsualizar.
 */
export async function generatePresentation(input = {}) {
  const brief = clean(input.brief, 6000);
  if (brief.length < 10) throw new HttpError(400, 'SLIDES_BRIEF_REQUIRED', 'Escribe un brief de al menos 10 caracteres.');
  const title = clean(input.title, 200);
  const audience = clean(input.audience, 200);
  const style = clean(input.style, 40) || 'ejecutivo';
  const presetId = normalizePresetName(input.preset || style) || 'ejecutivo';
  const preset = resolvePreset(presetId);
  const slideCount = Math.min(12, Math.max(6, Number(input.slideCount) || 10));
  let outline = null;
  let provider = null;
  let model = null;
  let fallback = true;
  try {
    const result = await llmComplete({
      profile: 'chat',
      messages: [
        { role: 'system', content: 'Eres director creativo de presentaciones ejecutivas. Respetas los hechos y no inventas datos. Respondes JSON válido.' },
        { role: 'user', content: outlinePrompt(brief, { title, audience, style, slideCount, preset }) }
      ],
      json: true,
      fallback: null,
      scope: 'studio:slides',
      workflow: 'slides',
      maxTokens: 3500,
      deadlineMs: 60_000
    });
    provider = result.provider || null;
    model = result.model || null;
    outline = result.ok && result.text ? extractJson(result.text) : null;
    fallback = !outline;
  } catch {
    fallback = true;
  }
  const normalized = normalizeOutline(outline, brief);
  if (!normalized.slides.length) Object.assign(normalized, fallbackOutline(brief, title));
  if (normalized.slides[0]?.layout !== 'cover') {
    normalized.slides.unshift({
      layout: 'cover',
      title: normalized.title,
      subtitle: normalized.subtitle,
      notes: ''
    });
  }
  if (normalized.slides.length > MAX_SLIDES) normalized.slides.length = MAX_SLIDES;
  const doc = await createDocument({
    type: 'pptx',
    title: normalized.title,
    subtitle: normalized.subtitle,
    author: 'Héctor Fabio Riascos C.',
    subject: brief.slice(0, 300),
    preset: presetId,
    slides: normalized.slides
  });
  const visual = presetSummary(presetId);
  const preview = buildCoverPreview(presetId, {
    title: normalized.slides[0]?.layout === 'cover' ? normalized.slides[0].title : normalized.title,
    subtitle: normalized.slides[0]?.layout === 'cover' ? normalized.slides[0].subtitle : normalized.subtitle
  });
  const slides = normalized.slides.map((slide, index) => ({
    ...slide,
    preset: presetId,
    ...(index === 0 && visual ? { visual } : {})
  }));
  return {
    ok: true,
    fallback,
    provider,
    model,
    preset: presetId,
    visual,
    preview,
    title: normalized.title,
    subtitle: normalized.subtitle,
    slides,
    doc,
    downloadUrl: doc.id ? `/api/docs/${doc.id}/download` : null
  };
}

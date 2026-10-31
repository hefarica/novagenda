/**
 * Rutas de research web (t25).
 *
 *   POST   /api/research/fetch              descarga + extrae una URL
 *   POST   /api/research/report             informe con fuentes citadas
 *   GET    /api/research/sources?limit=     fuentes persistidas
 *   DELETE /api/research/sources/:id
 *   GET    /api/research/reports?limit=     informes persistidos
 *   GET    /api/research/reports/:id
 *   GET    /api/research/reports/:id/markdown
 *   GET    /api/research/status             límites y configuración
 */

import { store } from '../store.mjs';
import {
  bodyOf, itemEnvelope, listEnvelope, notFound, paramOf, queryInt, respond, route, sendError
} from '../agenda/http.mjs';
import { RESEARCH_LIMITS } from '../research/fetchSafe.mjs';
import { MAX_TEXT_CHARS } from '../research/extract.mjs';
import { REPORT_LIMITS, createResearchReport, fetchResearchSource } from '../research/report.mjs';
import { deleteSource, getReport, listReports, listSources, researchState } from '../research/state.mjs';

export const name = 'research';
export const priority = 100;

async function fetchRoute(ctx) {
  const body = await bodyOf(ctx);
  const url = body.url || body.href || body.link;
  if (!url) return respond(ctx, 400, { error: 'url es requerido', code: 'VALIDATION', field: 'url', requestId: ctx.requestId });
  try {
    const result = await fetchResearchSource({ url, save: body.save !== false });
    return respond(ctx, 200, result);
  } catch (error) {
    return sendError(ctx, error);
  }
}

async function reportRoute(ctx) {
  const body = await bodyOf(ctx);
  try {
    const result = await createResearchReport({
      question: body.question,
      urls: body.urls || body.url,
      maxSources: body.maxSources,
      useLlm: body.useLlm !== false,
      attachDocument: body.attachDocument !== false,
      emailTo: body.emailTo || body.recipients || body.sendTo,
      actor: 'research'
    });
    return respond(ctx, 200, result);
  } catch (error) {
    return sendError(ctx, error);
  }
}

function sourcesRoute(ctx) {
  const data = store.get();
  const limit = queryInt(ctx, 'limit', 50, { min: 1, max: 200 });
  const result = listSources(data, { limit });
  return respond(ctx, 200, listEnvelope(result.items, { total: result.total }));
}

async function sourceDeleteRoute(ctx) {
  const id = paramOf(ctx, 'id');
  let removed = null;
  await store.mutate((data) => { removed = deleteSource(data, id); });
  if (!removed) return notFound(ctx, `No encontré la fuente ${id}`);
  return respond(ctx, 200, { ok: true, item: removed });
}

function reportsRoute(ctx) {
  const data = store.get();
  const limit = queryInt(ctx, 'limit', 20, { min: 1, max: 50 });
  const result = listReports(data, { limit });
  return respond(ctx, 200, listEnvelope(result.items, { total: result.total }));
}

function reportGetRoute(ctx) {
  const report = getReport(store.get(), paramOf(ctx, 'id'));
  if (!report) return notFound(ctx, `No encontré el informe ${paramOf(ctx, 'id')}`);
  return respond(ctx, 200, itemEnvelope(report));
}

function reportMarkdownRoute(ctx) {
  const report = getReport(store.get(), paramOf(ctx, 'id'));
  if (!report) return notFound(ctx, `No encontré el informe ${paramOf(ctx, 'id')}`);
  const filename = `informe-${String(report.id || 'research').replace(/[^A-Za-z0-9_-]/g, '_')}.md`;
  const body = String(report.markdown || report.answer || '');
  if (typeof ctx.text === 'function') {
    return ctx.text(200, body, 'text/markdown; charset=utf-8', {
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff'
    });
  }
  return respond(ctx, 200, { item: report, markdown: body, filename });
}

function statusRoute(ctx) {
  const data = store.get();
  const research = researchState(data);
  return respond(ctx, 200, {
    item: {
      limits: {
        maxBytes: RESEARCH_LIMITS.maxBytes,
        maxRedirects: RESEARCH_LIMITS.maxRedirects,
        timeoutMs: RESEARCH_LIMITS.timeoutMs,
        maxTextChars: MAX_TEXT_CHARS,
        maxSources: REPORT_LIMITS.maxSources,
        defaultSources: REPORT_LIMITS.defaultSources
      },
      sources: research.sources.length,
      reports: research.reports.length,
      searchProvider: null,
      searchProviderNote: 'No se usa un buscador por defecto: se aceptan URLs explícitas; un proveedor se puede conectar después.',
      llmConfigured: Boolean(process.env.OPENAI_API_KEY || process.env.OLLAMA_URL || process.env.OPENAI_BASE_URL)
    }
  });
}

export const routes = [
  { method: 'POST', path: '/api/research/fetch', name: 'research.fetch', handler: route(fetchRoute) },
  { method: 'POST', path: '/api/research/report', name: 'research.report', handler: route(reportRoute) },
  { method: 'GET', path: '/api/research/sources', name: 'research.sources.list', handler: route(sourcesRoute) },
  { method: 'DELETE', path: '/api/research/sources/:id', name: 'research.sources.delete', handler: route(sourceDeleteRoute) },
  { method: 'GET', path: '/api/research/reports', name: 'research.reports.list', handler: route(reportsRoute) },
  { method: 'GET', path: '/api/research/reports/:id', name: 'research.reports.get', handler: route(reportGetRoute) },
  { method: 'GET', path: '/api/research/reports/:id/markdown', name: 'research.reports.markdown', handler: route(reportMarkdownRoute) },
  { method: 'GET', path: '/api/research/status', name: 'research.status', handler: route(statusRoute) }
];

export default { name, priority, routes };

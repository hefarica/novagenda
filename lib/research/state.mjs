/**
 * Estado persistente de research en el store (sin migración de esquema):
 *
 *   data.research = {
 *     sources: [{ id, url, finalUrl, title, author, publishedAt, language,
 *                 siteName, excerpt, links, contentType, bytes, retrievedAt }],
 *     reports: [{ id, question, answer, markdown, sources, citations, usedLlm,
 *                 createdAt, documentId, proposalId }]
 *   }
 *
 * Se crea de forma perezosa al primer uso; el resto del store no cambia.
 */

import { nextId } from '../store.mjs';

export const RESEARCH_LIMITS = Object.freeze({
  maxSourcesStored: 200,
  maxReportsStored: 50,
  maxExcerptChars: 1200
});

export function ensureResearchState(data) {
  if (!data.research || typeof data.research !== 'object' || Array.isArray(data.research)) data.research = {};
  if (!Array.isArray(data.research.sources)) data.research.sources = [];
  if (!Array.isArray(data.research.reports)) data.research.reports = [];
  return data.research;
}

export function researchState(data) {
  if (!data?.research || typeof data.research !== 'object') return { sources: [], reports: [] };
  return {
    sources: Array.isArray(data.research.sources) ? data.research.sources : [],
    reports: Array.isArray(data.research.reports) ? data.research.reports : []
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Guarda/actualiza una fuente (idempotente por URL original).
 * Debe llamarse dentro de `store.mutate`.
 */
export function saveSource(data, { url, finalUrl, extraction, contentType, bytes, status = 200 } = {}) {
  const research = ensureResearchState(data);
  const storedUrl = String(url || finalUrl || '').trim();
  const existing = research.sources.find((source) => source.url === storedUrl || (finalUrl && source.finalUrl === finalUrl));
  const record = {
    id: existing?.id || nextId('RS', research.sources),
    url: storedUrl,
    finalUrl: finalUrl || storedUrl,
    title: String(extraction?.title || '').slice(0, 300),
    author: String(extraction?.author || '').slice(0, 200),
    publishedAt: String(extraction?.publishedAt || '').slice(0, 100),
    language: String(extraction?.language || '').slice(0, 10),
    siteName: String(extraction?.siteName || '').slice(0, 120),
    excerpt: String(extraction?.excerpt || '').slice(0, RESEARCH_LIMITS.maxExcerptChars),
    links: Array.isArray(extraction?.links) ? extraction.links.slice(0, 100).map((link) => ({ ...link })) : [],
    contentType: String(contentType || extraction?.contentType || '').slice(0, 100),
    bytes: Number.isFinite(Number(bytes)) ? Number(bytes) : null,
    status: Number.isFinite(Number(status)) ? Number(status) : 200,
    retrievedAt: nowIso(),
    createdAt: existing?.createdAt || nowIso()
  };
  if (existing) Object.assign(existing, record);
  else research.sources.unshift(record);
  research.sources.sort((a, b) => String(b.retrievedAt).localeCompare(String(a.retrievedAt)));
  if (research.sources.length > RESEARCH_LIMITS.maxSourcesStored) research.sources = research.sources.slice(0, RESEARCH_LIMITS.maxSourcesStored);
  return existing || record;
}

export function listSources(data, { limit = 50 } = {}) {
  const research = researchState(data);
  const size = Math.max(1, Math.min(RESEARCH_LIMITS.maxSourcesStored, Number(limit) || 50));
  return {
    items: research.sources.slice(0, size),
    total: research.sources.length
  };
}

export function getSource(data, id) {
  return researchState(data).sources.find((source) => String(source.id).toLowerCase() === String(id).toLowerCase()) || null;
}

export function deleteSource(data, id) {
  const research = ensureResearchState(data);
  const index = research.sources.findIndex((source) => String(source.id).toLowerCase() === String(id).toLowerCase());
  if (index < 0) return null;
  const [removed] = research.sources.splice(index, 1);
  return removed;
}

export function saveReport(data, report) {
  const research = ensureResearchState(data);
  const record = {
    id: report.id || nextId('RP', research.reports),
    question: String(report.question || '').slice(0, 500),
    answer: String(report.answer || '').slice(0, 80_000),
    markdown: String(report.markdown || report.answer || '').slice(0, 80_000),
    sources: Array.isArray(report.sources) ? report.sources.map((source) => ({ ...source })) : [],
    citations: Array.isArray(report.citations) ? [...report.citations] : [],
    usedLlm: report.usedLlm === true,
    provider: report.provider || null,
    model: report.model || null,
    createdAt: report.createdAt || nowIso(),
    documentId: report.documentId || null,
    proposalId: report.proposalId || null,
    errors: Array.isArray(report.errors) ? report.errors.slice(0, 20) : []
  };
  research.reports.unshift(record);
  if (research.reports.length > RESEARCH_LIMITS.maxReportsStored) research.reports = research.reports.slice(0, RESEARCH_LIMITS.maxReportsStored);
  return record;
}

export function getReport(data, id) {
  return researchState(data).reports.find((report) => String(report.id).toLowerCase() === String(id).toLowerCase()) || null;
}

export function listReports(data, { limit = 20 } = {}) {
  const reports = researchState(data).reports;
  return { items: reports.slice(0, Math.max(1, Math.min(50, Number(limit) || 20))), total: reports.length };
}

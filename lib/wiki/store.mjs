/**
 * Wiki interna de la oficina: memoria escrita consultable.
 *
 * Vive en `data.wiki.pages` (clave nueva, viaja en backup/restore). Cada
 * mutación recalcula `updatedAt`; los IDs son estables `WK-0001`.
 */
import { store } from '../store.mjs';
import { ValidationError, HttpError } from '../http/errors.mjs';

export const MAX_PAGES = 500;
export const MAX_BODY = 50_000;
const MAX_TITLE = 160;
const MAX_TAGS = 12;

function nowIso() {
  return new Date().toISOString();
}

export function ensureWiki(data) {
  if (!data.wiki || typeof data.wiki !== 'object' || !Array.isArray(data.wiki.pages)) {
    data.wiki = { version: 1, pages: [], updatedAt: nowIso() };
  }
  return data.wiki;
}

/** @param {any} page */
export function publicPage(page, { withBody = true } = {}) {
  const body = String(page.body || '');
  return {
    id: page.id,
    title: page.title,
    ...(withBody ? { body } : { bodyPreview: body.slice(0, 240) }),
    tags: Array.isArray(page.tags) ? [...page.tags] : [],
    words: body ? body.trim().split(/\s+/).length : 0,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt
  };
}

function normalizeTags(tags) {
  const source = Array.isArray(tags)
    ? tags
    : String(tags || '').split(',');
  const clean = [];
  for (const raw of source) {
    const tag = String(raw || '').trim().replace(/^#/, '').slice(0, 30);
    if (!tag) continue;
    if (!clean.some((item) => item.toLowerCase() === tag.toLowerCase())) clean.push(tag);
    if (clean.length >= MAX_TAGS) break;
  }
  return clean.sort((a, b) => a.localeCompare(b));
}

function validateTitle(value) {
  const title = String(value ?? '').trim();
  if (!title) throw new ValidationError('title', 'REQUIRED', 'El título es obligatorio.');
  if (title.length > MAX_TITLE) throw new ValidationError('title', 'TOO_LONG', `El título supera ${MAX_TITLE} caracteres.`);
  return title;
}

function validateBody(value) {
  const body = String(value ?? '');
  if (!body.trim()) throw new ValidationError('body', 'REQUIRED', 'El contenido es obligatorio.');
  if (body.length > MAX_BODY) throw new ValidationError('body', 'TOO_LONG', `El contenido supera ${MAX_BODY} caracteres.`);
  return body;
}

function nextId(pages) {
  let max = 0;
  for (const page of pages) {
    const match = /^WK-(\d+)$/i.exec(String(page.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `WK-${String(max + 1).padStart(4, '0')}`;
}

export function getPage(id) {
  const wiki = ensureWiki(store.get());
  const page = wiki.pages.find((item) => item.id === id);
  return page ? publicPage(page) : null;
}

export function listPages({ q = '', tag = '', limit = 50, offset = 0 } = {}) {
  const wiki = ensureWiki(store.get());
  const needle = String(q || '').trim().toLowerCase();
  const tagNeedle = String(tag || '').trim().toLowerCase();
  let rows = wiki.pages.filter((page) => {
    if (tagNeedle && !(page.tags || []).some((item) => String(item).toLowerCase() === tagNeedle)) return false;
    if (!needle) return true;
    const haystack = `${page.title}\n${page.body}\n${(page.tags || []).join(' ')}`.toLowerCase();
    return haystack.includes(needle);
  });
  rows = rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const total = rows.length;
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);
  return {
    items: rows.slice(skip, skip + size).map((page) => publicPage(page, { withBody: false })),
    total,
    count: Math.min(size, Math.max(0, total - skip))
  };
}

export function wikiStats() {
  const wiki = ensureWiki(store.get());
  const pages = wiki.pages.length;
  const words = wiki.pages.reduce((sum, page) => sum + (String(page.body || '').trim().split(/\s+/).length || 0), 0);
  const tags = [...new Set(wiki.pages.flatMap((page) => page.tags || []))].sort();
  return { pages, words, tags: tags.slice(0, 30), updatedAt: wiki.updatedAt || null };
}

export async function createPage({ title, body, tags = [] } = {}) {
  const cleanTitle = validateTitle(title);
  const cleanBody = validateBody(body);
  const cleanTags = normalizeTags(tags);
  let created = null;
  await store.mutate((current) => {
    const wiki = ensureWiki(current);
    if (wiki.pages.length >= MAX_PAGES) {
      throw new HttpError(409, 'WIKI_FULL', `La wiki alcanzó el máximo de ${MAX_PAGES} páginas.`);
    }
    const now = nowIso();
    const page = {
      id: nextId(wiki.pages),
      title: cleanTitle,
      body: cleanBody,
      tags: cleanTags,
      createdAt: now,
      updatedAt: now
    };
    wiki.pages.push(page);
    wiki.updatedAt = now;
    created = page;
  }, { label: 'wiki-create' });
  return publicPage(created);
}

export async function updatePage(id, { title, body, tags } = {}) {
  if (title === undefined && body === undefined && tags === undefined) {
    throw new ValidationError('body', 'EMPTY_PATCH', 'Indica al menos un campo para actualizar.');
  }
  let updated = null;
  await store.mutate((current) => {
    const wiki = ensureWiki(current);
    const page = wiki.pages.find((item) => item.id === id);
    if (!page) throw new HttpError(404, 'NOT_FOUND', `No existe la página ${id}.`);
    if (title !== undefined) page.title = validateTitle(title);
    if (body !== undefined) page.body = validateBody(body);
    if (tags !== undefined) page.tags = normalizeTags(tags);
    page.updatedAt = nowIso();
    wiki.updatedAt = page.updatedAt;
    updated = page;
  }, { label: 'wiki-update' });
  return publicPage(updated);
}

export async function deletePage(id) {
  let removed = null;
  await store.mutate((current) => {
    const wiki = ensureWiki(current);
    const index = wiki.pages.findIndex((item) => item.id === id);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `No existe la página ${id}.`);
    removed = wiki.pages.splice(index, 1)[0];
    wiki.updatedAt = nowIso();
  }, { label: 'wiki-delete' });
  return publicPage(removed, { withBody: false });
}

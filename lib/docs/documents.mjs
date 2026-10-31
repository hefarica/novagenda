/**
 * Almacén de documentos generados.
 *
 * Estructura en disco (fuera de git, dentro de DATA_DIR):
 *   DATA_DIR/docs/index.json       metadatos (sin rutas absolutas)
 *   DATA_DIR/docs/<ID>.<ext>       archivo binario real
 *
 * El nombre visible (`filename`) se usa solo en `Content-Disposition`; en disco
 * siempre se guarda como `<ID>.<ext>`, de modo que ningún título puede escapar
 * del directorio. Las escrituras del índice y de los archivos son atómicas y
 * serializadas para evitar carreras entre generaciones simultáneas.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/errors.mjs';
import { log } from '../http/logger.mjs';
import { buildFilename, dateKey, isoUtc, slugify } from './ooxml.mjs';
import { canonicalDocumentTitle } from '../style/lingo.mjs';
import { docsDir, docsIndexFile, ensureDocsDir, resolveInside, writeFileAtomic } from './paths.mjs';
import { createZip } from './zip.mjs';

export const DOC_MIME = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
});

export const DOC_EXTENSION = Object.freeze({ docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' });

export const MAX_DOCUMENTS = 200;
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

const ID_RE = /^DOC-\d{8}-[a-f0-9]{8}$/;

let indexCache = null;
let writeQueue = Promise.resolve();

function withLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function emptyIndex() {
  return { version: 1, items: [] };
}

function versionKeyOf(value) {
  return String(value || 'documento').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 200);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const type = String(raw.type || '').toLowerCase();
  if (!ID_RE.test(id) || !DOC_MIME[type]) return null;
  const storedAs = String(raw.storedAs || `${id}.${DOC_EXTENSION[type]}`);
  if (!storedAs.startsWith(`${id}.`)) return null;
  return {
    id,
    type,
    title: String(raw.title || 'Documento').slice(0, 200),
    filename: String(raw.filename || `${slugify(raw.title || 'documento')}.${DOC_EXTENSION[type]}`).slice(0, 180),
    storedAs,
    bytes: Math.max(0, Number(raw.bytes) || 0),
    sha256: String(raw.sha256 || ''),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    template: raw.template ? String(raw.template) : null,
    versionKey: String(raw.versionKey || versionKeyOf(raw.title) || 'documento').slice(0, 200)
  };
}

/**
 * Carga el índice (con recuperación ante JSON corrupto).
 * @returns {{version:number, items:any[]}}
 */
export function loadIndex() {
  if (indexCache) return indexCache;
  ensureDocsDir();
  const file = docsIndexFile();
  if (!fs.existsSync(file)) {
    indexCache = emptyIndex();
    return indexCache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('estructura inválida');
    indexCache = { version: 1, items: parsed.items.map(normalizeItem).filter(Boolean) };
    return indexCache;
  } catch (error) {
    const backup = `${file}.corrupt-${dateKey(new Date())}-${Date.now()}.json`;
    try { fs.renameSync(file, backup); } catch { /* no se pudo preservar: se sigue */ }
    log('warn', `Índice de documentos corrupto; se conserva una copia en ${path.basename(backup)}.`);
    indexCache = emptyIndex();
    return indexCache;
  }
}

function saveIndex(index) {
  writeFileAtomic(docsIndexFile(), `${JSON.stringify({ version: 1, items: index.items }, null, 2)}\n`);
  indexCache = index;
}

function indexEntries() {
  return loadIndex().items;
}

function totalBytes(items = indexEntries()) {
  return items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
}

/**
 * Metadatos públicos de un documento (sin ruta en disco).
 * @param {any} item
 * @param {{checkMissing?:boolean}} [options]
 */
export function publicDocument(item, options = {}) {
  if (!item) return null;
  const result = {
    id: item.id,
    type: item.type,
    title: item.title,
    filename: item.filename,
    mimeType: DOC_MIME[item.type],
    bytes: item.bytes,
    sha256: item.sha256 || null,
    createdAt: item.createdAt,
    template: item.template || null,
    downloadUrl: `/api/docs/${item.id}/download`
  };
  if (options.checkMissing) {
    try {
      result.missing = !fs.existsSync(storedPath(item));
    } catch {
      result.missing = true;
    }
  }
  return result;
}

function storedPath(item) {
  return resolveInside(docsDir(), item.storedAs);
}

function matchQuery(item, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const haystack = `${item.title} ${item.filename}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return haystack.includes(needle);
}

/**
 * Lista documentos (paginado, más recientes primero).
 * @param {{type?:string, q?:string, limit?:number, offset?:number}} [options]
 */
export function listDocuments(options = {}) {
  const index = loadIndex();
  const type = options.type ? String(options.type).toLowerCase() : '';
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  let items = index.items.slice();
  if (type) items = items.filter((item) => item.type === type);
  if (options.q) items = items.filter((item) => matchQuery(item, options.q));
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const total = items.length;
  const page = items.slice(offset, offset + limit).map((item) => publicDocument(item, { checkMissing: true }));
  return { items: page, count: page.length, total, limit, offset };
}

/**
 * Busca un documento por id.
 * @param {string} id
 */
export function getDocument(id) {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) return null;
  return publicDocument(indexEntries().find((item) => item.id === key) || null, { checkMissing: true });
}

function rawDocument(id) {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) throw new HttpError(404, 'DOC_NOT_FOUND', 'Documento no encontrado.', { field: 'id' });
  const item = indexEntries().find((entry) => entry.id === key);
  if (!item) throw new HttpError(404, 'DOC_NOT_FOUND', `No existe el documento ${key}.`, { field: 'id' });
  return item;
}

/**
 * Lee un documento completo.
 *
 * Devuelve la metadata pública aplanada (`id`, `type`, `filename`, `mimeType`,
 * `bytes`, `downloadUrl`, …) **más** `item` (registro interno) y `buffer`
 * (contenido binario), para que otros módulos puedan usarlo sin conocer el
 * índice:
 *
 *   const { filename, mimeType, buffer } = readDocument(id);
 *
 * @param {string} id
 * @returns {{id:string,type:string,title:string,filename:string,mimeType:string,bytes:number,createdAt:string,buffer:Buffer,item:any,downloadUrl:string}}
 */
export function readDocument(id) {
  const item = rawDocument(id);
  const file = storedPath(item);
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HttpError(404, 'DOC_FILE_MISSING', `El archivo del documento ${item.id} ya no está en disco.`, { field: 'id' });
    }
    throw error;
  }
  return { ...publicDocument(item), item, buffer };
}

function newId(existing) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `DOC-${dateKey(new Date()).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
    if (!existing.has(id) && !fs.existsSync(path.join(docsDir(), `${id}.docx`)) && !fs.existsSync(path.join(docsDir(), `${id}.xlsx`)) && !fs.existsSync(path.join(docsDir(), `${id}.pptx`))) {
      return id;
    }
  }
  throw new HttpError(500, 'DOC_ID_ERROR', 'No se pudo asignar un identificador único al documento.');
}

/**
 * Guarda un documento ya renderizado.
 * @param {{type:'docx'|'xlsx'|'pptx', title:string, buffer:Buffer, date?:Date, template?:string|null, now?:Date}} input
 */
export async function saveGeneratedDocument(input) {
  const type = String(input.type || '').toLowerCase();
  if (!DOC_MIME[type]) throw new HttpError(400, 'VALIDATION', 'Tipo de documento no válido.', { field: 'type' });
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer || '');
  if (!buffer.length) throw new HttpError(500, 'DOC_EMPTY', 'El documento generado está vacío.');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, 'DOC_TOO_LARGE', `El documento supera el máximo de ${MAX_DOCUMENT_BYTES} bytes.`);
  }
  const now = input.now instanceof Date ? input.now : new Date();
  const title = String(input.title || 'Documento').slice(0, 200);
  const date = input.date instanceof Date ? input.date : now;

  return withLock(async () => {
    const index = loadIndex();
    if (index.items.length >= MAX_DOCUMENTS) {
      throw new HttpError(409, 'DOC_LIMIT', `Se alcanzó el máximo de ${MAX_DOCUMENTS} documentos; elimina alguno antes de crear otro.`);
    }
    if (totalBytes(index.items) + buffer.length > MAX_TOTAL_BYTES) {
      throw new HttpError(409, 'DOC_STORAGE_LIMIT', 'El almacenamiento de documentos está lleno; elimina documentos antiguos.');
    }
    const existing = new Set(index.items.map((item) => item.id));
    const id = newId(existing);
    const extension = DOC_EXTENSION[type];
    let filename = buildFilename(canonicalDocumentTitle(title), extension, { date });
    const usedNames = new Set(index.items.map((item) => item.filename.toLowerCase()));
    if (usedNames.has(filename.toLowerCase())) {
      filename = filename.replace(new RegExp(`\\.${extension}$`), `-${id.slice(-4)}.${extension}`);
    }
    const item = {
      id,
      type,
      title,
      filename,
      storedAs: `${id}.${extension}`,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      createdAt: now.toISOString(),
      template: input.template ? String(input.template) : null,
      versionKey: versionKeyOf(title)
    };
    const file = storedPath(item);
    writeFileAtomic(file, buffer);
    try {
      const items = [item, ...index.items];
      saveIndex({ version: 1, items });
    } catch (error) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      throw error;
    }
    return publicDocument(item);
  });
}

/**
 * Elimina un documento y su archivo.
 * @param {string} id
 */
/**
 * Historial de versiones: documentos existentes con el mismo título
 * (comparación sin mayúsculas ni espacios extra), del más nuevo al más viejo.
 * @param {string} id
 */
export function documentVersions(id) {
  const target = rawDocument(id);
  const key = target.versionKey || versionKeyOf(target.title);
  const items = indexEntries()
    .filter((item) => (item.versionKey || versionKeyOf(item.title)) === key)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((item) => publicDocument(item, { checkMissing: true }));
  return { title: target.title, count: items.length, items };
}

export async function renameDocument(id, title) {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) throw new HttpError(404, 'DOC_NOT_FOUND', 'Documento no encontrado.', { field: 'id' });
  const clean = String(title || '').trim().slice(0, 200);
  if (!clean) throw new HttpError(400, 'DOC_TITLE_REQUIRED', 'El título no puede estar vacío.', { field: 'title' });
  return withLock(async () => {
    const index = loadIndex();
    const item = index.items.find((entry) => entry.id === key);
    if (!item) throw new HttpError(404, 'DOC_NOT_FOUND', `No existe el documento ${key}.`, { field: 'id' });
    const extension = DOC_EXTENSION[item.type];
    let filename = buildFilename(canonicalDocumentTitle(clean), extension, { date: new Date(item.createdAt) });
    const usedNames = new Set(index.items.filter((entry) => entry.id !== key).map((entry) => entry.filename.toLowerCase()));
    if (usedNames.has(filename.toLowerCase())) {
      filename = filename.replace(new RegExp(`\\.${extension}$`), `-${key.slice(-4)}.${extension}`);
    }
    item.title = clean;
    item.filename = filename;
    saveIndex({ version: 1, items: index.items });
    return publicDocument(item);
  });
}

export function documentsArchive() {
  const items = indexEntries();
  const entries = [];
  const used = new Set();
  let missing = 0;
  for (const item of items) {
    let buffer;
    try {
      buffer = fs.readFileSync(storedPath(item));
    } catch (error) {
      if (error.code === 'ENOENT') { missing += 1; continue; }
      throw error;
    }
    let name = String(item.filename || `${item.id}.${DOC_EXTENSION[item.type]}`);
    if (used.has(name.toLowerCase())) name = `${item.id}-${name}`;
    used.add(name.toLowerCase());
    entries.push({ name: `documentos/${name}`, data: buffer });
  }
  const buffer = createZip(entries);
  return { buffer, filename: `documentos-${dateKey(new Date())}.zip`, count: entries.length, missing };
}

export async function duplicateDocument(id) {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) throw new HttpError(404, 'DOC_NOT_FOUND', 'Documento no encontrado.', { field: 'id' });
  return withLock(async () => {
    const index = loadIndex();
    const source = index.items.find((item) => item.id === key);
    if (!source) throw new HttpError(404, 'DOC_NOT_FOUND', `No existe el documento ${key}.`, { field: 'id' });
    if (index.items.length >= MAX_DOCUMENTS) {
      throw new HttpError(409, 'DOC_LIMIT', `Se alcanzó el máximo de ${MAX_DOCUMENTS} documentos; elimina alguno antes de duplicar.`);
    }
    let buffer;
    try {
      buffer = fs.readFileSync(storedPath(source));
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(409, 'DOC_FILE_MISSING', 'El archivo original no está disponible; no se puede duplicar.');
      throw error;
    }
    if (totalBytes(index.items) + buffer.length > MAX_TOTAL_BYTES) {
      throw new HttpError(409, 'DOC_STORAGE_LIMIT', 'El almacenamiento de documentos está lleno; elimina documentos antes de duplicar.');
    }
    const now = new Date();
    const title = `${String(source.title || 'Documento').slice(0, 190)} (copia)`.slice(0, 200);
    const extension = DOC_EXTENSION[source.type];
    let filename = buildFilename(canonicalDocumentTitle(title), extension, { date: now });
    const usedNames = new Set(index.items.map((item) => item.filename.toLowerCase()));
    if (usedNames.has(filename.toLowerCase())) {
      filename = filename.replace(new RegExp('\\.' + extension + '$'), '-copia.' + extension);
    }
    const idNew = newId(new Set(index.items.map((item) => item.id)));
    const item = {
      id: idNew,
      type: source.type,
      title,
      filename,
      storedAs: `${idNew}.${extension}`,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      createdAt: now.toISOString(),
      template: source.template || null,
      versionKey: versionKeyOf(title)
    };
    const file = storedPath(item);
    writeFileAtomic(file, buffer);
    try {
      saveIndex({ version: 1, items: [item, ...index.items] });
    } catch (error) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      throw error;
    }
    return publicDocument(item);
  });
}

export async function deleteDocument(id) {
  const key = String(id || '').trim();
  if (!ID_RE.test(key)) throw new HttpError(404, 'DOC_NOT_FOUND', 'Documento no encontrado.', { field: 'id' });
  return withLock(async () => {
    const index = loadIndex();
    const position = index.items.findIndex((item) => item.id === key);
    if (position < 0) throw new HttpError(404, 'DOC_NOT_FOUND', `No existe el documento ${key}.`, { field: 'id' });
    const item = index.items[position];
    let removedFile = false;
    try {
      fs.unlinkSync(storedPath(item));
      removedFile = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const items = index.items.slice();
    items.splice(position, 1);
    saveIndex({ version: 1, items });
    return { ok: true, id: key, removed: true, removedFile, bytesFreed: item.bytes };
  });
}

/** Estadísticas del almacén. */
export function documentStats() {
  const items = indexEntries();
  return {
    count: items.length,
    bytes: totalBytes(items),
    maxDocuments: MAX_DOCUMENTS,
    maxDocumentBytes: MAX_DOCUMENT_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    byType: items.reduce((accumulator, item) => {
      accumulator[item.type] = (accumulator[item.type] || 0) + 1;
      return accumulator;
    }, {})
  };
}

/** Solo para pruebas: descarta la caché del índice. */
export function clearDocumentCache() {
  indexCache = null;
}

export { isoUtc };
export default {
  DOC_MIME,
  DOC_EXTENSION,
  listDocuments,
  getDocument,
  readDocument,
  saveGeneratedDocument,
  deleteDocument,
  documentStats,
  publicDocument,
  clearDocumentCache
};



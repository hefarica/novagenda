/**
 * Resolución de documentos para enviarlos como adjuntos por los canales.
 *
 * Fuentes, en orden:
 *   1. **Barrel de documentos** (`lib/docs/index.mjs`) → `readDocument(id)`.
 *      Es el contrato de t17: `{id, type, title, filename, mimeType, bytes, buffer}`.
 *   2. **Índice JSON** `DATA_DIR/docs/index.json` del propio módulo de documentos
 *      (mismo contrato de almacenamiento) y sus ficheros.
 *   3. **Proveedores registrados** con `registerDocumentProvider(fn)`.
 *   4. **Ficheros de la app** en `DATA_DIR/docs`, `DATA_DIR/office-documents`,
 *      `DATA_DIR/documents` o `DATA_DIR/docs-output` (por id o nombre).
 *
 * Nunca escribe en `lib/docs/**` ni en el almacén de documentos: solo lee.
 * El envío se hace con el adaptador del canal (Telegram/WhatsApp/correo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { store } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';
import { text } from '../validate.mjs';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
});

const EXTENSIONS = Object.freeze(['docx', 'xlsx', 'pptx', 'pdf', 'md', 'txt', 'csv', 'json', 'zip', 'png', 'jpg', 'jpeg']);

/** @type {Array<(docId:string, context:object)=>Promise<object|null>|object|null>} */
const providers = [];

/**
 * Registra una fuente adicional de documentos.
 * @param {(docId:string, context:object)=>Promise<object|null>|object|null} provider
 */
export function registerDocumentProvider(provider) {
  if (typeof provider !== 'function') throw new TypeError('El proveedor de documentos debe ser una función.');
  providers.push(provider);
  return () => {
    const index = providers.indexOf(provider);
    if (index >= 0) providers.splice(index, 1);
  };
}

/** Directorio de datos activo (mismo que usa el store). */
export function activeDataDir() {
  try {
    const status = store.status();
    if (status && status.dataDir) return path.resolve(status.dataDir);
  } catch { /* store aún no cargado */ }
  return path.resolve(process.env.DATA_DIR || './data');
}

/** @param {string} filename */
export function mimeFromFilename(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** Nombre seguro para adjuntar (sin rutas ni caracteres de control). */
export function safeFilename(value, fallback = 'documento') {
  const base = path.basename(String(value || fallback)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const clean = base.replace(/[\\/:*?"<>|]+/g, '_');
  return (clean || fallback).slice(0, 180);
}

function extensionOf(filename) {
  return String(filename || '').split('.').pop().toLowerCase();
}

/**
 * Normaliza cualquier documento de una fuente a la forma interna.
 * @param {any} source
 * @param {{id?:string, origin:string}} options
 */
function normalizeDocument(source, { id = null, origin } = {}) {
  if (!source || typeof source !== 'object') return null;
  let buffer = null;
  if (Buffer.isBuffer(source.buffer)) buffer = source.buffer;
  else if (Buffer.isBuffer(source.data)) buffer = source.data;
  else if (typeof source.base64 === 'string') buffer = Buffer.from(source.base64, 'base64');
  else if (typeof source.dataBase64 === 'string') buffer = Buffer.from(source.dataBase64, 'base64');
  else if (typeof source.contentBase64 === 'string') buffer = Buffer.from(source.contentBase64, 'base64');
  else if (typeof source.bytes === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(source.bytes) && source.bytes.length > 64) {
    buffer = Buffer.from(source.bytes, 'base64');
  } else if (typeof source.path === 'string') {
    buffer = readFileSafe(source.path);
  }
  if (!buffer || !buffer.length) return null;
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, 'DOC_TOO_LARGE', `El documento supera el máximo de ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`, { field: 'docId' });
  }
  const rawFilename = source.filename || source.fileName || source.name || source.file || (id ? `${id}.${source.type || 'docx'}` : 'documento');
  const filename = safeFilename(rawFilename);
  const mimeType = String(source.mimeType || source.mime || mimeFromFilename(filename)).slice(0, 120);
  return {
    id: String(source.id || id || '').slice(0, 120) || null,
    filename,
    mimeType,
    buffer,
    size: buffer.length,
    type: String(source.type || extensionOf(filename)).slice(0, 12),
    origin,
    downloadUrl: source.downloadUrl || null
  };
}

/** Lee un archivo con comprobación de tamaño. */
function readFileSafe(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size <= 0) return null;
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, 'DOC_TOO_LARGE', 'El documento supera el tamaño máximo permitido.', { field: 'docId' });
  }
  try { return fs.readFileSync(filePath); } catch { return null; }
}

/** Resuelve una ruta dentro de un directorio (anti traversal). */
function resolveInside(dir, filename) {
  const base = path.resolve(dir);
  const resolved = path.resolve(base, filename);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

/** Normaliza el índice de documentos de t17 a una lista de entradas. */
function indexEntries(index) {
  if (!index) return [];
  if (Array.isArray(index)) return index;
  if (Array.isArray(index.items)) return index.items;
  if (Array.isArray(index.documents)) return index.documents;
  if (index.items && typeof index.items === 'object' && !Array.isArray(index.items)) {
    return Object.entries(index.items).map(([id, entry]) => ({ id, ...(entry && typeof entry === 'object' ? entry : { filename: entry }) }));
  }
  if (typeof index === 'object') {
    return Object.entries(index)
      .filter(([, entry]) => entry && typeof entry === 'object')
      .map(([id, entry]) => ({ id, ...entry }));
  }
  return [];
}

function readDocsIndex(docsDir) {
  const file = path.join(docsDir, 'index.json');
  try {
    if (!fs.existsSync(file)) return [];
    return indexEntries(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

function documentFromIndexEntry(entry, docsDir, id) {
  const filename = safeFilename(entry.filename || entry.file || entry.name || `${id}.${entry.type || 'docx'}`);
  const candidates = [
    entry.path ? resolveInside(docsDir, entry.path) : null,
    entry.file ? resolveInside(docsDir, entry.file) : null,
    resolveInside(docsDir, filename),
    resolveInside(docsDir, `${id}.${entry.type || extensionOf(filename)}`)
  ].filter(Boolean);
  for (const candidate of candidates) {
    const buffer = readFileSafe(candidate);
    if (buffer) {
      return normalizeDocument({ ...entry, filename, buffer, id }, { id, origin: 'docs-index' });
    }
  }
  return null;
}

async function fromDocsBarrel(id) {
  let barrel;
  try {
    barrel = await import('../docs/index.mjs');
  } catch {
    return null;
  }
  if (!barrel || typeof barrel.readDocument !== 'function') return null;
  try {
    const doc = await barrel.readDocument(id);
    return normalizeDocument(doc, { id, origin: 'docs-barrel' });
  } catch (error) {
    // 404 = no existe en el almacén de documentos; se intentan otras fuentes.
    if (error?.status === 404 || error?.code === 'DOC_NOT_FOUND') return null;
    throw error;
  }
}

function fromStore(id) {
  const data = store.get();
  const collections = [data.documents, data.docs, data.office?.documents];
  for (const collection of collections) {
    if (!collection) continue;
    const entries = Array.isArray(collection)
      ? collection
      : typeof collection === 'object'
        ? Object.entries(collection).map(([key, value]) => (value && typeof value === 'object' ? { id: key, ...value } : null)).filter(Boolean)
        : [];
    const match = entries.find((entry) => entry && (String(entry.id) === id || String(entry.docId) === id));
    if (match) {
      const doc = normalizeDocument(match, { id, origin: 'store' });
      if (doc) return doc;
    }
  }
  return null;
}

function fromFilesystem(id) {
  const dataDir = activeDataDir();
  const docsDir = path.join(dataDir, 'docs');
  const directories = [docsDir, path.join(dataDir, 'office-documents'), path.join(dataDir, 'documents'), path.join(dataDir, 'docs-output')];
  // 1) Índice de documentos.
  const entries = readDocsIndex(docsDir);
  const entry = entries.find((item) => String(item.id || item.docId || '') === id || String(item.filename || '') === id);
  if (entry) {
    const doc = documentFromIndexEntry(entry, docsDir, id);
    if (doc) return doc;
  }
  // 2) Búsqueda directa por id o nombre de archivo.
  const safeId = safeFilename(id, '');
  for (const dir of directories) {
    if (!fs.existsSync(dir)) continue;
    const candidates = [];
    if (safeId) {
      candidates.push(path.join(dir, safeId));
      for (const ext of EXTENSIONS) candidates.push(path.join(dir, `${safeId}.${ext}`));
    }
    for (const candidate of candidates) {
      const resolved = resolveInside(dir, path.relative(dir, candidate));
      if (!resolved) continue;
      const buffer = readFileSafe(resolved);
      if (buffer) {
        const filename = safeFilename(path.basename(resolved));
        return normalizeDocument({ id, filename, buffer }, { id, origin: 'filesystem' });
      }
    }
    // Coincidencia por nombre exacto si el id ya trae extensión.
    if (safeId && extensionOf(safeId)) {
      const resolved = resolveInside(dir, safeId);
      const buffer = resolved ? readFileSafe(resolved) : null;
      if (buffer) return normalizeDocument({ id, filename: safeId, buffer }, { id, origin: 'filesystem' });
    }
  }
  return null;
}

/**
 * Resuelve un documento por id.
 * @param {string} docId
 * @returns {Promise<{id:string, filename:string, mimeType:string, buffer:Buffer, size:number, type:string, origin:string, downloadUrl:string|null}>}
 */
export async function resolveDocument(docId) {
  const id = text(docId, { field: 'docId', required: true, max: 160, allowEmpty: false });
  const sources = [
    () => fromDocsBarrel(id),
    () => fromStore(id),
    () => fromFilesystem(id)
  ];
  for (const source of sources) {
    const doc = await source();
    if (doc) return doc;
  }
  for (const provider of providers) {
    try {
      const provided = await provider(id, { dataDir: activeDataDir() });
      const doc = normalizeDocument(provided, { id, origin: 'provider' });
      if (doc) return doc;
    } catch (error) {
      if (error?.status === 404) continue;
      throw error;
    }
  }
  throw new HttpError(404, 'DOC_NOT_FOUND', `No encontré el documento ${id}.`, {
    field: 'docId',
    details: { sources: ['lib/docs/index.mjs', 'DATA_DIR/docs/index.json', 'store', 'DATA_DIR/*'] }
  });
}

/**
 * Construye un documento inline (para pruebas o integraciones que ya tienen
 * los bytes) validando nombre, mime y tamaño.
 * @param {{filename?:string, mimeType?:string, base64?:string}} input
 */
export function documentFromInline(input = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError('body', 'INVALID_BODY', 'Se espera un objeto con filename/base64.');
  const filename = safeFilename(text(input.filename, { field: 'filename', required: true, max: 180, allowEmpty: false }));
  if (typeof input.base64 !== 'string' || !input.base64.trim()) {
    throw new ValidationError('base64', 'REQUIRED', 'Falta el contenido base64 del documento.');
  }
  const buffer = Buffer.from(input.base64, 'base64');
  if (!buffer.length) throw new ValidationError('base64', 'INVALID_FORMAT', 'El contenido base64 está vacío o es inválido.');
  const doc = normalizeDocument({ filename, mimeType: input.mimeType, buffer }, { id: null, origin: 'inline' });
  return doc;
}

/** Diagnóstico sin secretos para la UI. */
export function documentsStatus() {
  const dataDir = activeDataDir();
  return {
    dataDir,
    docsDir: path.join(dataDir, 'docs'),
    providers: providers.length,
    maxBytes: MAX_DOCUMENT_BYTES,
    extensions: EXTENSIONS
  };
}

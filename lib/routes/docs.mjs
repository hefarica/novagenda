/**
 * Rutas de documentos ofimáticos reales (DOCX/XLSX/PPTX).
 *
 *   POST   /api/docs                          crear (y guardar) un documento
 *   GET    /api/docs                          listar documentos
 *   GET    /api/docs/:id                      metadatos de un documento
 *   GET    /api/docs/:id/download             binario con Content-Disposition
 *   DELETE /api/docs/:id                      eliminar documento y archivo
 *   POST   /api/docs/:id/send-email           enviar como adjunto por Gmail
 *   GET    /api/docs/templates                listar plantillas de marca
 *   POST   /api/docs/templates                guardar/actualizar una plantilla
 *   DELETE /api/docs/templates/:name          eliminar una plantilla
 *
 * Los binarios viven en `DATA_DIR/docs` (nunca en `public/`). La descarga exige
 * la misma autenticación que el resto de la API cuando la app está en modo
 * sesión; en modo local (127.0.0.1) se sirve sin login, como el resto.
 */
import {
  bodyOf, listEnvelope, paramOf, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { contentDisposition } from '../docs/ooxml.mjs';
import {
  DOC_MIME, deleteDocument, documentStats, documentVersions, documentsArchive, duplicateDocument, getDocument, listDocuments, readDocument, renameDocument
} from '../docs/documents.mjs';
import {
  DOC_TYPES, createDocument, deleteTemplate, emailDocument, listTemplates, saveTemplate
} from '../docs/index.mjs';

export const name = 'docs';
export const priority = 120;

function sendBinary(ctx, buffer, { contentType, filename, status = 200 }) {
  const res = ctx.res;
  if (!res) throw new Error('ctx sin respuesta HTTP');
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', String(buffer.length));
  res.setHeader('content-disposition', contentDisposition(filename, 'attachment'));
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.setHeader('accept-ranges', 'none');
  if (ctx.requestId) res.setHeader('x-request-id', ctx.requestId);
  if (ctx.head) res.end();
  else res.end(buffer);
  return status;
}

function docsList(ctx) {
  const type = queryString(ctx, 'type');
  if (type && !DOC_TYPES[String(type).toLowerCase()]) {
    return respond(ctx, 400, {
      error: 'type debe ser docx, xlsx o pptx.',
      code: 'VALIDATION',
      field: 'type',
      requestId: ctx.requestId
    });
  }
  const result = listDocuments({
    type: type ? String(type).toLowerCase() : '',
    q: queryString(ctx, 'q') || '',
    limit: queryInt(ctx, 'limit', 50, { min: 1, max: 200 }) ?? 50,
    offset: queryInt(ctx, 'offset', 0, { min: 0, max: 1_000_000 }) ?? 0
  });
  return respond(ctx, 200, listEnvelope(result.items, {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    stats: documentStats()
  }));
}

async function docsCreate(ctx) {
  const body = await bodyOf(ctx);
  const created = await createDocument(body);
  const status = created.registered === false ? 200 : 201;
  const headers = created.registered === false ? { 'cache-control': 'no-store' } : {};
  return respond(ctx, status, {
    ...created,
    downloadUrl: created.id ? `/api/docs/${created.id}/download` : null
  }, headers);
}

function docsGet(ctx) {
  const id = paramOf(ctx, 'id');
  const item = getDocument(id);
  if (!item) {
    return respond(ctx, 404, {
      error: `No existe el documento ${id || ''}`.trim(),
      code: 'DOC_NOT_FOUND',
      field: 'id',
      requestId: ctx.requestId
    });
  }
  return respond(ctx, 200, { item, stats: documentStats() });
}

function docsVersions(ctx) {
  return respond(ctx, 200, { ok: true, ...documentVersions(paramOf(ctx, 'id')) });
}

function docsDownload(ctx) {
  const id = paramOf(ctx, 'id');
  const { item, buffer } = readDocument(id);
  return sendBinary(ctx, buffer, {
    contentType: DOC_MIME[item.type] || 'application/octet-stream',
    filename: item.filename
  });
}

async function docsExport(ctx) {
  const archive = documentsArchive();
  return sendBinary(ctx, archive.buffer, { contentType: 'application/zip', filename: archive.filename });
}

async function docsRename(ctx) {
  const body = await bodyOf(ctx);
  const item = await renameDocument(paramOf(ctx, 'id'), body?.title);
  return respond(ctx, 200, { ok: true, item, stats: documentStats() });
}

async function docsDuplicate(ctx) {
  const item = await duplicateDocument(paramOf(ctx, 'id'));
  return respond(ctx, 201, { ok: true, item, stats: documentStats() });
}

async function docsDelete(ctx) {
  const id = paramOf(ctx, 'id');
  const result = await deleteDocument(id);
  return respond(ctx, 200, { ...result, stats: documentStats() });
}

async function docsSendEmail(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx);
  const result = await emailDocument(id, body);
  return respond(ctx, 200, result);
}

function templatesList(ctx) {
  return listTemplates().then((result) => respond(ctx, 200, result));
}

async function templatesCreate(ctx) {
  const body = await bodyOf(ctx);
  const result = await saveTemplate(body);
  return respond(ctx, result.created ? 201 : 200, result);
}

async function templatesDelete(ctx) {
  const templateName = paramOf(ctx, 'name');
  const result = await deleteTemplate(templateName);
  return respond(ctx, 200, result);
}

export const routes = [
  { method: 'GET', path: '/api/docs', name: 'docs.list', handler: route(docsList) },
  { method: 'POST', path: '/api/docs', name: 'docs.create', handler: route(docsCreate) },
  { method: 'GET', path: '/api/docs/templates', name: 'docs.templates.list', handler: route(templatesList) },
  { method: 'POST', path: '/api/docs/templates', name: 'docs.templates.save', handler: route(templatesCreate) },
  { method: 'DELETE', path: '/api/docs/templates/:name', name: 'docs.templates.delete', handler: route(templatesDelete) },
  { method: 'GET', path: '/api/docs/export.zip', name: 'docs.exportZip', handler: route(docsExport) },
  { method: 'GET', path: '/api/docs/:id', name: 'docs.get', handler: route(docsGet) },
  { method: 'GET', path: '/api/docs/:id/versions', name: 'docs.versions', handler: route(docsVersions) },
  { method: 'GET', path: '/api/docs/:id/download', name: 'docs.download', handler: route(docsDownload) },
  { method: 'PATCH', path: '/api/docs/:id', name: 'docs.rename', handler: route(docsRename) },
  { method: 'POST', path: '/api/docs/:id/duplicate', name: 'docs.duplicate', handler: route(docsDuplicate) },
  { method: 'DELETE', path: '/api/docs/:id', name: 'docs.delete', handler: route(docsDelete) },
  { method: 'POST', path: '/api/docs/:id/send-email', name: 'docs.sendEmail', handler: route(docsSendEmail) }
];

export default { name, priority, routes };


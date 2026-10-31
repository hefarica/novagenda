/**
 * Servidor de archivos estáticos (public/) con cabeceras de seguridad, HEAD
 * correcto, protección de traversal y fallback SPA para rutas del frontend.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, Errors } from './errors.mjs';
import { sendJson, CONTENT_TYPE } from './respond.mjs';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
});

const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

/**
 * @param {string} publicRoot
 * @param {string} pathname
 * @returns {string|null} ruta absoluta segura o null si escapa del root
 */
export function resolveStaticPath(publicRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'Ruta con codificación inválida.');
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'INVALID_PATH', 'Ruta inválida.');
  const relative = decoded === '/' || decoded === '' ? '/index.html' : decoded;
  const root = path.resolve(publicRoot);
  const candidate = path.resolve(root, `.${relative}`);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {{head?:boolean, requestId?:string, cacheControl?:string, status?:number}} [options]
 */
export async function sendFile(res, filePath, options = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw Errors.notFound('Archivo');
  }
  if (!stat.isFile()) throw Errors.notFound('Archivo');
  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = options.status || 200;
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
  res.setHeader('content-length', String(stat.size));
  res.setHeader('cache-control', options.cacheControl || 'public, max-age=3600');
  res.setHeader('last-modified', new Date(stat.mtimeMs).toUTCString());
  if (options.requestId) res.setHeader('x-request-id', options.requestId);
  if (options.head) {
    res.end();
    return options.status || 200;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    res.on('close', resolve);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return options.status || 200;
}

/**
 * @param {{req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse, url:URL, requestId:string, publicRoot:string, head:boolean}} ctx
 */
export async function serveStatic(ctx) {
  const method = String(ctx.req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    throw Errors.methodNotAllowed('Solo GET/HEAD para archivos estáticos.');
  }
  const filePath = resolveStaticPath(ctx.publicRoot, ctx.url.pathname);
  if (!filePath) throw new HttpError(403, 'FORBIDDEN', 'Ruta fuera del directorio público.');

  let stat = null;
  try { stat = await fsp.stat(filePath); } catch { /* puede ser fallback SPA */ }

  if (stat && stat.isFile()) {
    const relative = `/${path.relative(path.resolve(ctx.publicRoot), filePath).split(path.sep).join('/')}`;
    return sendFile(ctx.res, filePath, {
      head: ctx.head,
      requestId: ctx.requestId,
      cacheControl: NO_CACHE.has(relative) ? 'no-cache' : 'public, max-age=3600'
    });
  }

  const hasExtension = path.extname(ctx.url.pathname) !== '';
  if (!hasExtension && wantsHtml(ctx.req)) {
    const index = path.join(path.resolve(ctx.publicRoot), 'index.html');
    if (fs.existsSync(index)) {
      return sendFile(ctx.res, index, { head: ctx.head, requestId: ctx.requestId, cacheControl: 'no-cache' });
    }
  }
  return sendJson(ctx.res, {
    status: 404,
    payload: { error: 'Archivo no encontrado', code: 'NOT_FOUND', requestId: ctx.requestId },
    requestId: ctx.requestId,
    head: ctx.head,
    headers: { 'content-type': CONTENT_TYPE.json }
  });
}

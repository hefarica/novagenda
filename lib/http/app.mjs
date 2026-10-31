/**
 * Composición de la aplicación HTTP:
 *   cabeceras de seguridad → request-id → router → sesión → errores → log.
 *
 * El handler se crea con `createApp()` (asíncrono porque descubre módulos).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRoutes, isMutating } from './router.mjs';
import { readJsonBody, readRawBody, DEFAULT_BODY_LIMIT } from './body.mjs';
import { applySecurityHeaders, sendEmpty, sendJson, sendRedirect, sendError, sendText } from './respond.mjs';
import { Errors, HttpError, isHttpError } from './errors.mjs';
import { ensureRequestId, assertSameOrigin, isLoopbackPeer, clientIp } from './middleware.mjs';
import { requestAuth, isHttps } from '../security/session.mjs';
import { accessLog, log, logError } from './logger.mjs';
import { serveStatic } from './static.mjs';
import { store } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..');

function safeUrl(req) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'URL de petición inválida.');
  }
}

function createContext({ req, res, url, requestId, publicRoot, router }) {
  const cache = { body: undefined, rawBody: undefined, parsed: undefined };
  const ctx = {
    req,
    res,
    url,
    publicRoot,
    router,
    requestId,
    method: String(req.method || 'GET').toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    params: {},
    route: null,
    head: String(req.method || 'GET').toUpperCase() === 'HEAD',
    ip: clientIp(req),
    auth: null,
    log: {
      debug: (message, meta) => log('debug', message, meta),
      info: (message, meta) => log('info', message, meta),
      warn: (message, meta) => log('warn', message, meta),
      error: (message, meta) => log('error', message, meta)
    },
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    json(status, payload, extraHeaders = {}, opts = {}) {
      return sendJson(res, { status, payload, requestId, head: ctx.head, headers: extraHeaders, redact: opts.redact !== false });
    },
    text(status, body, contentType, extraHeaders = {}) {
      return sendText(res, { status, body, contentType, requestId, head: ctx.head, headers: extraHeaders });
    },
    redirect(location, status = 302) {
      return sendRedirect(res, location, status);
    },
    empty(status = 204, extraHeaders = {}) {
      return sendEmpty(res, status, extraHeaders);
    },
    async rawBody(limit) {
      if (cache.rawBody === undefined) {
        cache.rawBody = await readRawBody(req, { limit: limit || ctx.route?.maxBodyBytes || DEFAULT_BODY_LIMIT });
      }
      return cache.rawBody;
    },
    async body(limit) {
      if (cache.parsed !== undefined) return cache.parsed;
      const maxBytes = limit || ctx.route?.maxBodyBytes || DEFAULT_BODY_LIMIT;
      if (cache.rawBody !== undefined) {
        const text = cache.rawBody.toString('utf8').trim();
        if (!text) {
          cache.parsed = {};
        } else {
          try {
            cache.parsed = JSON.parse(text);
          } catch (err) {
            throw Errors.invalidJson(`JSON inválido: ${err.message}`);
          }
        }
        return cache.parsed;
      }
      cache.parsed = await readJsonBody(req, { limit: maxBytes });
      return cache.parsed;
    }
  };
  return ctx;
}

function allowedMethodsFor(router, pathname) {
  const methods = new Set();
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    try {
      if (router.match(method, pathname)) methods.add(method);
    } catch { /* ruta inválida */ }
  }
  if (methods.has('GET')) methods.add('HEAD');
  methods.add('OPTIONS');
  return methods;
}

async function handleApi(ctx, router) {
  const match = router.match(ctx.method, ctx.url.pathname);
  if (!match) throw Errors.notFound('Ruta de API');
  ctx.route = match.route;
  ctx.params = match.params;
  ctx.auth = requestAuth(ctx.req);

  const requirement = ctx.route.auth === 'default' ? (ctx.auth.required ? 'required' : 'optional') : ctx.route.auth;
  if (requirement === 'required' && !ctx.auth.authenticated) {
    throw Errors.unauthorized('Sesión requerida.', {
      mode: ctx.auth.mode,
      configured: ctx.auth.configured,
      loginUrl: '/api/auth/login'
    });
  }
  if (ctx.route.localOnly && !isLoopbackPeer(ctx.req)) {
    throw new HttpError(403, 'LOCAL_ONLY', 'Esta ruta solo está disponible desde 127.0.0.1 (loopback).');
  }
  if (ctx.route.csrf && !ctx.route.webhook && isMutating(ctx.method)) assertSameOrigin(ctx.req);

  const result = await ctx.route.handler(ctx);
  if (ctx.res.writableEnded) return ctx.res.statusCode || 200;
  if (result === undefined) return ctx.res.statusCode || 200;
  if (typeof result === 'number') return ctx.empty(result);
  if (!ctx.res.headersSent) return ctx.json(200, result);
  return ctx.res.statusCode || 200;
}

/**
 * @param {{rootDir?:string, routesDir?:string}} [options]
 */
export async function createApp(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const publicRoot = path.join(rootDir, 'public');
  const routesDir = options.routesDir || path.join(rootDir, 'lib', 'routes');
  const router = await discoverRoutes(routesDir);
  const summary = router.summary();
  if (summary.conflicts.length) log('warn', `Rutas en conflicto: ${summary.conflicts.length}`, { conflicts: summary.conflicts });
  log('info', `Router listo: ${summary.routes} rutas de ${summary.modules.filter((m) => m.ok).length} módulos`);

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handler(req, res) {
    const started = Date.now();
    const requestId = ensureRequestId(req);
    let status = 500;
    let ctx;
    try {
      applySecurityHeaders(res, { requestId, https: isHttps(req) });
      const url = safeUrl(req);
      ctx = createContext({ req, res, url, requestId, publicRoot, router });
      if (ctx.method === 'OPTIONS') {
        const allowed = allowedMethodsFor(router, url.pathname);
        if (allowed.size <= 1) throw Errors.notFound('Ruta');
        status = ctx.empty(204, { allow: [...allowed].join(', ') });
      } else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        status = await handleApi(ctx, router);
      } else {
        status = await serveStatic(ctx);
      }
    } catch (err) {
      if (!ctx) {
        try { applySecurityHeaders(res, { requestId, https: isHttps(req) }); } catch { /* ignore */ }
      }
      status = sendError(res, err, { requestId, head: ctx ? ctx.head : String(req.method || '').toUpperCase() === 'HEAD' });
      if (!isHttpError(err)) {
        logError('http', err, { requestId, method: req.method, path: ctx ? ctx.path : req.url });
      } else if (err.status >= 500) {
        log('warn', `HTTP ${status} ${err.code || 'ERROR'} en ${ctx ? ctx.path : req.url}`, { requestId });
      } else {
        log('debug', `HTTP ${status} ${err.code || 'ERROR'} en ${ctx ? ctx.path : req.url}`, { requestId });
      }
    } finally {
      accessLog({
        requestId,
        method: String(req.method || 'GET').toUpperCase(),
        path: ctx ? ctx.path : String(req.url || '/').split('?')[0],
        status,
        ms: Date.now() - started,
        ip: clientIp(req)
      });
    }
  }

  return {
    handler,
    router,
    rootDir,
    publicRoot,
    routesDir,
    summary: () => router.summary(),
    storeStatus: () => store.status()
  };
}

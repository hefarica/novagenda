/**
 * Adaptador HTTP para los módulos `lib/routes/*.mjs`.
 *
 * El router de backend-core entrega un `ctx` con helpers (ctx.json, ctx.body,
 * ctx.query, ctx.params, ctx.requestId…). Estas utilidades normalizan ese
 * contexto y permiten probar los handlers sin servidor.
 */

export function queryOf(ctx) {
  const query = ctx?.query;
  if (query instanceof URLSearchParams) return query;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
      else params.set(key, String(value));
    }
    return params;
  }
  if (ctx?.url?.searchParams) return ctx.url.searchParams;
  return new URLSearchParams();
}

export function queryString(ctx, name, fallback = null) {
  const value = queryOf(ctx).get(name);
  return value === null || value === undefined || value === '' ? fallback : value;
}

export function queryInt(ctx, name, fallback = null, { min = -Infinity, max = Infinity } = {}) {
  const raw = queryString(ctx, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function queryBool(ctx, name, fallback = false) {
  const raw = queryString(ctx, name);
  if (raw === null) return fallback;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export function paramOf(ctx, name) {
  const value = ctx?.params?.[name];
  if (value === undefined || value === null) return null;
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

export function pathOf(ctx) {
  return ctx?.path || (ctx?.url?.pathname) || '';
}

export async function bodyOf(ctx, fallback = {}) {
  if (typeof ctx?.body === 'function') {
    const parsed = await ctx.body();
    return parsed === undefined || parsed === null ? fallback : parsed;
  }
  if (ctx?.body !== undefined && ctx?.body !== null) return ctx.body;
  if (ctx?.req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of ctx.req) {
      size += chunk.length;
      if (size > 1_000_000) {
        throw Object.assign(new Error('Payload demasiado grande'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return fallback;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('JSON inválido'), { status: 400, code: 'INVALID_JSON' });
    }
  }
  return fallback;
}

export function respond(ctx, status, payload, headers = undefined) {
  if (typeof ctx?.json === 'function') return ctx.json(status, payload, headers);
  const res = ctx?.res;
  if (!res) throw new Error('ctx sin helper json/res');
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(headers || {})
  });
  res.end(ctx?.head ? undefined : body);
  return status;
}

export function errorPayload(error, ctx) {
  const status = Number(error?.status) || 500;
  const payload = {
    error: error?.message || 'Error interno',
    code: error?.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR'),
    requestId: ctx?.requestId
  };
  if (error?.field) payload.field = error.field;
  if (error?.details) payload.details = error.details;
  if (status >= 500 && typeof ctx?.log?.error === 'function') ctx.log.error(error.message, { stack: error.stack });
  return { status, payload };
}

export function sendError(ctx, error) {
  const { status, payload } = errorPayload(error, ctx);
  if (typeof ctx?.log?.warn === 'function' && status < 500) ctx.log.warn(payload.error, { code: payload.code, field: payload.field });
  return respond(ctx, status, payload);
}

/** Envuelve un handler para que cualquier excepción se convierta en JSON. */
export function route(handler) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      return sendError(ctx, error);
    }
  };
}

export function listEnvelope(items, extra = {}) {
  return { items, count: items.length, total: extra.total ?? items.length, ...extra };
}

export function itemEnvelope(item, extra = {}) {
  return { item, ...extra };
}

export function notFound(ctx, message) {
  return respond(ctx, 404, { error: message, code: 'NOT_FOUND', requestId: ctx?.requestId });
}

export function badRequest(ctx, message, { code = 'VALIDATION', field } = {}) {
  const payload = { error: message, code, requestId: ctx?.requestId };
  if (field) payload.field = field;
  return respond(ctx, 400, payload);
}

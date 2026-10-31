/**
 * Rutas de features y kill switch.
 *
 * Se montan por auto-descubrimiento (`export const routes`). Además de la API
 * `/api/features/*`, este módulo envuelve `GET /api/health` para añadir el
 * resumen `features` sin editar `core.mjs`: la ruta de features tiene mayor
 * prioridad, delega en el handler de core capturando su payload y lo reemite.
 */
import { HttpError } from '../http/errors.mjs';
import { routes as coreRoutes } from './core.mjs';
import {
  getFeature, featureSummary, listFeatures,
  setMode, pause, resume, pauseAll, resumeAll
} from '../features/registry.mjs';

export const name = 'features';
export const priority = 300;

const coreHealth = coreRoutes.find((route) => route.method === 'GET' && route.path === '/api/health' && typeof route.handler === 'function');

function actorOf(ctx) {
  const user = ctx?.auth?.user;
  return user && user !== 'local' ? String(user) : 'user';
}

async function bodyObject(ctx, { allowEmpty = true } = {}) {
  const body = await ctx.body();
  if (body === undefined || body === null) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  return body;
}

function modeFrom(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'mode')) {
    throw new HttpError(400, 'REQUIRED', 'Falta mode (off|shadow|on).', { field: 'mode' });
  }
  for (const key of Object.keys(body)) {
    if (key !== 'mode') {
      throw new HttpError(400, 'UNKNOWN_FIELD', `Campo no permitido: ${key}.`, { field: key });
    }
  }
  return body.mode;
}

function summaryPayload() {
  return { ok: true, ...featureSummary() };
}

async function listRoute(ctx) {
  return ctx.json(200, {
    ok: true,
    items: listFeatures(),
    count: featureSummary().count,
    summary: featureSummary()
  });
}

async function statusRoute(ctx) {
  return ctx.json(200, summaryPayload());
}

async function setModeRoute(ctx) {
  const body = await bodyObject(ctx, { allowEmpty: false });
  const mode = modeFrom(body);
  const item = await setMode(ctx.params.id, mode, { by: actorOf(ctx) });
  return ctx.json(200, { ok: true, item, summary: featureSummary() });
}

async function pauseRoute(ctx) {
  const item = await pause(ctx.params.id, { by: actorOf(ctx) });
  return ctx.json(200, { ok: true, item, paused: true, summary: featureSummary() });
}

async function resumeRoute(ctx) {
  const item = await resume(ctx.params.id, { by: actorOf(ctx) });
  return ctx.json(200, { ok: true, item, paused: false, summary: featureSummary() });
}

async function pauseAllRoute(ctx) {
  const summary = await pauseAll({ by: actorOf(ctx) });
  return ctx.json(200, { ok: true, paused: true, ...summary });
}

async function resumeAllRoute(ctx) {
  const summary = await resumeAll({ by: actorOf(ctx) });
  return ctx.json(200, { ok: true, paused: false, ...summary });
}

/**
 * Reemite el health de core + `features`. No modifica core: captura el payload
 * que core enviaría y lo vuelve a serializar con el campo añadido.
 */
async function healthRoute(ctx) {
  if (!coreHealth) {
    return ctx.json(503, { ok: false, status: 'degraded', error: 'core health no disponible', features: featureSummary() });
  }
  let captured = null;
  const capture = Object.create(ctx);
  capture.json = (status, payload, extraHeaders = {}, opts = {}) => {
    captured = { status, payload, extraHeaders, opts };
    return undefined;
  };
  await coreHealth.handler(capture);
  if (!captured || !captured.payload || typeof captured.payload !== 'object') {
    throw new HttpError(500, 'HEALTH_CAPTURE_FAILED', 'No se pudo capturar /api/health de core.');
  }
  captured.payload.features = featureSummary();
  return ctx.json(captured.status, captured.payload, captured.extraHeaders, captured.opts);
}

export const routes = [
  {
    method: 'GET',
    path: '/api/features',
    name: 'features.list',
    handler: listRoute
  },
  {
    method: 'GET',
    path: '/api/features/status',
    name: 'features.status',
    handler: statusRoute
  },
  {
    method: 'POST',
    path: '/api/features/:id',
    name: 'features.set-mode',
    handler: setModeRoute
  },
  {
    method: 'POST',
    path: '/api/features/:id/pause',
    name: 'features.pause',
    handler: pauseRoute
  },
  {
    method: 'POST',
    path: '/api/features/:id/resume',
    name: 'features.resume',
    handler: resumeRoute
  },
  {
    method: 'POST',
    path: '/api/features/pause-all',
    name: 'features.pause-all',
    handler: pauseAllRoute
  },
  {
    method: 'POST',
    path: '/api/features/resume-all',
    name: 'features.resume-all',
    handler: resumeAllRoute
  },
  {
    method: 'GET',
    path: '/api/health',
    name: 'features.health',
    auth: 'none',
    handler: healthRoute
  }
];

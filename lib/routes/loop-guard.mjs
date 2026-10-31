/**
 * Diagnóstico del loop guard.
 *
 *   GET  /api/loop-guard/status
 *   POST /api/loop-guard/reset
 *
 * Solo lectura/métricas en memoria; no envía nada.
 */
import { respond, route } from '../agenda/http.mjs';
import { getMode } from '../features/registry.mjs';
import { loopGuardStats, resetLoopGuard } from '../guard/loop.mjs';

export const name = 'loop-guard';
export const priority = 126;

function statusRoute(ctx) {
  return respond(ctx, 200, { ok: true, mode: getMode('loop_guard'), ...loopGuardStats() });
}

function resetRoute(ctx) {
  resetLoopGuard();
  return respond(ctx, 200, { ok: true, reset: true, mode: getMode('loop_guard') });
}

export const routes = [
  { method: 'GET', path: '/api/loop-guard/status', name: 'loopGuard.status', handler: route(statusRoute) },
  { method: 'POST', path: '/api/loop-guard/reset', name: 'loopGuard.reset', handler: route(resetRoute) }
];

export default { name, priority, routes };

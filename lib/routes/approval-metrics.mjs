/**
 * GET /api/approvals/metrics?slaHours=24&windowDays=7
 *
 * Métricas calculadas sobre las propuestas de Oficina y la cuarentena. Solo
 * lectura; no duplica datos.
 */
import { queryInt, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { approvalMetrics } from '../office/metrics.mjs';

export const name = 'approval-metrics';
export const priority = 132;

function metricsRoute(ctx) {
  const slaHours = queryInt(ctx, 'slaHours', 24, { min: 1, max: 720 });
  const windowDays = queryInt(ctx, 'windowDays', 7, { min: 1, max: 90 });
  return respond(ctx, 200, {
    ok: true,
    ...approvalMetrics(store.get(), { slaHours, windowDays })
  });
}

export const routes = [
  { method: 'GET', path: '/api/approvals/metrics', name: 'approvalMetrics.get', handler: route(metricsRoute) }
];

export default { name, priority, routes };

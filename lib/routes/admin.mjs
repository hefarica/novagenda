/**
 * GET /api/admin/export
 *
 * Copia de seguridad legible de la oficina, sin secretos ni binarios.
 */
import { respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { buildOfficeExport } from '../admin/export.mjs';

export const name = 'admin';
export const priority = 134;

function exportRoute(ctx) {
  return respond(ctx, 200, buildOfficeExport(store.get()));
}

export const routes = [
  { method: 'GET', path: '/api/admin/export', name: 'admin.export', handler: route(exportRoute) }
];

export default { name, priority, routes };

/**
 * GET /api/moments/weekly?at=ISO
 *
 * Resumen semanal determinista; `at` es opcional para pruebas y no escribe nada.
 */
import { queryString, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { momentsText, weeklyMoments } from '../moments/index.mjs';
import { HttpError } from '../http/errors.mjs';

export const name = 'moments';
export const priority = 133;

function weeklyRoute(ctx) {
  const raw = queryString(ctx, 'at', '');
  let now = new Date();
  if (raw) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'INVALID_DATE', 'at debe ser una fecha ISO válida.', { field: 'at' });
    now = parsed;
  }
  const moments = weeklyMoments(store.get(), { now });
  return respond(ctx, 200, { ok: true, ...moments, text: momentsText(moments) });
}

export const routes = [
  { method: 'GET', path: '/api/moments/weekly', name: 'moments.weekly', handler: route(weeklyRoute) }
];

export default { name, priority, routes };

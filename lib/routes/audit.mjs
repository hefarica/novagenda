/**
 * Auditoría consultable sobre el ledger de la Oficina.
 *
 *   GET /api/audit/events?actor=&action=&q=&from=&to=&limit=&offset=
 *   GET /api/audit/stats
 *   GET /api/audit/export?format=json|csv&<mismos filtros>
 *
 * Auto-descubierto (priority 122), autenticación normal. Solo lectura: no crea,
 * modifica ni borra entradas del ledger.
 */
import {
  queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { auditCsv, auditExport, auditQuery, auditStats } from '../audit/index.mjs';
import { HttpError } from '../http/errors.mjs';

export const name = 'audit';
export const priority = 122;

function filtersOf(ctx) {
  return {
    actor: queryString(ctx, 'actor', ''),
    action: queryString(ctx, 'action', ''),
    q: queryString(ctx, 'q', ''),
    from: queryString(ctx, 'from', ''),
    to: queryString(ctx, 'to', ''),
    limit: queryInt(ctx, 'limit', 50, { min: 1, max: 500 }),
    offset: queryInt(ctx, 'offset', 0, { min: 0, max: 1_000_000 })
  };
}

function eventsRoute(ctx) {
  const result = auditQuery(store.get(), filtersOf(ctx));
  return respond(ctx, 200, { ok: true, ...result });
}

function statsRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...auditStats(store.get()) });
}

function exportRoute(ctx) {
  const format = String(queryString(ctx, 'format', 'json')).toLowerCase();
  const filters = filtersOf(ctx);
  if (format === 'csv') {
    const { csv, total } = auditCsv(store.get(), filters);
    const res = ctx.res;
    if (!res) return respond(ctx, 200, { ok: true, format: 'csv', total, csv });
    const body = Buffer.from(csv, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="auditoria-ledger.csv"',
      'cache-control': 'no-store',
      'content-length': body.length
    });
    res.end(body);
    return 200;
  }
  if (format !== 'json') {
    throw new HttpError(400, 'INVALID_FORMAT', 'format debe ser json o csv.', { field: 'format' });
  }
  const payload = auditExport(store.get(), filters);
  return respond(ctx, 200, payload, {
    'content-disposition': 'attachment; filename="auditoria-ledger.json"',
    'cache-control': 'no-store'
  });
}

export const routes = [
  { method: 'GET', path: '/api/audit/events', name: 'audit.events', handler: route(eventsRoute) },
  { method: 'GET', path: '/api/audit/stats', name: 'audit.stats', handler: route(statsRoute) },
  { method: 'GET', path: '/api/audit/export', name: 'audit.export', handler: route(exportRoute) }
];

export default { name, priority, routes };

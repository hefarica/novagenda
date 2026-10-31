/**
 * API de conectores externos gobernados (t51).
 *
 *   GET    /api/studio/connectors
 *   POST   /api/studio/connectors
 *   GET    /api/studio/connectors/:id
 *   DELETE /api/studio/connectors/:id
 *   POST   /api/studio/connectors/:id/test
 *   POST   /api/studio/connectors/:id/invoke
 *
 * `invoke` es una extensión necesaria para que agentes consulten herramientas:
 * las lecturas se ejecutan directas; cualquier efecto se convierte en una
 * propuesta de la Oficina (202) y nunca se ejecuta sin aprobación.
 *
 * Las respuestas nunca incluyen tokens: solo `authRef`, `authKind` y `hasToken`.
 */
import { bodyOf, paramOf, respond, route } from '../agenda/http.mjs';
import { HttpError } from '../http/errors.mjs';
import {
  createConnector, deleteConnector, getConnectorPublic, invokeConnector, listConnectors,
  testConnector, validateTestInput, connectorGateStatus, registerConnectorExecutor
} from '../studio/connectors.mjs';

export const name = 'connectors';
export const priority = 118;

// Deja listo el ejecutor `connector` de la Oficina (idempotente). Si la Oficina
// no está disponible, el gate de efectos devolverá 503 al invocarse.
try {
  await registerConnectorExecutor();
} catch {
  /* la Oficina es opcional; el gate decidirá en tiempo de ejecución */
}

function actorOf(ctx) {
  const user = ctx?.auth?.user;
  return user && user !== 'local' ? String(user) : 'api';
}

async function listRoute(ctx) {
  const data = listConnectors();
  const gate = await connectorGateStatus();
  return respond(ctx, 200, { ok: true, ...data, gate });
}

async function createRoute(ctx) {
  const item = await createConnector(await bodyOf(ctx), { actor: actorOf(ctx) });
  return respond(ctx, 201, { ok: true, item, id: item.id });
}

function getRoute(ctx) {
  const item = getConnectorPublic(paramOf(ctx, 'id'));
  if (!item) throw new HttpError(404, 'CONNECTOR_NOT_FOUND', `Conector ${paramOf(ctx, 'id')} no encontrado.`);
  return respond(ctx, 200, { ok: true, item });
}

async function deleteRoute(ctx) {
  const result = await deleteConnector(paramOf(ctx, 'id'));
  return respond(ctx, 200, { ok: true, ...result });
}

async function testRoute(ctx) {
  const id = paramOf(ctx, 'id');
  const input = validateTestInput(await bodyOf(ctx, {}));
  const result = await testConnector(id, input);
  return respond(ctx, 200, { ok: true, item: result.item, test: result.test });
}

async function invokeRoute(ctx) {
  const id = paramOf(ctx, 'id');
  const body = await bodyOf(ctx, {});
  const result = await invokeConnector(id, body, { actor: actorOf(ctx) });
  return respond(ctx, result.pending === true ? 202 : 200, result);
}

export const routes = [
  { method: 'GET', path: '/api/studio/connectors', name: 'connectors.list', handler: route(listRoute) },
  { method: 'POST', path: '/api/studio/connectors', name: 'connectors.create', handler: route(createRoute) },
  { method: 'GET', path: '/api/studio/connectors/:id', name: 'connectors.get', handler: route(getRoute) },
  { method: 'DELETE', path: '/api/studio/connectors/:id', name: 'connectors.delete', handler: route(deleteRoute) },
  { method: 'POST', path: '/api/studio/connectors/:id/test', name: 'connectors.test', handler: route(testRoute) },
  { method: 'POST', path: '/api/studio/connectors/:id/invoke', name: 'connectors.invoke', handler: route(invokeRoute) }
];

export default { name, priority, routes };

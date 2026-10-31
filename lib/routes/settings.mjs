/**
 * Visibilidad de módulos opcionales.
 *
 *   GET   /api/settings/modules
 *   PATCH /api/settings/modules/:key   {enabled:boolean}
 */
import { bodyOf, paramOf, respond, route } from '../agenda/http.mjs';
import { store } from '../store.mjs';
import { listModules, setModule } from '../settings/modules.mjs';
import { HttpError } from '../http/errors.mjs';
import { isPlainObject } from '../validate.mjs';

export const name = 'settings';
export const priority = 135;

function listRoute(ctx) {
  return respond(ctx, 200, { ok: true, ...listModules(store.get()) });
}

async function patchRoute(ctx) {
  const body = await bodyOf(ctx);
  if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  let item;
  await store.mutate((data) => {
    item = setModule(data, paramOf(ctx, 'key'), body.enabled);
  }, { label: 'settings' });
  return respond(ctx, 200, { ok: true, item });
}

export const routes = [
  { method: 'GET', path: '/api/settings/modules', name: 'settings.modules.list', handler: route(listRoute) },
  { method: 'PATCH', path: '/api/settings/modules/:key', name: 'settings.modules.patch', handler: route(patchRoute) }
];

export default { name, priority, routes };

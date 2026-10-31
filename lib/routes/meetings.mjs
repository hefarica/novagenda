/**
 * Captura de reuniones.
 *
 *   POST /api/meetings/capture {title, transcript, date?, time?, location?, modality?}
 *
 * Solo extrae; el acta se crea con `POST /api/docs` (template `acta`) desde la
 * UI, que además convierte los acuerdos en tareas. Auto-descubierto (124).
 */
import { bodyOf, respond, route } from '../agenda/http.mjs';
import { isPlainObject } from '../validate.mjs';
import { HttpError } from '../http/errors.mjs';
import { captureMeeting } from '../meetings/capture.mjs';

export const name = 'meetings';
export const priority = 124;

const ALLOWED = Object.freeze(['title', 'transcript', 'date', 'time', 'location', 'modality']);

async function captureRoute(ctx) {
  const body = await bodyOf(ctx);
  if (!isPlainObject(body)) throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.');
  for (const key of Object.keys(body)) {
    if (!ALLOWED.includes(key)) throw new HttpError(400, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`, { field: key });
  }
  const result = await captureMeeting(body);
  return respond(ctx, 200, { ok: true, ...result });
}

export const routes = [
  { method: 'POST', path: '/api/meetings/capture', name: 'meetings.capture', handler: route(captureRoute) }
];

export default { name, priority, routes };

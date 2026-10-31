/**
 * Traducción con LLM.
 *
 *   GET  /api/translate/languages
 *   POST /api/translate {text, to?, from?}
 *
 * Auto-descubierto (priority 114), autenticación normal. Si no hay proveedor
 * LLM devuelve 503 y no inventa una traducción.
 */
import { HttpError } from '../http/errors.mjs';
import { bodyOf } from '../agenda/http.mjs';
import { LANGUAGES, translateText } from '../translate/index.mjs';

export const name = 'translate';
export const priority = 114;

async function bodyObject(ctx) {
  const body = await bodyOf(ctx);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Se espera un objeto JSON.', { field: 'body' });
  }
  return body;
}

function languagesRoute(ctx) {
  return ctx.json(200, { ok: true, items: LANGUAGES.map((item) => ({ ...item })) });
}

async function translateRoute(ctx) {
  const body = await bodyObject(ctx);
  const result = await translateText({ text: body.text, to: body.to, from: body.from });
  return ctx.json(200, { ok: true, ...result });
}

export const routes = [
  { method: 'GET', path: '/api/translate/languages', name: 'translate.languages', handler: languagesRoute },
  { method: 'POST', path: '/api/translate', name: 'translate.text', handler: translateRoute }
];

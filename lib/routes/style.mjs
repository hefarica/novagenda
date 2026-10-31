/**
 * Rutas del perfil de estilo ("como yo").
 *
 *   POST   /api/style/samples            {register, samples[]}  → añade y recalcula
 *   GET    /api/style/profiles                                  → perfiles por registro/global
 *   DELETE /api/style/profiles/:register                        → borra muestras del registro
 *   POST   /api/style/score              {register?, text}      → {score, why[]}
 *   POST   /api/style/compose            {register, intent, facts, recipient, thread, opening?}
 *                                                               → {draft, score, why[]}
 *
 * Auto-descubierto por `lib/http/router.mjs` (priority 120). Sin LLM funciona:
 * `compose` usa el generador determinista y solo pide una alternativa al LLM si
 * hay proveedor configurado.
 */
import {
  bodyOf, paramOf, respond, route
} from '../agenda/http.mjs';
import { isPlainObject, text } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import {
  STYLE_REGISTERS, addStyleSamples, assertRegister, deleteStyleRegister,
  profileForRegister, styleProfilesSnapshot
} from '../style/profile.mjs';
import { scoreText } from '../style/score.mjs';
import { composeEmail } from '../style/compose.mjs';
import { store } from '../store.mjs';

export const name = 'style';
export const priority = 120;

const SAMPLE_FIELDS = Object.freeze(['register', 'samples']);
const SCORE_FIELDS = Object.freeze(['register', 'text']);
const COMPOSE_FIELDS = Object.freeze(['register', 'intent', 'facts', 'recipient', 'thread', 'opening']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function assertBody(body, allowed, { allowEmpty = false } = {}) {
  if (!isPlainObject(body)) throw new ValidationError('body', 'INVALID_BODY', 'El cuerpo debe ser un objeto JSON.');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`);
  }
  if (!allowEmpty && Object.keys(body).length === 0) {
    throw new ValidationError('body', 'EMPTY_PATCH', 'El cuerpo no puede estar vacío.');
  }
  return body;
}

function samplesValue(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('samples', 'REQUIRED', 'samples debe ser un array con al menos una muestra.');
  }
  if (value.length > 50) throw new ValidationError('samples', 'TOO_LONG', 'Máximo 50 muestras por petición.');
  return value.map((sample, index) => {
    const raw = isPlainObject(sample) ? sample.text : sample;
    if (typeof raw !== 'string') throw new ValidationError(`samples[${index}]`, 'INVALID_TYPE', 'Cada muestra debe ser texto o {text}.');
    return text(raw, { field: `samples[${index}]`, required: true, max: 8_000, min: 20, allowEmpty: false });
  });
}

function factsValue(value) {
  if (value === undefined || value === null) return undefined;
  if (isPlainObject(value) || Array.isArray(value) || typeof value === 'string') {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized.length > 8_000) throw new ValidationError('facts', 'TOO_LONG', 'facts supera 8000 caracteres.');
    return value;
  }
  throw new ValidationError('facts', 'INVALID_TYPE', 'facts debe ser objeto, array o texto.');
}

function recipientValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const clean = text(value, { field: 'recipient', max: 254, allowEmpty: false });
    return { name: null, email: /@/.test(clean) ? clean.toLowerCase() : null, raw: clean };
  }
  if (!isPlainObject(value)) throw new ValidationError('recipient', 'INVALID_TYPE', 'recipient debe ser texto u objeto {name,email}.');
  const allowed = new Set(['name', 'email', 'emails']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`recipient.${key}`, 'UNKNOWN_FIELD', `Campo no permitido en recipient: ${key}`);
  }
  const name = value.name === undefined ? null : text(value.name, { field: 'recipient.name', max: 120, allowEmpty: false });
  const emails = [];
  if (value.email !== undefined) emails.push(text(value.email, { field: 'recipient.email', max: 254, allowEmpty: false }).toLowerCase());
  if (value.emails !== undefined) {
    if (!Array.isArray(value.emails)) throw new ValidationError('recipient.emails', 'INVALID_TYPE', 'recipient.emails debe ser un array.');
    if (value.emails.length > 10) throw new ValidationError('recipient.emails', 'TOO_LONG', 'recipient.emails admite 10 correos.');
    for (const [index, email] of value.emails.entries()) {
      emails.push(text(email, { field: `recipient.emails[${index}]`, max: 254, allowEmpty: false }).toLowerCase());
    }
  }
  for (const email of emails) {
    if (!EMAIL_RE.test(email)) throw new ValidationError('recipient.email', 'INVALID_FORMAT', `Correo inválido: ${email}`);
  }
  return { name, email: emails[0] || null, emails };
}

function threadValue(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError('thread', 'INVALID_TYPE', 'thread debe ser un array.');
  if (value.length > 10) throw new ValidationError('thread', 'TOO_LONG', 'thread admite 10 mensajes.');
  return value.map((message, index) => {
    const raw = typeof message === 'string' ? message : message?.text ?? message?.body ?? message?.content;
    if (typeof raw !== 'string') throw new ValidationError(`thread[${index}]`, 'INVALID_TYPE', 'Cada mensaje del hilo debe ser texto.');
    return text(raw, { field: `thread[${index}]`, required: true, max: 2_000, allowEmpty: false });
  });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function samplesPost(ctx) {
  const input = assertBody(await bodyOf(ctx), SAMPLE_FIELDS);
  const register = assertRegister(input.register);
  const samples = samplesValue(input.samples);
  const result = await addStyleSamples({ register, samples });
  return respond(ctx, 200, result);
}

function profilesGet(ctx) {
  return respond(ctx, 200, styleProfilesSnapshot(store.get()));
}

async function profileDelete(ctx) {
  const register = assertRegister(paramOf(ctx, 'register'));
  const result = await deleteStyleRegister(register);
  return respond(ctx, 200, result);
}

async function scorePost(ctx) {
  const input = assertBody(await bodyOf(ctx), SCORE_FIELDS);
  const register = input.register === undefined ? null : assertRegister(input.register);
  const value = text(input.text, { field: 'text', required: true, max: 20_000, min: 1, allowEmpty: false });
  const effective = profileForRegister(store.get(), register);
  const scored = scoreText(effective.profile, value);
  return respond(ctx, 200, {
    register: effective.requestedRegister,
    profileSource: effective.source,
    score: scored.score,
    why: scored.why,
    components: scored.components,
    penalties: scored.penalties
  });
}

async function composePost(ctx) {
  const input = assertBody(await bodyOf(ctx), COMPOSE_FIELDS);
  const register = assertRegister(input.register);
  const intent = text(input.intent, { field: 'intent', required: true, max: 2_000, min: 3, allowEmpty: false });
  const facts = factsValue(input.facts);
  const recipient = recipientValue(input.recipient);
  const thread = threadValue(input.thread);
  const opening = input.opening === undefined ? undefined : text(input.opening, { field: 'opening', max: 120, allowEmpty: false });
  const result = await composeEmail({ register, intent, facts, recipient, thread, opening });
  return respond(ctx, 200, result);
}

export const routes = [
  { method: 'POST', path: '/api/style/samples', name: 'style.samples.create', handler: route(samplesPost) },
  { method: 'GET', path: '/api/style/profiles', name: 'style.profiles', handler: route(profilesGet) },
  { method: 'DELETE', path: '/api/style/profiles/:register', name: 'style.profiles.delete', handler: route(profileDelete) },
  { method: 'POST', path: '/api/style/score', name: 'style.score', handler: route(scorePost) },
  { method: 'POST', path: '/api/style/compose', name: 'style.compose', handler: route(composePost) }
];

export { STYLE_REGISTERS };

export default { name, priority, routes };

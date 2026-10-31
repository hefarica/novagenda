/**
 * API de contexto de hilo y acuses variados.
 *
 *   POST /api/thread/context  {channel, userId, limit?}
 *   POST /api/thread/ack      {channel, userId, intent, urgency?}
 *   GET  /api/thread/summary?channel=&userId=&limit=
 *
 * Auto-descubierto por `lib/http/router.mjs` (priority 120). Requiere la
 * autenticación normal de la app y no expone secretos ni ids internos en los
 * acuses. Si no hay historial devuelve contexto vacío y un acuse neutro.
 */
import {
  bodyOf, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { isPlainObject, text } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import {
  DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT, buildThreadContext, threadSummaryLine
} from '../thread/context.mjs';
import { composeAck, normalizeUrgency } from '../thread/ack.mjs';

export const name = 'thread';
export const priority = 120;

const CONTEXT_FIELDS = Object.freeze(['channel', 'userId', 'limit']);
const ACK_FIELDS = Object.freeze(['channel', 'userId', 'intent', 'urgency']);

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

function channelValue(value) {
  const clean = text(value, { field: 'channel', required: true, min: 2, max: 40, allowEmpty: false }).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(clean)) {
    throw new ValidationError('channel', 'INVALID_FORMAT', 'channel solo admite letras, números, guion y guion bajo.');
  }
  return clean;
}

function userValue(value) {
  return text(value, { field: 'userId', required: true, min: 1, max: 200, allowEmpty: false });
}

function limitValue(value, fallback = DEFAULT_THREAD_LIMIT) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_THREAD_LIMIT) {
    throw new ValidationError('limit', 'OUT_OF_RANGE', `limit debe ser un entero entre 1 y ${MAX_THREAD_LIMIT}.`);
  }
  return parsed;
}

function intentValue(value) {
  return text(value, { field: 'intent', required: true, min: 2, max: 1000, allowEmpty: false });
}

function urgencyValue(value) {
  if (value === undefined || value === null || value === '') return 'normal';
  const clean = text(value, { field: 'urgency', required: true, min: 3, max: 20, allowEmpty: false });
  const normalized = normalizeUrgency(clean, null);
  if (!normalized) throw new ValidationError('urgency', 'INVALID_VALUE', 'urgency debe ser baja, normal, alta o urgente.');
  return normalized;
}

async function contextPost(ctx) {
  const input = assertBody(await bodyOf(ctx), CONTEXT_FIELDS);
  const context = await buildThreadContext({
    channel: channelValue(input.channel),
    userId: userValue(input.userId),
    limit: limitValue(input.limit)
  });
  return respond(ctx, 200, {
    context,
    summary: context.summary,
    usedLlm: context.usedLlm,
    sources: context.sources
  });
}

async function ackPost(ctx) {
  const input = assertBody(await bodyOf(ctx), ACK_FIELDS);
  const channel = channelValue(input.channel);
  const userId = userValue(input.userId);
  const intent = intentValue(input.intent);
  const urgency = urgencyValue(input.urgency);
  // El acuse debe ser inmediato: contexto determinista, sin esperar al LLM.
  const context = await buildThreadContext({ channel, userId, limit: DEFAULT_THREAD_LIMIT, useLlm: false });
  const ack = await composeAck({ channel, userId, intent, urgency, context });
  return respond(ctx, 200, {
    context,
    ack: ack.text,
    ackMeta: {
      urgency: ack.urgency,
      neutral: ack.neutral,
      replaced: ack.replaced,
      synthesized: ack.synthesized,
      exhausted: ack.exhausted,
      windowDays: ack.windowDays,
      recorded: ack.recorded
    },
    usedLlm: context.usedLlm,
    sources: [...context.sources, ...ack.sources]
  });
}

async function summaryGet(ctx) {
  const channel = channelValue(queryString(ctx, 'channel', ''));
  const userId = userValue(queryString(ctx, 'userId', ''));
  const limit = limitValue(queryInt(ctx, 'limit', DEFAULT_THREAD_LIMIT, { min: 1, max: MAX_THREAD_LIMIT }));
  const context = await buildThreadContext({ channel, userId, limit });
  return respond(ctx, 200, {
    context,
    summary: context.summary,
    line: threadSummaryLine(context),
    usedLlm: context.usedLlm,
    sources: context.sources
  });
}

export const routes = [
  { method: 'POST', path: '/api/thread/context', name: 'thread.context', handler: route(contextPost) },
  { method: 'POST', path: '/api/thread/ack', name: 'thread.ack', handler: route(ackPost) },
  { method: 'GET', path: '/api/thread/summary', name: 'thread.summary', handler: route(summaryGet) }
];

export { buildThreadContext, composeAck };

export default { name, priority, routes };

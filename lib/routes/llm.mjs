/**
 * Rutas del subsistema LLM y del agente de agenda (t3).
 *
 * Contrato (docs/CONTRATO_API.md §12):
 *   GET  /api/llm/status        GET  /api/llm/models
 *   POST /api/llm/chat          POST /api/llm/test
 *   POST /api/agent/command     GET  /api/agent/actions
 * Extensiones documentadas en docs/LLM.md:
 *   POST /api/llm/config        GET  /api/llm/usage
 *   POST /api/llm/workflow      POST /api/llm/autocomplete
 *   POST /api/agent/chat        POST /api/agent/autocomplete
 *   POST /api/agent/confirm     GET  /api/agent/history
 *   GET  /api/agent/conversations[/:key]   DELETE /api/agent/conversations/:key
 *
 * Todas las rutas son autenticadas cuando la app exige sesión (auth:'default').
 * Ninguna devuelve claves: solo `configured`, `model` y `baseUrl` saneada.
 */
import {
  bodyOf, paramOf, queryBool, queryInt, queryString, respond, route
} from '../agenda/http.mjs';
import { isPlainObject, text, integer, boolean, LIMITS } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import {
  llmStatus, llmModels, llmTest, llmChat, invalidateHealthCache
} from '../llm/client.mjs';
import { publicConfig, resolveLlmConfig, updateLlmConfig } from '../llm/config.mjs';
import { normalizeProfileName, PROFILE_IDS, resolveAllProfiles } from '../llm/profiles.mjs';
import { listActions, usageSnapshot } from '../llm/usage.mjs';
import { runWorkflow, WORKFLOW_NAMES } from '../llm/workflows.mjs';
import { handleAgentChat, agentHistory, confirmAgentAction } from '../agent/agent.mjs';
import { autocompleteFields } from '../agent/autocomplete.mjs';
import {
  conversationKey, clearConversation, getHistory, listConversations
} from '../agent/memory.mjs';

export const name = 'llm';
export const priority = 120;

const CHAT_FIELDS = Object.freeze(['messages', 'text', 'profile', 'temperature', 'maxTokens', 'requireLlm', 'cache', 'channel', 'userId']);
const AGENT_FIELDS = Object.freeze(['text', 'channel', 'userId', 'dryRun', 'confirmToken', 'confirm', 'deadlineMs']);
const AUTOCOMPLETE_FIELDS = Object.freeze(['text', 'channel', 'userId']);
const TEST_FIELDS = Object.freeze(['probe']);
const WORKFLOW_FIELDS = Object.freeze(['workflow', 'input', 'text', 'channel', 'userId']);
const CONFIRM_FIELDS = Object.freeze(['token', 'confirmCode', 'channel', 'userId', 'dryRun']);

function assertAllowed(body, allowed, { allowEmpty = false } = {}) {
  if (!isPlainObject(body)) throw new ValidationError('body', 'INVALID_BODY', 'El cuerpo debe ser un objeto JSON.');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`);
  }
  if (!allowEmpty && Object.keys(body).length === 0) {
    throw new ValidationError('body', 'EMPTY_PATCH', 'El cuerpo no puede estar vacío.');
  }
  return body;
}

function userOf(ctx, input) {
  const fromBody = typeof input?.userId === 'string' ? input.userId.trim() : '';
  if (fromBody) return fromBody.slice(0, 80);
  const authUser = ctx?.auth && ctx.auth.user && ctx.auth.user !== 'local' ? String(ctx.auth.user) : '';
  return (authUser || 'local').slice(0, 80);
}

function channelOf(input) {
  const raw = typeof input?.channel === 'string' ? input.channel.trim().toLowerCase() : '';
  if (!raw) return 'web';
  if (!/^[a-z0-9_-]{1,40}$/.test(raw)) throw new ValidationError('channel', 'INVALID_FORMAT', 'channel debe ser a-z, 0-9, _ o - (máx. 40).');
  return raw;
}

function validateChat(body) {
  assertAllowed(body, CHAT_FIELDS, { allowEmpty: true });
  const messages = [];
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ValidationError('messages', 'REQUIRED', 'messages debe ser un array con al menos un mensaje.');
    }
    if (body.messages.length > 24) throw new ValidationError('messages', 'TOO_LONG', 'Máximo 24 mensajes por petición.');
    body.messages.forEach((message, index) => {
      if (!isPlainObject(message)) throw new ValidationError(`messages[${index}]`, 'INVALID_TYPE', 'Cada mensaje debe ser un objeto {role, content}.');
      const role = message.role === undefined ? 'user' : message.role;
      if (!['system', 'user', 'assistant'].includes(role)) throw new ValidationError(`messages[${index}].role`, 'INVALID_VALUE', 'role debe ser system, user o assistant.');
      const content = text(message.content, { field: `messages[${index}].content`, required: true, max: 8000, allowEmpty: false });
      messages.push({ role, content });
    });
  } else if (body.text !== undefined) {
    messages.push({ role: 'user', content: text(body.text, { field: 'text', required: true, max: LIMITS.assistantText, allowEmpty: false }) });
  } else {
    throw new ValidationError('messages', 'REQUIRED', 'Envía messages o text.');
  }
  let profile = 'chat';
  if (body.profile !== undefined) {
    const normalized = normalizeProfileName(body.profile);
    if (!normalized) throw new ValidationError('profile', 'INVALID_VALUE', `Perfil desconocido. Válidos: ${PROFILE_IDS.join(', ')}.`);
    profile = normalized;
  }
  let temperature;
  if (body.temperature !== undefined) {
    const value = Number(body.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new ValidationError('temperature', 'OUT_OF_RANGE', 'temperature debe estar entre 0 y 2.');
    temperature = value;
  }
  const maxTokens = body.maxTokens === undefined ? undefined : integer(body.maxTokens, { field: 'maxTokens', min: 16, max: 4096, required: true });
  return {
    messages,
    profile,
    temperature,
    maxTokens,
    requireLlm: body.requireLlm === undefined ? false : boolean(body.requireLlm, { field: 'requireLlm', required: true }) === true,
    cache: body.cache === undefined ? 'auto' : boolean(body.cache, { field: 'cache', required: true }),
    channel: channelOf(body),
    userId: userOf({ auth: null }, body)
  };
}

function validateAgent(body) {
  assertAllowed(body, AGENT_FIELDS, { allowEmpty: true });
  const textValue = text(body.text, { field: 'text', required: true, max: LIMITS.assistantText, allowEmpty: false });
  const deadlineMs = body.deadlineMs === undefined
    ? undefined
    : integer(body.deadlineMs, { field: 'deadlineMs', min: 3_000, max: 25_000, required: true });
  return {
    text: textValue,
    channel: channelOf(body),
    userId: body.userId === undefined ? undefined : text(body.userId, { field: 'userId', max: 80, allowEmpty: false }),
    dryRun: body.dryRun === undefined ? false : boolean(body.dryRun, { field: 'dryRun', required: true }) === true,
    confirmToken: body.confirmToken === undefined ? null : text(body.confirmToken, { field: 'confirmToken', max: 80, allowEmpty: false }),
    confirm: body.confirm === undefined ? false : boolean(body.confirm, { field: 'confirm', required: true }) === true,
    deadlineMs
  };
}

function validateAutocomplete(body) {
  assertAllowed(body, AUTOCOMPLETE_FIELDS, { allowEmpty: true });
  return {
    text: text(body.text, { field: 'text', required: true, max: LIMITS.assistantText, allowEmpty: false }),
    channel: channelOf(body),
    userId: body.userId === undefined ? undefined : text(body.userId, { field: 'userId', max: 80, allowEmpty: false })
  };
}

/* ------------------------------------------------------------------ */
/* Estado / modelos / prueba                                           */
/* ------------------------------------------------------------------ */

async function status(ctx) {
  const probe = queryBool(ctx, 'probe', false);
  const statusPayload = await llmStatus({ probe });
  return respond(ctx, 200, statusPayload);
}

async function models(ctx) {
  return respond(ctx, 200, await llmModels());
}

async function testRoute(ctx) {
  const body = await bodyOf(ctx);
  const input = assertAllowed(body, TEST_FIELDS, { allowEmpty: true });
  let probe = 'chat';
  if (input.probe !== undefined) {
    probe = String(input.probe).trim().toLowerCase();
    if (!['chat', 'health'].includes(probe)) throw new ValidationError('probe', 'INVALID_VALUE', 'probe debe ser chat o health.');
  }
  const result = await llmTest({ probe });
  invalidateHealthCache();
  return respond(ctx, 200, result);
}

/* ------------------------------------------------------------------ */
/* Configuración y consumo                                             */
/* ------------------------------------------------------------------ */

async function configRoute(ctx) {
  const body = await bodyOf(ctx);
  const state = await updateLlmConfig(body);
  invalidateHealthCache();
  // Sin sondeo de red aquí: guardar la configuración debe ser instantáneo.
  // La UI llama a GET /api/llm/status?probe=1 o POST /api/llm/test después.
  return respond(ctx, 200, {
    ok: true,
    config: state,
    profiles: resolveAllProfiles(resolveLlmConfig().profiles)
  });
}

function usageRoute(ctx) {
  const days = queryInt(ctx, 'days', 7, { min: 1, max: 30 });
  const config = resolveLlmConfig();
  const snapshot = usageSnapshot({ days, limits: config.limits });
  return respond(ctx, 200, {
    ...snapshot,
    enabled: config.enabled,
    killSwitch: config.killSwitch,
    configured: config.configured,
    provider: config.kind,
    profiles: resolveAllProfiles(config.profiles),
    config: publicConfig()
  });
}

/* ------------------------------------------------------------------ */
/* Chat / workflows / autocompletado                                   */
/* ------------------------------------------------------------------ */

async function chatRoute(ctx) {
  const body = await bodyOf(ctx);
  const input = validateChat(body);
  const userId = userOf(ctx, body);
  const result = await llmChat({
    messages: input.messages,
    profile: input.profile,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    requireLlm: input.requireLlm,
    scope: `${input.channel}:${userId}`,
    cache: input.cache,
    workflow: input.profile
  });
  return respond(ctx, 200, {
    reply: result.text,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage,
    fallback: result.fallback,
    cached: result.cached,
    profile: result.profile,
    error: result.error,
    errorCode: result.errorCode
  });
}

async function workflowRoute(ctx) {
  const body = await bodyOf(ctx);
  const input = assertAllowed(body, WORKFLOW_FIELDS);
  const name = text(input.workflow, { field: 'workflow', required: true, max: 40, allowEmpty: false }).toLowerCase();
  const normalized = normalizeProfileName(name);
  if (!normalized || !WORKFLOW_NAMES.includes(normalized)) {
    throw new ValidationError('workflow', 'INVALID_VALUE', `Workflow desconocido. Válidos: ${WORKFLOW_NAMES.join(', ')}.`);
  }
  let payload = {};
  if (input.input !== undefined) {
    if (!isPlainObject(input.input)) throw new ValidationError('input', 'INVALID_TYPE', 'input debe ser un objeto.');
    if (JSON.stringify(input.input).length > 8_000) throw new ValidationError('input', 'TOO_LONG', 'input supera 8000 caracteres.');
    payload = input.input;
  }
  if (input.text !== undefined) payload.text = text(input.text, { field: 'text', max: 2000, allowEmpty: false });
  const result = await runWorkflow(normalized, {
    input: payload,
    scope: `${channelOf(input)}:${userOf(ctx, input)}`,
    channel: channelOf(input),
    userId: userOf(ctx, input)
  });
  const { facts, ...rest } = result;
  return respond(ctx, 200, rest);
}

async function autocompleteRoute(ctx) {
  const body = await bodyOf(ctx);
  const input = validateAutocomplete(body);
  const userId = userOf(ctx, body);
  const result = await autocompleteFields({
    text: input.text,
    channel: input.channel,
    userId,
    scope: `${input.channel}:${userId}`
  });
  return respond(ctx, 200, result);
}

/* ------------------------------------------------------------------ */
/* Agente                                                              */
/* ------------------------------------------------------------------ */

async function agentChatRoute(ctx) {
  const body = await bodyOf(ctx);
  const input = validateAgent(body);
  const userId = userOf(ctx, { userId: input.userId });
  const result = await handleAgentChat({
    text: input.text,
    channel: input.channel,
    userId,
    dryRun: input.dryRun,
    confirmToken: input.confirmToken,
    confirm: input.confirm,
    deadlineMs: input.deadlineMs,
    scope: `${input.channel}:${userId}`
  });
  return respond(ctx, 200, result);
}

async function confirmRoute(ctx) {
  const body = await bodyOf(ctx);
  const input = assertAllowed(body, CONFIRM_FIELDS);
  const rawToken = input.token !== undefined ? input.token : input.confirmCode;
  const token = text(rawToken, { field: input.token !== undefined ? 'token' : 'confirmCode', required: true, max: 80, allowEmpty: false });
  const channel = channelOf(input);
  const userId = userOf(ctx, input);
  const result = await confirmAgentAction({
    token,
    channel,
    userId,
    dryRun: input.dryRun === undefined ? false : boolean(input.dryRun, { field: 'dryRun', required: true }) === true
  });
  return respond(ctx, 200, result);
}

function actionsRoute(ctx) {
  const limit = queryInt(ctx, 'limit', 50, { min: 1, max: 200 });
  const items = listActions(limit);
  return respond(ctx, 200, { items, count: items.length });
}

function conversationsRoute(ctx) {
  const limit = queryInt(ctx, 'limit', 20, { min: 1, max: 100 });
  const channel = queryString(ctx, 'channel');
  const items = listConversations({ limit, channel });
  return respond(ctx, 200, { items, count: items.length });
}

function conversationGet(ctx) {
  const rawKey = paramOf(ctx, 'key');
  const key = rawKey && rawKey.includes(':') ? rawKey : conversationKey(queryString(ctx, 'channel', 'web'), rawKey || 'local');
  const limit = queryInt(ctx, 'limit', 12, { min: 1, max: 50 });
  const messages = getHistory(key, { limit });
  return respond(ctx, 200, { key, messages, count: messages.length });
}

async function conversationDelete(ctx) {
  const rawKey = paramOf(ctx, 'key');
  const key = rawKey && rawKey.includes(':') ? rawKey : conversationKey(queryString(ctx, 'channel', 'web'), rawKey || 'local');
  const result = await clearConversation(key);
  return respond(ctx, 200, { ok: result.ok === true, key });
}

function historyRoute(ctx) {
  const channel = queryString(ctx, 'channel', 'web');
  const userId = queryString(ctx, 'userId');
  const limit = queryInt(ctx, 'limit', 12, { min: 1, max: 50 });
  return respond(ctx, 200, agentHistory({ channel, userId: userOf(ctx, { userId }), limit }));
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

export const routes = [
  { method: 'GET', path: '/api/llm/status', name: 'llm.status', handler: route(status) },
  { method: 'GET', path: '/api/llm/models', name: 'llm.models', handler: route(models) },
  { method: 'POST', path: '/api/llm/chat', name: 'llm.chat', handler: route(chatRoute) },
  { method: 'POST', path: '/api/llm/test', name: 'llm.test', handler: route(testRoute) },
  { method: 'POST', path: '/api/llm/config', name: 'llm.config', handler: route(configRoute) },
  { method: 'GET', path: '/api/llm/usage', name: 'llm.usage', handler: route(usageRoute) },
  { method: 'POST', path: '/api/llm/workflow', name: 'llm.workflow', handler: route(workflowRoute) },
  { method: 'POST', path: '/api/llm/autocomplete', name: 'llm.autocomplete', handler: route(autocompleteRoute) },
  { method: 'POST', path: '/api/agent/chat', name: 'agent.chat', handler: route(agentChatRoute) },
  { method: 'POST', path: '/api/agent/command', name: 'agent.command', handler: route(agentChatRoute) },
  { method: 'POST', path: '/api/agent/autocomplete', name: 'agent.autocomplete', handler: route(autocompleteRoute) },
  { method: 'POST', path: '/api/agent/confirm', name: 'agent.confirm', handler: route(confirmRoute) },
  { method: 'GET', path: '/api/agent/actions', name: 'agent.actions', handler: route(actionsRoute) },
  { method: 'GET', path: '/api/agent/history', name: 'agent.history', handler: route(historyRoute) },
  { method: 'GET', path: '/api/agent/conversations', name: 'agent.conversations', handler: route(conversationsRoute) },
  { method: 'GET', path: '/api/agent/conversations/:key', name: 'agent.conversation', handler: route(conversationGet) },
  { method: 'DELETE', path: '/api/agent/conversations/:key', name: 'agent.conversation.delete', handler: route(conversationDelete) }
];

export default { name, priority, routes };

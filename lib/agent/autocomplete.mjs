/**
 * Autocompletado de campos a partir de una frase libre.
 *
 * Flujo: frase → LLM (perfil `autocomplete`) → JSON → validación determinista
 * (`sanitizeProposal`) → propuesta editable. Sin LLM funciona igual con las
 * pistas deterministas y valores por defecto. NUNCA guarda: el usuario confirma
 * en la UI y la cita se crea con `POST /api/agenda`.
 */
import { store } from '../store.mjs';
import { timezoneOf } from '../agenda/time.mjs';
import { extractJson, llmComplete, localContext } from '../llm/client.mjs';
import { traceLlm } from '../llm/trace.mjs';
import { buildAutocompleteSystemPrompt, buildAutocompleteUserMessage } from './prompts.mjs';
import { sanitizeProposal } from './schema.mjs';

/** Propuesta determinista (sin LLM) usando solo pistas del texto. */
export function deterministicProposal(text, { todayKey, timezone, settings = {} } = {}) {
  return sanitizeProposal({}, { text, todayKey, timezone, settings });
}

/**
 * Genera una propuesta de campos validada.
 * @param {{text:string, channel?:string, userId?:string, scope?:string, signal?:AbortSignal, deadlineMs?:number}} options
 */
export async function autocompleteFields({ text, channel = 'web', userId = 'local', scope, signal, deadlineMs } = {}) {
  const settings = store.get().settings || {};
  const tz = timezoneOf(settings);
  const context = localContext();
  const todayKey = context.today;
  const clean = String(text || '').trim();
  if (!clean) {
    const proposal = sanitizeProposal({}, { text: '', todayKey, timezone: tz, settings });
    return {
      proposal: proposal.fields,
      fields: proposal.fields,
      suggestedRequest: buildCreateRequest(proposal.fields),
      warnings: ['escribe una frase para generar la propuesta'],
      validated: true,
      requiresConfirmation: true,
      saved: false,
      source: 'fallback',
      provider: null,
      model: null,
      fallback: true,
      latencyMs: null,
      usage: null,
      error: 'LLM_BAD_REQUEST',
      errorCode: 'LLM_BAD_REQUEST',
      profile: 'autocomplete'
    };
  }

  const result = await llmComplete({
    profile: 'autocomplete',
    messages: [
      { role: 'system', content: buildAutocompleteSystemPrompt(context) },
      { role: 'user', content: buildAutocompleteUserMessage(clean) }
    ],
    json: true,
    fallback: null,
    scope: scope || `${channel}:${userId}`,
    signal,
    deadlineMs,
    workflow: 'autocomplete'
  });

  let proposal = null;
  let error = null;
  if (result.ok && result.text) {
    const parsed = extractJson(result.text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      proposal = sanitizeProposal(parsed, { text: clean, todayKey, timezone: tz, settings });
    } else {
      error = 'LLM_JSON_INVALID';
    }
  }
  if (!proposal) proposal = sanitizeProposal({}, { text: clean, todayKey, timezone: tz, settings });

  const source = result.ok && !error ? 'llm' : 'fallback';
  traceLlm({
    workflow: 'autocomplete',
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    latencyMs: result.latencyMs,
    tokens: result.usage ? result.usage.totalTokens : null,
    chars: clean.length,
    fallback: result.fallback || source !== 'llm',
    errorCode: result.errorCode || error,
    detail: result.error || error
  });

  return {
    proposal: proposal.fields,
    fields: proposal.fields,
    suggestedRequest: buildCreateRequest(proposal.fields),
    warnings: proposal.warnings,
    meta: proposal.meta,
    validated: true,
    requiresConfirmation: true,
    saved: false,
    source,
    provider: result.provider,
    model: result.model,
    fallback: result.fallback === true || source !== 'llm',
    latencyMs: result.latencyMs,
    usage: result.usage,
    error: result.error || error,
    errorCode: result.errorCode || error,
    profile: 'autocomplete'
  };
}

/**
 * Construye el cuerpo exacto para `POST /api/agenda` (el usuario confirma).
 * @param {object} fields
 */
export function buildCreateRequest(fields = {}) {
  const request = {
    title: fields.title,
    type: fields.type,
    priority: fields.priority,
    impact: fields.impact,
    urgency: fields.urgency,
    energy: fields.energy,
    durationMin: fields.durationMin,
    reminderMin: fields.reminderMin,
    notes: fields.notes,
    deepFocus: fields.deepFocus === true
  };
  if (fields.context) request.context = fields.context;
  if (fields.location) request.location = fields.location;
  if (Array.isArray(fields.attendees) && fields.attendees.length) request.attendees = fields.attendees;
  if (fields.date) request.date = fields.date;
  else if (fields.start) request.start = fields.start;
  if (fields.time) request.time = fields.time;
  else if (fields.end) request.end = fields.end;
  for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
  return request;
}

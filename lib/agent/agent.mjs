/**
 * Agente de agenda: intérprete LLM (protocolo JSON) + ejecución determinista.
 *
 * Contrato de comportamiento:
 *   - Los comandos históricos (HOY, CAPTURA, HECHO, POSPONER/MOVER, FOCO,
 *     CIERRE, SEMANA, balance) se resuelven SIEMPRE de forma determinista con el
 *     asistente de `lib/assistant.mjs` (compatibilidad exacta).
 *   - El lenguaje libre se interpreta con el perfil LLM `intent` (JSON) y se
 *     valida con `schema.mjs`; si el LLM no está disponible se usa el parser
 *     local. En ambos casos la ejecución la hace `tools.mjs`.
 *   - Nunca se inventan fechas: si falta un dato, se pregunta.
 *   - Las acciones destructivas piden confirmación explícita (pendiente con
 *     token; se confirma con «sí» o con `confirmToken`).
 *   - Máximo 3 iteraciones lógicas (interpretar → ejecutar → resumir) y
 *     presupuesto total de 25 s por petición.
 */
import { store } from '../store.mjs';
import { dateKeyOfIso, formatShortDate, formatTime, timezoneOf } from '../agenda/time.mjs';
import { dashboard as computeDashboard } from '../assistant.mjs';
import { extractJson, llmComplete, localContext } from '../llm/client.mjs';
import { runWorkflow } from '../llm/workflows.mjs';
import { recordAction } from '../llm/usage.mjs';
import { traceLlm, redactPii } from '../llm/trace.mjs';
import { buildIntentSystemPrompt, buildIntentUserMessage } from './prompts.mjs';
import {
  ACTION_CATALOG, isDestructive, normalizeAction, requiresConfirmation, validateIntent
} from './schema.mjs';
import {
  applySlotChoice, resolveEventReference, resolveInboxReference, resolveRoutineReference, runTool
} from './tools.mjs';
import {
  conversationKey, getPending, newConfirmToken, readConversation, saveConversation
} from './memory.mjs';
import {
  assistantHasPending, dispatchGuaranteed, guaranteedKind, helpReply, parseLocalIntent
} from './fallback.mjs';
import { isAffirmative, isNegative } from './context.mjs';
import { consultTeam, consultTeamDeep, shouldConsult } from './team.mjs';
import { organizationSummary } from '../studio/org.mjs';
export const AGENT_MAX_ITERATIONS = 3;
export const AGENT_BUDGET_MS = 25_000;

function settingsNow() {
  const data = store.get();
  return { data, settings: data.settings || {}, timezone: timezoneOf(data.settings || {}) };
}

function when(iso, tz) {
  try {
    return `${formatShortDate(iso, tz)} ${formatTime(iso, tz)}`;
  } catch {
    return String(iso || '');
  }
}

function pendingPublic(pending) {
  if (!pending) return null;
  return {
    type: pending.type,
    action: pending.action || pending.toolAction || null,
    summary: pending.summary || null,
    // OJO: el serializador HTTP enmascara cualquier propiedad llamada `*token`;
    // por eso el token se publica como `confirmCode` (y se acepta igual en /api/agent/confirm).
    confirmCode: pending.token || null,
    requiresConfirmation: pending.type === 'confirm',
    options: Array.isArray(pending.slots)
      ? pending.slots.map((slot, index) => ({ index: index + 1, start: slot.start, end: slot.end }))
      : Array.isArray(pending.candidates)
        ? pending.candidates.map((candidate, index) => ({ index: index + 1, id: candidate.id, title: candidate.title, label: candidate.label }))
        : null,
    createdAt: pending.createdAt || null
  };
}

/* ------------------------------------------------------------------ */
/* Interpretación                                                      */
/* ------------------------------------------------------------------ */

async function interpretWithLlm(text, { conversation, channel, userId, scope, signal, deadlineMs }) {
  const context = localContext();
  const result = await llmComplete({
    profile: 'intent',
    messages: [
      { role: 'system', content: buildIntentSystemPrompt(context) },
      {
        role: 'user',
        content: buildIntentUserMessage({
          text,
          history: conversation.messages.slice(-6),
          pending: conversation.pending
        })
      }
    ],
    json: true,
    fallback: null,
    scope,
    signal,
    deadlineMs,
    // El presupuesto se contabiliza bajo el perfil `intent` (así se puede
    // limitar por workflow desde POST /api/llm/config).
    workflow: 'intent'
  });
  traceLlm({
    workflow: 'agent',
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    fallback: result.fallback,
    latencyMs: result.latencyMs,
    tokens: result.usage ? result.usage.totalTokens : null,
    chars: text.length,
    errorCode: result.errorCode,
    detail: result.error
  });
  if (!result.ok || !result.text) {
    return { used: false, provider: result.provider, model: result.model, latencyMs: result.latencyMs, usage: result.usage, attempts: result.attempts || [], errorCode: result.errorCode || 'LLM_UNAVAILABLE', error: result.error || null, raw: null };
  }
  const parsed = extractJson(result.text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { used: false, provider: result.provider, model: result.model, latencyMs: result.latencyMs, usage: result.usage, attempts: result.attempts || [], errorCode: 'LLM_JSON_INVALID', error: 'El proveedor LLM no devolvió un JSON válido.', raw: null };
  }
  return { used: true, provider: result.provider, model: result.model, latencyMs: result.latencyMs, usage: result.usage, attempts: result.attempts || [], errorCode: null, error: null, raw: parsed, cached: result.cached === true };
}

/* ------------------------------------------------------------------ */
/* Resúmenes enriquecidos                                              */
/* ------------------------------------------------------------------ */

async function polishSummary(action, result, ctx) {
  try {
    if (action === 'listar_dia') {
      const date = result?.data?.date || null;
      const polished = await runWorkflow('schedule_summary', { input: { date }, scope: ctx.scope, channel: ctx.channel, userId: ctx.userId, deadlineMs: ctx.remainingMs });
      return polished?.text || null;
    }
    if (action === 'resumen_semana') {
      const polished = await runWorkflow('weekly', { scope: ctx.scope, channel: ctx.channel, userId: ctx.userId, deadlineMs: ctx.remainingMs });
      return polished?.text || null;
    }
  } catch {
    /* el texto determinista es suficiente */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Confirmaciones                                                      */
/* ------------------------------------------------------------------ */

function describeIntentForConfirmation(action, args, ctx) {
  const tz = ctx.timezone;
  const label = ACTION_CATALOG[action]?.label || action;
  if (action === 'mover_cita') {
    const resolved = resolveEventReference({ id: args.id, query: args.query });
    if (!resolved.ok) return resolved;
    const event = resolved.event;
    let target = '';
    if (Number.isFinite(Number(args.shiftMinutes))) {
      const minutes = Number(args.shiftMinutes);
      target = `${minutes >= 0 ? 'atrasarla' : 'adelantarla'} ${Math.abs(minutes)} min`;
    } else if (args.date && args.time) {
      target = `moverla a ${args.date} ${args.time}`;
    } else if (args.time) {
      target = `moverla a las ${args.time} del mismo día`;
    } else {
      target = 'moverla';
    }
    return {
      ok: true,
      summary: `${target}: ${event.id} «${event.title}» (actualmente ${when(event.start, tz)}).`,
      event
    };
  }
  if (action === 'cancelar_cita' || action === 'completar_cita') {
    const resolved = resolveEventReference({ id: args.id, query: args.query });
    if (!resolved.ok) return resolved;
    const event = resolved.event;
    return {
      ok: true,
      summary: `${action === 'cancelar_cita' ? 'cancelar' : 'marcar como Hecho'} ${event.id} «${event.title}» del ${when(event.start, tz)}.`,
      event
    };
  }
  if (action === 'editar_rutina' || action === 'activar_rutina') {
    const resolved = resolveRoutineReference({ id: args.id, query: args.query }, ctx);
    if (!resolved.ok) return resolved;
    const routine = resolved.routine;
    if (action === 'activar_rutina') {
      const goingActive = args.active === undefined ? !routine.active : args.active === true;
      return { ok: true, summary: `${goingActive ? 'activar' : 'pausar'} la rutina ${routine.id} «${routine.title}».`, routine };
    }
    const fields = Object.keys(args).filter((key) => !['id', 'query'].includes(key));
    return { ok: true, summary: `editar la rutina ${routine.id} «${routine.title}» (${fields.join(', ') || 'sin cambios'}).`, routine };
  }
  if (action === 'convertir_inbox') {
    const resolved = resolveInboxReference({ id: args.id, query: args.query });
    if (!resolved.ok) return resolved;
    return { ok: true, summary: `convertir la captura ${resolved.item.id} «${String(resolved.item.input).slice(0, 80)}» en una cita.`, item: resolved.item };
  }
  if (action === 'enviar_correo') return { ok: true, summary: `preparar un correo a ${args.to || '(sin destinatario)'} con asunto «${args.subject || 'Agenda Copilot'}» para que el jefe lo apruebe en la Oficina.` };
  if (action === 'enviar_whatsapp') return { ok: true, summary: `preparar este WhatsApp para que el jefe lo apruebe en la Oficina: «${String(args.text || '').slice(0, 100)}».` };
  if (action === 'enviar_telegram') return { ok: true, summary: `preparar este mensaje de Telegram para que el jefe lo apruebe en la Oficina: «${String(args.text || '').slice(0, 100)}».` };
  if (action === 'enviar_documento') return { ok: true, summary: `preparar el envío del documento ${args.docId || '(sin DOC)'} para que el jefe lo apruebe en la Oficina.` };
  return { ok: true, summary: `${label.toLowerCase()}.` };
}

function pendingFromResolutionFailure(action, args, failure, ctx) {
  if (!failure || failure.code !== 'AMBIGUOUS') return null;
  const candidates = Array.isArray(failure.candidates) ? failure.candidates : [];
  if (!candidates.length) return null;
  return {
    type: 'choose',
    toolAction: action,
    action,
    args,
    candidates,
    token: newConfirmToken(),
    summary: 'Elige la opción correcta',
    source: ctx.intentSource || 'deterministic',
    createdAt: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                           */
/* ------------------------------------------------------------------ */

function buildConflictPending(action, args, result, ctx) {
  if (!Array.isArray(result.slots) || !result.slots.length) return null;
  return {
    type: 'choose',
    toolAction: action,
    action,
    args,
    agendaId: result.event?.id || args.id || null,
    slots: result.slots,
    allowUnverified: result.allowUnverified === true,
    token: newConfirmToken(),
    summary: 'Elige una alternativa disponible',
    source: ctx.intentSource || 'deterministic',
    createdAt: new Date().toISOString()
  };
}

async function explainConflictResult(action, result, ctx) {
  const payload = {
    reason: result.message,
    conflicts: result.conflicts || [],
    slots: result.slots || [],
    event: result.event || null
  };
  try {
    const explained = await runWorkflow('conflict', { input: payload, scope: ctx.scope, channel: ctx.channel, userId: ctx.userId, deadlineMs: ctx.remainingMs });
    if (explained?.text) return explained.text;
  } catch {
    /* se usa el mensaje determinista */
  }
  return result.message;
}

async function executeIntent(intent, ctx, { confirmed = false } = {}) {
  const action = intent.action;
  if (action === 'preguntar') {
    return { reply: intent.question || '¿Me das más detalle?', intent, result: null, pending: null };
  }
  const args = intent.args || {};
  const label = ACTION_CATALOG[action]?.label || action;

  if (!confirmed && ctx.dryRun !== true && requiresConfirmation(action)) {
    const preview = describeIntentForConfirmation(action, args, ctx);
    if (!preview.ok) {
      const pending = pendingFromResolutionFailure(action, args, preview, ctx);
      return { reply: preview.message, intent, result: preview, pending };
    }
    const pending = {
      type: 'confirm',
      action,
      args,
      summary: preview.summary,
      token: newConfirmToken(),
      source: ctx.intentSource || 'deterministic',
      createdAt: new Date().toISOString()
    };
    return {
      reply: `⚠️ Vas a ${preview.summary}\n¿Confirmas? Responde «sí» para ejecutar o «no» para cancelar.`,
      intent,
      result: null,
      pending,
      requiresConfirmation: true
    };
  }

  const result = await runTool(action, args, {
    ...ctx,
    dryRun: ctx.dryRun === true
  });

  if (!result.ok) {
    if (result.code === 'AMBIGUOUS') {
      const pending = pendingFromResolutionFailure(action, args, result, ctx);
      return { reply: result.message, intent, result, pending };
    }
    if (result.code === 'CONFLICT' || result.code === 'FREEBUSY_UNAVAILABLE' || (Array.isArray(result.slots) && result.slots.length)) {
      const explanation = await explainConflictResult(action, result, ctx);
      const slotText = Array.isArray(result.slots) && result.slots.length
        ? `\nAlternativas:\n${result.slots.map((slot, index) => `${index + 1}) ${when(slot.start, ctx.timezone)}`).join('\n')}\nResponde 1, 2 o 3 para aplicarla.`
        : '';
      const pending = buildConflictPending(action, args, result, ctx);
      return { reply: `${explanation}${slotText}`, intent, result, pending };
    }
    const plainAction = ['crear_tarea', 'cerrar_tarea', 'reabrir_tarea', 'listar_tareas', 'crear_meet', 'enviar_correo', 'enviar_whatsapp', 'enviar_telegram', 'enviar_documento'].includes(action);
    return { reply: plainAction ? result.message : `⚠️ ${result.message}`, intent, result, pending: null };
  }

  let reply = result.message;
  if (['listar_dia', 'resumen_semana'].includes(action) && ctx.dryRun !== true) {
    const polished = await polishSummary(action, result, ctx);
    if (polished) reply = polished;
  }
  return { reply, intent, result, pending: null, label };
}

async function executePending(pending, ctx) {
  ctx.intentSource = pending.source || 'deterministic';
  if (pending.type === 'confirm') {
    return executeIntent({ action: pending.action, args: pending.args || {}, confidence: 1, issues: [] }, ctx, { confirmed: true });
  }
  if (pending.type === 'choose') {
    if (Array.isArray(pending.slots)) {
      const index = Number(ctx.choiceIndex) - 1;
      const result = await applySlotChoice(pending, index, ctx);
      if (!result.ok) return { reply: `⚠️ ${result.message}`, intent: null, result, pending: null };
      return { reply: result.message, intent: { action: pending.toolAction, args: pending.args, confidence: 1 }, result, pending: null };
    }
    if (Array.isArray(pending.candidates)) {
      const index = Number(ctx.choiceIndex) - 1;
      const candidate = pending.candidates[index];
      if (!candidate) return { reply: 'Esa opción ya no está disponible. Repite la instrucción, por favor.', intent: null, result: null, pending: null };
      const args = { ...(pending.args || {}), id: candidate.id };
      delete args.query;
      return executeIntent({ action: pending.action || pending.toolAction, args, confidence: 1, issues: [] }, ctx, { confirmed: false });
    }
  }
  return { reply: 'No hay una acción pendiente que ejecutar.', intent: null, result: null, pending: null };
}

/* ------------------------------------------------------------------ */
/* Entrada principal                                                   */
/* ------------------------------------------------------------------ */

/**
 * Comandos explícitos de tareas/Meet en los que el parser determinista debe
 * mandar aunque el LLM proponga otra acción (evita perder la ejecución real).
 */
function shouldPreferDeterministic(text, localIntent, llmIntent) {
  if (!localIntent || localIntent.action === 'preguntar') return false;
  if (!llmIntent || localIntent.action === llmIntent.action) return false;
  if (['cerrar_tarea', 'reabrir_tarea'].includes(localIntent.action)
    && /^(?:cierra|cerrar|completa|completar|termina|terminar|reabre|reabrir|abre|abrir)\s+(?:la\s+)?tarea\b|^(?:cierra|reabre)\s+tk-/i.test(text)) {
    return true;
  }
  if (localIntent.action === 'crear_meet' && /\b(virtual|videollamada|video\s*llamada|meet|google\s*meet)\b/i.test(text)) return true;
  if (localIntent.action === 'crear_tarea' && /^(?:crea|crear|añade|anade|agrega|agregar|nueva?|nuevo)\s+(?:una\s+|un\s+)?tarea\b|^asignar\s+tarea\b/i.test(text)) return true;
  if (localIntent.action === 'listar_tareas' && /(?:\bque|\bqué)\s+tareas|mis tareas|lista de tareas|tareas pendientes|tareas tengo|ver tareas/i.test(text)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Charla natural                                                      */
/* ------------------------------------------------------------------ */

/**
 * Detecta mensajes de conversación (saludo, hora, fecha, capacidades…) para
 * responder con lenguaje natural en lugar de volcar la agenda. Devuelve null
 * si el texto parece una instrucción de agenda (esas van por el motor).
 */
function conversationalKind(raw) {
  const low = String(raw || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
  if (!low || low.length > 160) return null;
  if (/\b(cita|citas|agenda|reunion|reuniones|rutina|rutinas|tarea|tareas|correo|correos|whatsapp|telegram|programa|programar|mueve|mover|cancela|cancelar|crea|crear|borra|borrar|elimina|reprograma|reprogramar|meet)\b/.test(low)) {
    return null;
  }
  if (/\b(que hora|hora es|hora tienes|me dices la hora|hora actual|son las)\b/.test(low)) return 'hora';
  if (/\b(que dia es|fecha de hoy|fecha es|a que dia estamos|que fecha)\b/.test(low)) return 'fecha';
  if (/\b(que puedes hacer|para que sirves|capacidades|que sabes hacer|en que me puedes ayudar)\b/.test(low)) return 'capacidades';
  if (/\b(organizacion|organigrama|equipo|equipos|agentes|roles|quienes son|quien forma|quienes forman|que equipo)\b/.test(low)) return 'organizacion';
  if (/^(gracias|muchas gracias|mil gracias|te agradezco)\b/.test(low)) return 'gracias';
  if (/\b(como estas|que tal estas|como va todo|quien eres|quien sos)\b/.test(low)) return 'estado';
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|saludos|que tal)\b/.test(low)) return 'saludo';
  if (/^(ayuda|help)\b/.test(low)) return 'capacidades';
  return null;
}

function nextEventText(ctx) {
  try {
    const data = ctx.data || {};
    const tz = ctx.timezone;
    const todayKey = dateKeyOfIso(new Date().toISOString(), tz);
    const nowIso = new Date().toISOString();
    const today = (data.agenda || [])
      .filter((event) => event && event.start && String(event.start).startsWith(todayKey))
      .filter((event) => String(event.status || '') !== 'CANCELADA' && String(event.status || '') !== 'COMPLETADA')
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const next = today.find((event) => String(event.start) >= nowIso);
    if (next) {
      const clock = formatTime(next.start, tz).replace(/\.$/, '');
      return `Lo siguiente es «${next.title}» a las ${clock}.`;
    }
    if (today.length) return 'No te quedan citas hoy.';
    return 'Hoy no tienes citas en la agenda.';
  } catch {
    return '';
  }
}

function deterministicNaturalReply(kind, ctx) {
  const now = new Date();
  const iso = now.toISOString();
  const tz = ctx.timezone;
  const clock = formatTime(iso, tz);
  const day = formatShortDate(iso, tz);
  const next = nextEventText(ctx);
  const tail = next ? ` ${next}` : '';
  switch (kind) {
    case 'hora':
      return `Son las ${clock} del ${day} (${tz}).${tail}`;
    case 'fecha':
      return `Hoy es ${day}.${tail}`;
    case 'capacidades':
      return 'Puedo agendar, mover y cancelar citas, crear rutinas, capturar ideas, cerrar tareas, agendar reuniones con Meet y preparar correos o mensajes que tú apruebas. Dime qué necesitas y lo dejo listo.';
    case 'gracias':
      return 'Con gusto, Héctor. Aquí sigo cuando me necesites.';
    case 'estado':
      return `Todo en orden por aquí. Son las ${clock} del ${day}.${tail}`;
    case 'organizacion': {
      const org = organizationSummary();
      if (!org.count) return 'La organización todavía no tiene equipos cargados. Puedes crearlos en Organización.';
      const teams = org.teams.map((team) => `${team.name} (${team.members})`).join(', ');
      return `La oficina tiene ${org.count} perfiles en ${org.teams.length} equipos: ${teams}. Puedo decirte qué hace cada rol o preparar un encargo con el equipo que elijas.`;
    }
    default:
      return `Hola, Héctor. Son las ${clock} del ${day}.${tail} ¿Te doy el plan del día o ajustamos algo?`;
  }
}

/** Respuesta conversacional: LLM natural cuando está disponible; si no, texto natural determinista. */
async function polishActionReply({ reply, team, text, ctx }) {
  if (!reply || String(reply).length < 12) return reply;
  if (ctx.remainingMs < 1_800) return reply;
  const ids = Array.from(new Set(String(reply).match(/\b(?:AG|OF|IN|R|MT|TK|DOC)[-\s]?\d[\w-]*/gi) || []));
  try {
    const result = await llmComplete({
      profile: 'chat',
      messages: [
        {
          role: 'system',
          content: `Eres el Chief of Staff de la oficina de Héctor Fabio Riascos C. Redacta en 1 a 3 frases naturales, en español, cálidas y profesionales, lo que acabas de hacer. Sin listas ni markdown pesado.
Conserva EXACTAMENTE estos identificadores si aparecen: ${ids.join(', ') || '(ninguno)'}. No inventes datos, fechas, importes ni compromisos, y no digas que enviaste algo: todo pasa por su aprobación.
Hecho: ${JSON.stringify({ resultado: String(reply).slice(0, 600), equipo: (team?.roles || []).map((role) => ({ rol: role.nombre, nota: role.note })) })}`
        },
        { role: 'user', content: String(text).slice(0, 500) }
      ],
      json: false,
      fallback: null,
      scope: ctx.scope,
      deadlineMs: ctx.remainingMs,
      workflow: 'chat'
    });
    if (!result.ok || !result.text) return reply;
    const candidate = String(result.text).trim();
    if (!candidate) return reply;
    for (const id of ids) {
      if (!candidate.toUpperCase().includes(String(id).toUpperCase())) return reply;
    }
    return candidate;
  } catch {
    return reply;
  }
}

async function naturalReply(text, kind, ctx) {
  const facts = {
    ahora: `${formatShortDate(new Date().toISOString(), ctx.timezone)} ${formatTime(new Date().toISOString(), ctx.timezone)}`,
    zona: ctx.timezone,
    proxima: nextEventText(ctx) || null,
    modo: ctx.settings?.office?.mode || 'asistido',
    canal: ctx.voice ? 'nota de voz transcrita' : 'texto',
    organizacion: organizationSummary()
  };
  if (ctx.remainingMs > 2_500) {
    try {
      const result = await llmComplete({
        profile: 'chat',
        messages: [
          {
            role: 'system',
            content: `Eres el Chief of Staff de la oficina de Héctor Fabio Riascos C. Hablas español natural, cálido y profesional, en primera persona, sin sonar a robot ni a formulario.
Responde al mensaje del usuario en 1 a 4 frases (máximo 70 palabras). Sin tablas ni listas largas; puedes usar **negrita** con moderación.
Hechos verificados (no inventes otros): ${JSON.stringify(facts)}
Si preguntan la hora o la fecha, respóndela con esos hechos. Si preguntan qué puedes hacer, resume: agendar y mover citas, rutinas, capturas, tareas, reuniones con Meet y preparar correos o mensajes que el jefe aprueba. Nunca digas que ya enviaste algo: todo pasa por su aprobación.
Si el canal es una nota de voz, responde con calidez y naturalidad, confirma en una frase lo que entendiste y termina con una propuesta concreta o una pregunta útil. No menciones que fue transcrita salvo que sea necesario.
Si preguntan por la organización o el equipo, usa el bloque "organizacion" como fuente: menciona los equipos y los roles reales, sin inventar personas ni capacidades.`
          },
          { role: 'user', content: String(text).slice(0, 1500) }
        ],
        json: false,
        fallback: null,
        scope: ctx.scope,
        deadlineMs: ctx.remainingMs,
        workflow: 'chat'
      });
      if (result.ok && result.text && result.text.trim()) {
        return {
          reply: result.text.trim(),
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          llmUsed: true
        };
      }
    } catch {
      /* cae al texto natural determinista */
    }
  }
  return {
    reply: deterministicNaturalReply(kind, ctx),
    provider: null,
    model: null,
    usage: null,
    llmUsed: false
  };
}

/**
 * Procesa un mensaje del usuario y gestiona la agenda.
 *
 * @param {{text:string, channel?:string, userId?:string, dryRun?:boolean, confirmToken?:string|null, confirm?:boolean, scope?:string, ip?:string, signal?:AbortSignal, deadlineMs?:number}} options
 * @returns {Promise<object>} respuesta con `reply`, `actions`, `pending`, `provider`, `fallback`…
 */
export async function handleAgentChat(options = {}) {
  const started = Date.now();
  const text = String(options.text || '').trim();
  const channel = String(options.channel || 'web').slice(0, 40);
  const userId = String(options.userId || 'local').slice(0, 80);
  const dryRun = options.dryRun === true;
  const key = conversationKey(channel, userId);
  const { settings, timezone } = settingsNow();
  const todayKey = dateKeyOfIso(new Date().toISOString(), timezone);
  const scope = options.scope || `${channel}:${userId}`;
  const deadlineMs = Math.max(3_000, Number(options.deadlineMs) || AGENT_BUDGET_MS);
  const conversation = readConversation(key);
  const pending = getPending(key);

  const ctx = {
    data: store.get(),
    settings,
    timezone,
    channel,
    userId,
    voice: options.voice === true,
    dryRun,
    scope,
    choiceIndex: null,
    remainingMs: Math.max(2_000, deadlineMs - (Date.now() - started)),
    force: false,
    allowUnverified: false
  };

  /** Respuesta final homogénea. */
  const finish = async (payload = {}) => {
    const reply = String(payload.reply || '').trim() || 'Listo.';
    const source = payload.source || (payload.provider ? 'llm' : 'deterministic');
    let publicMeta = null;
    const metaSource = payload.meta && typeof payload.meta === 'object' ? payload.meta : payload.result?.meta;
    if (metaSource && typeof metaSource === 'object') {
      try { publicMeta = JSON.parse(JSON.stringify(metaSource)); } catch { publicMeta = null; }
    }
    const result = {
      reply,
      provider: payload.provider || null,
      model: payload.model || null,
      fallback: payload.fallback === undefined ? !payload.provider : payload.fallback === true,
      source,
      intent: payload.intent ? { action: payload.intent.action, args: payload.intent.args || {} } : null,
      actions: payload.result?.actions || payload.actions || [],
      pending: pendingPublic(payload.pending || null),
      ...(publicMeta ? { meta: publicMeta } : {}),
      dashboard: undefined,
      event: payload.result?.event || payload.event || null,
      conversation: { key, messages: 0 },
      latencyMs: Date.now() - started,
      usage: payload.usage || null,
      error: payload.error || null,
      errorCode: payload.errorCode || null,
      dryRun,
      iterations: payload.iterations || 1,
      choice: payload.choice || null
    };
    // Dashboard actualizado (barato y útil para la UI).
    try {
      result.dashboard = computeDashboard();
    } catch {
      result.dashboard = null;
    }
    // Memoria: se guarda el turno completo (salvo simulaciones).
    if (!dryRun) {
      const messages = [
        ...conversation.messages,
        { role: 'user', content: text, at: new Date().toISOString(), source: 'user' },
        { role: 'assistant', content: reply, at: new Date().toISOString(), source }
      ];
      const saved = await saveConversation(key, {
        messages,
        pending: payload.pending || null,
        lastIntent: payload.intent ? { action: payload.intent.action, args: payload.intent.args || {}, source, at: new Date().toISOString() } : conversation.lastIntent
      });
      result.conversation = { key, messages: saved?.conversation?.messages?.length || messages.length };
    } else {
      result.conversation = { key, messages: conversation.messages.length + 2 };
    }
    // Registro de acciones (auditable).
    if (payload.result || payload.pending || payload.intent) {
      recordAction({
        type: payload.intent?.action || 'agent',
        status: payload.result ? (payload.result.ok ? 'ok' : 'error') : 'pending_confirmation',
        agendaId: payload.result?.event?.id || null,
        detail: redactPii(reply).slice(0, 300),
        channel,
        user: userId,
        dryRun,
        source,
        intent: payload.intent?.action || null
      });
    }
    return result;
  };

  if (!text) {
    return finish({ reply: 'Escribe una instrucción.', source: 'deterministic', fallback: true });
  }

  /* 1. Pendiente de confirmación o elección ------------------------- */
  if (pending) {
    const tokenMatches = options.confirmToken && pending.token && String(options.confirmToken) === String(pending.token);
    if (tokenMatches || options.confirm === true) {
      ctx.choiceIndex = /^[1-9]$/.test(text) ? Number(text) : pending.choiceIndex || null;
      const executed = await executePending(pending, ctx);
      return finish({
        ...executed,
        source: pending.source || (executed.result?.ok ? 'deterministic' : 'deterministic'),
        iterations: 2
      });
    }
    if (pending.type === 'choose' && /^[1-9]$/.test(text)) {
      ctx.choiceIndex = Number(text);
      const executed = await executePending(pending, ctx);
      return finish({ ...executed, iterations: 2 });
    }
    if (pending.type === 'choose') {
      if (isNegative(text)) {
        return finish({ reply: 'Operación cancelada. No cambié nada.', source: 'deterministic', fallback: true });
      }
      if (isAffirmative(text)) {
        return finish({
          reply: `Necesito que elijas una opción: responde 1, 2 o 3.\n${pending.summary || ''}`.trim(),
          pending,
          source: 'deterministic',
          fallback: true
        });
      }
    }
    if (pending.type === 'confirm') {
      if (isAffirmative(text)) {
        const executed = await executePending(pending, ctx);
        return finish({ ...executed, iterations: 2 });
      }
      if (isNegative(text)) {
        return finish({ reply: 'Operación cancelada. No cambié nada.', source: 'deterministic', fallback: true });
      }
      // Cualquier otra frase cancela el pendiente y se procesa como instrucción nueva.
    } else if (isNegative(text)) {
      return finish({ reply: 'Operación cancelada. No cambié nada.', source: 'deterministic', fallback: true });
    }
  }

  /* 2. Comandos históricos garantizados ----------------------------- */
  const hasAssistantPending = assistantHasPending(channel, userId);
  const kind = guaranteedKind(text, { hasAssistantPending });
  if (kind) {
    const dispatched = await dispatchGuaranteed(text, { channel, userId });
    return finish({
      reply: dispatched.reply,
      event: dispatched.event,
      provider: null,
      model: null,
      fallback: true,
      source: 'deterministic',
      intent: null,
      result: { ok: true, actions: [], event: dispatched.event || null }
    });
  }

  /* 2.5 Charla natural: saludo, hora, fecha, capacidades o gracias ---- */
  const chatKind = conversationalKind(text);
  if (chatKind) {
    const natural = await naturalReply(text, chatKind, ctx);
    return finish({
      reply: natural.reply,
      provider: natural.provider,
      model: natural.model,
      fallback: !natural.llmUsed,
      source: natural.llmUsed ? 'llm' : 'deterministic',
      usage: natural.usage,
      intent: null,
      result: { ok: true, actions: [] }
    });
  }

  /* 3. Interpretación (LLM → parser local) -------------------------- */
  let llm = { used: false, provider: null, model: null, latencyMs: null, usage: null, errorCode: 'LLM_NOT_CONFIGURED', error: null, raw: null };
  if (deadlineMs - (Date.now() - started) > 2_500) {
    llm = await interpretWithLlm(text, { conversation, channel, userId, scope, signal: options.signal, deadlineMs: ctx.remainingMs });
  }

  let intent;
  let source = 'deterministic';
  if (llm.used) {
    intent = validateIntent(llm.raw, { text, todayKey, timezone, settings });
    intent.source = 'llm';
    source = 'llm';
    // Si el LLM propone "preguntar" pero el parser local ve una acción clara,
    // se prefiere la acción determinista (el LLM no debe bloquear al usuario).
    if (intent.action === 'preguntar') {
      const local = validateIntent(parseLocalIntent(text, { todayKey, timezone, settings }), { text, todayKey, timezone, settings });
      if (local.action !== 'preguntar') intent = { ...local, source: 'deterministic' };
    }
    // Guardarraíl determinista para comandos explícitos de tareas y Meet: si el
    // LLM se desvía (p. ej. "cierra la tarea" → listar_tareas), manda el parser
    // local y la ejecución real no se pierde.
    const localIntent = validateIntent(parseLocalIntent(text, { todayKey, timezone, settings }), { text, todayKey, timezone, settings });
    if (shouldPreferDeterministic(text, localIntent, intent)) {
      intent = { ...localIntent, source: 'deterministic' };
      source = 'deterministic';
    }
  } else {
    intent = validateIntent(parseLocalIntent(text, { todayKey, timezone, settings }), { text, todayKey, timezone, settings });
    intent.source = 'deterministic';
    source = 'deterministic';
  }

  if (!intent || intent.action === 'preguntar') {
    const question = intent?.question || intent?.args?.question || helpReply();
    return finish({
      reply: question,
      intent: intent ? { action: 'preguntar', args: { question } } : null,
      provider: llm.used ? llm.provider : null,
      model: llm.used ? llm.model : null,
      fallback: !llm.used,
      source: llm.used ? 'llm' : 'deterministic',
      usage: llm.usage,
      error: llm.used ? null : llm.error,
      errorCode: llm.used ? null : llm.errorCode
    });
  }

  /* 4. Ejecución (con confirmación si es destructiva) --------------- */
  const executed = await executeIntent(intent, ctx, { confirmed: false });

  /* 5. El equipo de la oficina opina antes de dar por lista la tarea --- */
  let reply = executed.reply;
  let team = null;
  if (executed.result && executed.result.ok !== false && shouldConsult(intent.action)) {
    const teamInput = { action: intent.action, args: intent.args || {}, text, data: ctx.data };
    try {
      // Opiniones reales del modelo (en paralelo) cuando hay presupuesto; si no, rúbrica.
      team = ctx.remainingMs > 5_000 ? await consultTeamDeep(teamInput) : consultTeam(teamInput);
    } catch {
      team = consultTeam(teamInput);
    }
    if (team.consulted) {
      reply = await polishActionReply({ reply, team, text, ctx });
      if (team.summary) reply = `${reply}\n\n_Equipo: ${team.summary}_`;
    }
  }

  return finish({
    ...executed,
    reply,
    ...(team && team.consulted ? { meta: { team } } : {}),
    provider: llm.used ? llm.provider : null,
    model: llm.used ? llm.model : null,
    fallback: source !== 'llm',
    source,
    usage: llm.usage,
    error: llm.error || null,
    errorCode: llm.errorCode || null,
    iterations: llm.used ? 2 : 1
  });
}

/** Historial de una conversación (para la UI). */
export function agentHistory({ channel = 'web', userId = 'local', limit = 12 } = {}) {
  const key = conversationKey(channel, userId);
  return { key, items: readConversation(key).messages.slice(-Math.max(1, Math.min(50, limit))), pending: pendingPublic(getPending(key)) };
}

/** Confirmación explícita por token (sin depender del texto). */
export async function confirmAgentAction({ token, channel = 'web', userId = 'local', dryRun = false } = {}) {
  return handleAgentChat({ text: 'sí', channel, userId, dryRun, confirmToken: token });
}

export { isDestructive, normalizeAction };

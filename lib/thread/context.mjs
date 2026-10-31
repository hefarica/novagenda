/**
 * Contexto de hilo por canal y usuario.
 *
 * Lee los mensajes normalizados del almacén de canales
 * (`store.channelState.messages`, el más reciente primero) y devuelve una
 * fotografía determinista del hilo: estado, compromisos, temas y última
 * intención. El resumen puede pedirse a un LLM, pero SIEMPRE hay un resumen
 * determinista de respaldo; sin proveedor no se hace ninguna llamada de red.
 *
 * No modifica nada: es solo lectura del estado persistido.
 */
import { store } from '../store.mjs';
import { dateKeyOfIso, formatShortDate, isoAtLocal, timezoneOf, addDaysKey } from '../agenda/time.mjs';
import { parseDateHint, parseTimeHint, foldText } from '../agent/context.mjs';
import { llmComplete } from '../llm/client.mjs';
import { buildProviderChain, resolveLlmConfig } from '../llm/config.mjs';
import { redactString } from '../security/redact.mjs';

export const THREAD_STATES = Object.freeze(['pendiente_mío', 'pendiente_suyo', 'cerrado', 'sin_historial']);
export const DEFAULT_THREAD_LIMIT = 20;
export const MAX_THREAD_LIMIT = 50;

const MAX_TEXT = 1200;
const CLOSURE_RE = /^(?:muchas\s+)?(?:gracias[.,! ]*)?(?:qued[oó] (?:resuelto|listo|cerrado)|damos por (?:cerrado|resuelto)|asunto (?:cerrado|resuelto)|todo (?:resuelto|listo)|resuelto|cerrado|listo|perfecto|de acuerdo|dale)[.! ]*$/i;
const CLOSURE_INLINE_RE = /\b(?:qued[oó] (?:resuelto|listo|cerrado)|damos por (?:cerrado|resuelto)|asunto (?:cerrado|resuelto)|todo (?:resuelto|listo))\b/i;
const REQUEST_RE = /\b(?:conf[ií]rmame|conf[ií]rmame|env[ií]ame|m[aá]ndame|p[aá]same|dime|av[ií]same|ind[ií]came|cu[eé]ntame|necesito|quiero|solicito|pido|podr[ií]as|puedes|me (?:confirmas|env[ií]as|pasas|dices|av[ií]sas)|quedo pendiente de tu|espero tu)\b/i;
const COMMITMENT_RE = /\b(?:te (?:env[ií]o|paso|confirmo|aviso|comparto|mando|llamo|entrego|dejo)|lo (?:reviso|hago|preparo|cierro|gestiono|veo)|me encargo|me ocupo|quedo pendiente|prometo|me comprometo|voy a|har[eé]|entregar[eé]|enviar[eé]|revisar[eé]|preparar[eé])\b/i;
const STOPWORDS = new Set(`
a al algo algunas algunos ante antes aqui así también tras como con contra cual cuando de del desde donde durante e el ella ellas ellos en entre era eres es esa esas ese eso esos esta estaba estado estas este esto estos estoy fue fueron ha hace hacer hacia han hasta hay la las le les lo los más me mi mis mucho muy nada ni no nos nosotros o os otra otro para pero poco por porque que quien se sea ser si sin sobre su sus te tengo ti tiene tienen todo todos tu tus un una uno unos usted ustedes y ya yo
hola buenas buen buen día dias días gracias favor porfa vale dale ok okay perfecto listo quedo quedó recibido recibí mensaje mensajes correo email hola saludos
puedes podrías quiero necesito necesitamos tengo tenemos hacer revisar enviar pasar confirmar avisar mandar compartir
incluye incluyo parece cierro cerramos quedo quedó estoy revisando confirmo aviso paso envío envio mando comparto entrego preparo gestiono
hoy mañana manana ayer lunes martes miércoles miercoles jueves viernes sábado sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre
`.split(/\s+/).filter(Boolean));

function clampText(value, max = MAX_TEXT) {
  const clean = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function timestampOf(message, index = 0) {
  const parsed = Date.parse(message?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : index;
}

function isClosure(text) {
  const clean = clampText(text, 200).replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  if (CLOSURE_RE.test(clean)) return true;
  // "Gracias, quedó resuelto." también cierra; una petición nueva no.
  if (REQUEST_RE.test(clean) || /\bpero\b|\bnecesito\b|\botra cosa\b/i.test(clean)) return false;
  return CLOSURE_INLINE_RE.test(clean);
}

function normalizedMessages(data, { channel, userId, limit }) {
  const state = data?.channelState && typeof data.channelState === 'object' ? data.channelState : {};
  let rows = Array.isArray(state.messages) ? state.messages : null;
  let source = 'channelState.messages';
  if (!rows) {
    rows = Array.isArray(state.inbox) ? state.inbox : [];
    source = rows.length ? 'channelState.inbox' : 'channelState.messages';
  }
  const filtered = rows
    .filter((message) => message && typeof message === 'object')
    .filter((message) => !channel || message.channel === channel)
    .filter((message) => !userId || String(message.userId ?? '') === String(userId))
    .map((message, index) => ({
      id: String(message.id || `MSG-${index + 1}`),
      channel: String(message.channel || channel || ''),
      userId: String(message.userId || userId || ''),
      direction: message.direction === 'outbound' ? 'outbound' : 'inbound',
      text: clampText(message.text),
      timestamp: message.timestamp || null,
      status: message.status || null,
      replyTo: message.replyTo || null,
      at: timestampOf(message, index)
    }))
    .filter((message) => message.text)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const selected = filtered.slice(-limit);
  return {
    messages: selected.map((message) => ({
      id: message.id,
      channel: message.channel,
      userId: message.userId,
      direction: message.direction,
      who: message.direction === 'inbound' ? 'usuario' : 'oficina',
      text: message.text,
      timestamp: message.timestamp,
      status: message.status,
      replyTo: message.replyTo
    })),
    stored: rows.length,
    matched: filtered.length,
    source
  };
}

function stateOf(messages) {
  if (!messages.length) {
    return {
      state: 'sin_historial',
      label: 'Sin historial en la app',
      reason: 'no hay mensajes previos de este contacto en este canal'
    };
  }
  const last = messages[messages.length - 1];
  if (isClosure(last.text)) {
    return { state: 'cerrado', label: 'Hilo cerrado', reason: `el último mensaje (${last.who}) cierra el tema` };
  }
  if (last.direction === 'inbound') {
    return { state: 'pendiente_mío', label: 'Pendiente de nuestra respuesta', reason: 'el usuario escribió al final y aún no hay respuesta nuestra' };
  }
  if (REQUEST_RE.test(last.text) || last.text.includes('?')) {
    return { state: 'pendiente_suyo', label: 'Pendiente de su respuesta', reason: 'nuestro último mensaje pide algo o hace una pregunta' };
  }
  return { state: 'pendiente_suyo', label: 'Pendiente de su respuesta', reason: 'respondimos y esperamos su confirmación' };
}

function dueLabel(due, dueTime, timezone) {
  if (!due) return null;
  const today = dateKeyOfIso(new Date().toISOString(), timezone);
  const tomorrow = addDaysKey(today, 1);
  const time = dueTime ? ` ${String(dueTime).replace(/^0/, '')}` : '';
  if (due === today) return `hoy${time}`;
  if (due === tomorrow) return `mañana${time}`;
  try {
    const base = formatShortDate(isoAtLocal(due, dueTime || '09:00', timezone), timezone);
    return `${base}${time}`;
  } catch {
    return `${due}${time}`;
  }
}

function extractCommitments(messages, { timezone, todayKey }) {
  const rows = [];
  for (const message of messages) {
    const sentences = message.text
      .split(/(?<=[.!?;])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (!COMMITMENT_RE.test(sentence)) continue;
      // Las preguntas y las negaciones no son compromisos.
      if (/[?¿]/.test(sentence) || /\bno\s+(?:te|lo|me)\b|\bno\s+prometo\b|\bquiz[aá]s\b/i.test(sentence)) continue;
      const dateHint = parseDateHint(sentence, { todayKey });
      const timeHint = parseTimeHint(sentence);
      const who = message.direction === 'outbound' ? 'mío' : 'suyo';
      rows.push({
        text: clampText(sentence, 220),
        who,
        direction: message.direction,
        messageId: message.id,
        at: message.timestamp,
        due: dateHint ? dateHint.date : null,
        dueTime: timeHint ? timeHint.time : null,
        dueLabel: dateHint ? dueLabel(dateHint.date, timeHint ? timeHint.time : null, timezone) : null
      });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${foldText(row.text)}|${row.who}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function topicsOf(messages) {
  const counts = new Map();
  for (const message of messages) {
    // Solo cuenta palabras con valor semántico; nada de fechas, ids ni números.
    const words = foldText(message.text)
      .replace(/\b(?:ag|tk|in|mt|r)-\d+\b/gi, ' ')
      .replace(/[^a-záéíóúñü\s-]+/gi, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));
}

function intentOf(messages) {
  const inbound = [...messages].reverse().find((message) => message.direction === 'inbound') || null;
  const last = messages[messages.length - 1] || null;
  const target = inbound || last;
  if (!target) return { lastIntent: null, lastIntentText: null, lastIntentDetail: null };
  let type = 'mensaje';
  if (/[?¿]/.test(target.text) || /\b(?:qué|que|cómo|como|cuándo|cuando|dónde|donde|quién|quien|podr[ií]as|puedes|me confirmas)\b/i.test(target.text)) type = 'pregunta';
  else if (/\b(?:necesito|quiero|solicito|pido|env[ií]ame|m[aá]ndame|conf[ií]rmame|av[ií]same)\b/i.test(target.text)) type = 'solicitud';
  else if (/\b(?:gracias|perfecto|listo|recibido|de acuerdo|conforme|ok|dale)\b/i.test(target.text)) type = 'confirmación';
  else if (COMMITMENT_RE.test(target.text)) type = 'compromiso';
  return {
    lastIntent: type,
    lastIntentText: clampText(target.text, 180),
    lastIntentDetail: {
      type,
      text: clampText(target.text, 180),
      direction: target.direction,
      who: target.who,
      at: target.timestamp
    }
  };
}

function stateSentence(state, commitments) {
  const base = {
    pendiente_mío: 'El hilo queda pendiente de nuestra parte.',
    pendiente_suyo: 'El hilo queda pendiente de su respuesta.',
    cerrado: 'El hilo está cerrado.',
    sin_historial: 'No hay historial previo en la app.'
  }[state] || 'No pude determinar el estado del hilo.';
  const mine = commitments.filter((commitment) => commitment.who === 'mío');
  if (!mine.length) return base;
  const next = mine[mine.length - 1];
  return `${base} Nuestro último compromiso: «${next.text}»${next.dueLabel ? ` (${next.dueLabel})` : ''}.`;
}

function deterministicSummary({ channel, userId, messages, state, commitments, topics, intent }) {
  if (!messages.length) {
    return `Sin historial previo en ${channel || 'el canal'} para ${userId || 'este contacto'}. Puedo responder sin contexto o pedirte el detalle.`;
  }
  const topicText = topics.length ? topics.map((row) => row.topic).join(', ') : 'sin temas claros';
  const parts = [
    `Hilo de ${messages.length} mensaje${messages.length === 1 ? '' : 's'} con ${userId || 'el contacto'} en ${channel || 'el canal'}.`,
    stateSentence(state, commitments),
    `Temas: ${topicText}.`
  ];
  if (intent.lastIntentText) {
    parts.push(`Última intención (${intent.lastIntent}): «${intent.lastIntentText}».`);
  }
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Resumen opcional con LLM (fallback determinista garantizado)        */
/* ------------------------------------------------------------------ */

function summaryPrompt({ channel, userId, messages, state, commitments }) {
  const lines = messages.map((message) => `${message.who === 'usuario' ? 'Usuario' : 'Oficina'}: ${message.text}`).join('\n');
  return [
    {
      role: 'system',
      content: 'Resume el hilo en 2 o 3 frases, en español, sin inventar datos ni fechas y sin revelar identificadores internos, correos ni secretos. Incluye el estado y los compromisos relevantes. Devuelve solo el resumen.'
    },
    {
      role: 'user',
      content: `Canal: ${channel}\nContacto: ${userId}\nEstado detectado: ${state}\nCompromisos detectados: ${commitments.map((row) => `${row.who}: ${row.text}${row.dueLabel ? ` (${row.dueLabel})` : ''}`).join(' | ') || 'ninguno'}\n\nMensajes (del más antiguo al más reciente):\n${lines.slice(0, 6000)}`
    }
  ];
}

async function maybeLlmSummary(input, { useLlm }) {
  if (useLlm === false) return { text: null, usedLlm: false, llm: null, error: 'desactivado' };
  let chain = [];
  try {
    chain = buildProviderChain(resolveLlmConfig());
  } catch {
    chain = [];
  }
  if (!chain.length) return { text: null, usedLlm: false, llm: null, error: 'sin proveedor' };
  try {
    const result = await llmComplete({
      profile: 'chat',
      messages: summaryPrompt(input),
      temperature: 0.2,
      maxTokens: 260,
      fallback: null,
      cache: false,
      scope: `thread:${input.channel}:${input.userId}`,
      workflow: 'thread-summary',
      deadlineMs: 6_000
    });
    if (result.ok && result.text) {
      const text = redactString(String(result.text).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').replace(/\s+/g, ' ').trim()).slice(0, 800);
      if (text.length >= 10) {
        return { text, usedLlm: true, llm: { provider: result.provider, model: result.model, latencyMs: result.latencyMs } };
      }
    }
    return { text: null, usedLlm: false, llm: null, error: result.errorCode || 'respuesta vacía' };
  } catch (error) {
    return { text: null, usedLlm: false, llm: null, error: String(error.message || error).slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Construye el contexto de hilo.
 *
 * @param {{channel:string, userId:string, limit?:number, data?:object, now?:number, useLlm?:boolean}} options
 * @returns {Promise<object>}
 */
export async function buildThreadContext({ channel, userId, limit = DEFAULT_THREAD_LIMIT, data = null, now = Date.now(), useLlm = true } = {}) {
  const sourceData = data || store.get();
  const channelValue = String(channel || '').trim().slice(0, 40);
  const userValue = String(userId || '').trim().slice(0, 200);
  const limitValue = Math.min(MAX_THREAD_LIMIT, Math.max(1, Number(limit) || DEFAULT_THREAD_LIMIT));
  const raw = normalizedMessages(sourceData, { channel: channelValue, userId: userValue, limit: limitValue });
  const messages = raw.messages;
  const timezone = timezoneOf(sourceData?.settings || {});
  const todayKey = dateKeyOfIso(new Date(now).toISOString(), timezone);
  const status = stateOf(messages);
  const commitments = extractCommitments(messages, { timezone, todayKey });
  const topicDetails = topicsOf(messages);
  const topics = topicDetails.map((row) => row.topic);
  const intent = intentOf(messages);
  const deterministic = deterministicSummary({ channel: channelValue, userId: userValue, messages, state: status.state, commitments, topics: topicDetails, intent });
  const llm = await maybeLlmSummary({ channel: channelValue, userId: userValue, messages, state: status.state, commitments }, { useLlm });
  const summary = llm.text || deterministic;
  const sources = [{
    type: raw.source,
    channel: channelValue || null,
    userId: userValue || null,
    count: messages.length,
    matched: raw.matched,
    stored: raw.stored,
    order: 'cronológico'
  }];
  if (llm.usedLlm) sources.push({ type: 'llm', provider: llm.llm?.provider || null, model: llm.llm?.model || null });
  sources.push({ type: 'determinista', detail: 'estado, compromisos, temas y última intención' });

  return {
    channel: channelValue || null,
    userId: userValue || null,
    limit: limitValue,
    messages,
    messageCount: messages.length,
    hasHistory: messages.length > 0,
    firstAt: messages[0]?.timestamp || null,
    lastAt: messages[messages.length - 1]?.timestamp || null,
    lastDirection: messages[messages.length - 1]?.direction || null,
    state: status.state,
    stateLabel: status.label,
    stateReason: status.reason,
    commitments,
    pendingMine: commitments.filter((row) => row.who === 'mío'),
    pendingTheirs: commitments.filter((row) => row.who === 'suyo'),
    topics,
    topicDetails,
    lastIntent: intent.lastIntent,
    lastIntentText: intent.lastIntentText,
    lastIntentDetail: intent.lastIntentDetail,
    summary,
    summarySource: llm.usedLlm ? 'llm' : 'determinista',
    summaryFallback: deterministic,
    usedLlm: llm.usedLlm,
    llm: llm.llm,
    llmError: llm.usedLlm ? null : (llm.error || null),
    sources,
    generatedAt: new Date(now).toISOString()
  };
}

/** Resumen corto listo para UI (sin LLM). */
export function threadSummaryLine(context) {
  if (!context) return 'Sin contexto de hilo.';
  if (!context.hasHistory) return 'Sin historial en la app para este contacto.';
  const mine = context.pendingMine?.length || 0;
  const theirs = context.pendingTheirs?.length || 0;
  const mineLabel = `${mine} compromiso${mine === 1 ? '' : 's'} nuestro${mine === 1 ? '' : 's'}`;
  const theirsLabel = `${theirs} suyo${theirs === 1 ? '' : 's'}`;
  return `${context.messageCount} mensajes · ${context.stateLabel}${mine ? ` · ${mineLabel}` : ''}${theirs ? ` · ${theirsLabel}` : ''}`;
}

export const __test__ = Object.freeze({ stateOf, extractCommitments, topicsOf, intentOf, isClosure, normalizedMessages, deterministicSummary });

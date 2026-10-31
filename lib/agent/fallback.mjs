/**
 * Fallback determinista del agente.
 *
 * Dos capas:
 *   1. Comandos históricos garantizados (HOY, CAPTURA, HECHO, POSPONER/MOVER,
 *      FOCO, CIERRE, SEMANA, balance): se delegan al asistente determinista de
 *      `lib/assistant.mjs`, que los resuelve SIN red.
 *   2. Parser local para lenguaje libre: produce la misma forma de intención
 *      que el LLM (`{action, args}`) para que el agente la valide y ejecute con
 *      las herramientas. Nunca inventa fechas: si falta un dato, la validación
 *      la convierte en pregunta.
 *
 * Este módulo no hace ninguna petición de red.
 */
import { store } from '../store.mjs';
import { handleAssistant } from '../assistant.mjs';
import { dateKeyOfIso, timezoneOf } from '../agenda/time.mjs';
import {
  cleanText, deriveTaskTitle, deriveTitle, foldText, parseDateHint, parseDurationHint,
  parsePriorityHint, parseTaskOwner, parseTimeHint, parseTypeHint
} from './context.mjs';

/** Comandos que siempre funcionan igual, con o sin LLM. */
const GUARANTEED = [
  { kind: 'today', re: /^(hoy|qué tengo hoy|que tengo hoy|agenda de hoy)\s*[?¿!]*$/i },
  { kind: 'capture', re: /^captura\s+\S+/i },
  { kind: 'done', re: /^hecho\s+ag-\d+/i },
  { kind: 'postpone', re: /^(posponer|mover)\s+ag-\d+\s+\d+/i },
  { kind: 'focus', re: /^foco\s+\d+\s+\S+/i },
  { kind: 'close', re: /^cierre\s*$/i },
  { kind: 'week', re: /^semana\s*$/i },
  { kind: 'balance', re: /^(balance|cómo voy|como voy|resumen del día|resumen del dia)\s*[?¿!]*$/i },
  { kind: 'choice', re: /^[123]$/ }
];

/**
 * ¿Es un comando garantizado? Devuelve su tipo o null.
 * @param {string} text
 * @param {{hasAssistantPending?:boolean}} [options]
 */
export function guaranteedKind(text, { hasAssistantPending = false } = {}) {
  const value = cleanText(text);
  for (const entry of GUARANTEED) {
    if (!entry.re.test(value)) continue;
    if (entry.kind === 'choice' && !hasAssistantPending) continue;
    return entry.kind;
  }
  return null;
}

/** ¿El asistente determinista tiene alternativas pendientes para este contexto? */
export function assistantHasPending(channel, userId) {
  const pending = store.get().pendingActions || {};
  return !!pending[`${channel}:${userId}`];
}

/**
 * Ejecuta un comando garantizado con el asistente determinista (sin LLM).
 * @param {string} text
 * @param {{channel?:string, userId?:string}} [options]
 */
export async function dispatchGuaranteed(text, { channel = 'web', userId = 'local' } = {}) {
  const result = await handleAssistant(text, { channel, userId });
  return {
    reply: String(result?.reply || ''),
    event: result?.event || null,
    dashboard: result?.dashboard || null,
    source: 'deterministic',
    fallback: true,
    provider: null,
    model: null,
    intent: null
  };
}

/* ------------------------------------------------------------------ */
/* Parser local de lenguaje libre                                      */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

function hasAny(low, words) {
  return words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(low));
}

function queryFrom(text) {
  const candidate = deriveTitle(text, { fallback: '' });
  return candidate || cleanText(text);
}

/**
 * Interpreta una frase libre sin LLM.
 * @param {string} text
 * @param {{todayKey:string, timezone:string, settings?:object}} options
 * @returns {{action:string, args:object, confidence:number, source:'deterministic'}}
 */
export function parseLocalIntent(text, { todayKey, timezone = 'America/Bogota', settings = {} } = {}) {
  const raw = cleanText(text);
  const low = foldText(raw);
  const dateHint = parseDateHint(raw, { todayKey });
  const timeHint = parseTimeHint(raw);
  const durationHint = parseDurationHint(raw, null);
  const priorityHint = parsePriorityHint(raw);
  const typeHint = parseTypeHint(raw);
  const idMatch = raw.match(/\b((?:AG|IN|R|MT|TK)-\d{1,6})\b/i);
  const id = idMatch ? idMatch[1].toUpperCase() : undefined;

  // Consultas
  if (/^(hoy|qué tengo hoy|que tengo hoy|agenda de hoy|mi día|mi dia)\b/.test(low) || /^listar/.test(low)) {
    return { action: 'listar_dia', args: dateHint ? { date: dateHint.date } : {}, confidence: 0.9, source: 'deterministic' };
  }
  if (hasAny(low, ['balance', 'resumen', 'estado']) && !dateHint) {
    return { action: 'balance', args: {}, confidence: 0.85, source: 'deterministic' };
  }
  if (/\bsemana\b/.test(low) || /\breporte semanal\b/.test(low)) {
    return { action: 'resumen_semana', args: {}, confidence: 0.85, source: 'deterministic' };
  }
  if (/\bcier(re|ra)\b/.test(low) && !dateHint) {
    return { action: 'balance', args: {}, confidence: 0.7, source: 'deterministic' };
  }
  if (/\b(hueco|huecos|disponibilidad|espacio libre)\b/.test(low)) {
    return {
      action: 'buscar_huecos',
      args: {
        ...(durationHint ? { durationMin: durationHint } : {}),
        ...(dateHint ? { date: dateHint.date } : {}),
        ...(timeHint ? { time: timeHint.time } : {})
      },
      confidence: 0.8,
      source: 'deterministic'
    };
  }

  // Tareas (antes de "cancelar/completar cita" para no confundir "cierra la tarea").
  function taskQueryFrom(value) {
    const clean = cleanText(value).replace(/^.*?\btarea\b\s*(?:de\s+|para\s+)?/i, '').trim();
    return deriveTitle(clean, { fallback: clean });
  }
  if (/(?:\bque|\bqué)\s+tareas|mis tareas|lista de tareas|tareas pendientes|tareas tengo|ver tareas|listar tareas/.test(low)) {
    const status = /\b(hechas?|cerradas?|completadas?)\b/.test(low) ? 'done'
      : /\bcanceladas?\b/.test(low) ? 'cancelled'
        : /\b(todas|todos)\b/.test(low) ? 'all'
          : 'open';
    return { action: 'listar_tareas', args: { status }, confidence: 0.85, source: 'deterministic' };
  }
  if (/^(?:crea|crear|añade|anade|agrega|agregar|nueva?|nuevo)\s+(?:una\s+|un\s+)?tarea\b|^tarea\b|^asignar\s+tarea\b/.test(low)) {
    return {
      action: 'crear_tarea',
      args: {
        title: deriveTaskTitle(raw, { fallback: 'Tarea' }),
        ...(dateHint ? { due: dateHint.date } : {}),
        ...(timeHint ? { dueTime: timeHint.time } : {}),
        ...(priorityHint ? { priority: priorityHint } : {}),
        ...(parseTaskOwner(raw) ? { owner: parseTaskOwner(raw) } : {})
      },
      confidence: 0.85,
      source: 'deterministic'
    };
  }
  if (/^(?:cierra|cerrar|completa|completar|termina|terminar)\s+(?:la\s+)?tarea\b|^cierra\s+tk-/.test(low)) {
    return {
      action: 'cerrar_tarea',
      args: id && /^TK-/i.test(id) ? { id } : { query: taskQueryFrom(raw) },
      confidence: 0.85,
      source: 'deterministic'
    };
  }
  if (/^(?:reabre|reabrir|abre|abrir)\s+(?:la\s+)?tarea\b|^reabre\s+tk-/.test(low)) {
    return {
      action: 'reabrir_tarea',
      args: id && /^TK-/i.test(id) ? { id } : { query: taskQueryFrom(raw) },
      confidence: 0.85,
      source: 'deterministic'
    };
  }

  // Reunión virtual con Meet (antes de "crear cita").
  if (/\b(virtual|videollamada|video\s*llamada|meet|google\s*meet)\b/.test(low)
    && /\b(agenda|agendar|agéndame|agendame|programa|programar|crea|crear|reuni[oó]n|bloquea)\b/.test(low)) {
    return {
      action: 'crear_meet',
      args: {
        title: deriveTitle(raw, { fallback: 'Reunión virtual' }),
        ...(dateHint ? { date: dateHint.date } : {}),
        ...(timeHint ? { time: timeHint.time } : {}),
        ...(durationHint ? { durationMin: durationHint } : {})
      },
      confidence: 0.85,
      source: 'deterministic'
    };
  }

  // Documento por correo/canal (siempre crea propuesta en la Oficina).
  if (/\bdocumento\b/i.test(raw) && /\b(env[ií]a|enviar|manda|mandar|comparte|compartir|prop[oó]n|proponer)\b/i.test(raw)) {
    const docId = raw.match(/\bDOC-[A-Z0-9-]{6,}\b/i)?.[0];
    const emailList = [...raw.matchAll(new RegExp(EMAIL_RE.source, 'gi'))].map((match) => match[0]);
    const tail = raw
      .replace(/^.*?\bdocumento\b/i, '')
      .replace(docId || '', '')
      .replace(/^\s*(?:a|para)\s+/i, '')
      .replace(/\bpor\s+(?:correo|email|e-mail|whatsapp|telegram)\b.*$/i, '')
      .trim();
    const named = tail
      ? tail.split(/\s*(?:,|;|\by\b)\s*/).map((value) => value.trim()).filter((value) => value && !/^(?:el|la|los|las)$/i.test(value))
      : [];
    const to = [...new Set([...emailList, ...named].map((value) => value.toLowerCase().includes('@') ? value.toLowerCase() : value))];
    const channel = /\bwhatsapp\b/i.test(low) ? 'whatsapp' : /\btelegram\b/i.test(low) ? 'telegram' : 'email';
    return {
      action: 'enviar_documento',
      args: {
        ...(docId ? { docId } : {}),
        ...(to.length ? { to } : {}),
        channel
      },
      confidence: 0.8,
      source: 'deterministic'
    };
  }

  // Correo / mensajes
  const email = raw.match(EMAIL_RE)?.[0];
  if (/\bcorreo\b|\bemail\b|\be-mail\b/.test(low)) {
    const body = raw
      .replace(/^.*?\benvi(?:a|ar|ame|e)\b[^ ]*\s*/i, '')
      .replace(/\b(?:un\s+)?(?:correo|email|e-mail)\b(?:\s+a\s+)?/i, '')
      .replace(email || '', '')
      .replace(/^(?:a|para)\s+/i, '')
      .trim();
    return {
      action: 'enviar_correo',
      args: { ...(email ? { to: email } : {}), subject: 'Agenda Copilot', body },
      confidence: 0.7,
      source: 'deterministic'
    };
  }
  if (/\bwhatsapp\b/.test(low) || /^wa\b/.test(low)) {
    const body = raw.replace(/^.*?\benvi(?:a|ar|ame|e)\b[^ ]*\s*/i, '').replace(/\b(?:un\s+)?whatsapp\b/i, '').replace(/^(?:a|para)\s+/i, '').trim();
    return { action: 'enviar_whatsapp', args: { text: body }, confidence: 0.7, source: 'deterministic' };
  }
  if (/\btelegram\b/.test(low)) {
    const body = raw.replace(/^.*?\benvi(?:a|ar|ame|e)\b[^ ]*\s*/i, '').replace(/\b(?:un\s+)?telegram\b/i, '').replace(/^(?:a|para)\s+/i, '').trim();
    return { action: 'enviar_telegram', args: { text: body }, confidence: 0.7, source: 'deterministic' };
  }

  // Captura
  const capture = raw.match(/^(?:captura|capturar|anota|anotar|apunta|recuérdame|recuerdame|guarda)\s+(.+)/i);
  if (capture && !/\b(rutina|reunión|reunion|cita)\b/i.test(low)) {
    return {
      action: 'capturar',
      args: {
        text: capture[1].trim(),
        ...(priorityHint ? { priority: priorityHint } : {}),
        ...(dateHint ? { due: dateHint.date } : {})
      },
      confidence: 0.9,
      source: 'deterministic'
    };
  }

  // Inbox → cita
  if (/\b(convierte|convertir|pasa a agenda|pasar a agenda|agenda la captura)\b/.test(low)) {
    return {
      action: 'convertir_inbox',
      args: {
        ...(id ? { id } : {}),
        ...(!id && raw.length > 12 ? { query: queryFrom(raw) } : {}),
        ...(dateHint ? { date: dateHint.date } : {}),
        ...(timeHint ? { time: timeHint.time } : {}),
        ...(durationHint ? { durationMin: durationHint } : {})
      },
      confidence: 0.8,
      source: 'deterministic'
    };
  }

  // Rutinas
  if (/\brutina\b|\brecurrencia\b|\brecurrente\b/.test(low)) {
    const wantsToggle = /\bpausa|desactiva|activa|reanuda\b/.test(low);
    const wantsEdit = /\b(cambia|cambiar|edita|editar|modifica|modificar)\b/.test(low);
    if (wantsToggle) {
      return {
        action: 'activar_rutina',
        args: { ...(id ? { id } : { query: queryFrom(raw) }), ...(/\bpausa|desactiva\b/.test(low) ? { active: false } : { active: true }) },
        confidence: 0.75,
        source: 'deterministic'
      };
    }
    if (wantsEdit) {
      return {
        action: 'editar_rutina',
        args: {
          ...(id ? { id } : { query: queryFrom(raw) }),
          ...(timeHint ? { time: timeHint.time } : {}),
          ...(durationHint ? { durationMin: durationHint } : {})
        },
        confidence: 0.75,
        source: 'deterministic'
      };
    }
    return {
      action: 'crear_rutina',
      args: {
        title: deriveTitle(raw, { fallback: 'Rutina' }),
        ...(timeHint ? { time: timeHint.time } : {}),
        ...(durationHint ? { durationMin: durationHint } : {}),
        ...(priorityHint ? { priority: priorityHint } : {}),
        ...(typeHint ? { type: typeHint } : {}),
        ...(/\bmensual\b/.test(low) ? { frequency: 'MENSUAL' } : /\bsemanal\b/.test(low) ? { frequency: 'SEMANAL' } : /\blaborables?\b/.test(low) ? { frequency: 'LABORABLES' } : { frequency: 'DIARIA' })
      },
      confidence: 0.7,
      source: 'deterministic'
    };
  }

  // Cancelar / completar / mover
  const wantsCancel = /\b(cancela|cancelar|elimina|eliminar|borra|borrar|anula|anular)\b/.test(low);
  const wantsComplete = /\b(completa|completar|termina|terminar|marca como hecho|marcar como hecho|ya lo hice)\b/.test(low);
  const wantsMove = /\b(mueve|mover|muéveme|mueveme|reprograma|reprogramar|cambia|cambiar|pasa|pasar|pospone|posponer|atrasa|atrasar|adelanta|adelantar)\b/.test(low);
  const eventQuery = id ? undefined : queryFrom(raw.replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, ' ').replace(/\b\d+\s*(min|minutos?)\b/gi, ' '));

  if (wantsCancel) {
    return {
      action: 'cancelar_cita',
      args: { ...(id ? { id } : { query: eventQuery || queryFrom(raw) }) },
      confidence: 0.8,
      source: 'deterministic'
    };
  }
  if (wantsComplete) {
    return {
      action: 'completar_cita',
      args: { ...(id ? { id } : { query: eventQuery || queryFrom(raw) }) },
      confidence: 0.8,
      source: 'deterministic'
    };
  }
  if (wantsMove) {
    const shift = raw.match(/\b(?:atrasa|atrasar|adelanta|adelantar|pospone|posponer)\b[^\d]*(\d{1,3})\s*(min|minutos?)?/i);
    if (shift && !dateHint) {
      // Desplazamiento relativo: se resuelve como mover a la hora actual + minutos.
      const minutes = Number(shift[1]) || 30;
      const target = /\badelanta/.test(low) ? -minutes : minutes;
      return {
        action: 'mover_cita',
        args: {
          ...(id ? { id } : { query: eventQuery || queryFrom(raw) }),
          shiftMinutes: target
        },
        confidence: 0.7,
        source: 'deterministic'
      };
    }
    return {
      action: 'mover_cita',
      args: {
        ...(id ? { id } : { query: eventQuery || queryFrom(raw) }),
        ...(dateHint ? { date: dateHint.date } : {}),
        ...(timeHint ? { time: timeHint.time } : {}),
        ...(durationHint ? { durationMin: durationHint } : {})
      },
      confidence: 0.8,
      source: 'deterministic'
    };
  }

  // Crear cita (verbo de agenda o tipo de evento)
  if (/\b(agenda|agendar|agéndame|agendame|programa|programar|reserva|reservar|bloquea|bloquear|crea|crear|nueva cita|nuevo evento)\b/.test(low)
    || /\b(reunión|reunion|cita|llamada|bloque de foco|foco)\b/.test(low)) {
    return {
      action: 'crear_cita',
      args: {
        title: deriveTitle(raw, { fallback: 'Compromiso' }),
        ...(dateHint ? { date: dateHint.date } : {}),
        ...(timeHint ? { time: timeHint.time } : {}),
        ...(durationHint ? { durationMin: durationHint } : {}),
        ...(typeHint ? { type: typeHint } : {}),
        ...(priorityHint ? { priority: priorityHint } : {})
      },
      confidence: 0.85,
      source: 'deterministic'
    };
  }

  return {
    action: 'preguntar',
    args: {
      question: 'No entendí la instrucción. Puedo: «agenda reunión con Ana mañana 10:00 45 min», «muéveme la reunión de Ana a las 3», «cancela AG-0002», «CAPTURA llamar a Juan», «convierte IN-0001 en cita», «crea rutina de foco diaria 8:00», «¿qué tengo hoy?» o «balance».'
    },
    confidence: 0.2,
    source: 'deterministic'
  };
}

/** Texto de ayuda cuando no se entiende la petición. */
export function helpReply() {
  return 'Puedo ayudarte con: «agenda reunión con Ana mañana 10:00 45 min», «agenda reunión virtual con Ana mañana a las 10 por 30 min», «muéveme la reunión de Ana a las 3», «cancela AG-0002», «marca como hecho AG-0003», «crea una tarea para llamar al Dr. Rodrigo mañana a las 9», «cierra la tarea TK-0001», «qué tareas tengo pendientes», «CAPTURA llamar a Juan», «convierte IN-0001 en cita», «crea rutina de foco diaria 08:00», «envía el documento DOC-… a ana@empresa.com», «¿qué tengo hoy?», «balance», «cierre» y «semana».';
}

/** Resumen local del día para el fallback de resúmenes. */
export function deterministicDaySummary({ dateKey, timezone = 'America/Bogota' } = {}) {
  const data = store.get();
  const tz = timezoneOf(data.settings || {});
  const key = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  const rows = (data.agenda || [])
    .filter((event) => event && event.start && dateKeyOfIso(event.start, tz) === key && event.status !== 'Cancelada')
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const done = rows.filter((event) => event.status === 'Hecho').length;
  if (!rows.length) return `Sin citas para ${key}.`;
  const lines = rows.slice(0, 12).map((event) => {
    const time = new Intl.DateTimeFormat('es-CO', { timeZone: tz || timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(event.start));
    return `${time} ${event.title}`;
  });
  return `${key}: ${rows.length} citas (${done} hechas). ${lines.join(' · ')}`;
}

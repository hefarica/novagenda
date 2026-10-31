/**
 * Parsers deterministas del agente (sin LLM).
 *
 * Todo lo que se puede interpretar de forma segura se resuelve aquí:
 * fechas relativas, horas, duraciones, prioridad, energía, tipo, recordatorios
 * y la búsqueda difusa de citas («la reunión de Ana»).
 *
 * Regla de oro: NO se inventa nada. Si un dato no aparece en el texto y no hay
 * una convención explícita (por ejemplo, «a las 3» en jornada laboral = 15:00),
 * el parser devuelve `null` para que el agente pregunte.
 */
import {
  addDaysKey, dateKeyOfIso, isValidDateKey, isoAtLocal, weekdayCodeOfKey, WEEKDAY_NAMES, formatTime, formatShortDate
} from '../agenda/time.mjs';

export const MONTHS = Object.freeze({
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
});

export const WEEKDAYS = Object.freeze({
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
  jueves: 4, viernes: 5, sabado: 6, sábado: 6
});

const STOPWORDS = new Set([
  'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'con', 'para', 'por',
  'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'que', 'y', 'o', 'a', 'al', 'en', 'es', 'son',
  'reunion', 'reunión', 'reuniones', 'cita', 'citas', 'evento', 'eventos', 'compromiso',
  'agenda', 'agendar', 'agendame', 'agéndame', 'programa', 'programar', 'mueve', 'muéveme',
  'mover', 'mueveme', 'cambia', 'cambiar', 'pasa', 'pasar', 'reprograma', 'reprogramar',
  'cancela', 'cancelar', 'elimina', 'eliminar', 'borra', 'borrar', 'completa', 'completar',
  'marca', 'marcar', 'hecho', 'termina', 'terminar', 'quiero', 'necesito', 'puedes',
  'por', 'favor', 'me', 'lo', 'le', 'se', 'hoy', 'manana', 'mañana', 'pasado', 'tarde',
  'noche', 'am', 'pm', 'horas', 'hora', 'minutos', 'minuto', 'min'
]);

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Limpia caracteres de control y normaliza espacios. */
export function cleanText(value) {
  return String(value ?? '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
}

/** Minúsculas sin tildes para comparar. */
export function foldText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Tokeniza un texto quitando palabras vacías. */
export function tokenize(value) {
  return foldText(value)
    .replace(/[^a-z0-9áéíóúüñ@._-]+/gi, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function todayKeyOf(timezone = 'America/Bogota') {
  return dateKeyOfIso(new Date().toISOString(), timezone);
}

/* ------------------------------------------------------------------ */
/* Fechas                                                              */
/* ------------------------------------------------------------------ */

/**
 * Interpreta una fecha relativa o explícita.
 * @param {string} text
 * @param {{todayKey:string}} options
 * @returns {{date:string, source:string}|null}
 */
export function parseDateHint(text, { todayKey = todayKeyOf() } = {}) {
  const raw = cleanText(text);
  const low = foldText(raw);

  // ISO explícita 2026-11-03
  const iso = low.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    if (isValidDateKey(date)) return { date, source: 'iso' };
  }

  if (/\bpasado\s+manana\b/.test(low)) return { date: addDaysKey(todayKey, 2), source: 'pasado_manana' };
  if (/\bmanana\b/.test(low)) return { date: addDaysKey(todayKey, 1), source: 'manana' };
  if (/\bhoy\b/.test(low)) return { date: todayKey, source: 'hoy' };

  const inDays = low.match(/\ben\s+(\d{1,2})\s+dias?\b/);
  if (inDays) return { date: addDaysKey(todayKey, Math.min(365, Number(inDays[1]))), source: 'en_dias' };

  // 3 de noviembre [de 2026]
  for (const [name, month] of Object.entries(MONTHS)) {
    if (name.endsWith('_')) continue;
    const match = low.match(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${name}(?:\\s+de\\s+(20\\d{2}))?`));
    if (match) {
      const year = match[2] || todayKey.slice(0, 4);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
      if (isValidDateKey(date)) return { date, source: 'dia_mes' };
    }
  }

  // 03/11[/2026] (día/mes)
  const slash = low.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
  if (slash) {
    const year = slash[3] || todayKey.slice(0, 4);
    const date = `${year}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
    if (isValidDateKey(date)) return { date, source: 'dia_mes_slash' };
  }

  // "el 3" / "el día 15" → próximo día 3/15 (de este mes si aún no pasó)
  const dayOnly = low.match(/\bel\s+(?:dia\s+)?(\d{1,2})\b(?!\s*[:.])/);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) {
      const candidate = `${todayKey.slice(0, 8)}${String(day).padStart(2, '0')}`;
      if (isValidDateKey(candidate) && candidate >= todayKey) return { date: candidate, source: 'dia_suelto' };
      const nextMonth = addDaysKey(`${todayKey.slice(0, 8)}01`, 32);
      const candidate2 = `${nextMonth.slice(0, 8)}${String(day).padStart(2, '0')}`;
      if (isValidDateKey(candidate2)) return { date: candidate2, source: 'dia_suelto_mes_siguiente' };
    }
  }

  // Día de la semana → próxima aparición (si es hoy, hoy).
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${name}\\b`).test(low)) continue;
    const current = Number(weekdayCodeOfKey(todayKey) === 'DOM' ? 0 : ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'].indexOf(weekdayCodeOfKey(todayKey)));
    let delta = (dow - current + 7) % 7;
    if (low.includes('proximo') || low.includes('próximo') || low.includes('siguiente')) {
      if (delta === 0) delta = 7;
    }
    return { date: addDaysKey(todayKey, delta), source: 'dia_semana' };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Horas                                                               */
/* ------------------------------------------------------------------ */

/**
 * Interpreta una hora. Convención de agenda: 1–7 sin meridiano = PM (tarde,
 * dentro de la jornada laboral); 8–11 = AM; 12 = mediodía.
 * @param {string} text
 * @returns {{time:string, source:string}|null}
 */
export function parseTimeHint(text) {
  const low = foldText(text).replace(/(\d)\s*([ap])\.?\s*m\.?/g, '$1 $2m');
  if (/\bmedianoche\b/.test(low)) return { time: '00:00', source: 'medianoche' };
  if (/\bmediodia\b/.test(low)) {
    // "a mediodía" es 12:00; "12 del mediodía" también.
    return { time: '12:00', source: 'mediodia' };
  }
  const meridiem = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] || 0);
    if (hour > 12 || minute > 59) return null;
    if (meridiem[3] === 'pm' && hour < 12) hour += 12;
    if (meridiem[3] === 'am' && hour === 12) hour = 0;
    return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, source: 'meridiem' };
  }
  // HH:MM (24h)
  const colon = low.match(/\b(\d{1,2}):(\d{2})\b/);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour > 23 || minute > 59) return null;
    return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, source: 'hhmm' };
  }
  // "a las 3", "a la 1", "a las 15", "a las 10 de la mañana/tarde"
  const spoken = low.match(/\b(?:a\s+las?|a\s+la|@)\s*(\d{1,2})\b(?!\s*[:.])(.*)$/);
  if (spoken) {
    let hour = Number(spoken[1]);
    const tail = spoken[2] || '';
    if (!Number.isFinite(hour) || hour > 23) return null;
    if (/\bde\s+la\s+(manana|tarde|noche)\b/.test(tail)) {
      if (hour < 12) hour += 12;
    } else if (hour >= 1 && hour <= 5) {
      hour += 12; // 1–5 sin meridiano → tarde (3 → 15:00), convención de agenda laboral
    }
    // 6–11 sin meridiano se interpretan como mañana (07:00, 08:00…) y 12 = mediodía.
    return { time: `${String(hour).padStart(2, '0')}:00`, source: 'spoken' };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Duración, prioridad, energía, tipo, recordatorio                    */
/* ------------------------------------------------------------------ */

/** @param {string} text @param {number} [fallback] */
export function parseDurationHint(text, fallback = 60) {
  const low = foldText(text);
  if (/\bmedia\s+hora\b/.test(low)) return 30;
  if (/\bhora\s+y\s+media\b/.test(low)) return 90;
  if (/\b(un\s+)?cuarto\s+de\s+hora\b/.test(low)) return 15;
  const minutes = low.match(/(\d{1,3})\s*(?:minutos?|mins?)\b/);
  if (minutes) {
    const value = Number(minutes[1]);
    if (value >= 5 && value <= 720) return value;
  }
  const hours = low.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:horas?|hrs?|h)\b/);
  if (hours) {
    const value = Math.round(Number(String(hours[1]).replace(',', '.')) * 60);
    if (value >= 5 && value <= 720) return value;
  }
  if (/\bpor\s+(\d{1,3})\b/.test(low)) {
    const value = Number(low.match(/\bpor\s+(\d{1,3})\b/)[1]);
    if (value >= 5 && value <= 720) return value;
  }
  if (/\buna\s+hora\b/.test(low)) return 60;
  if (/\bdos\s+horas\b/.test(low)) return 120;
  return fallback;
}

/** @param {string} text */
export function parsePriorityHint(text) {
  const low = foldText(text);
  if (/\bp1\b|\bp-1\b|\burgent(e|isimo|ísimo)\b|\bcritico\b|\bcritico\b|\bya\b/.test(low)) return 'P1';
  if (/\bp3\b|\bp-3\b|\bcuando\s+pueda\b|\balgun\s+dia\b|\bno\s+urgente\b|\bbaja\s+prioridad\b/.test(low)) return 'P3';
  if (/\bp2\b|\bp-2\b|\bimportante\b|\bprioridad\s+alta\b/.test(low)) return 'P2';
  return null;
}

/** @param {string} text */
export function parseEnergyHint(text) {
  const low = foldText(text);
  if (/\benergia\s+alta\b|\balta\s+energia\b|\bconcentracion\b|\bconcentración\b/.test(low)) return 'Alta';
  if (/\benergia\s+baja\b|\bbaja\s+energia\b|\bcansad/.test(low)) return 'Baja';
  if (/\benergia\s+media\b|\bmedia\s+energia\b/.test(low)) return 'Media';
  return null;
}

/** @param {string} text */
export function parseTypeHint(text) {
  const low = foldText(text);
  if (/\breunion\b|\breunión\b|\bmeeting\b|\b1:1\b|\bllamada\b|\bvideollamada\b|\bmeet\b/.test(low)) return 'Reunión';
  if (/\bfoco\b|\bdeep\s+work\b|\bbloque\s+de\s+concentracion\b|\bconcentracion\b/.test(low)) return 'Foco';
  if (/\bentrenamiento\b|\bgym\b|\bejercicio\b|\brun\b|\bcorrer\b/.test(low)) return 'Personal';
  if (/\bviaje\b|\bdesplazamiento\b|\btrayecto\b/.test(low)) return 'Desplazamiento';
  if (/\breporte\b|\binforme\b/.test(low)) return 'Reporte';
  if (/\badmin\b|\bpapeleo\b|\brevision\b|\brevisión\b|\binbox\b/.test(low)) return 'Administrativo';
  if (/\btarea\b|\brecordatorio\b|\bpendiente\b/.test(low)) return 'Tarea';
  return null;
}

/** @param {string} text */
export function parseReminderHint(text) {
  const low = foldText(text);
  const match = low.match(/avis(?:a|ame|arme)?me?\s+(\d{1,3})\s*(minutos?|mins?|horas?)\s+antes/);
  if (match) {
    const value = Number(match[1]) * (/hora/.test(match[2]) ? 60 : 1);
    if (value >= 0 && value <= 1440) return value;
  }
  if (/\bsin\s+(recordatorio|aviso)\b/.test(low)) return 0;
  return null;
}

/* ------------------------------------------------------------------ */
/* Título                                                              */
/* ------------------------------------------------------------------ */

const TITLE_STRIP_PATTERNS = [
  /^(?:por\s+favor[, ]*)?(?:agenda|agendar|agéndame|agendame|agéndame|programa|programar|bloquea|bloquear|reserva|reservar|crea|crear|añade|anade|nueva?|nuevo)\s+/i,
  /^(?:la|el|una|un)\s+/i
];

/**
 * Construye un título legible a partir de la frase del usuario, quitando
 * verbos de acción, fechas, horas, duraciones y muletillas.
 * @param {string} text
 * @param {{fallback?:string}} [options]
 */
export function deriveTitle(text, { fallback = 'Compromiso' } = {}) {
  let out = cleanText(text);
  for (const pattern of TITLE_STRIP_PATTERNS) out = out.replace(pattern, '');
  out = out
    .replace(/\b(hoy|mañana|manana|pasado mañana|pasado manana)\b/gi, '')
    .replace(/\b(el\s+|para\s+el\s+)?(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)(\s+(próximo|proximo|siguiente))?\b/gi, '')
    .replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, '')
    .replace(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/gi, '')
    .replace(/\b(\d{1,2})[\/](\d{1,2})(?:[\/](20\d{2}))?\b/g, '')
    .replace(/\b(?:a\s+las?|a\s+la|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.?\s?m\.?|p\.?\s?m\.?)?\b/gi, '')
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, '')
    .replace(/\b(?:durante|por|de)\s+\d{1,3}\s*(?:minutos?|mins?|horas?|hrs?|h)\b/gi, '')
    .replace(/\b\d{1,3}\s*(?:minutos?|mins?|horas?|hrs?|h)\b/gi, '')
    .replace(/\b(?:media\s+hora|hora\s+y\s+media)\b/gi, '')
    .replace(/\b(?:urgente|importante|prioridad\s+(?:alta|baja)|p1|p2|p3)\b/gi, '')
    .replace(/\b(?:avísame|avisame|recuérdame|recuerdame)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '')
    .trim();
  if (!out) return fallback;
  // Quita "con" inicial ("con Ana" → "Ana" se conserva en el medio).
  out = out.replace(/^(?:con|para)\s+/i, '');
  out = out.replace(/\s+(?:con|para)$/i, '').trim();
  if (!out) return fallback;
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return out.slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Tareas: título y responsable desde una frase libre                  */
/* ------------------------------------------------------------------ */

/**
 * Extrae el título de una tarea de frases como:
 *   "crea una tarea para llamar al Dr. Rodrigo mañana a las 9"
 *   "asignar tarea a Laura: revisar contrato"
 *   "tarea: enviar informe"
 * @param {string} text
 * @param {{fallback?:string}} [options]
 */
export function deriveTaskTitle(text, { fallback = 'Tarea' } = {}) {
  let out = cleanText(text);
  out = out
    .replace(/^(?:crea|crear|añade|anade|agrega|agregar|nueva?|nuevo)\s+(?:una\s+|un\s+)?tarea\s+(?:para\s+|de\s+)?/i, '')
    .replace(/^(?:asignar|asigna|asigname|asígnale|asignale)\s+(?:una\s+)?tarea\s+(?:a\s+[^:,.]{1,80}\s*[:,]\s*)?/i, '')
    .replace(/^tarea\s+(?:para\s+|de\s+|:\s*)?/i, '');
  if (out === cleanText(text)) out = out.replace(/^tarea\s*/i, '');
  return deriveTitle(out, { fallback });
}

/**
 * Detecta el responsable en "asignar tarea a Laura: revisar contrato".
 * @param {string} text
 * @returns {string|null}
 */
export function parseTaskOwner(text) {
  const raw = cleanText(text);
  if (!/\btarea\b/i.test(raw)) return null;
  const match = raw.match(/\btarea\s+(?:a|para)\s+([A-ZÁÉÍÓÚÑ][\p{L}.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}.'-]+)?)\s*[:,]/u)
    || raw.match(/\basignar(?:le)?\s+(?:la\s+)?tarea\s+a\s+([A-ZÁÉÍÓÚÑ][\p{L}.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}.'-]+)?)/u);
  if (!match) return null;
  return match[1].replace(/[.,;:]+$/, '').trim().slice(0, 120) || null;
}

/* ------------------------------------------------------------------ */
/* Búsqueda difusa de citas                                            */
/* ------------------------------------------------------------------ */

/**
 * Busca citas por descripción libre («la reunión de Ana»).
 * @param {Array<object>} events
 * @param {string} query
 * @param {{now?:number}} [options]
 * @returns {Array<{event:object, score:number}>}
 */
export function findEventCandidates(events, query, { now = Date.now() } = {}) {
  const tokens = tokenize(query);
  const idMatch = cleanText(query).match(/\b([A-Z]{1,4}-\d{1,6})\b/i);
  const rows = Array.isArray(events) ? events.filter((event) => event && event.id) : [];
  if (idMatch) {
    const id = idMatch[1].toUpperCase();
    return rows.filter((event) => String(event.id).toUpperCase() === id).map((event) => ({ event, score: 1000 }));
  }
  if (!tokens.length) return [];
  const scored = [];
  for (const event of rows) {
    const haystack = foldText([event.title, event.notes, event.context, event.result, event.owner, Array.isArray(event.attendees) ? event.attendees.join(' ') : ''].filter(Boolean).join(' '));
    // Coincidencia por PALABRA (no por subcadena): «ana» no debe casar con «semanal».
    const words = new Set(haystack.split(/[^a-z0-9@._-]+/).filter(Boolean));
    let score = 0;
    for (const token of tokens) {
      if (words.has(token)) score += token.length >= 4 ? 3 : 2;
      else if (token.length >= 5 && haystack.includes(token)) score += 1;
    }
    if (!score) continue;
    if (String(event.status || '') === 'Cancelada') score -= 1;
    const start = new Date(event.start).getTime();
    if (Number.isFinite(start) && start >= now) score += 1;
    scored.push({ event, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aStart = new Date(a.event.start).getTime() || 0;
    const bStart = new Date(b.event.start).getTime() || 0;
    const aUpcoming = aStart >= now;
    const bUpcoming = bStart >= now;
    if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
    return Math.abs(aStart - now) - Math.abs(bStart - now);
  });
  return scored;
}

/** Descripción corta en español de una cita. */
export function describeEvent(event, timezone = 'America/Bogota') {
  if (!event) return '';
  const when = (() => {
    try {
      return `${formatShortDate(event.start, timezone)} ${formatTime(event.start, timezone)}`;
    } catch {
      return '';
    }
  })();
  const status = event.status && event.status !== 'Pendiente' ? ` [${event.status}]` : '';
  return `${event.id} «${event.title}»${when ? ` · ${when}` : ''}${status}`;
}

/** Lista numerada de candidatos para pedir aclaración. */
export function candidatesReply(candidates, timezone = 'America/Bogota', limit = 3) {
  const lines = candidates.slice(0, limit).map((row, index) => `${index + 1}) ${describeEvent(row.event, timezone)}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Confirmaciones                                                      */
/* ------------------------------------------------------------------ */

const AFFIRMATIVE_RE = /^(si|sí|s|ok|okay|dale|listo|confirmo|confirmado|hazlo|hagalo|hágalo|adelante|deacuerdo|de acuerdo|correcto|claro|yes|y|1)$/i;
const NEGATIVE_RE = /^(no|nop|nope|cancel|cancela|cancelar|anula|anular|para|parar|olvidalo|olvídalo|dejalo|déjalo|mejor no|0|2)$/i;

/** @param {string} text */
export function isAffirmative(text) {
  const low = foldText(text).replace(/[.!¡?¿]+/g, '');
  return AFFIRMATIVE_RE.test(low);
}

/** @param {string} text */
export function isNegative(text) {
  const low = foldText(text).replace(/[.!¡?¿]+/g, '');
  return NEGATIVE_RE.test(low);
}

/* ------------------------------------------------------------------ */
/* Construcción de instantes                                           */
/* ------------------------------------------------------------------ */

/**
 * Combina fecha + hora local en un ISO con offset de la zona configurada.
 * @param {string} dateKey
 * @param {string} hhmm
 * @param {string} timezone
 * @param {number} [durationMin]
 */
export function instantFrom(dateKey, hhmm, timezone = 'America/Bogota', durationMin = 60) {
  if (!isValidDateKey(dateKey)) return null;
  const start = isoAtLocal(dateKey, hhmm, timezone);
  const end = new Date(new Date(start).getTime() + Math.max(5, durationMin) * 60_000).toISOString();
  return { start, end };
}

/** Etiqueta «mañana 10:00» → «2026-10-28 10:00»; útil para resúmenes. */
export function friendlyWhen(dateKey, hhmm, timezone = 'America/Bogota') {
  if (!isValidDateKey(dateKey)) return hhmm || '';
  const iso = isoAtLocal(dateKey, hhmm || '00:00', timezone);
  return `${formatShortDate(iso, timezone)} ${formatTime(iso, timezone)}`;
}

/** Nombre del día de la semana de una clave de fecha. */
export function weekdayNameOf(dateKey) {
  try {
    return WEEKDAY_NAMES[weekdayCodeOfKey(dateKey)] || '';
  } catch {
    return '';
  }
}

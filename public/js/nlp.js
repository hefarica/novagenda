/**
 * Interpretación de lenguaje natural para crear rutinas.
 * Preferencia: endpoint de autocompletado del agente (t3) → chat del LLM →
 * parser local determinista. La app funciona igual sin LLM.
 */
import { api, ApiError, rememberEndpoint } from './api.js';
import { capability } from './data.js';

const FREQUENCIES = ['DIARIA', 'LABORABLES', 'SEMANAL', 'MENSUAL', 'TRIMESTRAL'];
const TYPES = ['Foco', 'Administrativo', 'Reunión', 'Reporte', 'Compromiso'];
const PRIORITIES = ['P1', 'P2', 'P3'];
const DAY_MAP = [
  [/lunes|\blun\b/i, 'LUN'], [/martes|\bmar\b/i, 'MAR'], [/mi[eé]rcoles|\bmie\b/i, 'MIE'],
  [/jueves|\bjue\b/i, 'JUE'], [/viernes|\bvie\b/i, 'VIE'], [/s[aá]bado|\bsab\b/i, 'SAB'],
  [/domingo|\bdom\b/i, 'DOM']
];

function deaccent(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeTime(raw) {
  const text = String(raw || '').trim().toLowerCase();
  const match = /^(\d{1,2})(?::|h|\.)?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3] ? match[3].replace(/\./g, '') : '';
  if (minutes > 59 || hours > 23) return null;
  if (meridiem.startsWith('p') && hours < 12) hours += 12;
  if (meridiem.startsWith('a') && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function findTime(text) {
  const lower = deaccent(text).toLowerCase();
  if (/\bmedianoche\b/.test(lower)) return { time: '00:00', label: 'medianoche' };
  if (/\bmediodia\b/.test(lower)) return { time: '12:00', label: 'mediodía' };
  if (/\b(cierre|final del dia|fin del dia)\b/.test(lower)) return { time: '17:30', label: 'cierre del día' };
  if (/\b(inicio del dia|primer|primera hora|arranque)\b/.test(lower)) return { time: '07:00', label: 'inicio del día' };
  const patterns = [
    /(?:a las|a la|desde las|sobre las|hacia las)\s*(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i,
    /\b(\d{1,2})[:h.](\d{2})\s*(am|pm|a\.?m\.?|p\.?m\.?)?/i,
    /\b(\d{1,2})\s*(am|pm)\b/i,
    /\b(\d{1,2})\s*h\b/i,
    /^(\d{1,2})$/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(lower);
    if (!match) continue;
    const candidate = normalizeTime(`${match[1]}:${match[2] || '00'}${match[3] ? ` ${match[3].replace(/[.\s]/g, '')}` : ''}`);
    if (candidate) return { time: candidate, label: candidate };
  }
  return null;
}

function findDuration(text) {
  const lower = deaccent(text).toLowerCase();
  if (/hora y media|1,5 h|1\.5 h|90 min/.test(lower)) return 90;
  if (/media hora|30 min/.test(lower)) return 30;
  let match = /(\d{1,3})\s*(?:min|minutos|mins)\b/.exec(lower);
  if (match) return clamp(match[1], 5, 720, 30);
  match = /(\d{1,2})(?:[.,](\d))?\s*(?:h|horas?|hrs?)\b/.exec(lower);
  if (match) {
    const hours = Number(match[1]);
    const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
    return clamp((hours + fraction) * 60, 5, 720, 30);
  }
  if (/\btoda la manana\b/.test(lower)) return 180;
  if (/\bmedia manana\b/.test(lower)) return 120;
  return null;
}

function findFrequency(text) {
  const lower = deaccent(text).toLowerCase();
  const days = DAY_MAP.filter(([pattern]) => pattern.test(lower)).map(([, code]) => code);
  if (/trimestral|cada trimestre/.test(lower)) return { frequency: 'TRIMESTRAL', rule: String(findMonthDay(lower) || 1), days };
  if (/mensual|cada mes|una vez al mes/.test(lower)) return { frequency: 'MENSUAL', rule: String(findMonthDay(lower) || 1), days };
  if (/laborable|dias habiles|lunes a viernes|entre semana|de lunes a viernes/.test(lower)) return { frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', days };
  if (/semanal|cada semana|una vez por semana|semanalmente/.test(lower)) {
    return { frequency: 'SEMANAL', rule: days.length ? [...new Set(days)].join('-') : 'LUN', days };
  }
  if (days.length) return { frequency: 'SEMANAL', rule: [...new Set(days)].join('-'), days };
  if (/diari|todos los dias|cada dia|a diario/.test(lower)) return { frequency: 'DIARIA', rule: '', days };
  return { frequency: 'DIARIA', rule: '', days };
}

function findMonthDay(lower) {
  const match = /(?:dia|el)\s+(\d{1,2})\b/.exec(lower);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 1 && value <= 31 ? value : null;
}

function findType(text) {
  const lower = deaccent(text).toLowerCase();
  if (/\breunion|cadencia|1:1|one on one|daily\b/.test(lower)) return 'Reunión';
  if (/\bfoco\b|enfoque|deep work|sin interrupciones|concentracion/.test(lower)) return 'Foco';
  if (/\breporte|informe|revision\b/.test(lower)) return 'Reporte';
  if (/administrativ|papeleo|inbox|correo|bandeja/.test(lower)) return 'Administrativo';
  if (/compromiso|cliente|seguimiento/.test(lower)) return 'Compromiso';
  return null;
}

function findPriority(text) {
  const lower = deaccent(text).toLowerCase();
  const explicit = /\bp([123])\b/.exec(lower);
  if (explicit) return `P${explicit[1]}`;
  if (/prioridad alta|critic|urgente|impostergable/.test(lower)) return 'P1';
  if (/prioridad media/.test(lower)) return 'P2';
  if (/prioridad baja|opcional/.test(lower)) return 'P3';
  return null;
}

function findReminder(text) {
  const lower = deaccent(text).toLowerCase();
  if (/sin (?:aviso|recordatorio)/.test(lower)) return 0;
  const match = /(?:aviso|recordatorio|recordar|recordarme|notificar)\D{0,15}(\d{1,3})\s*(?:min|minutos)?/.exec(lower);
  if (match) return clamp(match[1], 0, 40320, 10);
  return null;
}

function findPurpose(text) {
  const match = /(?:para|con el objetivo de|con el fin de|con el prop[oó]sito de)\s+([^.;\n]{4,160})/i.exec(text);
  if (!match) return '';
  return match[1].trim().replace(/\s+/g, ' ');
}

function findResult(text) {
  const match = /(?:resultado|salida|que quede|entregable)\s*:?\s*([^.;\n]{3,160})/i.exec(text);
  return match ? match[1].trim() : '';
}

function findTitle(text, { type, frequency }) {
  const quoted = /[«"“]([^»"”]{3,80})[»"”]/.exec(text);
  if (quoted) return quoted[1].trim();
  let candidate = String(text || '');
  const removals = [
    /\b(todos los|todas las)\s+(d[ií]as|laborables|semanas?)\b/gi,
    /\b(cada|una vez (?:al|por))\s+(d[ií]a|semana|mes|trimestre)\b/gi,
    /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\b/gi,
    /\b(de|a|hasta)\s+las\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi,
    /\ba\s+las\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi,
    /\b\d{1,3}\s*(min|minutos|h|horas?|hrs?)\b/gi,
    /\b(aviso|recordatorio|recordarme|recordar)\b[^.,;]{0,20}/gi,
    /\b(p1|p2|p3|prioridad alta|prioridad media|prioridad baja)\b/gi,
    /\b(para|con el objetivo de|con el fin de)\b[^.;]*/gi,
    /\b(resultado|salida|que quede)\s*:?[^.;]*/gi,
    /\b(diaria|diario|semanal|mensual|trimestral|laborables?)\b/gi,
    /\bfoco profundo\b|\bsin interrupciones\b/gi,
    /[,.;:]+/g
  ];
  for (const pattern of removals) candidate = candidate.replace(pattern, ' ');
  candidate = candidate.replace(/\s+/g, ' ').trim();
  if (candidate.length < 3) {
    if (type === 'Foco') return 'Bloque de foco';
    if (type === 'Reunión') return frequency === 'SEMANAL' ? 'Reunión semanal' : 'Reunión';
    if (type === 'Reporte') return 'Revisión';
    return frequency === 'LABORABLES' || frequency === 'DIARIA' ? 'Rutina diaria' : 'Rutina';
  }
  return candidate.slice(0, 160);
}

/** Parser local determinista (sin LLM). Nunca lanza. */
export function parseRoutineText(input = {}) {
  const text = String(input.text || '').trim();
  const interpretation = [];
  const lower = deaccent(text).toLowerCase();
  const typeHint = findType(text);
  const { frequency, rule, days } = findFrequency(text);
  const isMeeting = /reuni[oó]n|cadencia|1:1|daily\b/.test(lower) || typeHint === 'Reunión';
  const time = findTime(text);
  const duration = findDuration(text);
  const reminder = findReminder(text);
  const priority = findPriority(text);
  const deepFocus = /foco profundo|sin interrupciones|deep work|concentraci[oó]n/.test(lower);
  const type = typeHint || (deepFocus ? 'Foco' : 'Administrativo');
  const purpose = findPurpose(text);
  const result = findResult(text);
  const title = findTitle(text, { type, frequency });

  const fields = {
    kind: isMeeting ? 'meeting' : 'recurrence',
    active: true,
    title,
    frequency,
    rule,
    time: time?.time || (input.time || '09:00'),
    durationMin: duration || (input.durationMin || 30),
    type,
    priority: priority || 'P2',
    impact: priority === 'P1' ? 5 : priority === 'P3' ? 2 : 3,
    urgency: priority === 'P1' ? 4 : priority === 'P3' ? 2 : 3,
    deepFocus,
    energy: deepFocus ? 'Alta' : 'Media',
    reminderMin: reminder === null ? 10 : reminder,
    whatsapp: true,
    calendar: true,
    skipHolidays: true,
    purpose,
    result,
    notes: text.slice(0, 1000)
  };

  interpretation.push(`${isMeeting ? 'Reunión' : 'Rutina'} · ${frequency.toLowerCase()}`);
  if (days.length && frequency === 'SEMANAL') interpretation.push(`días: ${days.join(', ')}`);
  if (frequency === 'MENSUAL' || frequency === 'TRIMESTRAL') interpretation.push(`día ${rule}`);
  interpretation.push(`hora ${fields.time}`);
  interpretation.push(`${fields.durationMin} min`);
  interpretation.push(type);
  if (fields.deepFocus) interpretation.push('foco profundo');
  if (fields.reminderMin) interpretation.push(`aviso ${fields.reminderMin} min antes`);
  if (purpose) interpretation.push('propósito detectado');

  return {
    source: 'local',
    fields,
    interpretation,
    confidence: interpretation.length >= 4 ? 'alta' : interpretation.length >= 2 ? 'media' : 'baja'
  };
}

/** Valida y normaliza campos propuestos por el LLM. */
export function sanitizeRoutineFields(raw = {}, base = parseRoutineText({ text: '' })) {
  const fields = { ...base.fields };
  const notes = [];
  if (typeof raw.title === 'string' && raw.title.trim().length >= 3) fields.title = raw.title.trim().slice(0, 160);
  if (typeof raw.frequency === 'string') {
    const value = raw.frequency.trim().toUpperCase();
    if (FREQUENCIES.includes(value)) fields.frequency = value;
    else notes.push(`frequency «${raw.frequency}» ignorada`);
  }
  if (typeof raw.rule === 'string' && raw.rule.trim()) {
    const value = raw.rule.trim().toUpperCase();
    if (fields.frequency === 'SEMANAL' && /(LUN|MAR|MIE|JUE|VIE|SAB|DOM)/.test(value)) fields.rule = value;
    if ((fields.frequency === 'MENSUAL' || fields.frequency === 'TRIMESTRAL') && /^\d{1,2}$/.test(value)) fields.rule = value;
  }
  const time = normalizeTime(raw.time);
  if (time) fields.time = time;
  if (raw.durationMin !== undefined) fields.durationMin = clamp(raw.durationMin, 5, 720, fields.durationMin);
  if (typeof raw.type === 'string' && TYPES.includes(raw.type.trim())) fields.type = raw.type.trim();
  if (typeof raw.priority === 'string' && PRIORITIES.includes(raw.priority.trim().toUpperCase())) fields.priority = raw.priority.trim().toUpperCase();
  if (typeof raw.deepFocus === 'boolean') fields.deepFocus = raw.deepFocus;
  if (raw.reminderMin !== undefined) fields.reminderMin = clamp(raw.reminderMin, 0, 40320, fields.reminderMin);
  if (typeof raw.purpose === 'string' && raw.purpose.trim()) fields.purpose = raw.purpose.trim().slice(0, 500);
  if (typeof raw.result === 'string' && raw.result.trim()) fields.result = raw.result.trim().slice(0, 500);
  if (typeof raw.kind === 'string') fields.kind = raw.kind === 'meeting' ? 'meeting' : 'recurrence';
  return { fields, notes };
}

/**
 * Interpreta una rutina escrita en lenguaje natural.
 * 1) /api/llm/autocomplete (t3) 2) /api/llm/chat 3) parser local.
 */
export async function interpretRoutineText(text) {
  const local = parseRoutineText({ text });
  if (!text || !text.trim()) return local;
  /* Si el módulo del LLM no está montado, no se sondea nada: parser local. */
  if (!capability('llm')) return { ...local, interpretation: [...local.interpretation, 'parser local (LLM no montado)'] };

  const prompt = [
    'Extrae los campos de una rutina de agenda a partir del texto del usuario.',
    'Responde SOLO con JSON válido, sin explicaciones ni markdown:',
    '{"title":"","kind":"recurrence|meeting","frequency":"DIARIA|LABORABLES|SEMANAL|MENSUAL|TRIMESTRAL","rule":"","time":"HH:MM","durationMin":30,"type":"Foco|Administrativo|Reunión|Reporte","priority":"P1|P2|P3","deepFocus":false,"reminderMin":10,"purpose":"","result":""}',
    `Texto: ${text}`
  ].join('\n');

  try {
    const response = await api.post('/api/llm/autocomplete', { mode: 'routine', text }, { timeoutMs: 15000 });
    rememberEndpoint('llmAutocomplete', true);
    const payload = response?.fields || response?.item || response?.suggestion || null;
    if (payload && typeof payload === 'object') {
      const { fields } = sanitizeRoutineFields(payload, local);
      return { ...local, source: 'llm-autocomplete', fields, interpretation: [...local.interpretation, 'autocompletado del agente'] };
    }
  } catch (error) {
    rememberEndpoint('llmAutocomplete', false, { missing: error instanceof ApiError && [404, 405, 501].includes(error.status) });
  }

  try {
    const response = await api.post('/api/llm/chat', {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 320
    }, { timeoutMs: 25000 });
    rememberEndpoint('llmChat', true);
    const reply = String(response?.reply || '').trim();
    const jsonText = /{[^}]*}/s.exec(reply)?.[0];
    if (jsonText) {
      const parsed = JSON.parse(jsonText);
      const { fields } = sanitizeRoutineFields(parsed, local);
      return {
        ...local,
        source: response?.provider ? `llm (${response.provider})` : 'llm',
        fields,
        interpretation: [...local.interpretation, 'campos sugeridos por el modelo']
      };
    }
  } catch (error) {
    rememberEndpoint('llmChat', false, { missing: error instanceof ApiError && [404, 405, 501].includes(error.status) });
  }

  return local;
}

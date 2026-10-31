/**
 * Redacción natural de los avisos (t16).
 *
 * Regla de estilo: UNA frase, sin listas, sin markdown y sin sonar a bot.
 * Se varían las plantillas con una semilla estable por aviso/día para que no
 * todos los avisos del mismo tipo se lean igual. Si hay LLM, `engine.mjs`
 * reescribe este borrador con el perfil `signals`.
 */
import { formatTime } from '../agenda/time.mjs';

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'el correo' };

function hashSeed(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function pick(seed, variants) {
  return variants[hashSeed(seed) % variants.length];
}

function labelOf(item) {
  return `«${String(item.title || 'asunto').slice(0, 80)}»`;
}

function hourLabel(iso, tz) {
  try {
    return formatTime(iso, tz);
  } catch {
    return '';
  }
}

function oneSentence(text) {
  const clean = String(text || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s*_#-]+/, '')
    .trim();
  if (!clean) return '';
  const capped = clean.length > 500 ? `${clean.slice(0, 497)}…` : clean;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function extraClause(extraCount) {
  if (!extraCount) return '';
  return extraCount === 1 ? '; y hay 1 asunto más en la cola' : `; y hay ${extraCount} asuntos más en la cola`;
}

function draftFor(item, context) {
  const { tz, dateKey, time } = context;
  const seed = `${item.type}:${item.fingerprint || item.id}:${dateKey}`;
  const count = Math.max(1, Number(item.count) || 1);
  switch (item.type) {
    case 'overdue': {
      const days = Math.max(0, Number(item.daysOverdue) || 0);
      return pick(seed, [
        `Se te pasó la fecha de ${labelOf(item)}${days ? ` hace ${days} día${days === 1 ? '' : 's'}` : ''}; ciérrala o muévela hoy`,
        `${labelOf(item)} sigue abierta${days ? ` desde hace ${days} día${days === 1 ? '' : 's'}` : ''}; ¿la cierras ahora o le buscas hueco?`,
        `Llevas pendiente ${labelOf(item)} y ya venció; decide si la haces hoy o la reprogramas`
      ]);
    }
    case 'undated': {
      return pick(seed, [
        `${labelOf(item)} no tiene fecha; ponle un día para que no se pierda`,
        `Hay algo sin agendar: ${labelOf(item)}; asígnale un momento hoy`,
        `No dejes suelto ${labelOf(item)}; elige cuándo lo vas a hacer`
      ]);
    }
    case 'free_gap': {
      const at = hourLabel(item.start, tz);
      return pick(seed, [
        `Tienes ${item.minutes} minutos libres a las ${at}; úsalos para adelantar lo importante`,
        `A las ${at} se abre un hueco de ${item.minutes} minutos; métete en lo que más pesa`,
        `Hay una ventana de ${item.minutes} minutos a las ${at}; aprovéchala para avanzar`
      ]);
    }
    case 'focus_unmet': {
      return pick(seed, [
        `Llevas ${item.focusMin} minutos de foco de ${item.target}; te quedan ${item.remaining} por delante hoy`,
        `El foco real va en ${item.focusMin} de ${item.target} minutos; protege un bloque antes de que se acabe el día`,
        `Te faltan ${item.remaining} minutos de foco para llegar a la meta de hoy`
      ]);
    }
    case 'meeting_no_place': {
      const at = item.start ? hourLabel(item.start, tz) : '';
      return pick(seed, [
        `${labelOf(item)} empieza${at ? ` a las ${at}` : ''} y no tiene lugar ni enlace; define dónde será`,
        `Antes de entrar a ${labelOf(item)}${at ? ` a las ${at}` : ''}, ponle sala o link`,
        `La reunión ${labelOf(item)} está cerca${at ? ` (${at})` : ''} y sigue sin sitio; resuélvelo ahora`
      ]);
    }
    case 'approvals': {
      const age = Number(item.ageHours) > 0
        ? Number(item.ageHours) >= 24
          ? `${Math.floor(Number(item.ageHours) / 24)} día${Math.floor(Number(item.ageHours) / 24) === 1 ? '' : 's'}`
          : `${Math.round(Number(item.ageHours))} hora${Math.round(Number(item.ageHours)) === 1 ? '' : 's'}`
        : '';
      return pick(seed, [
        `Tienes ${count === 1 ? 'una propuesta esperando' : `${count} propuestas esperando`} tu decisión, empezando por ${labelOf(item)}`,
        `${labelOf(item)} necesita tu visto bueno${age ? ` desde hace ${age}` : ''}; revísala cuando puedas`,
        `Hay ${count === 1 ? 'una aprobación pendiente' : `${count} aprobaciones pendientes`}; ${labelOf(item)}${age ? ` lleva ${age}` : ' es la primera'}`
      ]);
    }
    case 'unanswered': {
      const channel = CHANNEL_LABELS[item.channel] || 'un canal';
      const since = item.since ? hourLabel(item.since, tz) : '';
      return pick(seed, [
        `Tienes ${item.count} mensaje${item.count === 1 ? '' : 's'} sin responder en ${channel}${since ? ` desde las ${since}` : ''}`,
        `En ${channel} quedó${item.count === 1 ? '' : 'n'} ${item.count} mensaje${item.count === 1 ? '' : 's'} esperando respuesta${since ? ` desde ${since}` : ''}`,
        `No se te escape: ${item.count} mensaje${item.count === 1 ? '' : 's'} de ${channel} sin contestar`
      ]);
    }
    case 'daily_close': {
      const time = context.time || '17:30';
      return pick(seed, [
        `Todavía no has hecho el cierre del día; son las ${time} y toca revisar qué quedó`,
        'El cierre diario sigue pendiente; anota qué terminaste y qué se mueve a mañana',
        `Falta el cierre de hoy (${time}); dedica dos minutos a dejar la agenda en orden`
      ]);
    }
    default:
      return `Tienes ${labelOf(item)} pendiente`;
  }
}

/**
 * Borrador determinista del aviso (sin LLM).
 * @param {{items:object[], fingerprint:string, type:string}} nudge
 * @param {{now:Date, tz:string, dateKey:string, counters?:object}} context
 */
export function buildDraft(nudge, context) {
  const items = Array.isArray(nudge.items) ? nudge.items : [];
  if (!items.length) return '';
  const primary = items[0];
  const sentence = draftFor(primary, context);
  return oneSentence(`${sentence}${extraClause(items.length - 1)}`);
}

/** Asunto corto y humano (sin spam). */
export function subjectFor(nudge) {
  const type = nudge?.type;
  if (type === 'overdue') return 'Agenda Copilot — algo se te pasó';
  if (type === 'daily_close') return 'Agenda Copilot — cierre del día';
  if (type === 'unanswered') return 'Agenda Copilot — mensajes pendientes';
  if (type === 'approvals') return 'Agenda Copilot — decisión pendiente';
  if (type === 'free_gap') return 'Agenda Copilot — hueco aprovechable';
  if (type === 'focus_unmet') return 'Agenda Copilot — foco del día';
  if (type === 'meeting_no_place') return 'Agenda Copilot — reunión sin lugar';
  return 'Agenda Copilot — aviso';
}

/**
 * Texto del reporte diario (al cierre).
 * @param {{sent:number, dismissed:number, pending:object[], now:Date, tz:string}} options
 */
export function buildDailyReportText({ sent = 0, dismissed = 0, pending = [], now, tz }) {
  const pendingTitles = (Array.isArray(pending) ? pending : []).slice(0, 3).map((item) => labelOf(item));
  const pendingPart = pendingTitles.length
    ? `quedó pendiente ${pendingTitles.join(', ')}`
    : 'no quedó nada urgente abierto';
  const sentPart = sent === 0
    ? 'Hoy no hizo falta avisarte'
    : `Hoy te avisé ${sent} ${sent === 1 ? 'vez' : 'veces'}`;
  const dismissedPart = dismissed > 0
    ? ` y descartaste ${dismissed} aviso${dismissed === 1 ? '' : 's'}`
    : '';
  return oneSentence(`${sentPart}${dismissedPart}; ${pendingPart}`);
}

/** Sanea la salida del LLM para que siga siendo un aviso corto. */
export function sanitizeLlmText(text) {
  return oneSentence(String(text || '').replace(/^["“]|["”]$/g, '').trim());
}


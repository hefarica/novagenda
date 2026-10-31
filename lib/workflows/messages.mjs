/**
 * Textos deterministas de los workflows.
 *
 * Compatibilidad: brief, mediodía, cierre y semanal reproducen EXACTAMENTE los
 * textos del motor anterior (modelo P95). Nocturno y resumen horario son nuevos.
 * Si el LLM está apagado o falla, el scheduler envía estos textos.
 */
import { store } from '../store.mjs';
import { dashboard, todaySummary, closeSummary, weeklySummary } from '../assistant.mjs';
import {
  addDaysKey, dateKeyOfIso, formatTime, minutesBetween, timezoneOf
} from '../agenda/time.mjs';

function data() {
  return store.get();
}

function tzOf() {
  return timezoneOf(data().settings || {});
}

function todayKey(now = new Date()) {
  return dateKeyOfIso(now.toISOString(), tzOf());
}

function safeEvents() {
  return (data().agenda || []).filter((event) => event && typeof event === 'object');
}

function eventsOfDay(dateKey) {
  return safeEvents()
    .filter((event) => {
      const start = Date.parse(event.start);
      if (!Number.isFinite(start)) return false;
      return dateKeyOfIso(event.start, tzOf()) === dateKey && event.status !== 'Cancelada';
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Brief: texto histórico del modelo. */
export function briefText() {
  return todaySummary();
}

/** Chequeo de mediodía: mismo texto que el motor anterior. */
export function middayText(now = new Date()) {
  const today = todayKey(now);
  const current = dashboard();
  const top = current.top3 && current.top3[0] ? current.top3[0].title : null;
  return `🧭 CHEQUEO MEDIODÍA — ${today}\n¿Tu prioridad #1 sigue siendo la correcta?\n${top ? `Top actual: ${top}` : 'No hay Top 1 pendiente.'}`;
}

/** Cierre diario (las métricas se capturan antes en el runner). */
export function closeText() {
  return closeSummary();
}

/** Reporte semanal P95. */
export function weeklyText() {
  return weeklySummary();
}

/** Resumen nocturno: cierre + preparación de mañana. */
export function nightlyText(now = new Date()) {
  const view = dashboard();
  const tomorrow = addDaysKey(todayKey(now), 1);
  const rows = eventsOfDay(tomorrow).slice(0, 6);
  const lines = [
    `🌙 RESUMEN NOCTURNO — ${view.date}`,
    `Hechas: ${view.done}/${view.total} · Foco: ${view.focusMin} min · Índice P95: ${view.p95}/100`
  ];
  if (rows.length) {
    lines.push('', `MAÑANA (${tomorrow})`);
    for (const event of rows) {
      lines.push(`${formatTime(event.start, tzOf())} — ${event.title || 'Cita'}${event.type ? ` [${event.type}]` : ''}`);
    }
  } else {
    lines.push('', `MAÑANA (${tomorrow}): sin citas registradas.`);
  }
  if (view.overdue > 0) lines.push('', `Vencidas abiertas: ${view.overdue}`);
  return lines.join('\n');
}

/**
 * Cambios de la última ventana: nuevas, movidas y completadas.
 * Tolera eventos corruptos (start inválido) sin romper.
 */
export function collectChanges({ sinceIso, now = new Date() } = {}) {
  const sinceMs = Date.parse(sinceIso || '');
  const from = Number.isFinite(sinceMs) ? sinceMs : now.getTime() - 3600_000;
  const created = [];
  const moved = [];
  const completed = [];
  for (const event of safeEvents()) {
    try {
      const createdMs = Date.parse(event.createdAt || '');
      const updatedMs = Date.parse(event.updatedAt || '');
      const completedMs = Date.parse(event.completedAt || '');
      if (Number.isFinite(completedMs) && completedMs >= from) {
        completed.push(event);
        continue;
      }
      if (event.status === 'Cancelada') continue;
      if (Number.isFinite(createdMs) && createdMs >= from) created.push(event);
      else if (Number.isFinite(updatedMs) && updatedMs >= from) moved.push(event);
    } catch { /* dato corrupto: se ignora */ }
  }
  return {
    created,
    moved,
    completed,
    total: created.length + moved.length + completed.length
  };
}

function lineFor(event) {
  const start = Date.parse(event.start);
  const when = Number.isFinite(start) ? `${formatTime(event.start, tzOf())} ` : '';
  return `${when}${String(event.title || 'Cita').slice(0, 80)}`;
}

/** Resumen horario de cambios (texto determinista). */
export function hourlyChangesText({ sinceIso, now = new Date() } = {}) {
  const changes = collectChanges({ sinceIso, now });
  const label = formatTime(now.toISOString(), tzOf());
  if (!changes.total) {
    return {
      text: `🕐 SIN CAMBIOS — ${label}\nNo hubo citas nuevas, movidas ni completadas en la última hora.`,
      empty: true,
      changes
    };
  }
  const lines = [`🕐 CAMBIOS EN LA AGENDA — ${label}`];
  if (changes.created.length) lines.push(`• Nuevas (${changes.created.length}): ${changes.created.slice(0, 5).map(lineFor).join(' · ')}`);
  if (changes.moved.length) lines.push(`• Movidas (${changes.moved.length}): ${changes.moved.slice(0, 5).map(lineFor).join(' · ')}`);
  if (changes.completed.length) lines.push(`• Completadas (${changes.completed.length}): ${changes.completed.slice(0, 5).map(lineFor).join(' · ')}`);
  return { text: lines.join('\n'), empty: false, changes };
}

/**
 * Construye el mensaje de una acción `notify`.
 * @param {string} template
 * @param {{now?:Date, sinceIso?:string}} [options]
 * @returns {{text:string, subject:string|null, empty:boolean, llmProfile:string|null, llmInput:object}}
 */
export function buildTemplateMessage(template, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const tz = tzOf();
  const today = todayKey(now);
  switch (template) {
    case 'brief':
      return { text: briefText(), subject: 'Brief diario Agenda Copilot', empty: false, llmProfile: 'brief', llmInput: {} };
    case 'midday':
      return { text: middayText(now), subject: 'Chequeo de mediodía', empty: false, llmProfile: 'midday', llmInput: {} };
    case 'close':
      return { text: closeText(), subject: 'Cierre diario Agenda Copilot', empty: false, llmProfile: 'close', llmInput: {} };
    case 'weekly':
      return { text: weeklyText(), subject: 'Reporte semanal P95', empty: false, llmProfile: 'weekly', llmInput: {} };
    case 'nightly':
      return {
        text: nightlyText(now),
        subject: 'Resumen nocturno Agenda Copilot',
        empty: false,
        llmProfile: 'schedule_summary',
        llmInput: { date: addDaysKey(today, 1) }
      };
    case 'hourly_changes': {
      const changes = hourlyChangesText({ sinceIso: options.sinceIso, now });
      return {
        text: changes.text,
        subject: 'Cambios en la agenda (última hora)',
        empty: changes.empty,
        llmProfile: 'schedule_summary',
        llmInput: { date: today },
        compose: 'detail_then_summary'
      };
    }
    case 'custom':
      return {
        text: String(options.customText || '').trim(),
        subject: null,
        empty: !String(options.customText || '').trim(),
        llmProfile: null,
        llmInput: {}
      };
    default:
      return { text: '', subject: null, empty: true, llmProfile: null, llmInput: {} };
  }
}

/** Contexto mínimo para el mensaje de recordatorio (compatibilidad exacta). */
export function reminderMessage(event, reminderMin) {
  return {
    text: `⏰ ${event.title || 'Evento'}\n${event.id || ''} empieza en ${reminderMin} min.`,
    subject: `Recordatorio: ${event.title || 'Evento'}`
  };
}

/** Utilidad compartida por señales: minutos de un evento. */
export function eventMinutes(event) {
  const start = Date.parse(event?.start);
  const end = Date.parse(event?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return minutesBetween(event.start, event.end);
}

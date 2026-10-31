import { store, nextId, addActivity, localDateKey, isoAtLocal } from './store.mjs';
import { createGoogleEvent, updateGoogleEvent, reconcileGoogle, googleSyncStatus } from './google.mjs';
import {
  addDaysKey, dateKeyOfIso, formatShortDate, formatTime, isValidIso, minutesBetween,
  safeDateKeyOfIso, timezoneOf, weekStartKey
} from './agenda/time.mjs';
import { compareByScore, priorityScore, withComputedScore } from './agenda/score.mjs';
import { computeP95FromData } from './agenda/p95.mjs';
import {
  checkConflicts, collectBusy as collectBusyEngine, collectBusyDetailed as collectBusyDetailedEngine,
  describeConflict, detectTodayConflicts, findSlotsDetailed as findSlotsDetailedEngine
} from './agenda/conflicts.mjs';
import {
  cancelAgendaEvent, completeAgendaEvent, createAgendaEvent as createAgendaEventService,
  patchAgendaEvent, presentEvent
} from './agenda/events.mjs';
import {
  materializeToday, runDailyMaterialization
} from './agenda/routines.mjs';
import {
  formatMonthlyText, formatWeeklyText, monthlyReport, snapshotDailyMetrics as snapshotMetrics,
  weeklyReport, getMetrics
} from './metrics/metrics.mjs';

/**
 * Asistente determinista en español + dashboard P95 + reportes.
 *
 * Compatibilidad: mantiene los comandos del modelo
 * (HOY, CAPTURA, HECHO, POSPONER/MOVER, FOCO, CIERRE, SEMANA, balance) y las
 * funciones exportadas que usa server.mjs. La lógica pesada vive en
 * lib/agenda/** y lib/metrics/**.
 */

const MONTHS = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };
const WEEK = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
const fmtTime = (value) => formatTime(value, store.get().settings.timezone);
const fmtDate = (value) => formatShortDate(value, store.get().settings.timezone);

function addDaysKeySafe(key, n) {
  return addDaysKey(key, n);
}

function keyFromDate(value) {
  return safeDateKeyOfIso(value, timezoneOf(store.get().settings));
}

function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function dashboard() {
  const data = store.get();
  const tz = timezoneOf(data.settings);
  const today = dateKeyOfIso(new Date().toISOString(), tz);
  const rows = data.agenda.filter((event) => keyFromDate(event.start) === today && event.status !== 'Cancelada');
  const done = rows.filter((event) => event.status === 'Hecho');
  const focus = rows.filter((event) => event.deepFocus)
    .reduce((sum, event) => sum + Number(event.actualMin || 0), 0);
  const overdue = data.agenda.filter((event) => event.status !== 'Hecho' && event.status !== 'Cancelada' && event.due && event.due < today).length;
  const meetings = rows.filter((event) => event.type === 'Reunión');
  const meetingMin = meetings.reduce((sum, event) => sum + minutesBetween(event.start, event.end), 0);
  const effectivenessValues = (data.meetings || []).map((meeting) => Number(meeting.effectiveness)).filter((value) => Number.isFinite(value));
  const meetingEffectiveness = effectivenessValues.length ? effectivenessValues.reduce((sum, value) => sum + value, 0) / effectivenessValues.length : 0;
  const okrProgress = data.okrs.length ? data.okrs.reduce((sum, okr) => sum + Number(okr.progress || 0), 0) / data.okrs.length : 0;
  const execution = rows.length ? done.length / rows.length : 0;
  const p95 = computeP95FromData(data, { dateKey: today, timezone: tz });
  const todayConflicts = detectTodayConflicts({ data, settings: data.settings, dateKey: today });
  const top3 = rows
    .filter((event) => event.status !== 'Hecho')
    .map(withComputedScore)
    .sort(compareByScore)
    .slice(0, 3);

  return {
    date: today,
    p95: p95.index,
    p95Score: p95.score,
    p95Components: p95.components,
    p95Inputs: p95.inputs,
    p95Weights: p95.weights,
    p95Targets: p95.targets,
    execution,
    focusMin: focus,
    overdue,
    meetingMin,
    meetingEffectiveness,
    okrProgress,
    weeklyExecution: p95.inputs.weeklyExecution,
    weeklyReview: p95.inputs.weeklyReview === 1,
    interruptionsToday: p95.inputs.interruptionsToday,
    total: rows.length,
    done: done.length,
    pending: rows.length - done.length,
    conflicts: todayConflicts.count,
    conflictDetails: todayConflicts.conflicts,
    todayEvents: [...rows].map(presentEvent).sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 20),
    top3,
    google: googleSyncStatus(),
    metrics: getMetrics(data, { days: 7, dateKey: today }).totals
  };
}

export function todaySummary() {
  const data = dashboard();
  let text = `📌 AGENDA COPILOT — ${data.date}\nPendientes: ${data.pending} · Foco: ${data.focusMin} min · Conflictos: ${data.conflicts}\nÍndice P95: ${data.p95}/100\n\nTOP 3\n`;
  data.top3.forEach((event, index) => {
    text += `${index + 1}. ${fmtTime(event.start)} — ${event.title} [${event.priority}] score ${event.score}\n`;
  });
  if (!data.top3.length) text += '✅ Sin pendientes prioritarios.\n';
  return text.trim();
}

export function closeSummary() {
  const data = dashboard();
  return `✅ CIERRE ${data.date}\nHechas: ${data.done}/${data.total}\nAbiertas: ${data.pending}\nFoco: ${data.focusMin} min\nÍndice P95: ${data.p95}/100`;
}

export function weeklySummary() {
  const report = weeklyReport(store.get());
  return formatWeeklyText(report);
}

export function monthlySummary() {
  const report = monthlyReport(store.get());
  return formatMonthlyText(report);
}

/**
 * Snapshot diario de los 14 campos. Se conserva la firma síncrona histórica;
 * la persistencia se agenda en el store.
 */
export function snapshotDailyMetrics() {
  const data = store.get();
  const metric = snapshotMetrics(data, {});
  store.mutate(() => {}).catch(console.error);
  return metric;
}

/** Compatibilidad con server.mjs: choques locales + rutinas + Google. */
export async function collectBusy(start, end, ignoreId = null) {
  return collectBusyEngine(start, end, ignoreId);
}

export async function collectBusyDetailed(start, end, options = {}) {
  return collectBusyDetailedEngine(start, end, options);
}

/** Compatibilidad: franjas alternativas dentro de jornada. */
export async function findSlots(durationMin, fromIso, days = 3, options = {}) {
  const result = await findSlotsDetailedEngine({ ...options, durationMin, fromIso, days, count: options.count || 3 });
  return result.slots;
}

export async function findSlotsDetailed(durationMin, fromIso, options = {}) {
  return findSlotsDetailedEngine({ ...options, durationMin, fromIso });
}

async function openAIParse(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
  const prompt = `Eres un parser de agenda en español. Fecha local actual: ${localDateKey()}, zona ${store.get().settings.timezone}. Devuelve SOLO JSON sin markdown con: {"action":"schedule|balance|capture|done|postpone|focus|today|week|close|unknown","title":string|null,"date":"YYYY-MM-DD"|null,"time":"HH:MM"|null,"durationMin":number|null,"id":string|null,"minutes":number|null,"attendees":[],"notes":string|null}. No inventes fecha/hora si no están implícitas o explícitas. Texto: ${JSON.stringify(text)}`;
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: prompt }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    let out = json.output_text || '';
    if (!out && Array.isArray(json.output)) for (const item of json.output) for (const content of item.content || []) if (content.text) out += content.text;
    try {
      return JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || out);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function parseDate(text) {
  const low = text.toLowerCase();
  const today = localDateKey();
  if (/pasado mañana/.test(low)) return addDaysKeySafe(today, 2);
  if (/mañana/.test(low)) return addDaysKeySafe(today, 1);
  if (/\bhoy\b/.test(low)) return today;
  const iso = low.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const slash = low.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
  if (slash) return `${slash[3] || today.slice(0, 4)}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  for (const [name, monthIndex] of Object.entries(MONTHS)) {
    const match = low.match(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${escapeReg(name)}(?:\\s+de\\s+(20\\d{2}))?`));
    if (match) return `${match[2] || today.slice(0, 4)}-${String(monthIndex + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  for (const [name, dow] of Object.entries(WEEK)) {
    if (new RegExp(`\\b${escapeReg(name)}\\b`).test(low)) {
      const base = new Date(`${today}T12:00:00Z`);
      const current = base.getUTCDay();
      let delta = (dow - current + 7) % 7;
      if (delta === 0) delta = 7;
      return addDaysKeySafe(today, delta);
    }
  }
  return null;
}

function parseTime(text) {
  const low = text.toLowerCase().replace(/a\.\s*m\./g, 'am').replace(/p\.\s*m\./g, 'pm');
  let match = low.match(/(?:a\s+las?|a\s+la|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) match = low.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (!match) return null;
  let hour = +match[1];
  const minute = +(match[2] || 0);
  const ampm = match[3];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseLocal(text) {
  const u = text.trim();
  const low = u.toLowerCase();
  if (/^hoy\??$/.test(low) || /qué tengo hoy|que tengo hoy|agenda de hoy/.test(low)) return { action: 'today' };
  if (/balance|resumen del día|resumen del dia|cómo voy|como voy/.test(low)) return { action: 'balance' };
  if (/^cierre/.test(low)) return { action: 'close' };
  if (/^semana/.test(low) || /reporte semanal/.test(low)) return { action: 'week' };
  let match = u.match(/^CAPTURA\s+(.+)/i);
  if (match) return { action: 'capture', title: match[1] };
  match = u.match(/^HECHO\s+(AG-\d+)/i);
  if (match) return { action: 'done', id: match[1].toUpperCase() };
  match = u.match(/^(?:POSPONER|MOVER)\s+(AG-\d+)\s+(\d+)\s*(?:MIN|MINUTOS?)?/i);
  if (match) return { action: 'postpone', id: match[1].toUpperCase(), minutes: +match[2] };
  match = u.match(/^FOCO\s+(\d+)\s+(.+)/i);
  if (match) return { action: 'focus', durationMin: +match[1], title: match[2] };
  const schedule = /\b(agenda|agendar|agéndame|agendame|programa|programar|reunión|reunion|cita|reserva|bloquea)\b/i.test(u);
  if (schedule) {
    const date = parseDate(u);
    const time = parseTime(u);
    const durationMatch = u.match(/(?:durante|por)\s+(\d+)\s*(?:minutos?|min)/i) || u.match(/(\d+)\s*(?:minutos?|min)\s+de\s+duración/i);
    let title = u
      .replace(/^(agenda|agendar|agéndame|agendame|programa|programar|bloquea)\s+/i, '')
      .replace(/\b(hoy|mañana|pasado mañana)\b/ig, '')
      .replace(/\b(el\s+)?(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/ig, '')
      .replace(/(?:a\s+las?|a\s+la|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/ig, '')
      .replace(/(?:durante|por)\s+\d+\s*(?:minutos?|min)/ig, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^reunión\s+/i, 'Reunión ');
    return { action: 'schedule', title: title || 'Compromiso', date, time, durationMin: durationMatch ? +durationMatch[1] : store.get().settings.defaultDurationMin };
  }
  return { action: 'unknown' };
}

async function parseIntent(text) {
  const local = parseLocal(text);
  if (local.action !== 'unknown' && !(local.action === 'schedule' && (!local.date || !local.time))) return local;
  const ai = await openAIParse(text);
  return ai && ai.action !== 'unknown' ? { ...local, ...ai } : local;
}

async function createEventFromAssistant(payload, { check = true, force = false, allowUnverified = false } = {}) {
  let result;
  await store.mutate(async (data) => {
    result = await createAgendaEventService({
      data, settings: data.settings, payload, check, force, allowUnverified
    });
  });
  return result;
}

async function patchEventFromAssistant(id, patch, { check = true, force = false, allowUnverified = false } = {}) {
  let result;
  await store.mutate(async (data) => {
    result = await patchAgendaEvent({ data, settings: data.settings, id, patch, check, force, allowUnverified });
  });
  return result;
}

async function planSchedule(intent, contextKey) {
  if (!intent.date || !intent.time) {
    return { reply: 'Necesito fecha y hora. Ejemplo: “Agenda reunión con Juan mañana a las 10:00 por 45 min”.' };
  }
  const tz = timezoneOf(store.get().settings);
  const start = isoAtLocal(intent.date, intent.time, tz);
  const end = new Date(new Date(start).getTime() + (intent.durationMin || 60) * 60000).toISOString();
  const conflict = await checkConflicts({ data: store.get(), settings: store.get().settings, start, end });
  if (conflict.conflictCount || conflict.errors.length) {
    const slots = (await findSlotsDetailedEngine({
      durationMin: intent.durationMin || 60, fromIso: start, days: 5, count: 3, data: store.get(), settings: store.get().settings
    })).slots;
    await store.mutate((data) => {
      data.pendingActions[contextKey] = {
        type: 'schedule', title: intent.title, start, end,
        durationMin: intent.durationMin || 60, slots,
        allowUnverified: conflict.errors.length > 0,
        createdAt: new Date().toISOString()
      };
    });
    const why = conflict.conflicts.slice(0, 2).map(describeConflict).join(', ');
    const warning = conflict.errors.length
      ? `\n⚠️ No pude verificar Google Calendar (${conflict.errors[0].error}). Las opciones no están confirmadas contra tu calendario externo.`
      : '';
    return {
      reply: `⚠️ Ese horario se cruza con ${why || 'otro compromiso'}.${warning}\n${slots.length ? slots.map((slot, index) => `${index + 1}) ${fmtDate(slot.start)} ${fmtTime(slot.start)}`).join('\n') : 'No encontré espacio dentro de la jornada configurada.'}\nResponde 1, 2 o 3 para confirmar una alternativa.`,
      conflicts: conflict.conflicts,
      errors: conflict.errors
    };
  }
  const result = await createEventFromAssistant({
    title: intent.title || 'Compromiso',
    start,
    end,
    type: intent.type || 'Compromiso',
    ...(Array.isArray(intent.attendees) && intent.attendees.length
      ? { attendees: intent.attendees.map(String).filter((email) => /@/.test(email)) }
      : {}),
    ...(intent.notes ? { notes: String(intent.notes) } : {})
  }, { check: false });
  if (!result.ok) return { reply: `No pude agendar: ${result.error}`, error: result };
  return {
    reply: `✅ Agendado ${result.event.id}: ${result.event.title}\n${fmtDate(result.event.start)} · ${fmtTime(result.event.start)}–${fmtTime(result.event.end)}${result.event.google ? '\nSincronizado con Google Calendar.' : ''}`,
    event: result.event
  };
}

export async function handleAssistant(text, { channel = 'web', userId = 'self' } = {}) {
  const contextKey = `${channel}:${userId}`;
  const trimmed = String(text || '').trim();
  if (!trimmed) return { reply: 'Escribe una instrucción.' };
  const pending = store.get().pendingActions[contextKey];

  if (pending && /^([123])$/.test(trimmed)) {
    const slot = pending.slots[Number(trimmed) - 1];
    if (!slot) return { reply: 'Esa opción ya no está disponible.' };
    if (pending.type === 'move' && pending.sourceId) {
      const result = await patchEventFromAssistant(pending.sourceId, { start: slot.start, end: slot.end }, {
        check: false, force: true, allowUnverified: pending.allowUnverified
      });
      if (!result.ok) return { reply: `No pude reprogramar: ${result.error}` };
      await store.mutate((data) => { delete data.pendingActions[contextKey]; });
      return { reply: `✅ ${result.event.id} reprogramado: ${result.event.title}\n${fmtDate(result.event.start)} ${fmtTime(result.event.start)}`, event: result.event };
    }
    const result = await createEventFromAssistant({
      title: pending.title, start: slot.start, end: slot.end,
      type: pending.type === 'focus' ? 'Foco' : 'Compromiso',
      deepFocus: pending.type === 'focus'
    }, { check: false, force: true, allowUnverified: pending.allowUnverified });
    if (!result.ok) return { reply: `No pude agendar: ${result.error}` };
    await store.mutate((data) => { delete data.pendingActions[contextKey]; });
    return { reply: `✅ Agendado ${result.event.id}: ${result.event.title}\n${fmtDate(result.event.start)} ${fmtTime(result.event.start)}`, event: result.event };
  }
  if (pending && /cancelar|ninguna/i.test(trimmed)) {
    await store.mutate((data) => { delete data.pendingActions[contextKey]; });
    return { reply: 'Operación cancelada.' };
  }

  const intent = await parseIntent(trimmed);
  if (intent.action === 'today') return { reply: todaySummary() };
  if (intent.action === 'balance') {
    const data = dashboard();
    const risks = [];
    if (data.conflicts) risks.push(`${data.conflicts} choque(s)`);
    if (data.overdue) risks.push(`${data.overdue} vencida(s)`);
    if (data.focusMin < store.get().settings.p95.deepFocusDailyMin) risks.push(`faltan ${Math.max(0, store.get().settings.p95.deepFocusDailyMin - data.focusMin)} min de foco`);
    const suggestion = data.conflicts ? 'resolver primero los choques de agenda'
      : data.focusMin < 120 ? 'proteger un bloque de foco antes de añadir reuniones'
        : 'mantener el Top 3 y evitar abrir más frentes';
    return {
      reply: `📈 BALANCE ${data.date}\nÍndice P95: ${data.p95}/100\nEjecución: ${Math.round(data.execution * 100)}%\nFoco: ${data.focusMin} min\nReuniones: ${Math.round(data.meetingMin)} min\nRiesgos: ${risks.join(' · ') || 'sin alertas críticas'}\nSugerencia: ${suggestion}.`,
      dashboard: data
    };
  }
  if (intent.action === 'week') return { reply: weeklySummary() };
  if (intent.action === 'close') return { reply: closeSummary() };
  if (intent.action === 'capture') {
    let item;
    await store.mutate((data) => {
      item = {
        id: nextId('IN', data.inbox), capturedAt: new Date().toISOString(),
        source: channel === 'web' ? 'App' : channel, type: 'Tarea', input: intent.title,
        context: 'Móvil', actionable: true, due: null, estimatedMin: 30, priority: 'P2',
        processed: false, agendaId: null, notes: 'Capturado por asistente'
      };
      data.inbox.push(item);
    });
    return { reply: `📥 Capturado ${item.id}: ${item.input}` };
  }
  if (intent.action === 'done') {
    let found = null;
    await store.mutate((data) => {
      const result = completeAgendaEvent({ data, settings: data.settings, id: intent.id });
      if (result.ok) found = result.event;
    });
    return { reply: found ? `✅ ${found.id} — Hecho` : `No encontré ${intent.id}.` };
  }
  if (intent.action === 'postpone') {
    const data = store.get();
    const event = data.agenda.find((item) => item.id === intent.id);
    if (!event) return { reply: `No encontré ${intent.id}.` };
    const minutes = Number(intent.minutes || 30);
    const start = new Date(new Date(event.start).getTime() + minutes * 60000).toISOString();
    const end = new Date(new Date(event.end).getTime() + minutes * 60000).toISOString();
    const conflict = await checkConflicts({ data, settings: data.settings, start, end, ignoreIds: [event.id] });
    if (conflict.conflictCount || conflict.errors.length) {
      const slots = (await findSlotsDetailedEngine({
        durationMin: minutesBetween(event.start, event.end), fromIso: start, days: 5, count: 3,
        data, settings: data.settings, ignoreIds: [event.id]
      })).slots;
      await store.mutate((state) => {
        state.pendingActions[contextKey] = {
          type: 'move', title: event.title, sourceId: event.id, slots,
          allowUnverified: conflict.errors.length > 0, createdAt: new Date().toISOString()
        };
      });
      const why = conflict.conflicts.slice(0, 2).map(describeConflict).join(', ');
      const warning = conflict.errors.length ? `\n⚠️ Google sin verificar: ${conflict.errors[0].error}` : '';
      return { reply: `⚠️ Mover ${event.id} ${minutes} min crea un choque${why ? ` con ${why}` : ''}.${warning}\nAlternativas:\n${slots.map((slot, index) => `${index + 1}) ${fmtDate(slot.start)} ${fmtTime(slot.start)}`).join('\n')}` };
    }
    const result = await patchEventFromAssistant(event.id, { start, end }, { check: false, force: true });
    if (!result.ok) return { reply: `No pude posponer: ${result.error}` };
    return { reply: `↪️ ${event.id} → ${fmtTime(start)}`, event: result.event };
  }
  if (intent.action === 'focus') {
    const start = new Date(Math.ceil(Date.now() / (5 * 60000)) * 5 * 60000).toISOString();
    const end = new Date(new Date(start).getTime() + (intent.durationMin || 60) * 60000).toISOString();
    const conflict = await checkConflicts({ data: store.get(), settings: store.get().settings, start, end });
    if (conflict.conflictCount || conflict.errors.length) {
      const slots = (await findSlotsDetailedEngine({
        durationMin: intent.durationMin || 60, fromIso: start, days: 3, count: 3,
        data: store.get(), settings: store.get().settings
      })).slots;
      await store.mutate((data) => {
        data.pendingActions[contextKey] = {
          type: 'focus', title: intent.title, slots,
          allowUnverified: conflict.errors.length > 0, createdAt: new Date().toISOString()
        };
      });
      const warning = conflict.errors.length ? `\n⚠️ Google sin verificar: ${conflict.errors[0].error}` : '';
      return { reply: `🎯 Ese bloque de foco choca con tu agenda.${warning}\nOpciones:\n${slots.map((slot, index) => `${index + 1}) ${fmtDate(slot.start)} ${fmtTime(slot.start)}`).join('\n')}` };
    }
    const result = await createEventFromAssistant({
      title: intent.title, start, end, type: 'Foco', priority: 'P1', impact: 5, urgency: 4, deepFocus: true
    }, { check: false });
    if (!result.ok) return { reply: `No pude crear el foco: ${result.error}` };
    return { reply: `🎯 ${result.event.id} — foco ${intent.durationMin} min creado.`, event: result.event };
  }
  if (intent.action === 'schedule') return planSchedule(intent, contextKey);
  return { reply: 'Puedo ayudarte con: “¿qué tengo hoy?”, “balance”, “agenda reunión mañana a las 10”, “CAPTURA …”, “HECHO AG-0002”, “POSPONER AG-0002 30”, “FOCO 90 …”, “CIERRE” y “SEMANA”.' };
}

/** Materializa rutinas con backfill (usado por el scheduler/arranque). */
export async function materializeRoutines({ todayKey, backfillDays } = {}) {
  let summary;
  await store.mutate(async (data) => {
    summary = await runDailyMaterialization(data, data.settings, {
      todayKey,
      backfillDays: backfillDays !== undefined ? backfillDays : data.settings.routineBackfillDays
    });
  });
  return summary;
}

/** Materializa solo hoy (idempotente). */
export async function materializeRoutinesToday({ todayKey } = {}) {
  let summary;
  await store.mutate(async (data) => {
    summary = await materializeToday(data, data.settings, { todayKey });
  });
  return summary;
}

/** Fuerza una reconciliación Google (endpoint/manual). */
export async function reconcileGoogleNow() {
  return reconcileGoogle({ data: store.get() });
}

/** Recalcula scores de prioridad de toda la agenda. */
export async function recalculateScores() {
  let changed = 0;
  await store.mutate((data) => {
    for (const event of data.agenda) {
      const next = priorityScore(event);
      if (event.score !== next) { event.score = next; changed += 1; }
    }
  });
  return { changed };
}

// La programación de intervalos (materialización de rutinas, reconciliación
// Google, briefings…) es responsabilidad del scheduler de workflows (t8).
// Este módulo expone `materializeRoutines` y `reconcileGoogleNow` para que el
// scheduler los invoque; no arranca timers propios.

export { createGoogleEvent, updateGoogleEvent, addActivity };

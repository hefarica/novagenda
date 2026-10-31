/**
 * Herramientas deterministas del agente de agenda.
 *
 * Cada herramienta valida, ejecuta con el motor de t2 (eventos, conflictos,
 * rutinas, métricas) y devuelve un resultado tipado. NUNCA llama a un LLM: el
 * LLM solo propone la intención; la ejecución es determinista y auditable.
 */
import { store, nextId, addActivity, readOnlyDetailForClients } from '../store.mjs';
import {
  cancelAgendaEvent, completeAgendaEvent, createAgendaEvent, patchAgendaEvent, presentEvent
} from '../agenda/events.mjs';
import { checkConflicts, findSlotsDetailed, describeConflict } from '../agenda/conflicts.mjs';
import { createRoutine, listRoutines, setRoutineActive, updateRoutine } from '../agenda/routines.mjs';
import { weeklyReport, formatWeeklyText } from '../metrics/metrics.mjs';
import { dashboard } from '../assistant.mjs';
import {
  addDaysKey, dateKeyOfIso, formatShortDate, formatTime, isoAtLocal, isValidIso,
  minutesBetween, timezoneOf
} from '../agenda/time.mjs';
import { normalizePriority } from '../agenda/score.mjs';
import { closeTask, createTask, listTasks, reopenTask, taskSummary } from '../travel/tasks.mjs';
import { ensureMeetLink } from '../travel/meet.mjs';
import {
  candidatesReply, describeEvent, findEventCandidates, foldText, instantFrom, tokenize
} from './context.mjs';
import { normalizeAttendees } from './schema.mjs';
import { canonicalizeAgentArgs } from './lingo.mjs';

const PRIORITY_DEFAULTS = Object.freeze({
  P1: { impact: 5, urgency: 5 },
  P2: { impact: 4, urgency: 3 },
  P3: { impact: 3, urgency: 2 }
});

function settingsOf(ctx) {
  return ctx.settings || store.get().settings || {};
}

function tzOf(ctx) {
  return ctx.timezone || timezoneOf(settingsOf(ctx));
}

function ok(message, extra = {}) {
  return { ok: true, status: 200, code: null, message, actions: [], ...extra };
}

function fail(status, code, message, extra = {}) {
  return { ok: false, status, code, message, actions: [], ...extra };
}

function storeReadOnly(error) {
  if (error && error.code === 'STORE_READ_ONLY') {
    return fail(503, 'STORE_READ_ONLY', readOnlyDetailForClients());
  }
  return null;
}

/** Ejecuta una mutación con el store (devuelve el resultado de `fn`). */
async function commit(fn) {
  let result;
  await store.mutate(async (data) => {
    result = await fn(data);
  });
  return result;
}

function whenText(iso, tz) {
  try {
    return `${formatShortDate(iso, tz)} ${formatTime(iso, tz)}`;
  } catch {
    return String(iso || '');
  }
}

function slotLines(slots, tz, limit = 3) {
  return (slots || []).slice(0, limit).map((slot, index) => `${index + 1}) ${whenText(slot.start, tz)}`).join('\n');
}

/** ¿El título ya menciona el nombre? (comparación por palabra, sin acentos). */
function titleMentions(title, name) {
  const hay = foldText(String(title || ''));
  const needle = foldText(String(name || ''));
  if (!hay || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(hay);
}

/**
 * Separa asistentes válidos (emails) de nombres mencionados sin email.
 * Los nombres NO se envían al motor de agenda: se conservan en título/notas.
 */
function resolveAttendees(args = {}) {
  const info = normalizeAttendees(args.attendees);
  const names = [];
  for (const candidate of [...(Array.isArray(args.attendeeNames) ? args.attendeeNames : []), ...info.names]) {
    const clean = String(candidate ?? '').trim().slice(0, 80);
    if (!clean) continue;
    if (names.some((existing) => foldText(existing) === foldText(clean))) continue;
    names.push(clean);
  }
  return { emails: info.emails, names };
}

function payloadFromArgs(args, ctx) {
  const tz = tzOf(ctx);
  const settings = settingsOf(ctx);
  const durationMin = Math.max(5, Number(args.durationMin) || Number(settings.defaultDurationMin) || 60);
  let start = args.start;
  let end = args.end;
  if (!start && args.date && args.time) {
    const instant = instantFrom(args.date, args.time, tz, durationMin);
    if (!instant) return { error: fail(400, 'INVALID_DATE', 'La fecha u hora no son válidas.') };
    start = instant.start;
    end = instant.end;
  }
  if (!isValidIso(start) || !isValidIso(end)) {
    return { error: fail(400, 'INVALID_DATE', 'Necesito una fecha y una hora válidas para agendar.') };
  }
  const priority = normalizePriority(args.priority, 'P2');
  const defaults = PRIORITY_DEFAULTS[priority] || PRIORITY_DEFAULTS.P2;
  const attendeeInfo = resolveAttendees(args);
  let title = typeof args.title === 'string' ? args.title.trim() : '';
  let notes = typeof args.notes === 'string' ? args.notes : '';
  if (attendeeInfo.names.length) {
    const missing = attendeeInfo.names.filter((name) => !titleMentions(title, name));
    if (missing.length) {
      if (title) {
        const suffix = ` con ${missing.join(', ')}`;
        if (title.length + suffix.length <= 200) title = `${title}${suffix}`;
      } else {
        title = `Reunión con ${missing.join(', ')}`;
      }
    }
    const mention = `${attendeeInfo.names.length > 1 ? 'Asistentes mencionados' : 'Asistente mencionado'}: ${attendeeInfo.names.join(', ')} (sin email)`;
    const notesKey = foldText(notes);
    if (!notesKey.includes(foldText(mention))) {
      notes = notes ? `${notes}\n${mention}` : mention;
    }
    notes = notes.slice(0, 2000);
  }
  const payload = {
    title,
    start,
    end,
    type: args.type || 'Compromiso',
    priority,
    impact: args.impact ?? defaults.impact,
    urgency: args.urgency ?? defaults.urgency,
    energy: args.energy || 'Media',
    context: args.context,
    location: args.location,
    reminderMin: args.reminderMin,
    notes,
    deepFocus: args.deepFocus,
    // Defensa extra: SIEMPRE un array de emails (vacío si no hay válidos).
    attendees: attendeeInfo.emails,
    due: args.date || dateKeyOfIso(start, tz)
  };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  return { payload, start, end, durationMin, attendeeNames: attendeeInfo.names };
}

/* ------------------------------------------------------------------ */
/* Resolución de referencias                                           */
/* ------------------------------------------------------------------ */

/** Busca una cita por ID o descripción libre. */
export function resolveEventReference({ id, query } = {}, { includeCancelled = false } = {}) {
  const data = store.get();
  const tz = tzOf({});
  const events = (data.agenda || []).filter((event) => event && event.id && (includeCancelled || event.status !== 'Cancelada'));
  if (id) {
    const found = events.find((event) => String(event.id).toUpperCase() === String(id).toUpperCase());
    if (!found) return fail(404, 'NOT_FOUND', `No encontré la cita ${id}.`);
    return { ok: true, event: found };
  }
  if (!query) return fail(400, 'REQUIRED', '¿Cuál cita? Dime el título o el ID (AG-0002).');
  const candidates = findEventCandidates(events, query);
  if (!candidates.length) return fail(404, 'NOT_FOUND', `No encontré ninguna cita que coincida con «${query}».`);
  if (candidates.length === 1) return { ok: true, event: candidates[0].event };
  const [first, second] = candidates;
  if (first.score >= 4 && first.score > second.score) return { ok: true, event: first.event };
  const options = candidates.slice(0, 3).map((row) => ({
    id: row.event.id,
    title: row.event.title,
    start: row.event.start,
    end: row.event.end,
    label: describeEvent(row.event, tz)
  }));
  return fail(409, 'AMBIGUOUS', `Encontré varias citas parecidas:\n${candidatesReply(candidates, tz)}\nResponde 1, 2 o 3.`, {
    candidates: options
  });
}

/** Busca una rutina por ID o título. */
export function resolveRoutineReference({ id, query } = {}, ctx = {}) {
  const data = store.get();
  const settings = settingsOf(ctx);
  const tz = tzOf(ctx);
  const routines = listRoutines(data, settings);
  if (id) {
    const found = routines.find((routine) => String(routine.id).toUpperCase() === String(id).toUpperCase());
    if (!found) return fail(404, 'NOT_FOUND', `No encontré la rutina ${id}.`);
    return { ok: true, routine: found };
  }
  if (!query) return fail(400, 'REQUIRED', '¿Cuál rutina? Dime el ID (R-002) o el título.');
  const tokens = tokenize(query);
  const scored = routines
    .map((routine) => {
      const haystack = `${routine.title} ${routine.id} ${routine.notes} ${routine.purpose}`.toLowerCase();
      const words = new Set(haystack.split(/[^a-z0-9@._-]+/).filter(Boolean));
      const score = tokens.reduce((acc, token) => acc + (words.has(token) ? 2 : token.length >= 5 && haystack.includes(token) ? 1 : 0), 0);
      return { routine, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return fail(404, 'NOT_FOUND', `No encontré ninguna rutina parecida a «${query}».`);
  if (scored.length === 1 || scored[0].score > scored[1].score) return { ok: true, routine: scored[0].routine };
  const options = scored.slice(0, 3).map((row) => ({
    id: row.routine.id,
    title: row.routine.title,
    label: `${row.routine.id} «${row.routine.title}» · ${row.routine.frequency} ${row.routine.time}`
  }));
  return fail(409, 'AMBIGUOUS', `Encontré varias rutinas parecidas:\n${options.map((row, index) => `${index + 1}) ${row.label}`).join('\n')}\nResponde 1, 2 o 3.`, { candidates: options });
}

/** Busca una captura del inbox por ID o texto. */
export function resolveInboxReference({ id, query } = {}) {
  const items = (store.get().inbox || []).filter((item) => item && item.id && !item.dismissed);
  if (id) {
    const found = items.find((item) => String(item.id).toUpperCase() === String(id).toUpperCase());
    if (!found) return fail(404, 'NOT_FOUND', `No encontré la captura ${id}.`);
    return { ok: true, item: found };
  }
  if (!query) return fail(400, 'REQUIRED', '¿Cuál captura del inbox? Dime el ID (IN-0002) o parte del texto.');
  const tokens = tokenize(query);
  const scored = items
    .map((item) => {
      const haystack = `${item.input} ${item.notes} ${item.id}`.toLowerCase();
      const score = tokens.reduce((acc, token) => acc + (haystack.includes(token) ? 1 : 0), 0);
      return { item, score };
    })
    .filter((row) => row.score > 0 && !row.item.processed)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return fail(404, 'NOT_FOUND', `No encontré ninguna captura pendiente que coincida con «${query}».`);
  if (scored.length === 1 || scored[0].score > scored[1].score) return { ok: true, item: scored[0].item };
  const options = scored.slice(0, 3).map((row) => ({ id: row.item.id, title: row.item.input, label: `${row.item.id} «${row.item.input}»` }));
  return fail(409, 'AMBIGUOUS', `Encontré varias capturas parecidas:\n${options.map((row, index) => `${index + 1}) ${row.label}`).join('\n')}\nResponde 1, 2 o 3.`, { candidates: options });
}

/* ------------------------------------------------------------------ */
/* Herramientas                                                        */
/* ------------------------------------------------------------------ */

async function createAppointment(args, ctx) {
  const tz = tzOf(ctx);
  const settings = settingsOf(ctx);
  const built = payloadFromArgs(args, ctx);
  if (built.error) return built.error;
  const { payload, start, durationMin } = built;

  const dryRun = ctx.dryRun === true;
  const conflicts = await checkConflicts({ data: store.get(), settings, start, end: built.end });
  const hasConflict = conflicts.conflictCount > 0;
  const hasErrors = conflicts.errors.length > 0;
  const blocked = (hasConflict || hasErrors) && ctx.force !== true && (hasConflict || ctx.allowUnverified !== true);
  if (blocked) {
    const alternatives = (await findSlotsDetailed({
      durationMin, fromIso: start, days: 5, count: 3, data: store.get(), settings
    })).slots;
    const why = conflicts.conflicts.slice(0, 2).map(describeConflict).join(', ');
    const warning = hasErrors ? `\n⚠️ No pude verificar Google Calendar (${conflicts.errors[0].error}).` : '';
    const code = hasConflict ? 'CONFLICT' : 'FREEBUSY_UNAVAILABLE';
    return fail(409, code, `${dryRun ? 'Simulación: ' : ''}⚠️ Ese horario ${hasConflict ? `se cruza con ${why || 'otro compromiso'}` : 'no se pudo verificar contra Google'}.${warning}`, {
      conflicts: conflicts.conflicts,
      errors: conflicts.errors,
      slots: alternatives,
      allowUnverified: hasErrors
    });
  }

  if (dryRun) {
    return ok(`Simulación: crearía «${payload.title}» el ${whenText(start, tz)} (${durationMin} min).`, {
      actions: [{ type: 'create', agendaId: null, dryRun: true, title: payload.title, start, end: built.end }],
      preview: { title: payload.title, start, end: built.end }
    });
  }

  let result;
  try {
    result = await commit((data) => createAgendaEvent({
      data,
      settings: data.settings,
      payload,
      check: false, // ya se verifica arriba para poder ofrecer alternativas
      force: ctx.force === true,
      allowUnverified: true
    }));
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude crear la cita.');
  }
  if (!result.ok) return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude crear la cita.', result);

  // Recalcula el dashboard después del cambio para la respuesta.
  return ok(
    `✅ Agendado ${result.event.id}: ${result.event.title}\n${whenText(result.event.start, tz)}–${formatTime(result.event.end, tz)} · ${result.event.type} · ${result.event.priority}${result.event.google ? '\nSincronizado con Google Calendar.' : ''}`,
    {
      event: presentEvent(result.event),
      actions: [{ type: 'create', status: 'ok', agendaId: result.event.id, title: result.event.title }],
      google: result.event.google || null
    }
  );
}

async function findHoles(args, ctx) {
  const settings = settingsOf(ctx);
  const tz = tzOf(ctx);
  const durationMin = Math.max(5, Number(args.durationMin) || Number(settings.defaultDurationMin) || 60);
  let fromIso = args.from;
  if (!fromIso && args.date) {
    fromIso = instantFrom(args.date, args.time || settings.workdayStart || '08:00', tz, durationMin)?.start;
  }
  if (!fromIso) fromIso = new Date().toISOString();
  const days = Number(args.days) || 5;
  const result = await findSlotsDetailed({ durationMin, fromIso, days, count: 5, data: store.get(), settings });
  if (!result.slots.length) {
    return fail(409, 'NO_SLOT', 'No encontré huecos disponibles en el horizonte pedido. Prueba otro día o una duración menor.', { slots: [] });
  }
  return ok(`Huecos disponibles (${durationMin} min):\n${slotLines(result.slots, tz, 5)}`, {
    slots: result.slots,
    errors: result.errors,
    unknown: result.unknown,
    actions: [{ type: 'find_slots', status: 'ok', detail: `${result.slots.length} huecos` }]
  });
}

async function moveAppointment(args, ctx) {
  const tz = tzOf(ctx);
  const settings = settingsOf(ctx);
  const resolved = resolveEventReference({ id: args.id, query: args.query || args.title });
  if (!resolved.ok) return resolved;
  const event = resolved.event;
  const durationMin = Math.max(5, Number(args.durationMin) || minutesBetween(event.start, event.end) || 60);
  let start = args.start;
  let end = args.end;
  const sameDayKey = (() => {
    try {
      return dateKeyOfIso(event.start, tz);
    } catch {
      return null;
    }
  })();
  if (!start && args.time && !args.date && sameDayKey) {
    const instant = instantFrom(sameDayKey, args.time, tz, durationMin);
    if (!instant) return fail(400, 'INVALID_DATE', 'La nueva hora no es válida.');
    start = instant.start;
    end = instant.end;
  }
  if (!start && args.date && args.time) {
    const instant = instantFrom(args.date, args.time, tz, durationMin);
    if (!instant) return fail(400, 'INVALID_DATE', 'La nueva fecha u hora no son válidas.');
    start = instant.start;
    end = instant.end;
  }
  if (!start && Number.isFinite(Number(args.shiftMinutes))) {
    // Desplazamiento relativo: «atrasa 30 min la reunión de Ana».
    const base = new Date(event.start).getTime();
    if (Number.isFinite(base)) {
      start = new Date(base + Number(args.shiftMinutes) * 60_000).toISOString();
      end = new Date(new Date(start).getTime() + durationMin * 60_000).toISOString();
    }
  }
  if (!isValidIso(start) || !isValidIso(end)) return fail(400, 'INVALID_DATE', 'Necesito la nueva fecha y hora de la cita.');

  if (ctx.dryRun === true) {
    return ok(`Simulación: movería ${event.id} «${event.title}» de ${whenText(event.start, tz)} a ${whenText(start, tz)}.`, {
      actions: [{ type: 'move', status: 'planned', agendaId: event.id, dryRun: true }],
      event: presentEvent(event),
      preview: { id: event.id, start, end }
    });
  }

  let result;
  try {
    result = await commit((data) => patchAgendaEvent({
      data, settings: data.settings, id: event.id, patch: { start, end },
      check: true, force: ctx.force === true, allowUnverified: ctx.allowUnverified === true
    }));
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude mover la cita.');
  }
  if (!result.ok) {
    if (result.code === 'CONFLICT' || result.code === 'FREEBUSY_UNAVAILABLE') {
      const alternatives = (await findSlotsDetailed({
        durationMin, fromIso: start, days: 5, count: 3, data: store.get(), settings, ignoreIds: [event.id]
      })).slots;
      const why = (result.conflicts || []).slice(0, 2).map(describeConflict).join(', ');
      return fail(409, result.code, `⚠️ No pude mover ${event.id}: ${result.error}${why ? ` (${why})` : ''}`, {
        conflicts: result.conflicts,
        errors: result.errors,
        slots: alternatives,
        allowUnverified: result.code === 'FREEBUSY_UNAVAILABLE'
      });
    }
    return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude mover la cita.', result);
  }
  return ok(`↪️ ${result.event.id} movido a ${whenText(result.event.start, tz)} (antes ${whenText(event.start, tz)})`, {
    event: presentEvent(result.event),
    actions: [{ type: 'move', status: 'ok', agendaId: result.event.id }]
  });
}

async function cancelAppointment(args, ctx) {
  const tz = tzOf(ctx);
  const resolved = resolveEventReference({ id: args.id, query: args.query || args.title });
  if (!resolved.ok) return resolved;
  const event = resolved.event;
  if (ctx.dryRun === true) {
    return ok(`Simulación: cancelaría ${event.id} «${event.title}» del ${whenText(event.start, tz)}.`, {
      actions: [{ type: 'cancel', status: 'planned', agendaId: event.id, dryRun: true }],
      event: presentEvent(event)
    });
  }
  let result;
  try {
    result = await commit((data) => cancelAgendaEvent({ data, settings: data.settings, id: event.id }));
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude cancelar la cita.');
  }
  if (!result.ok) return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude cancelar la cita.', result);
  return ok(`🗑️ ${result.event.id} «${result.event.title}» cancelada${result.google && result.google.deleted ? ' y borrada de Google Calendar' : ''}.`, {
    event: presentEvent(result.event),
    actions: [{ type: 'cancel', status: 'ok', agendaId: result.event.id }]
  });
}

async function completeAppointment(args, ctx) {
  const tz = tzOf(ctx);
  const resolved = resolveEventReference({ id: args.id, query: args.query || args.title });
  if (!resolved.ok) return resolved;
  const event = resolved.event;
  if (ctx.dryRun === true) {
    return ok(`Simulación: marcaría ${event.id} «${event.title}» como hecho.`, {
      actions: [{ type: 'complete', status: 'planned', agendaId: event.id, dryRun: true }]
    });
  }
  let result;
  try {
    result = await commit((data) => completeAgendaEvent({
      data, settings: data.settings, id: event.id, actualMin: args.actualMin
    }));
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude completar la cita.');
  }
  if (!result.ok) return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude completar la cita.', result);
  return ok(`✅ ${result.event.id} «${result.event.title}» marcada como Hecho (${result.event.actualMin} min).`, {
    event: presentEvent(result.event),
    actions: [{ type: 'complete', status: 'ok', agendaId: result.event.id }]
  });
}

async function captureInbox(args, ctx) {
  const text = String(args.text || args.title || '').trim();
  if (!text) return fail(400, 'REQUIRED', '¿Qué quieres capturar?');
  if (ctx.dryRun === true) {
    return ok(`Simulación: capturaría «${text.slice(0, 120)}».`, {
      actions: [{ type: 'capture', status: 'planned', dryRun: true, detail: text.slice(0, 120) }]
    });
  }
  let item;
  try {
    item = await commit((data) => {
      const created = {
        id: nextId('IN', data.inbox),
        capturedAt: new Date().toISOString(),
        source: ctx.channel && ctx.channel !== 'web' ? String(ctx.channel) : 'App',
        type: args.type || 'Tarea',
        input: text.slice(0, 2000),
        context: 'Móvil',
        actionable: true,
        due: args.due || null,
        estimatedMin: 30,
        priority: normalizePriority(args.priority, 'P2'),
        processed: false,
        agendaId: null,
        notes: args.notes || 'Capturado por el agente'
      };
      data.inbox.push(created);
      addActivity('inbox', `Captura del agente: ${created.input.slice(0, 80)}`);
      return created;
    });
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude capturar la idea.');
  }
  return ok(`📥 Capturado ${item.id}: ${item.input}`, {
    inbox: item,
    actions: [{ type: 'capture', status: 'ok', detail: item.id }]
  });
}

async function convertInbox(args, ctx) {
  const tz = tzOf(ctx);
  const settings = settingsOf(ctx);
  const resolved = resolveInboxReference({ id: args.id, query: args.query || args.text });
  if (!resolved.ok) return resolved;
  const item = resolved.item;
  if (item.processed) return fail(409, 'ALREADY_PROCESSED', `La captura ${item.id} ya fue procesada${item.agendaId ? ` (${item.agendaId})` : ''}.`);

  const durationMin = Math.max(5, Number(args.durationMin) || Number(item.estimatedMin) || 30);
  let start;
  let end;
  if (args.date && args.time) {
    const instant = instantFrom(args.date, args.time, tz, durationMin);
    if (!instant) return fail(400, 'INVALID_DATE', 'La fecha u hora no son válidas.');
    start = instant.start;
    end = instant.end;
  } else if (args.date) {
    const instant = instantFrom(args.date, '09:00', tz, durationMin);
    start = instant.start;
    end = instant.end;
  } else {
    const slots = await findSlotsDetailed({ durationMin, fromIso: new Date().toISOString(), days: 7, count: 1, data: store.get(), settings });
    if (!slots.slots.length) return fail(409, 'NO_SLOT', 'No hay hueco disponible para convertir la captura; indica fecha y hora.', { slots: [] });
    start = slots.slots[0].start;
    end = slots.slots[0].end;
  }
  const priority = normalizePriority(args.priority || item.priority, 'P2');
  const defaults = PRIORITY_DEFAULTS[priority] || PRIORITY_DEFAULTS.P2;
  const payload = {
    title: (args.title || item.input || 'Compromiso').slice(0, 200),
    start,
    end,
    type: args.type || (String(item.type || '').toLowerCase().startsWith('reun') ? 'Reunión' : 'Compromiso'),
    priority,
    impact: args.impact ?? defaults.impact,
    urgency: args.urgency ?? defaults.urgency,
    context: item.context || '',
    notes: args.notes ?? `Desde inbox ${item.id}`,
    due: args.date || dateKeyOfIso(start, tz)
  };
  if (ctx.dryRun === true) {
    return ok(`Simulación: convertiría ${item.id} en una cita el ${whenText(start, tz)}.`, {
      actions: [{ type: 'convert', status: 'planned', detail: item.id, dryRun: true }],
      preview: { item: item.id, start, end, title: payload.title }
    });
  }
  let result;
  try {
    result = await commit(async (data) => {
      const created = await createAgendaEvent({ data, settings: data.settings, payload, check: true, force: ctx.force === true, allowUnverified: ctx.allowUnverified === true });
      if (created.ok) {
        const target = data.inbox.find((row) => row.id === item.id);
        if (target) {
          target.processed = true;
          target.agendaId = created.event.id;
          target.processedAt = new Date().toISOString();
          target.updatedAt = target.processedAt;
        }
        addActivity('inbox', `Captura ${item.id} convertida en ${created.event.id} por el agente`);
      }
      return created;
    });
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude convertir la captura.');
  }
  if (!result.ok) {
    if (result.code === 'CONFLICT' || result.code === 'FREEBUSY_UNAVAILABLE') {
      const alternatives = (await findSlotsDetailed({ durationMin, fromIso: start, days: 5, count: 3, data: store.get(), settings })).slots;
      return fail(409, result.code, `⚠️ ${result.error}`, { conflicts: result.conflicts, errors: result.errors, slots: alternatives });
    }
    return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude convertir la captura.', result);
  }
  return ok(`✅ Captura ${item.id} convertida en ${result.event.id}: ${result.event.title}\n${whenText(result.event.start, tz)}`, {
    event: presentEvent(result.event),
    inbox: store.get().inbox.find((row) => row.id === item.id) || null,
    actions: [{ type: 'convert', status: 'ok', agendaId: result.event.id, detail: item.id }]
  });
}

async function createRoutineTool(args, ctx) {
  const settings = settingsOf(ctx);
  if (ctx.dryRun === true) {
    return ok(`Simulación: crearía la rutina «${args.title}» (${args.frequency || 'DIARIA'} ${args.time}).`, {
      actions: [{ type: 'create_routine', status: 'planned', dryRun: true }]
    });
  }
  let result;
  try {
    result = await commit((data) => createRoutine(data, args, data.settings || settings));
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 400, error.code || 'VALIDATION', `No pude crear la rutina: ${error.message}`);
  }
  if (!result.ok) {
    const error = result.error || 'No pude crear la rutina.';
    return fail(result.status || 400, result.code || 'VALIDATION', `No pude crear la rutina: ${error}`, { error });
  }
  return ok(`🔁 Rutina creada ${result.routine.id}: «${result.routine.title}» (${result.routine.frequency} ${result.routine.time}, ${result.routine.durationMin} min)${result.routine.nextDate ? `\nPróxima: ${result.routine.nextDate}` : ''}`, {
    routine: result.routine,
    actions: [{ type: 'create_routine', status: 'ok', detail: result.routine.id }]
  });
}

async function editRoutineTool(args, ctx) {
  const resolved = resolveRoutineReference({ id: args.id, query: args.query || args.title }, ctx);
  if (!resolved.ok) return resolved;
  const patch = { ...args };
  delete patch.id;
  delete patch.query;
  if (!Object.keys(patch).length) return fail(400, 'EMPTY_PATCH', '¿Qué quieres cambiar de la rutina?');
  if (ctx.dryRun === true) {
    return ok(`Simulación: editaría la rutina ${resolved.routine.id} (${Object.keys(patch).join(', ')}).`, {
      actions: [{ type: 'edit_routine', status: 'planned', detail: resolved.routine.id, dryRun: true }]
    });
  }
  let result;
  try {
    result = await commit((data) => updateRoutine(data, resolved.routine.id, patch, data.settings));
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 400, error.code || 'VALIDATION', `No pude editar la rutina: ${error.message}`);
  }
  if (!result.ok) return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude editar la rutina.', result);
  return ok(`🔁 Rutina actualizada ${result.routine.id}: «${result.routine.title}» (${result.routine.frequency} ${result.routine.time}, ${result.routine.durationMin} min)`, {
    routine: result.routine,
    actions: [{ type: 'edit_routine', status: 'ok', detail: result.routine.id }]
  });
}

async function toggleRoutineTool(args, ctx) {
  const resolved = resolveRoutineReference({ id: args.id, query: args.query || args.title }, ctx);
  if (!resolved.ok) return resolved;
  const active = args.active === undefined ? !resolved.routine.active : args.active === true;
  if (ctx.dryRun === true) {
    return ok(`Simulación: ${active ? 'activaría' : 'pausaría'} la rutina ${resolved.routine.id}.`, {
      actions: [{ type: 'toggle_routine', status: 'planned', detail: resolved.routine.id, dryRun: true }]
    });
  }
  let result;
  try {
    result = await commit((data) => setRoutineActive(data, resolved.routine.id, active, data.settings));
  } catch (error) {
    return storeReadOnly(error) || fail(500, 'INTERNAL', 'No pude cambiar el estado de la rutina.');
  }
  if (!result.ok) return fail(result.status || 400, result.code || 'VALIDATION', result.error || 'No pude cambiar la rutina.', result);
  return ok(`${result.routine.active ? '▶️ Rutina activada' : '⏸️ Rutina pausada'}: ${result.routine.id} «${result.routine.title}»`, {
    routine: result.routine,
    actions: [{ type: 'toggle_routine', status: 'ok', detail: result.routine.id }]
  });
}

function listDay(args, ctx) {
  const data = store.get();
  const tz = tzOf(ctx);
  const date = args.date || dateKeyOfIso(new Date().toISOString(), tz);
  const rows = (data.agenda || [])
    .filter((event) => event && event.start && dateKeyOfIso(event.start, tz) === date && event.status !== 'Cancelada')
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const done = rows.filter((event) => event.status === 'Hecho').length;
  if (!rows.length) {
    return ok(`📌 ${date}: no hay citas registradas.`, {
      events: [],
      data: { date, total: 0, done: 0 },
      actions: [{ type: 'list_day', status: 'ok', detail: date }]
    });
  }
  const lines = rows.map((event) => {
    const score = Number.isFinite(Number(event.score)) ? ` · score ${event.score}` : '';
    return `${formatTime(event.start, tz)}–${formatTime(event.end, tz)} · ${event.id} · ${event.title} [${event.priority}${event.status === 'Hecho' ? ' · Hecho' : ''}]${score}`;
  });
  return ok(`📌 ${date} (${rows.length} eventos, ${done} hechos)\n${lines.join('\n')}`, {
    events: rows.map(presentEvent),
    data: { date, total: rows.length, done, pending: rows.length - done },
    actions: [{ type: 'list_day', status: 'ok', detail: date }]
  });
}

function weekSummaryTool() {
  const report = weeklyReport(store.get());
  const text = formatWeeklyText(report);
  return ok(text, { report, actions: [{ type: 'week_summary', status: 'ok' }] });
}

function balanceTool(ctx) {
  const data = dashboard();
  const settings = settingsOf(ctx);
  const risks = [];
  if (data.conflicts) risks.push(`${data.conflicts} choque(s)`);
  if (data.overdue) risks.push(`${data.overdue} vencida(s)`);
  const focusTarget = Number(settings?.p95?.deepFocusDailyMin) || 120;
  if (data.focusMin < focusTarget) risks.push(`faltan ${Math.max(0, focusTarget - data.focusMin)} min de foco`);
  const suggestion = data.conflicts
    ? 'resolver primero los choques de agenda'
    : data.focusMin < 120
      ? 'proteger un bloque de foco antes de añadir reuniones'
      : 'mantener el Top 3 y evitar abrir más frentes';
  const text = `📈 BALANCE ${data.date}\nÍndice P95: ${data.p95}/100\nEjecución: ${Math.round(data.execution * 100)}%\nFoco: ${data.focusMin} min\nReuniones: ${Math.round(data.meetingMin)} min\nRiesgos: ${risks.join(' · ') || 'sin alertas críticas'}\nSugerencia: ${suggestion}.`;
  return ok(text, { dashboard: data, actions: [{ type: 'balance', status: 'ok' }] });
}

/* ------------------------------------------------------------------ */
/* Tareas (servicio de lib/travel/tasks.mjs)                          */
/* ------------------------------------------------------------------ */

function sentence(value) {
  const textValue = String(value ?? '').trim();
  if (!textValue) return '';
  return /[.!?]$/.test(textValue) ? textValue : `${textValue}.`;
}

function duePhrase(due, dueTime, tz) {
  if (!due) return '';
  const today = dateKeyOfIso(new Date().toISOString(), tz);
  const tomorrow = addDaysKey(today, 1);
  const time = dueTime ? ` ${String(dueTime).replace(/^0/, '')}` : '';
  if (due === today) return `hoy${time}`;
  if (due === tomorrow) return `mañana${time}`;
  try {
    return `${formatShortDate(isoAtLocal(due, dueTime || '09:00', tz), tz)}${time}`;
  } catch {
    return `${due}${time}`;
  }
}

function eventPhrase(event, tz) {
  try {
    return `${duePhrase(dateKeyOfIso(event.start, tz), null, tz)} ${formatTime(event.start, tz)}`.trim();
  } catch {
    return '';
  }
}

/** Busca una tarea por id (TK-0001) o por título. */
function resolveTaskReference({ id, taskId, query } = {}) {
  const data = store.get();
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const rawId = String(id || taskId || '').trim().toUpperCase();
  if (rawId) {
    const found = tasks.find((task) => String(task.id).toUpperCase() === rawId);
    if (!found) return fail(404, 'NOT_FOUND', `No encontré la tarea ${rawId}; no la invento.`);
    return { ok: true, task: found };
  }
  if (!query) return fail(400, 'REQUIRED', '¿Cuál tarea? Dame el id (TK-0001) o el título.');
  const tokens = tokenize(query);
  if (!tokens.length) return fail(404, 'NOT_FOUND', `No encontré una tarea que coincida con «${query}».`);
  const scored = tasks
    .map((task) => {
      const haystack = foldText(`${task.title || ''} ${task.id || ''} ${task.person || ''} ${task.owner || ''} ${task.notes || ''}`);
      const words = new Set(haystack.split(/[^a-z0-9@._-]+/).filter(Boolean));
      const score = tokens.reduce((acc, token) => acc + (words.has(token) ? 2 : 0), 0);
      return { task, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return fail(404, 'NOT_FOUND', `No encontré una tarea que coincida con «${query}».`);
  if (scored.length === 1 || scored[0].score > scored[1].score) return { ok: true, task: scored[0].task };
  const candidates = scored.slice(0, 3).map(({ task }) => ({ id: task.id, title: task.title, label: `${task.id} «${task.title}»` }));
  return fail(409, 'AMBIGUOUS', `Encontré varias tareas parecidas:\n${candidates.map((candidate, index) => `${index + 1}) ${candidate.label}`).join('\n')}\nResponde 1, 2 o 3.`, { candidates });
}

async function createTaskTool(args, ctx) {
  const title = String(args.title || '').trim();
  if (!title) return fail(400, 'REQUIRED', '¿Cuál es la tarea?');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(args.due || '')) ? args.due : null;
  const dueTime = /^\d{2}:\d{2}$/.test(String(args.dueTime || '')) ? args.dueTime : null;
  const priority = ['P1', 'P2', 'P3', 'P4'].includes(String(args.priority || '').toUpperCase()) ? String(args.priority).toUpperCase() : 'P2';
  const owner = String(args.owner || args.person || 'Yo').trim().slice(0, 120) || 'Yo';
  const person = String(args.person || '').trim().slice(0, 120) || null;
  const noteParts = [];
  if (args.notes) noteParts.push(String(args.notes).trim());
  if (dueTime) noteParts.push(`Hora: ${dueTime}`);
  const notes = noteParts.filter(Boolean).join('\n').slice(0, 1000);
  const tz = tzOf(ctx);

  if (ctx.dryRun === true) {
    return ok(`Simulación: crearía la tarea «${title}»${due ? ` para ${duePhrase(due, dueTime, tz)}` : ''}.`, {
      actions: [{ type: 'create_task', status: 'planned', dryRun: true, detail: title }]
    });
  }
  let task;
  try {
    task = await commit((data) => {
      const created = createTask(data, {
        title,
        due: due || undefined,
        priority,
        owner,
        person: person || undefined,
        notes: notes || undefined,
        origin: 'agente'
      });
      if (dueTime) created.dueTime = dueTime;
      addActivity('task', `Tarea creada desde el agente: ${title}`, { taskId: created.id });
      return created;
    });
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 400, error.code || 'VALIDATION', `No pude crear la tarea: ${error.message}`);
  }
  const when = due ? ` para ${duePhrase(due, dueTime, tz)}` : '';
  return ok(sentence(`Tarea creada${when}: ${title}`), {
    task,
    actions: [{ type: 'create_task', status: 'ok', detail: task.id }]
  });
}

async function closeTaskTool(args, ctx) {
  const resolved = resolveTaskReference({ id: args.id, taskId: args.taskId, query: args.query });
  if (!resolved.ok) return resolved;
  const task = resolved.task;
  if (ctx.dryRun === true) {
    return ok(`Simulación: cerraría la tarea ${task.id} «${task.title}».`, {
      actions: [{ type: 'close_task', status: 'planned', dryRun: true, detail: task.id }]
    });
  }
  let result;
  try {
    result = await commit((data) => {
      const closed = closeTask(data, task.id, { result: args.result, closedBy: ctx.userId });
      if (!closed.alreadyClosed) addActivity('task', `Tarea cerrada desde el agente: ${closed.task.title}`, { taskId: closed.task.id });
      return closed;
    });
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 400, error.code || 'VALIDATION', error.message || `No pude cerrar la tarea ${task.id}`);
  }
  if (result.alreadyClosed) {
    return ok(`La tarea ${result.task.id} «${result.task.title}» ya estaba cerrada; no la vuelvo a tocar.`, {
      task: result.task,
      alreadyClosed: true,
      actions: [{ type: 'close_task', status: 'ok', detail: result.task.id, alreadyClosed: true }]
    });
  }
  return ok(sentence(`Tarea cerrada: ${result.task.id} «${result.task.title}»`), {
    task: result.task,
    actions: [{ type: 'close_task', status: 'ok', detail: result.task.id }]
  });
}

async function reopenTaskTool(args, ctx) {
  const resolved = resolveTaskReference({ id: args.id, taskId: args.taskId, query: args.query });
  if (!resolved.ok) return resolved;
  const task = resolved.task;
  if (task.status === 'open') {
    return ok(`La tarea ${task.id} «${task.title}» ya estaba abierta.`, {
      task,
      alreadyOpen: true,
      actions: [{ type: 'reopen_task', status: 'ok', detail: task.id, alreadyOpen: true }]
    });
  }
  if (ctx.dryRun === true) {
    return ok(`Simulación: reabriría la tarea ${task.id} «${task.title}».`, {
      actions: [{ type: 'reopen_task', status: 'planned', dryRun: true, detail: task.id }]
    });
  }
  let reopened;
  try {
    reopened = await commit((data) => {
      const updated = reopenTask(data, task.id);
      addActivity('task', `Tarea reabierta desde el agente: ${updated.title}`, { taskId: updated.id });
      return updated;
    });
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 400, error.code || 'VALIDATION', `No pude reabrir la tarea ${task.id}: ${error.message}`);
  }
  return ok(sentence(`Tarea reabierta: ${reopened.id} «${reopened.title}»`), {
    task: reopened,
    actions: [{ type: 'reopen_task', status: 'ok', detail: reopened.id }]
  });
}

async function listTasksTool(args, ctx) {
  const data = store.get();
  const requested = String(args.status || 'open').toLowerCase();
  const status = ['open', 'done', 'cancelled', 'all'].includes(requested) ? requested : 'open';
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
  const all = listTasks(data, { status, owner: args.owner || undefined });
  const summary = taskSummary(data);
  if (!all.length) {
    return ok(status === 'open' ? 'No tienes tareas pendientes.' : 'No hay tareas en ese estado.', {
      tasks: [],
      summary,
      total: 0,
      actions: [{ type: 'list_tasks', status: 'ok', detail: '0' }]
    });
  }
  const shown = all.slice(0, limit);
  const tz = tzOf(ctx);
  const lines = shown.map((task) => {
    const when = task.due ? ` (${duePhrase(task.due, task.dueTime, tz)})` : '';
    const owner = task.owner && !/^yo$/i.test(String(task.owner)) ? ` · ${task.owner}` : '';
    const priority = task.priority ? ` [${task.priority}]` : '';
    return `- ${task.id}: ${task.title}${when}${owner}${priority}`;
  });
  const more = all.length > shown.length ? `\n… y ${all.length - shown.length} más.` : '';
  const plural = all.length === 1 ? '' : 's';
  const header = status === 'open'
    ? `Tienes ${all.length} tarea${plural} pendiente${plural}:`
    : status === 'done'
      ? `Tienes ${all.length} tarea${plural} cerrada${plural}:`
      : status === 'cancelled'
        ? `Tienes ${all.length} tarea${plural} cancelada${plural}:`
        : `Tareas (${all.length}):`;
  return ok(`${header}\n${lines.join('\n')}${more}`, {
    tasks: shown,
    summary,
    total: all.length,
    actions: [{ type: 'list_tasks', status: 'ok', detail: String(all.length) }]
  });
}

/* ------------------------------------------------------------------ */
/* Reuniones virtuales con Meet (servicio de lib/travel/meet.mjs)     */
/* ------------------------------------------------------------------ */

async function createMeetTool(args, ctx) {
  const data = store.get();
  const tz = tzOf(ctx);
  let event = null;

  if (args.eventId) {
    event = (data.agenda || []).find((item) => String(item.id).toUpperCase() === String(args.eventId).toUpperCase()) || null;
    if (!event) return fail(404, 'NOT_FOUND', `No encontré la cita ${args.eventId}; no la invento.`);
  } else if (args.query) {
    const resolved = resolveEventReference({ query: args.query });
    if (!resolved.ok) return resolved;
    event = resolved.event;
  }

  if (!event) {
    if (!args.title) return fail(400, 'REQUIRED', '¿Cómo se llama la reunión virtual?');
    if (!args.date || !args.time) return fail(400, 'REQUIRED', 'Necesito fecha y hora para la reunión virtual.');
    if (ctx.dryRun === true) {
      return ok(`Simulación: crearía «${args.title}» para ${duePhrase(args.date, args.time, tz)} y le pondría sala de videollamada (Meet con Google; si no, Jitsi).`, {
        actions: [{ type: 'create_meet', status: 'planned', dryRun: true, detail: args.title }]
      });
    }
    const created = await runTool('crear_cita', {
      title: args.title,
      date: args.date,
      time: args.time,
      durationMin: args.durationMin,
      type: args.type || 'Reunión',
      attendees: args.attendees,
      ...(Array.isArray(args.attendeeNames) && args.attendeeNames.length ? { attendeeNames: args.attendeeNames } : {}),
      notes: args.notes || 'Reunión virtual con Meet',
      context: 'Google Meet'
    }, ctx);
    if (!created.ok) return created;
    event = (store.get().agenda || []).find((item) => item.id === created.event.id) || null;
  }

  if (!event) return fail(500, 'INTERNAL', 'No pude recuperar la cita para ponerle Meet.');
  if (ctx.dryRun === true) {
    return ok(`Simulación: le pondría sala de videollamada a ${event.id} «${event.title}» (Meet con Google; si no, Jitsi).`, {
      actions: [{ type: 'create_meet', status: 'planned', dryRun: true, agendaId: event.id }]
    });
  }

  let result;
  try {
    result = await commit(async (current) => {
      const target = (current.agenda || []).find((item) => item.id === event.id);
      if (!target) {
        const error = new Error(`No encontré la cita ${event.id}`);
        error.status = 404;
        error.code = 'NOT_FOUND';
        throw error;
      }
      const meet = await ensureMeetLink({ data: current, settings: current.settings, event: target });
      target.updatedAt = new Date().toISOString();
      addActivity('calendar', `${meet.generated ? 'Sala Meet generada' : 'Meet creado'} desde el agente: ${target.title}`, { agendaId: target.id });
      return { event: target, meet };
    });
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 502, error.code || 'MEET_ERROR', `No pude crear la sala de Meet: ${error.message}`);
  }

  const link = result.meet.meetLink;
  const when = eventPhrase(result.event, tz);
  let reply;
  if (result.meet.provider === 'jitsi' || result.meet.fallback) {
    reply = `Google Meet no está conectado, así que te dejo una sala Jitsi que sí funciona para «${result.event.title}» (${when}): ${link}. Cuando conectes Google, la cambio por un Meet real.`;
  } else if (result.meet.existing) {
    reply = `La reunión «${result.event.title}» ya tenía sala: ${link}`;
  } else if (result.meet.generated) {
    reply = `La reunión «${result.event.title}» tiene una sala local marcada como no válida; conecta Google para un Meet real.`;
  } else {
    reply = `Meet creado en Google para «${result.event.title}» (${when}): ${link}`;
  }
  return ok(sentence(reply), {
    event: presentEvent(result.event),
    meetLink: link,
    generated: result.meet.generated === true,
    provider: result.meet.provider || null,
    note: result.meet.note || '',
    googleError: result.meet.googleError || null,
    actions: [{ type: 'create_meet', status: 'ok', agendaId: result.event.id, meetLink: link }]
  });
}

/* ------------------------------------------------------------------ */
/* Salidas externas: SIEMPRE propuesta en la Oficina (nunca envío)     */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OUTBOUND_CHANNELS = Object.freeze(['email', 'whatsapp', 'telegram']);

/** Kill-switch operativo: si la Oficina no está disponible, se deniega. */
function officeGateEnabled() {
  const raw = process.env.OFFICE_ENABLED ?? process.env.AGENT_OFFICE_GATE ?? 'on';
  return !['off', 'false', '0', 'no', 'disabled'].includes(String(raw).trim().toLowerCase());
}

function officeGateError(detail = '') {
  const suffix = detail ? ` (${String(detail).slice(0, 300)})` : '';
  const error = new Error(`No puedo enviar sin el gate de la Oficina; revisa Integraciones/Oficina.${suffix}`);
  error.code = 'OFFICE_GATE_UNAVAILABLE';
  error.status = 503;
  return error;
}

/** Carga perezosa de la Oficina (nunca se importa si no hay salida externa). */
async function loadOffice() {
  if (!officeGateEnabled()) throw officeGateError('OFFICE_ENABLED=off');
  let office;
  try {
    office = await import('../office/index.mjs');
  } catch (error) {
    throw officeGateError(`no se pudo cargar la Oficina: ${error.message}`);
  }
  if (!office || typeof office.createProposal !== 'function') {
    throw officeGateError('la Oficina no expone createProposal');
  }
  return office;
}

function proposalStatusMessage({ proposal, channel, recipients, subject, attachmentNames = [] }) {
  const p = proposal;
  const target = recipients.length ? recipients.join(', ') : 'la Oficina';
  const level = p.level || 'N2';
  const risk = Number(p.risk?.score) || 0;
  const isDocument = channel === 'document' || (Array.isArray(attachmentNames) && attachmentNames.length > 0 && channel === 'email');
  const object = channel === 'email'
    ? `${isDocument ? 'el documento' : 'el correo'}${subject ? ` «${subject}»` : ''} a ${target}`
    : `${channel === 'whatsapp' ? 'el WhatsApp' : 'el Telegram'} a ${target}`;
  const status = p.status || 'pending';
  const id = p.id;
  if (status === 'executed') {
    return `La Oficina ejecutó automáticamente ${object} (nivel ${level}, riesgo ${risk}) según su modo: ${id}.`;
  }
  if (status === 'held') {
    return `Preparé ${object} (nivel ${level}, riesgo ${risk}). Quedó retenida en la Oficina: ${id}.`;
  }
  if (status === 'approved') {
    return `Preparé ${object} (nivel ${level}, riesgo ${risk}). La Oficina la aprobó según su política y queda lista para ejecución: ${id}.`;
  }
  return `Preparé ${object} (nivel ${level}, riesgo ${risk}). Queda en la Oficina para tu aprobación: ${id}.`;
}

/**
 * Crea una propuesta en la Oficina. Nunca llama a Gmail/WhatsApp/Telegram:
 * la ejecución (si procede) la decide el jefe desde la Oficina.
 */
async function proposeOutboundTool({
  action, kind, channel, recipients, subject = '', body, attachments = [], meta = {}, attachmentNames = []
}, ctx) {
  const list = (Array.isArray(recipients) ? recipients : [recipients]).map((value) => String(value || '').trim()).filter(Boolean);
  if (!list.length) return fail(400, 'REQUIRED', 'Necesito al menos un destinatario para preparar la propuesta.');
  if (!String(body || '').trim()) return fail(400, 'REQUIRED', 'Necesito el cuerpo del mensaje para preparar la propuesta.');
  if (ctx.dryRun === true) {
    return ok(`Simulación: prepararía una propuesta en la Oficina para ${list.join(', ')} (${channel}); no se envía nada.`, {
      actions: [{ type: 'office_proposal', status: 'planned', dryRun: true, channel, recipients: list }]
    });
  }
  try {
    const office = await loadOffice();
    const input = {
      kind,
      channel,
      recipients: list,
      subject: String(subject || '').slice(0, 300),
      body: String(body).slice(0, 20_000),
      attachments: (Array.isArray(attachments) ? attachments : []).map((value) => String(value).slice(0, 500)).slice(0, 10),
      meta: {
        origin: 'agent',
        agentAction: action,
        conversation: {
          channel: ctx.channel || 'web',
          userId: ctx.userId || 'local',
          scope: ctx.scope || null
        },
        ...meta
      }
    };
    const result = await office.createProposal({ input, actor: 'agent', useLlm: false });
    const proposal = result?.proposal;
    if (!proposal || !proposal.id) {
      throw Object.assign(new Error('la Oficina no devolvió una propuesta válida'), { code: 'OFFICE_GATE_UNAVAILABLE', status: 503 });
    }
    addActivity('office', `Propuesta ${proposal.id} (${proposal.level}) para ${channel}: ${list.join(', ')}`, { proposalId: proposal.id });
    const message = proposalStatusMessage({ proposal, channel, recipients: list, subject, attachmentNames });
    return ok(message, {
      proposalId: proposal.id,
      proposal: {
        id: proposal.id,
        level: proposal.level,
        risk: Number(proposal.risk?.score) || 0,
        status: proposal.status,
        channel: proposal.channel,
        recipients: proposal.recipients,
        subject: proposal.subject,
        attachments: proposal.attachments
      },
      office: {
        mode: proposal.policy?.mode || null,
        reason: proposal.policy?.reason || null,
        requiresApproval: proposal.policy?.requiresApproval === true
      },
      sent: proposal.status === 'executed',
      actions: [{
        type: 'office_proposal',
        status: proposal.status || 'pending',
        proposalId: proposal.id,
        channel: proposal.channel,
        level: proposal.level,
        risk: Number(proposal.risk?.score) || 0,
        recipients: list
      }]
    });
  } catch (error) {
    return storeReadOnly(error) || fail(error.status || 503, error.code || 'OFFICE_GATE_UNAVAILABLE',
      error.message || 'No puedo enviar sin el gate de la Oficina; revisa Integraciones/Oficina.');
  }
}

async function proposeEmailTool(args, ctx) {
  const to = String(args.to || '').trim();
  const subject = String(args.subject || 'Agenda Copilot').slice(0, 200);
  const body = String(args.body || '').trim();
  if (!to || !body) return fail(400, 'REQUIRED', 'Necesito destinatario y cuerpo del correo.');
  if (!EMAIL_RE.test(to)) return fail(400, 'INVALID_FORMAT', 'El correo del destinatario no es válido.');
  return proposeOutboundTool({
    action: 'enviar_correo',
    kind: 'email_send',
    channel: 'email',
    recipients: [to],
    subject,
    body
  }, ctx);
}

async function proposeWhatsAppTool(args, ctx) {
  const text = String(args.text || '').trim();
  const to = String(args.to || '').trim();
  if (!to) return fail(400, 'REQUIRED', '¿A qué número o chat propongo el WhatsApp?');
  if (!text) return fail(400, 'REQUIRED', '¿Qué mensaje quieres proponer por WhatsApp?');
  return proposeOutboundTool({
    action: 'enviar_whatsapp',
    kind: 'whatsapp_send',
    channel: 'whatsapp',
    recipients: [to],
    body: text.slice(0, 4000)
  }, ctx);
}

async function proposeTelegramTool(args, ctx) {
  const text = String(args.text || '').trim();
  const chatId = String(args.chatId || args.to || '').trim();
  if (!chatId) return fail(400, 'REQUIRED', '¿A qué chat propongo el mensaje de Telegram?');
  if (!text) return fail(400, 'REQUIRED', '¿Qué mensaje quieres proponer por Telegram?');
  return proposeOutboundTool({
    action: 'enviar_telegram',
    kind: 'telegram_send',
    channel: 'telegram',
    recipients: [chatId],
    body: text.slice(0, 4096)
  }, ctx);
}

/** Expande nombres a correos con el grafo de identidad (sin red). */
async function expandDocumentRecipients(values, channel) {
  const raw = (Array.isArray(values) ? values : [values]).map((value) => String(value || '').trim()).filter(Boolean);
  const resolved = [];
  const unresolved = [];
  let expander = null;
  for (const value of raw) {
    if (EMAIL_RE.test(value)) {
      resolved.push(value.toLowerCase());
      continue;
    }
    if (channel !== 'email') {
      resolved.push(value);
      continue;
    }
    if (!expander) {
      try {
        expander = await import('../identity/resolve.mjs');
      } catch {
        expander = null;
      }
    }
    if (expander && typeof expander.expandRecipients === 'function') {
      try {
        const expanded = expander.expandRecipients({ query: value }, { data: store.get() });
        const emails = (expanded.recipients || []).filter((email) => EMAIL_RE.test(email));
        if (emails.length) {
          resolved.push(...emails.map((email) => email.toLowerCase()));
          continue;
        }
      } catch {
        /* se trata como no resuelto */
      }
    }
    unresolved.push(value);
  }
  return {
    recipients: [...new Set(resolved)],
    unresolved: [...new Set(unresolved)],
    expanded: raw.some((value) => !EMAIL_RE.test(value)) && resolved.length > 0
  };
}

async function proposeDocumentTool(args, ctx) {
  const docId = String(args.docId || '').trim();
  if (!docId) return fail(400, 'REQUIRED', '¿Qué documento propongo enviar? Dime el id DOC-…');
  if (!/^DOC-\d{8}-[A-Z0-9]+$/i.test(docId) && !/^DOC-[A-Z0-9-]{6,}$/i.test(docId)) {
    return fail(400, 'INVALID_FORMAT', 'El id del documento no tiene el formato DOC-…');
  }
  let document;
  try {
    const docs = await import('../docs/documents.mjs');
    document = docs.readDocument(docId);
  } catch (error) {
    const status = error.status || error.statusCode || 404;
    return fail(status, error.code || 'DOC_NOT_FOUND', error.message || `No encontré el documento ${docId}.`);
  }
  if (!document || !document.filename) return fail(404, 'DOC_NOT_FOUND', `No encontré el documento ${docId}.`);

  const requestedChannel = String(args.channel || '').trim().toLowerCase();
  const channel = requestedChannel && OUTBOUND_CHANNELS.includes(requestedChannel) ? requestedChannel : 'email';
  if (requestedChannel && !OUTBOUND_CHANNELS.includes(requestedChannel)) {
    return fail(400, 'INVALID_VALUE', 'channel debe ser email, whatsapp o telegram.');
  }
  const expansion = await expandDocumentRecipients(args.to, channel);
  if (!expansion.recipients.length) {
    const names = expansion.unresolved.length ? `: ${expansion.unresolved.join(', ')}` : '';
    return fail(400, 'REQUIRED', channel === 'email'
      ? `No pude resolver un correo válido para el documento${names}.`
      : `Necesito un destinatario de ${channel} para el documento${names}.`);
  }
  if (expansion.unresolved.length) {
    return fail(400, 'UNRESOLVED_RECIPIENTS', `No pude resolver estos destinatarios del documento: ${expansion.unresolved.join(', ')}.`);
  }
  if (channel === 'email' && expansion.recipients.some((email) => !EMAIL_RE.test(email))) {
    return fail(400, 'INVALID_FORMAT', 'Para enviar por correo todos los destinatarios deben ser direcciones válidas.');
  }
  const subject = String(args.subject || document.title).slice(0, 200);
  const body = String(args.body || `Te comparto el documento «${document.title}» (${document.filename}).`).slice(0, 20_000);
  return proposeOutboundTool({
    action: 'enviar_documento',
    kind: 'document_send',
    channel,
    recipients: expansion.recipients,
    subject,
    body,
    attachments: [document.filename],
    attachmentNames: [document.filename],
    meta: {
      document: {
        id: document.id,
        filename: document.filename,
        title: document.title,
        mimeType: document.mimeType,
        bytes: document.bytes,
        downloadUrl: document.downloadUrl
      },
      expandedRecipients: expansion.expanded
    }
  }, ctx);
}

/** Despacha una acción validada a su herramienta. */
async function dispatchTool(action, args = {}, ctx = {}) {
  switch (action) {
    case 'crear_cita': return createAppointment(args, ctx);
    case 'buscar_huecos': return findHoles(args, ctx);
    case 'mover_cita': return moveAppointment(args, ctx);
    case 'cancelar_cita': return cancelAppointment(args, ctx);
    case 'completar_cita': return completeAppointment(args, ctx);
    case 'capturar': return captureInbox(args, ctx);
    case 'crear_tarea': return createTaskTool(args, ctx);
    case 'cerrar_tarea': return closeTaskTool(args, ctx);
    case 'reabrir_tarea': return reopenTaskTool(args, ctx);
    case 'listar_tareas': return listTasksTool(args, ctx);
    case 'crear_meet': return createMeetTool(args, ctx);
    case 'convertir_inbox': return convertInbox(args, ctx);
    case 'crear_rutina': return createRoutineTool(args, ctx);
    case 'editar_rutina': return editRoutineTool(args, ctx);
    case 'activar_rutina': return toggleRoutineTool(args, ctx);
    case 'listar_dia': return listDay(args, ctx);
    case 'resumen_semana': return weekSummaryTool(args, ctx);
    case 'balance': return balanceTool(ctx);
    case 'enviar_correo': return proposeEmailTool(args, ctx);
    case 'enviar_whatsapp': return proposeWhatsAppTool(args, ctx);
    case 'enviar_telegram': return proposeTelegramTool(args, ctx);
    case 'enviar_documento': return proposeDocumentTool(args, ctx);
    default:
      return fail(400, 'UNKNOWN_ACTION', `Acción no soportada: ${action}`);
  }
}

/**
 * Punto de entrada público: canonicaliza los campos con Lingo y adjunta
 * `meta.lingoWarning` / `meta.lingoApplied` al resultado. Si Lingo está vacío,
 * el resultado es idéntico al de antes de t47.
 */
export async function runTool(action, args = {}, ctx = {}) {
  const canonical = canonicalizeAgentArgs(args, { data: store.get() });
  const result = await dispatchTool(action, canonical.args, ctx);
  if (!result || typeof result !== 'object') return result;
  const warnings = canonical.warnings.length ? canonical.warnings : canonical.args.lingoWarning;
  const applied = canonical.applied.length ? canonical.applied : canonical.args.lingoApplied;
  if ((Array.isArray(warnings) && warnings.length) || (Array.isArray(applied) && applied.length)) {
    result.meta = {
      ...(result.meta && typeof result.meta === 'object' ? result.meta : {}),
      ...(Array.isArray(warnings) && warnings.length
        ? { lingoWarning: warnings.map((row) => ({ ...row, candidates: Array.isArray(row.candidates) ? row.candidates.map((item) => ({ ...item })) : [] })) }
        : {}),
      ...(Array.isArray(applied) && applied.length
        ? { lingoApplied: applied.map((row) => ({ ...row, terms: Array.isArray(row.terms) ? [...row.terms] : [] })) }
        : {})
    };
  }
  return result;
}

/** Aplica una alternativa elegida (crear o mover) sin volver a interpretar. */
export async function applySlotChoice(pending, index, ctx = {}) {
  const slot = Array.isArray(pending?.slots) ? pending.slots[index] : null;
  if (!slot) return fail(409, 'NO_SLOT', 'Esa opción ya no está disponible.');
  if (pending.toolAction === 'crear_cita' || pending.type === 'create') {
    return runTool('crear_cita', {
      ...(pending.args || {}),
      start: slot.start,
      end: slot.end,
      date: String(slot.start).slice(0, 10)
    }, { ...ctx, force: true, allowUnverified: pending.allowUnverified === true });
  }
  if (pending.toolAction === 'mover_cita' || pending.type === 'move') {
    return runTool('mover_cita', {
      id: pending.agendaId || pending.args?.id,
      start: slot.start,
      end: slot.end
    }, { ...ctx, force: true, allowUnverified: pending.allowUnverified === true });
  }
  if (pending.toolAction === 'crear_meet') {
    const tz = ctx.timezone || timezoneOf(store.get().settings || {});
    return runTool('crear_meet', {
      ...(pending.args || {}),
      date: dateKeyOfIso(slot.start, tz),
      time: formatTime(slot.start, tz),
      durationMin: pending.args?.durationMin || minutesBetween(slot.start, slot.end) || 30
    }, { ...ctx, force: true, allowUnverified: pending.allowUnverified === true });
  }
  return fail(400, 'UNKNOWN_ACTION', 'No sé cómo aplicar esa opción.');
}



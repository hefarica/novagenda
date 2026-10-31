/**
 * Motor de señales declarativas sobre el estado de la agenda.
 *
 * Una señal es un aviso con condición, umbral, ventana horaria, canal, cooldown
 * y acción. Las reglas viven en `data.signalRules` (sembradas una vez y
 * editables); las señales emitidas en `data.signals`; los cooldowns en
 * `data.signalCooldowns`.
 *
 * Reglas de oro:
 * - `dryRun` no escribe, no envía y no llama al LLM: solo describe candidatos.
 * - Una señal no se repite dentro de su `cooldownMin` ni si fue descartada.
 * - Un dato corrupto (fecha inválida) se ignora; nunca tumba el tick.
 */
import { store, nextId } from '../store.mjs';
import { logError } from '../http/logger.mjs';
import {
  dateKeyOfIso, formatTime, isoAtLocal, isValidDateKey, timezoneOf
} from '../agenda/time.mjs';
import { detectTodayConflicts, findSlotsDetailed } from '../agenda/conflicts.mjs';
import { createAgendaEvent } from '../agenda/events.mjs';
import { baseSignalRules } from '../workflows/defaults.mjs';
import {
  cooldownOf, ensureSignalState, ensureWorkflowState, findSignal, isPlainObject,
  needsSeed, nowIso, pruneCooldowns, pruneSignals, setCooldown, signalCooldownKey, signalsOf
} from '../workflows/state.mjs';
import { signalWindowAllows } from '../workflows/time.mjs';
import { deliverNotification } from '../workflows/notify.mjs';
import { emptyUsage, normalizeUsage } from '../workflows/llm.mjs';
import { eventMinutes } from '../workflows/messages.mjs';

const LLM_DEADLINE_MS = 20_000;

/* ------------------------------------------------------------------ */
/* Semilla y lectura                                                   */
/* ------------------------------------------------------------------ */

/** Siembra reglas/estructuras si hace falta (idempotente, una sola escritura). */
export async function ensureSignalsSeeded() {
  const data = store.get();
  if (!needsSeed(data)) return { seeded: false };
  let seeded = false;
  await store.mutate((current) => {
    const a = ensureWorkflowState(current);
    const b = ensureSignalState(current);
    seeded = a.seeded || b.seeded;
  }, { label: 'workflows-seed' });
  return { seeded };
}

/** Reglas activas (o defaults si aún no se ha sembrado, p. ej. en dry-run). */
export function signalRules(data = store.get()) {
  const stored = Array.isArray(data.signalRules) ? data.signalRules : [];
  if (stored.length) return stored;
  return baseSignalRules();
}

export function findRule(data, id) {
  return signalRules(data).find((rule) => rule && rule.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Contexto del día                                                    */
/* ------------------------------------------------------------------ */

function maxTime(values) {
  let max = 0;
  for (const value of values) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return max;
}

/**
 * Hechos verificados del día, tolerantes a datos corruptos.
 * @param {any} data
 * @param {object} settings
 * @param {Date} now
 */
export function buildContext(data, settings = {}, now = new Date()) {
  const tz = timezoneOf(settings);
  const todayKey = dateKeyOfIso(now.toISOString(), tz);
  const nowMs = now.getTime();
  const events = (Array.isArray(data.agenda) ? data.agenda : []).filter((event) => event && typeof event === 'object');

  const dayEvents = [];
  for (const event of events) {
    try {
      const startMs = Date.parse(event.start);
      if (!Number.isFinite(startMs)) continue;
      if (dateKeyOfIso(event.start, tz) !== todayKey) continue;
      if (event.status === 'Cancelada') continue;
      dayEvents.push(event);
    } catch { /* evento corrupto: se ignora */ }
  }
  dayEvents.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const done = dayEvents.filter((event) => event.status === 'Hecho');
  const pending = dayEvents.filter((event) => event.status === 'Pendiente' || event.status === 'En curso');
  const meetings = dayEvents.filter((event) => event.type === 'Reunión');
  const focusMin = dayEvents
    .filter((event) => event.deepFocus)
    .reduce((sum, event) => sum + (Number(event.actualMin) || 0), 0);
  const meetingMin = meetings.reduce((sum, event) => sum + eventMinutes(event), 0);
  const overdue = events.filter((event) => {
    if (event.status === 'Hecho' || event.status === 'Cancelada') return false;
    if (!isValidDateKey(event.due)) return false;
    return event.due < todayKey;
  }).length;

  const activityAt = maxTime((data.activity || []).map((item) => item?.at));
  const completedAt = maxTime(events.map((event) => event.completedAt));
  const updatedAt = maxTime(dayEvents.map((event) => event.updatedAt));
  const dayStart = (() => {
    try { return Date.parse(isoAtLocal(todayKey, settings.workdayStart || '07:00', tz)); } catch { return nowMs; }
  })();

  return {
    tz,
    todayKey,
    nowMs,
    dayEvents,
    done,
    pending,
    meetings,
    focusMin,
    meetingMin,
    overdue,
    lastTouchMs: Math.max(activityAt, completedAt, updatedAt, Number.isFinite(dayStart) ? dayStart : 0),
    dayRange: {
      start: isoAtLocal(todayKey, '00:00', tz),
      end: isoAtLocal(todayKey, '23:59', tz)
    }
  };
}

/* ------------------------------------------------------------------ */
/* Detección por tipo de señal                                         */
/* ------------------------------------------------------------------ */

function shortEvent(event) {
  return {
    id: event.id || null,
    title: String(event.title || '').slice(0, 90),
    start: event.start || null,
    end: event.end || null,
    time: Number.isFinite(Date.parse(event.start)) ? formatTime(event.start, timezoneOf({})) : null
  };
}

/**
 * @returns {Promise<{triggered:boolean, summary:string, payload:object,
 *                    llmInput:object, proposal?:object|null}>}
 */
export async function detectRule(rule, ctx, options = {}) {
  const settings = options.settings || {};
  const data = options.data || store.get();
  const threshold = Math.max(0, Number(rule.threshold) || 0);
  const type = String(rule.type || '');

  if (type === 'conflicts') {
    const result = detectTodayConflicts({ data, settings, dateKey: ctx.todayKey });
    const pairs = (result.conflicts || []).slice(0, Number(rule.params?.maxItems) || 3).map((pair) => ({
      a: shortEvent(pair.a), b: shortEvent(pair.b)
    }));
    const count = pairs.length;
    const lines = pairs.map((pair) => `• ${pair.a.id || ''} ${pair.a.title} ↔ ${pair.b.id || ''} ${pair.b.title}`.trim());
    const summary = count
      ? `⚠️ CHOQUES DE AGENDA — ${ctx.todayKey}\n${count} choque(s) hoy:\n${lines.join('\n')}\nReordena o pide alternativas.`
      : '';
    return {
      triggered: count >= Math.max(1, threshold),
      summary,
      payload: { count, pairs, unknown: false },
      llmInput: { conflicts: pairs.map((pair) => pair.b), reason: `${count} choques hoy` },
      proposal: null
    };
  }

  if (type === 'overdue') {
    const summary = ctx.overdue
      ? `⏳ VENCIDAS — ${ctx.overdue} cita(s) abiertas con fecha pasada.\nDecide hoy: completar, reprogramar o cancelar.`
      : '';
    return {
      triggered: ctx.overdue >= Math.max(1, threshold),
      summary,
      payload: { count: ctx.overdue },
      llmInput: { overdue: ctx.overdue },
      proposal: null
    };
  }

  if (type === 'focus_low') {
    const goal = threshold || 60;
    let proposal = null;
    if (options.computeSlots !== false) {
      try {
        const durationMin = Math.max(30, Number(rule.params?.durationMin) || goal);
        const slots = await findSlotsDetailed({
          durationMin,
          fromIso: new Date(ctx.nowMs).toISOString(),
          days: Math.max(1, Number(rule.params?.days) || 3),
          count: 1,
          data,
          settings,
          includeGoogle: rule.params?.includeGoogle === true
        });
        if (slots.slots && slots.slots[0]) proposal = { start: slots.slots[0].start, end: slots.slots[0].end, durationMin };
      } catch (error) {
        logError('signals:focus-slots', error);
      }
    }
    const when = proposal && Number.isFinite(Date.parse(proposal.start))
      ? ` Propuesta: bloque de ${proposal.durationMin} min a las ${formatTime(proposal.start, ctx.tz)}.`
      : '';
    return {
      triggered: ctx.focusMin < goal,
      summary: ctx.focusMin < goal
        ? `🎯 FOCO INSUFICIENTE — ${ctx.focusMin} min reales (meta ${goal} min).${when}`
        : '',
      payload: { focusMin: ctx.focusMin, goal, proposal },
      llmInput: { focusMin: ctx.focusMin, goal, proposal },
      proposal
    };
  }

  if (type === 'free_gap') {
    const durationMin = Math.max(15, threshold || 60);
    let slot = null;
    if (options.computeSlots !== false) {
      try {
        const result = await findSlotsDetailed({
          durationMin,
          fromIso: new Date(ctx.nowMs).toISOString(),
          days: 1,
          count: 1,
          data,
          settings,
          includeGoogle: rule.params?.includeGoogle === true
        });
        if (result.slots && result.slots[0]) slot = { ...result.slots[0], durationMin };
      } catch (error) {
        logError('signals:free-gap', error);
      }
    }
    return {
      triggered: !!slot,
      summary: slot
        ? `🕳️ HUECO LIBRE — ${durationMin} min disponibles desde las ${formatTime(slot.start, ctx.tz)}.\nPuedes adelantar una tarea del Top 3.`
        : '',
      payload: { slot, durationMin },
      llmInput: { slot, durationMin },
      proposal: slot ? { start: slot.start, end: slot.end, durationMin } : null
    };
  }

  if (type === 'meeting_no_result') {
    const offenders = ctx.meetings.filter((event) => !String(event.result || '').trim());
    return {
      triggered: offenders.length >= Math.max(1, threshold),
      summary: offenders.length
        ? `📝 REUNIONES SIN RESULTADO — ${offenders.length}:\n${offenders.slice(0, 4).map((event) => `• ${event.title || 'Reunión'}`).join('\n')}\nDefine el resultado esperado antes de entrar.`
        : '',
      payload: { count: offenders.length, meetings: offenders.slice(0, 4).map(shortEvent) },
      llmInput: { meetings: offenders.slice(0, 3).map(shortEvent) },
      proposal: null
    };
  }

  if (type === 'meeting_overload') {
    const goal = threshold || 240;
    return {
      triggered: ctx.meetingMin >= Math.max(30, goal),
      summary: ctx.meetingMin >= Math.max(30, goal)
        ? `📅 EXCESO DE REUNIONES — ${Math.round(ctx.meetingMin)} min hoy (umbral ${goal}).\nCancela o acorta al menos una.`
        : '',
      payload: { meetingMin: Math.round(ctx.meetingMin), goal, meetings: ctx.meetings.length },
      llmInput: { meetingMin: Math.round(ctx.meetingMin), goal },
      proposal: null
    };
  }

  if (type === 'inactivity') {
    const goalMin = Math.max(15, threshold || 120);
    const idleMin = Math.round((ctx.nowMs - ctx.lastTouchMs) / 60_000);
    const hasWork = ctx.pending.length > 0 || ctx.overdue > 0;
    return {
      triggered: hasWork && idleMin >= goalMin,
      summary: hasWork && idleMin >= goalMin
        ? `💤 SIN MOVIMIENTO — ${idleMin} min sin cierres ni cambios.\nElige una tarea del Top 3 y dale 25 min.`
        : '',
      payload: { idleMin, goalMin, pending: ctx.pending.length, overdue: ctx.overdue },
      llmInput: { idleMin, goalMin, pending: ctx.pending.length, overdue: ctx.overdue },
      proposal: null
    };
  }

  return { triggered: false, summary: '', payload: {}, llmInput: {}, proposal: null };
}

/* ------------------------------------------------------------------ */
/* Cooldown                                                            */
/* ------------------------------------------------------------------ */

export function cooldownStatus(data, rule, key, nowMs) {
  const record = cooldownOf(data, key);
  if (record?.dismissedAt) return { blocked: true, reason: 'dismissed', retryAt: null };
  const cooldownMs = Math.max(0, Number(rule.cooldownMin) || 0) * 60_000;
  const stamps = [];
  const recordAt = Date.parse(record?.at || '');
  if (Number.isFinite(recordAt)) stamps.push(recordAt);
  for (const signal of signalsOf(data)) {
    if (!signal || signal.cooldownKey !== key) continue;
    const at = Date.parse(signal.at || '');
    if (Number.isFinite(at)) stamps.push(at);
  }
  if (!stamps.length || cooldownMs <= 0) return { blocked: false, reason: null, retryAt: null };
  const last = Math.max(...stamps);
  if (nowMs - last < cooldownMs) {
    return { blocked: true, reason: 'cooldown', retryAt: new Date(last + cooldownMs).toISOString() };
  }
  return { blocked: false, reason: null, retryAt: null };
}

/* ------------------------------------------------------------------ */
/* Enriquecido LLM de señales                                          */
/* ------------------------------------------------------------------ */

async function enrichSignalText(rule, detection, baseText, options = {}) {
  const llm = rule.llm && typeof rule.llm === 'object' ? rule.llm : {};
  if (llm.enabled === false) {
    return { text: baseText, used: false, fallback: true, reason: 'llm-disabled', usage: emptyUsage(), provider: null, model: null };
  }
  const profile = String(llm.profile || 'signals');
  try {
    const { llmComplete } = await import('../llm/client.mjs');
    const facts = JSON.stringify(detection.payload || {}).slice(0, 1800);
    const result = await llmComplete({
      profile,
      messages: [
        {
          role: 'system',
          content: 'Eres el copiloto de agenda P95. Recibes HECHOS verificados y un borrador de alerta. Reescribe la alerta en español, tono directo, máximo 60 palabras. No inventes fechas, horas, personas ni datos que no estén en los hechos. No uses markdown.'
        },
        {
          role: 'user',
          content: `Alerta: ${rule.name || rule.type}\nHechos verificados (JSON): ${facts}\nBorrador: ${String(baseText || '').slice(0, 900)}\nDevuelve solo el mensaje final.`
        }
      ],
      fallback: baseText,
      workflow: `signal:${rule.id}`,
      scope: 'signals',
      deadlineMs: LLM_DEADLINE_MS,
      cache: false,
      ...(options.signal ? { signal: options.signal } : {})
    });
    const usage = normalizeUsage(result?.usage);
    if (result && result.fallback !== true && typeof result.text === 'string' && result.text.trim()) {
      return {
        text: result.text.trim(), used: true, fallback: false, reason: null,
        usage, provider: result.provider || null, model: result.model || null
      };
    }
    return {
      text: baseText, used: false, fallback: true,
      reason: result?.errorCode || 'llm-fallback', usage,
      provider: result?.provider || null, model: result?.model || null,
      error: result?.error || null
    };
  } catch (error) {
    return { text: baseText, used: false, fallback: true, reason: 'llm-unavailable', usage: emptyUsage(), provider: null, model: null, error: error?.message || 'LLM no disponible' };
  }
}

/* ------------------------------------------------------------------ */
/* Emisión y evaluación                                                */
/* ------------------------------------------------------------------ */

function severityOf(rule) {
  return rule.severity || 'medium';
}

async function applyAutoAction(rule, detection, data, signalId) {
  if (rule.action?.autoApply !== true) return null;
  if (!detection.proposal || !Number.isFinite(Date.parse(detection.proposal.start))) return null;
  if (rule.action?.type === 'notify') return null;
  let createdId = null;
  try {
    await store.mutate(async (current) => {
      const result = await createAgendaEvent({
        data: current,
        settings: current.settings,
        payload: {
          title: `Foco: ${rule.name || 'bloque protegido'}`,
          start: detection.proposal.start,
          end: detection.proposal.end,
          type: 'Foco',
          priority: 'P1',
          impact: 5,
          urgency: 4,
          deepFocus: true,
          notes: `Creado por la señal ${rule.id}.`
        },
        check: true,
        allowUnverified: true,
        syncGoogle: false
      });
      if (result.ok) {
        createdId = result.event.id;
        const signal = findSignal(current, signalId);
        if (signal) signal.createdEventId = createdId;
      }
    }, { label: 'senal-auto-foco' });
  } catch (error) {
    logError('signals:auto-action', error, { ruleId: rule.id });
  }
  return createdId;
}

/**
 * Evalúa todas las reglas activas.
 *
 * @param {{now?:Date, dryRun?:boolean, types?:string[]|null, notify?:boolean,
 *          source?:string, settings?:object, computeSlots?:boolean}} [options]
 * @returns {Promise<{items:any[], candidates:any[], emitted:number, dryRun:boolean,
 *                    evaluated:number, errors:any[]}>}
 */
export async function evaluateSignals(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dryRun = options.dryRun === true;
  if (!dryRun) await ensureSignalsSeeded();

  const data = store.get();
  const settings = options.settings || data.settings || {};
  const tz = timezoneOf(settings);
  const todayKey = dateKeyOfIso(now.toISOString(), tz);
  const requested = Array.isArray(options.types) && options.types.length ? new Set(options.types) : null;
  const rules = signalRules(data).filter((rule) => rule && rule.enabled !== false && (!requested || requested.has(rule.type)));
  const ctx = buildContext(data, settings, now);
  const items = [];
  const candidates = [];
  const errors = [];

  for (const rule of rules) {
    try {
      if (!signalWindowAllows(rule.window, now, tz)) continue;
      const key = signalCooldownKey(rule, todayKey);
      const cooldown = cooldownStatus(data, rule, key, now.getTime());
      // En producción, si está en cooldown/descartada no gastamos búsquedas de
      // huecos ni LLM: solo se reporta el estado. En dry-run sí calculamos el
      // detalle para poder explicar qué pasaría.
      if (cooldown.blocked && !dryRun) {
        candidates.push({ ruleId: rule.id, type: rule.type, status: cooldown.reason, retryAt: cooldown.retryAt });
        continue;
      }
      const detection = await detectRule(rule, ctx, {
        data,
        settings,
        computeSlots: options.computeSlots !== false
      });
      if (!detection.triggered) continue;

      if (cooldown.blocked) {
        candidates.push({
          ruleId: rule.id, type: rule.type, status: cooldown.reason,
          retryAt: cooldown.retryAt, text: detection.summary, payload: detection.payload
        });
        continue;
      }

      let text = detection.summary;
      let llmInfo = null;
      if (!dryRun && options.useLlm !== false) {
        llmInfo = await enrichSignalText(rule, detection, text);
        text = llmInfo.text;
      }

      if (dryRun) {
        candidates.push({
          ruleId: rule.id, type: rule.type, status: 'would-emit',
          severity: severityOf(rule), text, payload: detection.payload,
          action: rule.action?.type || 'notify',
          channels: Array.isArray(rule.channels) ? rule.channels : []
        });
        continue;
      }

      let signal = null;
      await store.mutate((current) => {
        const created = {
          id: nextId('SIG', signalsOf(current)),
          at: nowIso(),
          type: rule.type,
          source: options.source || 'scheduler',
          read: false,
          dismissed: false,
          title: rule.name || rule.type,
          severity: severityOf(rule),
          message: text,
          action: rule.action?.type || 'notify',
          payload: {
            ruleId: rule.id,
            ...detection.payload,
            llm: llmInfo ? { used: llmInfo.used, fallback: llmInfo.fallback, provider: llmInfo.provider, model: llmInfo.model, usage: llmInfo.usage } : null
          },
          cooldownKey: key,
          delivery: []
        };
        if (detection.proposal) created.payload.proposal = detection.proposal;
        signalsOf(current).push(created);
        pruneSignals(current);
        setCooldown(current, key, { at: created.at, ruleId: rule.id });
        pruneCooldowns(current, todayKey);
        signal = created;
      }, { label: 'senal-emitida' });

      if (!signal) continue;

      let delivery = [];
      const shouldNotify = options.notify !== false;
      if (shouldNotify && text && rule.action?.type !== 'silent') {
        const delivered = await deliverNotification(text, {
          subject: rule.name || 'Agenda Copilot — señal',
          channels: Array.isArray(rule.channels) ? rule.channels : []
        });
        delivery = delivered.results || [];
        if (delivered.error) errors.push({ ruleId: rule.id, stage: 'notify', error: delivered.error });
        await store.mutate((current) => {
          const stored = findSignal(current, signal.id);
          if (stored) stored.delivery = delivery;
        }, { label: 'senal-entrega' }).catch(() => {});
      }

      const createdEventId = await applyAutoAction(rule, detection, data, signal.id);
      items.push({ ...signal, delivery, createdEventId: createdEventId || null });
    } catch (error) {
      logError(`signals:${rule?.id}`, error);
      errors.push({ ruleId: rule?.id || null, stage: 'evaluate', error: String(error?.message || error) });
    }
  }

  return { items, candidates, emitted: items.length, dryRun, evaluated: rules.length, errors };
}

/* ------------------------------------------------------------------ */
/* Consultas y mutaciones de señales                                   */
/* ------------------------------------------------------------------ */

export function listSignals(data = store.get(), options = {}) {
  const limit = Math.min(500, Math.max(1, Math.round(Number(options.limit) || 50)));
  const type = options.type ? String(options.type) : null;
  const includeDismissed = options.includeDismissed === true;
  const unreadOnly = options.unread === true;
  const all = signalsOf(data)
    .filter((signal) => signal && typeof signal === 'object')
    .filter((signal) => !type || signal.type === type)
    .filter((signal) => includeDismissed || signal.dismissed !== true)
    .filter((signal) => !unreadOnly || signal.read !== true)
    .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  return {
    items: all.slice(0, limit),
    count: Math.min(limit, all.length),
    total: all.length,
    unread: all.filter((signal) => signal.read !== true).length
  };
}

export async function createManualSignal(input = {}) {
  await ensureSignalsSeeded();
  const signal = {
    id: nextId('SIG', signalsOf(store.get())),
    at: nowIso(),
    type: String(input.type || 'manual').slice(0, 60),
    source: String(input.source || 'api').slice(0, 60),
    read: false,
    dismissed: false,
    title: String(input.title || input.type || 'Señal manual').slice(0, 120),
    severity: String(input.severity || 'low'),
    message: String(input.message || '').slice(0, 2000),
    payload: isPlainObject(input.payload) ? input.payload : {},
    cooldownKey: null,
    delivery: []
  };
  await store.mutate((current) => {
    signalsOf(current).push(signal);
    pruneSignals(current);
  }, { label: 'senal-manual' });
  return signal;
}

export async function markSignalRead(id) {
  let item = null;
  await store.mutate((current) => {
    const signal = findSignal(current, id);
    if (!signal) return;
    signal.read = true;
    signal.readAt = nowIso();
    item = signal;
  }, { label: 'senal-leida' });
  return item;
}

export async function dismissSignal(id) {
  let item = null;
  await store.mutate((current) => {
    const signal = findSignal(current, id);
    if (!signal) return;
    const stamp = nowIso();
    signal.read = true;
    signal.dismissed = true;
    signal.dismissedAt = stamp;
    if (signal.cooldownKey) {
      setCooldown(current, signal.cooldownKey, { at: signal.at || stamp, dismissedAt: stamp, ruleId: signal.payload?.ruleId || null });
    }
    item = signal;
  }, { label: 'senal-descartada' });
  return item;
}

export async function updateSignalRule(id, patch = {}) {
  await ensureSignalsSeeded();
  let item = null;
  await store.mutate((current) => {
    const rule = (current.signalRules || []).find((entry) => entry && entry.id === id);
    if (!rule) return;
    for (const [key, value] of Object.entries(patch)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      rule[key] = value;
    }
    rule.updatedAt = nowIso();
    item = rule;
  }, { label: 'senal-regla' });
  return item;
}

export function signalStatus(data = store.get()) {
  const rules = signalRules(data);
  return {
    rules: rules.length,
    activeRules: rules.filter((rule) => rule.enabled !== false).length,
    emitted: signalsOf(data).length,
    unread: signalsOf(data).filter((signal) => signal && signal.read !== true).length,
    lastAt: signalsOf(data).reduce((last, signal) => (Date.parse(signal?.at || '') > Date.parse(last || '') ? signal.at : last), null)
  };
}

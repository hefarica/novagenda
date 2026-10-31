/**
 * Motor de avisos inteligentes (t16).
 *
 * Se engancha al scheduler de t8 mediante `registerTickHandler` (sin timers
 * propios). También se puede invocar por HTTP (`POST /api/nudges/evaluate`) y
 * en el selfcheck.
 *
 * Flujo:
 *   detectar → priorizar → filtrar anti-spam → redactar → entregar → persistir
 *
 * Garantías:
 * - `dryRun` no envía, no escribe y no llama al LLM.
 * - Dos evaluaciones seguidas no repiten el mismo aviso (cooldown + huella).
 * - Silencio nocturno y topes por hora/día se respetan SIEMPRE.
 * - Sin canales configurados no se intenta ningún envío.
 */
import { store, nextId } from '../store.mjs';
import { logError } from '../http/logger.mjs';
import { dateKeyOfIso, timeKeyOf, timezoneOf } from '../agenda/time.mjs';
import {
  DEFAULT_CONFIG, NUDGE_TYPES, ensureNudgeState, hourKeyOf, normalizeConfig, pruneNudgeState,
  readConfig, readNudgeState
} from './config.mjs';
import { collectCandidates } from './detect.mjs';
import { rankItems, selectNudge } from './rank.mjs';
import { buildDailyReportText, buildDraft, sanitizeLlmText, subjectFor } from './messages.mjs';
import { deliverNudge, resolveTargets } from './deliver.mjs';

// El scheduler corta los handlers a 5 s: el LLM debe responder dentro de ese
// presupuesto o el tick se audita como timeout (la entrega continúa aparte).
const LLM_DEADLINE_MS = 3_500;
const HISTORY_LIMIT = 200;

let tickInFlight = false;
let emitInFlight = false;
let reportInFlight = false;
let lastTickEvalMs = 0;

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function minutesOf(hhmm) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function nowMinuteOf(now, tz) {
  return minutesOf(timeKeyOf(now, tz));
}

/**
 * ¿Estamos en la franja de silencio (por defecto 21:30–07:00)?
 * Exportada para tests y para el estado de la API.
 */
export function inSilence(config, now, tz) {
  const silence = config?.silence;
  if (!silence || silence.enabled === false) return false;
  const from = minutesOf(silence.from);
  const to = minutesOf(silence.to);
  const current = nowMinuteOf(now, tz);
  if (from === null || to === null || current === null) return false;
  if (from === to) return false;
  if (from < to) return current >= from && current < to;
  return current >= from || current < to;
}

function countersFor(state, dateKey) {
  if (!state.counters || state.counters.dateKey !== dateKey) {
    state.counters = { dateKey, sent: 0, dismissed: 0, reports: 0 };
  }
  return state.counters;
}

function hourCountOf(state, hourKey) {
  const bucket = state.hourBuckets?.[hourKey];
  if (!bucket) return 0;
  if (typeof bucket === 'number') return bucket;
  return Number(bucket.count) || 0;
}

function bumpHour(state, hourKey, iso) {
  const bucket = state.hourBuckets?.[hourKey];
  const count = (typeof bucket === 'number' ? bucket : Number(bucket?.count) || 0) + 1;
  state.hourBuckets[hourKey] = { count, at: iso };
}

function summarizeItem(item) {
  return {
    type: item.type,
    title: item.title,
    score: item.score ?? null,
    fingerprint: item.fingerprint || null,
    eventId: item.eventId || null,
    due: item.due || null,
    start: item.start || null,
    minutesToStart: item.minutesToStart ?? null,
    daysOverdue: item.daysOverdue ?? null,
    count: item.count ?? null,
    channel: item.channel || null,
    focusMin: item.focusMin ?? null,
    target: item.target ?? null,
    remaining: item.remaining ?? null
  };
}

function summarizeNudge(nudge) {
  return {
    fingerprint: nudge.fingerprint,
    type: nudge.type,
    score: nudge.score,
    text: nudge.text,
    subject: nudge.subject,
    items: nudge.items.map(summarizeItem),
    llm: nudge.llm || null,
    dryRun: nudge.dryRun === true
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const prompt = Number(usage.promptTokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.completionTokens ?? usage.completion_tokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? prompt + completion) || 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

async function enrichWithLlm(draft, items, config) {
  if (config.llmEnabled === false) {
    return { text: draft, used: false, fallback: true, reason: 'llm-disabled', provider: null, model: null, usage: normalizeUsage() };
  }
  try {
    const { llmComplete } = await import('../llm/client.mjs');
    const facts = JSON.stringify(items.map(summarizeItem)).slice(0, 1800);
    const result = await llmComplete({
      profile: 'signals',
      messages: [
        {
          role: 'system',
          content: 'Eres el copiloto personal de agenda. Reescribe el aviso en UNA sola frase natural en español, máximo 45 palabras, sin listas, sin markdown y sin sonar a robot. No inventes datos que no estén en los hechos.'
        },
        {
          role: 'user',
          content: `Hechos verificados (JSON): ${facts}\nBorrador: ${String(draft).slice(0, 700)}\nDevuelve solo la frase final.`
        }
      ],
      fallback: draft,
      workflow: 'nudges',
      scope: 'nudges',
      deadlineMs: LLM_DEADLINE_MS,
      cache: false
    });
    const usage = normalizeUsage(result?.usage);
    if (result && result.fallback !== true && typeof result.text === 'string' && result.text.trim()) {
      return {
        text: sanitizeLlmText(result.text), used: true, fallback: false, reason: null,
        provider: result.provider || null, model: result.model || null, usage
      };
    }
    return {
      text: draft, used: false, fallback: true,
      reason: result?.errorCode || 'llm-fallback', provider: result?.provider || null,
      model: result?.model || null, usage, error: result?.error || null
    };
  } catch (error) {
    return {
      text: draft, used: false, fallback: true, reason: 'llm-unavailable',
      provider: null, model: null, usage: normalizeUsage(), error: String(error?.message || error)
    };
  }
}

/* ------------------------------------------------------------------ */
/* Reporte diario                                                      */
/* ------------------------------------------------------------------ */

async function maybeDailyReport({ now, tz, dateKey, config, ranked, selected, deliver }) {
  if (reportInFlight) return null;
  const current = readNudgeState(store.get());
  if (current.state.reports?.[dateKey]) return current.state.reports[dateKey];
  const nowMinutes = nowMinuteOf(now, tz);
  const reportMinutes = minutesOf(config.reportAt);
  if (nowMinutes === null || reportMinutes === null || nowMinutes < reportMinutes) return null;
  reportInFlight = true;
  try {
    return await buildAndDeliverDailyReport({ now, tz, dateKey, config, ranked, selected, deliver });
  } finally {
    reportInFlight = false;
  }
}

async function buildAndDeliverDailyReport({ now, tz, dateKey, config, ranked, selected, deliver }) {
  const current = readNudgeState(store.get());
  const counters = current.state.counters?.dateKey === dateKey
    ? current.state.counters
    : { sent: 0, dismissed: 0, reports: 0 };
  const selectedKeys = new Set((selected?.items || []).map((item) => item.fingerprint));
  const pending = (ranked || []).filter((item) => !selectedKeys.has(item.fingerprint)).slice(0, 3);
  const text = buildDailyReportText({ sent: counters.sent, dismissed: counters.dismissed, pending, now, tz });
  const subject = 'Agenda Copilot — cierre del día';
  const delivery = await deliverNudge(text, { config, subject, dryRun: false, deliver });
  let record = null;

  await store.mutate((data) => {
    const { state: stateNow } = ensureNudgeState(data);
    if (stateNow.reports?.[dateKey]) return;
    const iso = now.toISOString();
    const id = nextId('NUD', stateNow.history);
    record = {
      id,
      at: iso,
      kind: 'daily_report',
      type: 'daily_report',
      fingerprint: `report:${dateKey}`,
      items: [],
      text,
      subject,
      score: 0,
      delivered: delivery.attempted && delivery.results.some((result) => result.ok),
      delivery: {
        attempted: delivery.attempted,
        reason: delivery.reason,
        targets: delivery.targets,
        results: delivery.results
      },
      dismissed: false,
      dryRun: false,
      llm: null
    };
    stateNow.reports[dateKey] = {
      at: iso,
      text,
      sent: counters.sent,
      dismissed: counters.dismissed,
      pending: pending.map(summarizeItem),
      delivered: record.delivered,
      delivery: record.delivery
    };
    const countersNow = countersFor(stateNow, dateKey);
    countersNow.reports += 1;
    stateNow.history.unshift(record);
    stateNow.history = stateNow.history.slice(0, HISTORY_LIMIT);
  }, { label: 'nudge-reporte-diario' });

  return record;
}

/* ------------------------------------------------------------------ */
/* Evaluación                                                          */
/* ------------------------------------------------------------------ */

/**
 * Evalúa y (si `dryRun:false`) genera/entrega un aviso como máximo.
 *
 * @param {{now?:Date, dryRun?:boolean, force?:boolean,
 *          deliver?:(input:{text:string,subject:string,targets:string[]})=>any}} [options]
 */
export async function evaluateNudges(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'Fecha de evaluación inválida.' };
  const dryRun = options.dryRun !== false; // por defecto seguro: no envía
  const force = options.force === true;
  const data = store.get();
  const settings = data.settings || {};
  const tz = timezoneOf(settings);
  const dateKey = dateKeyOfIso(now.toISOString(), tz);
  const hourKey = hourKeyOf(now, tz);
  const snapshot = readNudgeState(data);
  const config = normalizeConfig(snapshot.config);
  const state = snapshot.state;

  const base = {
    ok: true,
    at: now.toISOString(),
    dryRun,
    skipped: null,
    nudges: [],
    candidates: [],
    counters: null,
    targets: resolveTargets(config).targets,
    dailyReport: null
  };

  if (!config.enabled) return { ...base, skipped: 'disabled' };
  if (inSilence(config, now, tz)) {
    return { ...base, skipped: 'silence', silence: { from: config.silence.from, to: config.silence.to } };
  }

  const dayCount = state.counters?.dateKey === dateKey ? Number(state.counters.sent) || 0 : 0;
  const hourCount = hourCountOf(state, hourKey);
  if (hourCount >= config.maxPerHour) {
    return { ...base, skipped: 'max-per-hour', counters: { hourCount, dayCount, maxPerHour: config.maxPerHour, maxPerDay: config.maxPerDay } };
  }
  if (dayCount >= config.maxPerDay) {
    return { ...base, skipped: 'max-per-day', counters: { hourCount, dayCount, maxPerHour: config.maxPerHour, maxPerDay: config.maxPerDay } };
  }

  if (!force && state.lastSentAt) {
    const last = Date.parse(state.lastSentAt);
    if (Number.isFinite(last) && now.getTime() - last < config.cadenceMin * 60_000) {
      return { ...base, skipped: 'cadence', counters: { hourCount, dayCount } };
    }
  }

  const detected = await collectCandidates({ data, settings, now, config });
  const ranked = rankItems(detected.items, { now, tz });
  base.candidates = ranked.slice(0, 10).map(summarizeItem);

  const selected = selectNudge({ items: ranked, config, state, now, tz });

  if (!selected) {
    const report = dryRun ? null : await maybeDailyReport({ now, tz, dateKey, config, ranked, selected: null, deliver: options.deliver });
    return { ...base, skipped: 'no-candidates', dailyReport: report, counters: { hourCount, dayCount } };
  }

  const draftContext = {
    now,
    tz,
    dateKey,
    time: timeKeyOf(now, tz),
    counters: { sent: dayCount, dismissed: Number(state.counters?.dismissed) || 0 }
  };
  const draft = buildDraft(selected, draftContext);
  let llm = null;
  let text = draft;
  if (!dryRun && config.llmEnabled) {
    llm = await enrichWithLlm(draft, selected.items, config);
    text = llm.text || draft;
  }
  const subject = subjectFor(selected);
  const nudge = {
    fingerprint: selected.fingerprint,
    type: selected.type,
    score: selected.score,
    items: selected.items,
    text,
    subject,
    llm,
    dryRun
  };

  if (dryRun) {
    base.nudges = [summarizeNudge(nudge)];
    base.counters = { hourCount, dayCount };
    return base;
  }

  if (emitInFlight) return { ...base, skipped: 'busy' };
  emitInFlight = true;
  try {
    const delivery = await deliverNudge(text, {
      config,
      subject,
      dryRun: false,
      deliver: options.deliver
    });

    let saved = null;
    await store.mutate((current) => {
      const { state: stateNow } = ensureNudgeState(current);
      pruneNudgeState(stateNow, now);
      const counters = countersFor(stateNow, dateKey);
      // Timestamps del reloj de evaluación (coherentes con `now` y testeables).
      const iso = now.toISOString();
      const id = nextId('NUD', stateNow.history);
      counters.sent += 1;
      bumpHour(stateNow, hourKey, iso);
      stateNow.lastSentAt = iso;
      stateNow.lastEvaluateAt = iso;
      for (const item of selected.items) stateNow.cooldowns[item.type] = iso;
      stateNow.frames[selected.fingerprint] = iso;
      saved = {
        id,
        at: iso,
        kind: 'nudge',
        type: selected.type,
        fingerprint: selected.fingerprint,
        items: selected.items.map(summarizeItem),
        text,
        subject,
        score: selected.score,
        delivered: delivery.attempted && delivery.results.some((result) => result.ok),
        delivery: {
          attempted: delivery.attempted,
          reason: delivery.reason,
          targets: delivery.targets,
          results: delivery.results,
          error: delivery.error || null
        },
        dismissed: false,
        dryRun: false,
        llm: llm
          ? { used: llm.used, fallback: llm.fallback, reason: llm.reason, provider: llm.provider, model: llm.model, usage: llm.usage }
          : null
      };
      stateNow.history.unshift(saved);
      stateNow.history = stateNow.history.slice(0, HISTORY_LIMIT);
    }, { label: 'nudge-emitido' });

    const report = await maybeDailyReport({ now, tz, dateKey, config, ranked, selected, deliver: options.deliver });
    const finalState = readNudgeState(store.get());
    return {
      ...base,
      skipped: null,
      nudges: [saved],
      dailyReport: report,
      targets: delivery.targets,
      counters: {
        hourCount: hourCountOf(finalState.state, hourKey),
        dayCount: finalState.state.counters?.dateKey === dateKey ? finalState.state.counters.sent : 0,
        maxPerHour: config.maxPerHour,
        maxPerDay: config.maxPerDay
      }
    };
  } catch (error) {
    logError('nudges:evaluate', error);
    return { ...base, ok: false, error: String(error?.message || error).slice(0, 300) };
  } finally {
    emitInFlight = false;
  }
}

/**
 * Tick del scheduler (t8). Sin timers propios. Respeta cadencia y silencio.
 * @param {{now?:Date, dryRun?:boolean, deliver?:Function}} [options]
 */
export async function nudgesTick(options = {}) {
  if (tickInFlight) return { ok: true, skipped: 'in-flight' };
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'Fecha de tick inválida.' };
  const data = store.get();
  const config = readConfig(data);
  const tz = timezoneOf(data.settings || {});
  if (!config.enabled) return { ok: true, skipped: 'disabled' };
  if (inSilence(config, now, tz)) return { ok: true, skipped: 'silence' };
  const nowMs = now.getTime();
  if (lastTickEvalMs > 0 && nowMs - lastTickEvalMs < config.cadenceMin * 60_000) {
    return { ok: true, skipped: 'cadence' };
  }
  // Un dry-run no debe bloquear la siguiente evaluación real.
  if (options.dryRun !== true) lastTickEvalMs = nowMs;
  tickInFlight = true;
  try {
    return await evaluateNudges({
      now,
      dryRun: options.dryRun === true,
      force: false,
      deliver: options.deliver
    });
  } catch (error) {
    logError('nudges:tick', error);
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  } finally {
    tickInFlight = false;
  }
}

/* ------------------------------------------------------------------ */
/* Feed, descarte y configuración                                      */
/* ------------------------------------------------------------------ */

/** Feed de avisos para la UI (más recientes primero). */
export function listFeed(options = {}) {
  const state = readNudgeState(store.get()).state;
  const limit = Math.min(100, Math.max(1, Math.round(Number(options.limit) || 20)));
  const includeDismissed = options.includeDismissed === true;
  const all = (state.history || [])
    .filter((item) => item && typeof item === 'object')
    .filter((item) => includeDismissed || item.dismissed !== true);
  return { items: all.slice(0, limit), count: Math.min(limit, all.length), total: all.length };
}

/** Descarta un aviso (no vuelve a aparecer; queda en el feed como descartado). */
export async function dismissNudge(id) {
  let item = null;
  await store.mutate((data) => {
    const { state } = ensureNudgeState(data);
    const iso = new Date().toISOString();
    const index = state.history.findIndex((entry) => entry && entry.id === id);
    if (index < 0) return;
    const entry = state.history[index];
    entry.dismissed = true;
    entry.dismissedAt = iso;
    for (const candidate of entry.items || []) {
      if (candidate?.fingerprint) state.dismissedItems[candidate.fingerprint] = iso;
    }
    if (entry.fingerprint) state.dismissedItems[entry.fingerprint] = iso;
    const tz = timezoneOf(data.settings || {});
    const dateKey = dateKeyOfIso(iso, tz);
    countersFor(state, dateKey).dismissed += 1;
    state.history[index] = entry;
    item = entry;
  }, { label: 'nudge-descartado' });
  return item;
}

/** Config efectiva + resumen de estado para GET /api/nudges/config. */
export function getConfigView() {
  const data = store.get();
  const snapshot = readNudgeState(data);
  const tz = timezoneOf(data.settings || {});
  const dateKey = dateKeyOfIso(new Date().toISOString(), tz);
  const counters = snapshot.state.counters?.dateKey === dateKey
    ? snapshot.state.counters
    : { dateKey, sent: 0, dismissed: 0, reports: 0 };
  return {
    config: snapshot.config,
    state: {
      counters,
      lastSentAt: snapshot.state.lastSentAt,
      lastEvaluateAt: snapshot.state.lastEvaluateAt,
      history: snapshot.state.history.length,
      reports: Object.keys(snapshot.state.reports || {}).length,
      targets: resolveTargets(snapshot.config).targets
    },
    types: NUDGE_TYPES
  };
}

/**
 * Actualiza la configuración (merge validado).
 * @param {object} patch
 */
export async function updateConfig(patch = {}) {
  let config = null;
  await store.mutate((data) => {
    const { config: current } = ensureNudgeState(data);
    const merged = {
      ...current,
      ...patch,
      silence: { ...current.silence, ...(patch && typeof patch.silence === 'object' ? patch.silence : {}) }
    };
    config = normalizeConfig(merged);
    data.nudges.config = config;
  }, { label: 'nudge-config' });
  return config || DEFAULT_CONFIG;
}

/** Reporte diario guardado (o null). */
export function getDailyReport(dateKey = null) {
  const data = store.get();
  const tz = timezoneOf(data.settings || {});
  const key = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  return readNudgeState(data).state.reports?.[key] || null;
}

/** Estado compacto para /api/nudges/status. */
export function nudgesStatus() {
  const view = getConfigView();
  return {
    enabled: view.config.enabled,
    config: view.config,
    state: view.state,
    types: NUDGE_TYPES,
    silence: { active: inSilence(view.config, new Date(), timezoneOf(store.get().settings || {})), ...view.config.silence },
    targets: view.state.targets
  };
}

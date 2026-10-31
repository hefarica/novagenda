/**
 * Priorización de avisos (t16).
 *
 * Puntúa cada candidato por:
 *   impacto (vencido > hoy/semana…) + urgencia (minutos hasta la cita, días
 *   vencidos, mensajes acumulados) + momento del día − esfuerzo estimado.
 *
 * Reglas duras:
 *   - máximo `config.maxItems` (3 por defecto) por aviso,
 *   - el motor global limita a `config.maxPerHour` avisos por hora,
 *   - cooldown por tipo, huella anti-duplicado y descartes del usuario.
 */
import crypto from 'node:crypto';
import { timeKeyOf } from '../agenda/time.mjs';
import { NUDGE_TYPES } from './config.mjs';

const IMPACT = Object.freeze(Object.fromEntries(NUDGE_TYPES.map((entry) => [entry.type, entry.baseImpact])));

const MORNING_TYPES = new Set(['overdue', 'undated', 'focus_unmet', 'approvals']);
const MIDDAY_TYPES = new Set(['free_gap', 'focus_unmet', 'meeting_no_place']);
const EVENING_TYPES = new Set(['daily_close', 'unanswered', 'overdue']);

function hourOf(now, tz) {
  try {
    return Number(String(timeKeyOf(now, tz)).slice(0, 2));
  } catch {
    return new Date(now).getUTCHours();
  }
}

function timeBonus(type, hour) {
  if (hour >= 5 && hour < 11) return MORNING_TYPES.has(type) ? 8 : 0;
  if (hour >= 11 && hour < 15) return MIDDAY_TYPES.has(type) ? 8 : 0;
  if (hour >= 15 && hour < 22) return EVENING_TYPES.has(type) ? 8 : 0;
  return 0;
}

function urgencyOf(item) {
  let urgency = 0;
  const minutesToStart = Number(item.minutesToStart);
  if (Number.isFinite(minutesToStart)) {
    if (minutesToStart <= 15) urgency += 25;
    else if (minutesToStart <= 60) urgency += 15;
    else if (minutesToStart <= 180) urgency += 6;
  }
  const daysOverdue = Number(item.daysOverdue);
  if (Number.isFinite(daysOverdue) && daysOverdue > 0) urgency += Math.min(20, daysOverdue * 4);
  const count = Number(item.count);
  if (Number.isFinite(count) && count > 1) urgency += Math.min(12, (count - 1) * 3);
  return urgency;
}

/**
 * @param {object} item
 * @param {{now:Date, tz:string}} context
 * @returns {{score:number, breakdown:object}}
 */
export function scoreItem(item, context) {
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const tz = context.tz;
  const base = IMPACT[item.type] || 40;
  const urgency = urgencyOf(item);
  const bonus = timeBonus(item.type, hourOf(now, tz));
  const effortMin = Math.max(0, Number(item.effortMin) || 0);
  const effortPenalty = Math.min(15, effortMin / 6);
  const score = Math.round((base + urgency + bonus - effortPenalty) * 10) / 10;
  return { score, breakdown: { base, urgency, bonus, effortPenalty: Math.round(effortPenalty * 10) / 10 } };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

/** Huella estable de un candidato. */
export function itemFingerprint(item) {
  if (item.fingerprint) return String(item.fingerprint);
  const parts = [item.type, item.id || '', item.eventId || '', item.due || '', item.start || '', item.count || ''];
  return digest(parts.join('|'));
}

/** Huella del aviso completo (independiente del orden). */
export function nudgeFingerprint(items) {
  const keys = items.map(itemFingerprint).sort();
  return digest(`nudge:${keys.join(',')}`);
}

/**
 * Ordena candidatos por puntuación descendente.
 * @param {object[]} items
 * @param {{now:Date, tz:string}} context
 */
export function rankItems(items, context) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.type)
    .map((item) => {
      const scored = scoreItem(item, context);
      return { ...item, score: scored.score, scoreBreakdown: scored.breakdown, fingerprint: itemFingerprint(item) };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.due || a.start || '').localeCompare(String(b.due || b.start || ''));
    });
}

/**
 * Aplica anti-spam y elige el aviso (máx. N ítems).
 *
 * @param {{items:object[], config:object, state:object, now:Date, tz:string}} options
 * @returns {null|{items:object[], fingerprint:string, score:number, type:string}}
 */
export function selectNudge({ items, config, state, now, tz }) {
  const nowMs = now.getTime();
  const cooldownMs = Math.max(0, Number(config.cooldownMin) || 0) * 60_000;
  const dedupeMs = Math.max(0, Number(config.dedupeTtlMin) || 0) * 60_000;
  const dismissed = state?.dismissedItems && typeof state.dismissedItems === 'object' ? state.dismissedItems : {};
  const cooldowns = state?.cooldowns && typeof state.cooldowns === 'object' ? state.cooldowns : {};
  const frames = state?.frames && typeof state.frames === 'object' ? state.frames : {};

  const eligible = rankItems(items, { now, tz }).filter((item) => {
    const dismissedAt = Date.parse(dismissed[item.fingerprint] || '');
    if (Number.isFinite(dismissedAt) && nowMs - dismissedAt <= Math.max(dedupeMs, 24 * 3_600_000)) return false;
    const cooledAt = Date.parse(cooldowns[item.type] || '');
    if (Number.isFinite(cooledAt) && nowMs - cooledAt < cooldownMs) return false;
    return true;
  });

  if (!eligible.length) return null;
  const chosen = eligible.slice(0, Math.max(1, Math.min(3, Number(config.maxItems) || 3)));
  const fingerprint = nudgeFingerprint(chosen);
  const seenAt = Date.parse(frames[fingerprint] || '');
  if (Number.isFinite(seenAt) && nowMs - seenAt < dedupeMs) return null;

  return {
    items: chosen,
    fingerprint,
    score: Math.max(...chosen.map((item) => item.score)),
    type: chosen[0].type
  };
}

export { IMPACT };

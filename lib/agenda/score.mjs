/**
 * Score de prioridad — puerto literal de `02_AGENDA!Y4` del modelo Excel:
 *
 *   ROUND((Impacto*4 + Urgencia*3 + Prioridad*2 + FocoProfundo) * 2, 0)
 *
 * Prioridad: P1=5, P2=4, P3=3, cualquier otra=2.
 * Foco profundo: 5 si es foco, 3 si no.
 * Impacto y urgencia: enteros 1..5 (el Excel los valida con lista).
 *
 * Resultado en escala 0-100. El Top 3 y el orden de la agenda usan SIEMPRE
 * este valor calculado; el `score` guardado se refresca al crear/editar.
 */

export const PRIORITY_POINTS = { P1: 5, P2: 4, P3: 3 };
export const PRIORITY_OTHER = 2;
export const SCORE_MIN = 28; // impacto 1, urgencia 1, prioridad distinta, sin foco
export const SCORE_MAX = 100;

export function normalizePriority(value, fallback = 'P2') {
  const raw = String(value ?? '').trim().toUpperCase();
  const match = /^P([1-9])$/.exec(raw);
  if (match) return `P${match[1]}`;
  const named = { ALTA: 'P1', MEDIA: 'P2', BAJA: 'P3', CRITICA: 'P1', CRÍTICA: 'P1' }[raw];
  return named || fallback;
}

export function priorityPoints(value) {
  const priority = normalizePriority(value, '');
  return PRIORITY_POINTS[priority] ?? PRIORITY_OTHER;
}

export function clampRating(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export function deepFocusPoints(value) {
  if (value === true || value === 'Sí' || value === 'SI' || value === 1 || value === '1') return 5;
  return 3;
}

/**
 * Calcula el score 0-100 de un evento o de un payload con impacto/urgencia.
 * @param {{impact?:number, urgency?:number, priority?:string, deepFocus?:boolean, type?:string}} input
 * @returns {number}
 */
export function priorityScore(input = {}) {
  const impact = clampRating(input.impact ?? input.impacto, 3);
  const urgency = clampRating(input.urgency ?? input.urgencia, 3);
  const priority = normalizePriority(input.priority ?? input.prioridad, 'P2');
  const focus = deepFocusPoints(input.deepFocus ?? input.focoProfundo ?? (String(input.type || '').toLowerCase() === 'foco'));
  const raw = impact * 4 + urgency * 3 + priorityPoints(priority) * 2 + focus;
  return Math.min(SCORE_MAX, Math.max(0, Math.round(raw * 2)));
}

/**
 * Devuelve el evento con el score recalculado (sin mutar el original).
 * Si el evento no tiene impacto/urgencia (datos antiguos), conserva su score.
 */
export function withComputedScore(event) {
  if (!event || typeof event !== 'object') return event;
  const hasInputs = Number.isFinite(Number(event.impact)) && Number.isFinite(Number(event.urgency));
  if (!hasInputs) return { ...event, score: Number.isFinite(Number(event.score)) ? Number(event.score) : priorityScore(event) };
  return { ...event, score: priorityScore(event) };
}

/** Recalcula en sitio el score de todos los eventos y devuelve cuántos cambiaron. */
export function recalculateScores(agenda = []) {
  let changed = 0;
  for (const event of agenda) {
    if (!event) continue;
    const next = priorityScore(event);
    if (event.score !== next) {
      event.score = next;
      changed += 1;
    }
  }
  return changed;
}

/** Orden de prioridad descendente, con desempate estable por hora y prioridad. */
export function compareByScore(a, b) {
  const scoreA = Number.isFinite(Number(a?.score)) ? Number(a.score) : priorityScore(a || {});
  const scoreB = Number.isFinite(Number(b?.score)) ? Number(b.score) : priorityScore(b || {});
  if (scoreB !== scoreA) return scoreB - scoreA;
  const startA = new Date(a?.start || 0).getTime();
  const startB = new Date(b?.start || 0).getTime();
  if (startA !== startB) return startA - startB;
  return priorityPoints(b?.priority) - priorityPoints(a?.priority);
}

export function topPriorities(events = [], limit = 3) {
  return [...events].sort(compareByScore).slice(0, Math.max(0, limit));
}

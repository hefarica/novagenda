import {
  dateKeyOfIso, weekStartKey, weekEndKey, isValidDateKey, compareDateKeys, safeDateKeyOfIso
} from './time.mjs';

/**
 * Índice P95 — puerto literal de `08_DASHBOARD!A4` del modelo
 * `docs/Agenda_P95_Modelo_Canonico_2026.xlsx`:
 *
 *   ROUND(
 *     MIN(1, ejecución/meta) * peso * 100
 *   + MIN(1, foco/meta) * peso * 100
 *   + MIN(1, MAX(0, 1 - vencidas/MAX(1, metaVencidas))) * peso * 100
 *   + MIN(1, efectividadReuniones/meta) * peso * 100
 *   + MIN(1, okr/meta) * peso * 100
 *   + MIN(1, ejecuciónSemanal/meta) * peso * 100
 *   + MIN(1, revisiónSemanal/meta) * peso * 100
 *   , 1)
 *
 * Pesos por defecto de `12_CONFIG`: .25, .20, .15, .10, .15, .10, .05.
 * No hay puntos fijos: si un componente vale 0, aporta 0.
 */

export const P95_COMPONENTS = [
  { key: 'agendaExecution', label: 'Ejecución de agenda', targetKey: 'agendaExecution', weightKey: 'agendaExecution', targetDefault: 0.85, weightDefault: 0.25, unit: 'ratio' },
  { key: 'deepFocus', label: 'Foco profundo diario', targetKey: 'deepFocusDailyMin', weightKey: 'deepFocus', targetDefault: 120, weightDefault: 0.20, unit: 'min' },
  { key: 'overdue', label: 'Vencidas abiertas (inverso)', targetKey: 'overdueOpen', weightKey: 'overdue', targetDefault: 2, weightDefault: 0.15, unit: 'count', inverse: true },
  { key: 'meetingEffectiveness', label: 'Efectividad de reuniones', targetKey: 'meetingEffectiveness', weightKey: 'meetingEffectiveness', targetDefault: 4, weightDefault: 0.10, unit: '1-5' },
  { key: 'okrProgress', label: 'Progreso OKR', targetKey: 'okrProgress', weightKey: 'okrProgress', targetDefault: 0.70, weightDefault: 0.15, unit: 'ratio' },
  { key: 'weeklyExecution', label: 'Ejecución semanal', targetKey: 'weeklyExecution', weightKey: 'weeklyExecution', targetDefault: 0.80, weightDefault: 0.10, unit: 'ratio' },
  { key: 'weeklyReview', label: 'Revisión semanal', targetKey: 'weeklyReview', weightKey: 'weeklyReview', targetDefault: 1, weightDefault: 0.05, unit: 'flag' }
];

const WEIGHT_ALIASES = {
  agendaExecution: ['execution', 'executionWeight', 'weightAgendaExecution', 'weightExecution', 'pesoEjecucion'],
  deepFocus: ['deepFocus', 'focus', 'focusWeight', 'weightDeepFocus', 'weightFocus', 'pesoFoco'],
  overdue: ['overdue', 'overdueWeight', 'weightOverdue', 'pesoVencidas'],
  meetingEffectiveness: ['meetings', 'meetingWeight', 'weightMeetingEffectiveness', 'weightMeetings', 'pesoReuniones'],
  okrProgress: ['okr', 'okrWeight', 'weightOkrProgress', 'weightOkr', 'pesoOkr'],
  weeklyExecution: ['weeklyExec', 'weeklyExecutionWeight', 'weightWeeklyExecution', 'pesoSemanal'],
  weeklyReview: ['weeklyReviewWeight', 'weightWeeklyReview', 'pesoRevision']
};

const TARGET_DEFAULTS = {
  agendaExecution: 0.85,
  deepFocusDailyMin: 120,
  overdueOpen: 2,
  meetingEffectiveness: 4,
  okrProgress: 0.70,
  weeklyExecution: 0.80,
  weeklyReview: 1
};

function asFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirst(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

/**
 * Normaliza settings.p95 aceptando tanto el formato histórico
 * ({agendaExecution, deepFocusDailyMin, ...}) como pesos anidados
 * (p95.weights.{...}) o planos (p95.weightExecution).
 */
export function normalizeP95Settings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const nestedWeights = source.weights && typeof source.weights === 'object' ? source.weights : {};
  const targets = {};
  for (const component of P95_COMPONENTS) {
    const fallback = TARGET_DEFAULTS[component.targetKey];
    targets[component.targetKey] = Math.max(
      component.key === 'overdue' ? 1 : 0,
      asFiniteNumber(source[component.targetKey], fallback)
    );
  }
  targets.overdueOpen = asFiniteNumber(source.overdueOpen, 2);
  const weights = {};
  for (const component of P95_COMPONENTS) {
    const aliases = WEIGHT_ALIASES[component.key];
    // En `p95.weights` se aceptan las claves canónicas; en plano solo alias
    // inequívocos (nunca la meta, que vive en la misma raíz).
    const nestedValue = pickFirst(nestedWeights, [component.key, ...aliases]);
    const flatValue = pickFirst(source, aliases);
    const value = nestedValue !== undefined ? nestedValue : flatValue;
    weights[component.key] = Math.max(0, asFiniteNumber(value, component.weightDefault));
  }
  const weightsSum = Object.values(weights).reduce((sum, value) => sum + value, 0);

  return {
    targets,
    weights,
    weightsSum,
    weeklyFocusMin: Math.max(1, asFiniteNumber(source.weeklyFocusMin, 600)),
    weeklyMeetingMin: Math.max(0, asFiniteNumber(source.weeklyMeetingMin, 480)),
    raw: source
  };
}

/** Construye settings.p95 completo para persistir (mantiene claves existentes). */
export function buildP95Settings(existing = {}, patch = {}) {
  const merged = { ...(existing || {}), ...(patch || {}) };
  if (patch && patch.weights && typeof patch.weights === 'object') {
    merged.weights = { ...(existing?.weights || {}), ...patch.weights };
  }
  const normalized = normalizeP95Settings(merged);
  return {
    ...merged,
    ...normalized.targets,
    weights: { ...normalized.weights }
  };
}

/**
 * Referencia numérica del propio Excel (`08_DASHBOARD!A4` = 13.1 con sus
 * valores cacheados). Sirve de fixture para tests de fidelidad.
 */
export const EXCEL_P95_REFERENCE = Object.freeze({
  inputs: Object.freeze({
    agendaExecution: 0,
    deepFocus: 0,
    overdue: 3,
    meetingEffectiveness: 0,
    okrProgress: 0.611764705882353,
    weeklyExecution: 0,
    weeklyReview: 0
  }),
  expected: 13.1,
  note: '08_DASHBOARD!A4 ROUND(...,1) con los valores cacheados del modelo canónico'
});

export function excelReferenceP95(settingsP95 = {}) {
  return computeP95(EXCEL_P95_REFERENCE.inputs, settingsP95);
}

function ratioFor(component, raw, target) {
  if (component.inverse) {
    const meta = Math.max(1, Number(target) || 1);
    const overdue = Math.max(0, Number(raw) || 0);
    return Math.min(1, Math.max(0, 1 - overdue / meta));
  }
  const meta = Number(target);
  if (!Number.isFinite(meta) || meta <= 0) return 0;
  const value = Math.max(0, Number(raw) || 0);
  return Math.min(1, value / meta);
}

/**
 * Calcula el índice con los 7 componentes.
 * @param {object} inputs {agendaExecution, deepFocus, overdue, meetingEffectiveness, okrProgress, weeklyExecution, weeklyReview}
 * @param {object} settingsP95 settings.p95 crudo o normalizado
 * @returns {{index:number, rounded:number, components:Array, weights:object, targets:object, weightsSum:number}}
 */
export function computeP95(inputs = {}, settingsP95 = {}) {
  const normalized = settingsP95?.targets && settingsP95?.weights
    ? settingsP95
    : normalizeP95Settings(settingsP95);
  const components = [];
  let total = 0;

  for (const component of P95_COMPONENTS) {
    const raw = asFiniteNumber(inputs[component.key], 0);
    const target = normalized.targets[component.targetKey];
    const weight = normalized.weights[component.key];
    const ratio = ratioFor(component, raw, target);
    const points = ratio * weight * 100;
    total += points;
    components.push({
      key: component.key,
      label: component.label,
      raw,
      target,
      weight,
      ratio: Math.round(ratio * 10000) / 10000,
      points: Math.round(points * 100) / 100,
      met: ratio >= 1,
      unit: component.unit,
      inverse: !!component.inverse
    });
  }

  const index = Math.round(Math.min(100, Math.max(0, total)) * 10) / 10;
  return {
    index,
    rounded: Math.round(index),
    components,
    weights: { ...normalized.weights },
    targets: { ...normalized.targets },
    weightsSum: normalized.weightsSum,
    formula: 'ROUND(SUM(MIN(1, ratio_i) * peso_i * 100), 1)'
  };
}

function average(values) {
  // Como AVERAGE del Excel: ignora celdas vacías, texto no numérico y null.
  const finite = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['SI', 'SÍ', 'TRUE', '1', 'YES'].includes(value.trim().toUpperCase());
  return false;
}

/**
 * Extrae los 7 insumos desde el estado de la app con la misma semántica que el Excel.
 * @param {object} data estado completo {agenda, okrs, meetings, metrics, settings}
 * @param {{dateKey?:string, timezone?:string}} options
 */
export function p95InputsFromData(data, { dateKey, timezone } = {}) {
  const tz = timezone || data?.settings?.timezone || process.env.TIMEZONE || 'America/Bogota';
  const today = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  const agenda = Array.isArray(data?.agenda) ? data.agenda : [];
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const okrs = Array.isArray(data?.okrs) ? data.okrs : [];
  const meetings = Array.isArray(data?.meetings) ? data.meetings : [];

  const todayRows = agenda.filter((event) => event && event.id && safeDateKeyOfIso(event.start, tz) === today);
  const doneToday = todayRows.filter((event) => event.status === 'Hecho');
  const agendaExecution = todayRows.length ? doneToday.length / todayRows.length : 0;

  const deepFocus = todayRows
    .filter((event) => truthyFlag(event.deepFocus))
    .reduce((sum, event) => sum + (Number.isFinite(Number(event.actualMin)) ? Number(event.actualMin) : 0), 0);

  const overdue = agenda.filter((event) => {
    if (!event || !event.id) return false;
    if (event.status === 'Hecho' || event.status === 'Cancelada') return false;
    return isValidDateKey(event.due) && compareDateKeys(event.due, today) < 0;
  }).length;

  const meetingEffectiveness = average(meetings.map((meeting) => meeting?.effectiveness));
  const okrProgress = average(okrs.map((okr) => okr?.progress));

  const weekStart = weekStartKey(today);
  const weekEnd = weekEndKey(today);
  const weekRows = agenda.filter((event) => {
    if (!event || !event.id) return false;
    const key = safeDateKeyOfIso(event.start, tz);
    return key && key >= weekStart && key <= weekEnd;
  });
  const doneWeek = weekRows.filter((event) => event.status === 'Hecho');
  const weeklyExecution = weekRows.length ? doneWeek.length / weekRows.length : 0;

  const weeklyReview = metrics.some((row) => {
    if (!row || !isValidDateKey(row.date)) return false;
    return row.date >= weekStart && row.date <= weekEnd && truthyFlag(row.weeklyReview);
  }) ? 1 : 0;

  const interruptionsToday = metrics
    .filter((row) => row?.date === today)
    .reduce((sum, row) => sum + (Number.isFinite(Number(row.interruptions)) ? Number(row.interruptions) : 0), 0);

  return {
    dateKey: today,
    weekStart,
    weekEnd,
    agendaExecution,
    deepFocus,
    overdue,
    meetingEffectiveness,
    okrProgress,
    weeklyExecution,
    weeklyReview,
    todayTotal: todayRows.length,
    todayDone: doneToday.length,
    weekTotal: weekRows.length,
    weekDone: doneWeek.length,
    interruptionsToday,
    meetingCount: meetings.length,
    okrCount: okrs.length
  };
}

/**
 * Calcula el índice directamente desde el estado de la app.
 * Devuelve el índice exacto (1 decimal, como el Excel) y los componentes.
 */
export function computeP95FromData(data, options = {}) {
  const inputs = p95InputsFromData(data, options);
  const result = computeP95(inputs, data?.settings?.p95 || {});
  return {
    ...result,
    inputs,
    index: result.index,
    score: result.rounded,
    p95: result.index
  };
}

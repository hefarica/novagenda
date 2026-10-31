import {
  addDaysKey, compareDateKeys, dateKeyOfIso, daysBetweenKeys, formatShortDate, formatTime,
  isoAtLocal, monthKeyOf, monthRange, safeDateKeyOfIso, timezoneOf, weekEndKey, weekStartKey
} from '../agenda/time.mjs';
import { computeP95FromData, p95InputsFromData } from '../agenda/p95.mjs';
import { priorityScore } from '../agenda/score.mjs';
import { inferRoutineRole, routinesFromData } from '../agenda/occurrences.mjs';

/**
 * Métricas diarias — 14 columnas del modelo `06_METRICAS_DIARIAS`:
 *
 *  date, focusPlanMin, focusRealMin, interruptions, meetingMin, agendaPlanMin,
 *  agendaDoneMin, planDaily, closeDaily, weeklyReview, energyAM, energyPM,
 *  improvement, comments
 *
 * Los campos automáticos salen de la agenda y de las rutinas por ROL
 * (`plan`, `close`, `weeklyReview`), nunca por IDs hardcodeados.
 */

export const METRIC_FIELDS = [
  'date', 'focusPlanMin', 'focusRealMin', 'interruptions', 'meetingMin', 'agendaPlanMin',
  'agendaDoneMin', 'planDaily', 'closeDaily', 'weeklyReview', 'energyAM', 'energyPM',
  'improvement', 'comments'
];

export const METRIC_FIELD_COUNT = METRIC_FIELDS.length; // 14

function truthy(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['SI', 'SÍ', 'TRUE', '1', 'YES'].includes(value.trim().toUpperCase());
  return false;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function toMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function routineRoleMap(data, settings) {
  const byId = new Map();
  for (const routine of routinesFromData(data, settings)) {
    byId.set(routine.id, routine.role || inferRoutineRole(routine, settings));
  }
  return byId;
}

export function metricRoleOfEvent(event, roles, settings = {}) {
  if (!event) return null;
  if (event.metricRole) return event.metricRole;
  for (const id of [event.routineId, event.recurrentId, event.meetingId].filter(Boolean)) {
    if (roles.has(id)) return roles.get(id);
  }
  return inferRoutineRole({
    title: event.title,
    name: event.title,
    role: event.role
  }, settings);
}

function eventMetrics(event, settings, tz) {
  const role = metricRoleOfEvent(event, routineRoleMapCache, settings);
  return {
    role,
    plannedMin: toMinutes(event.plannedMin ?? (new Date(event.end) - new Date(event.start)) / 60000),
    actualMin: toMinutes(event.actualMin ?? 0),
    deepFocus: truthy(event.deepFocus),
    meeting: String(event.type || '').toLowerCase().includes('reunión') || String(event.type || '').toLowerCase() === 'reunion',
    done: event.status === 'Hecho',
    date: dateKeyOfIso(event.start, tz)
  };
}

let routineRoleMapCache = new Map();

/**
 * Calcula el snapshot diario combinando datos automáticos con captura manual.
 * @param {object} data estado del store
 * @param {{dateKey?:string, patch?:object}} options
 */
export function buildDailyMetric(data, { dateKey, patch = {} } = {}) {
  const settings = data.settings || {};
  const tz = timezoneOf(settings);
  const today = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  routineRoleMapCache = routineRoleMap(data, settings);
  const rows = (data.agenda || []).filter((event) => event && event.id && safeDateKeyOfIso(event.start, tz) === today);
  const nonCancelled = rows.filter((event) => event.status !== 'Cancelada');

  let focusPlanMin = 0, focusRealMin = 0, meetingMin = 0, agendaPlanMin = 0, agendaDoneMin = 0;
  let planDaily = false, closeDaily = false;
  for (const event of rows) {
    const info = eventMetrics(event, settings, tz);
    if (info.deepFocus) {
      focusPlanMin += info.plannedMin;
      focusRealMin += info.actualMin;
    }
    if (info.meeting) meetingMin += info.plannedMin;
    agendaPlanMin += info.plannedMin;
    if (info.done) {
      agendaDoneMin += info.actualMin || info.plannedMin;
      if (info.role === 'plan') planDaily = true;
      if (info.role === 'close') closeDaily = true;
    }
  }

  const weekStart = weekStartKey(today);
  const weekEnd = weekEndKey(today);
  let weeklyReviewDone = false;
  for (const event of data.agenda || []) {
    if (!event || event.status !== 'Hecho') continue;
    const key = safeDateKeyOfIso(event.start, tz);
    if (!key || key < weekStart || key > weekEnd) continue;
    const role = metricRoleOfEvent(event, routineRoleMapCache, settings);
    if (role === 'weeklyReview') { weeklyReviewDone = true; break; }
  }

  const previous = (data.metrics || []).find((row) => row.date === today) || {};
  const pick = (field) => (patch[field] !== undefined ? patch[field] : previous[field]);
  const normalizedPatch = normalizeManualFields(patch);
  const energyAM = normalizedPatch.energyAM !== undefined ? normalizedPatch.energyAM : normalizeEnergy(previous.energyAM);
  const energyPM = normalizedPatch.energyPM !== undefined ? normalizedPatch.energyPM : normalizeEnergy(previous.energyPM);
  const interruptions = normalizedPatch.interruptions !== undefined ? normalizedPatch.interruptions : Math.max(0, toInt(previous.interruptions, 0));
  const improvement = normalizedPatch.improvement !== undefined ? normalizedPatch.improvement : String(previous.improvement || '');
  const comments = normalizedPatch.comments !== undefined ? normalizedPatch.comments : String(previous.comments || '');
  const weeklyReview = normalizedPatch.weeklyReview !== undefined
    ? truthy(normalizedPatch.weeklyReview)
    : (weeklyReviewDone || truthy(previous.weeklyReview));
  const planFlag = normalizedPatch.planDaily !== undefined ? truthy(normalizedPatch.planDaily) : planDaily;
  const closeFlag = normalizedPatch.closeDaily !== undefined ? truthy(normalizedPatch.closeDaily) : closeDaily;
  void pick;

  return {
    date: today,
    focusPlanMin,
    focusRealMin,
    interruptions,
    meetingMin,
    agendaPlanMin,
    agendaDoneMin,
    planDaily: planFlag,
    closeDaily: closeFlag,
    weeklyReview,
    energyAM,
    energyPM,
    improvement,
    comments,
    updatedAt: new Date().toISOString(),
    auto: {
      rows: nonCancelled.length,
      done: nonCancelled.filter((event) => event.status === 'Hecho').length
    }
  };
}

function normalizeEnergy(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return Math.round(n);
}

export function normalizeManualFields(patch = {}) {
  const out = {};
  if (patch.energyAM !== undefined) {
    const value = normalizeEnergy(patch.energyAM);
    if (patch.energyAM !== null && patch.energyAM !== '' && value === null) {
      throw Object.assign(new Error('energyAM debe estar entre 1 y 5'), { status: 400, code: 'VALIDATION', field: 'energyAM' });
    }
    out.energyAM = value;
  }
  if (patch.energyPM !== undefined) {
    const value = normalizeEnergy(patch.energyPM);
    if (patch.energyPM !== null && patch.energyPM !== '' && value === null) {
      throw Object.assign(new Error('energyPM debe estar entre 1 y 5'), { status: 400, code: 'VALIDATION', field: 'energyPM' });
    }
    out.energyPM = value;
  }
  if (patch.interruptions !== undefined) {
    const n = Number(patch.interruptions);
    if (!Number.isFinite(n) || n < 0 || n > 500) {
      throw Object.assign(new Error('interruptions debe ser un entero entre 0 y 500'), { status: 400, code: 'VALIDATION', field: 'interruptions' });
    }
    out.interruptions = Math.round(n);
  }
  if (patch.improvement !== undefined) {
    out.improvement = String(patch.improvement ?? '').slice(0, 200);
  }
  if (patch.comments !== undefined) {
    out.comments = String(patch.comments ?? '').slice(0, 1000);
  }
  if (patch.planDaily !== undefined) out.planDaily = truthy(patch.planDaily);
  if (patch.closeDaily !== undefined) out.closeDaily = truthy(patch.closeDaily);
  if (patch.weeklyReview !== undefined) out.weeklyReview = truthy(patch.weeklyReview);
  return out;
}

/**
 * Inserta/actualiza el snapshot del día (idempotente por `date`).
 * @returns {object} fila de métricas con los 14 campos
 */
export function snapshotDailyMetrics(data, { dateKey, patch = {} } = {}) {
  const built = buildDailyMetric(data, { dateKey, patch });
  // Se persisten exactamente los 14 campos del modelo (sin metadatos extra).
  const metric = normalizeMetricRow(built);
  if (!data.metrics) data.metrics = [];
  const index = data.metrics.findIndex((row) => row.date === metric.date);
  if (index >= 0) data.metrics[index] = { ...normalizeMetricRow(data.metrics[index]), ...metric };
  else data.metrics.push(metric);
  data.metrics.sort((a, b) => compareDateKeys(a.date, b.date));
  // Retención: 3 años de histórico es más que suficiente para la app local.
  const maxRows = 1100;
  if (data.metrics.length > maxRows) data.metrics = data.metrics.slice(-maxRows);
  return data.metrics.find((row) => row.date === metric.date);
}

/** Captura manual de energía/interrupciones/mejora/comentarios del día. */
export function captureDailyMetrics(data, patch, { dateKey } = {}) {
  return snapshotDailyMetrics(data, { dateKey, patch });
}

export function normalizeMetricRow(row) {
  const source = row || {};
  const result = {
    date: source.date,
    focusPlanMin: toMinutes(source.focusPlanMin),
    focusRealMin: toMinutes(source.focusRealMin),
    interruptions: Math.max(0, toInt(source.interruptions, 0)),
    meetingMin: toMinutes(source.meetingMin),
    agendaPlanMin: toMinutes(source.agendaPlanMin),
    agendaDoneMin: toMinutes(source.agendaDoneMin),
    planDaily: truthy(source.planDaily),
    closeDaily: truthy(source.closeDaily),
    weeklyReview: truthy(source.weeklyReview),
    energyAM: normalizeEnergy(source.energyAM),
    energyPM: normalizeEnergy(source.energyPM),
    improvement: String(source.improvement || ''),
    comments: String(source.comments || '')
  };
  return result;
}

/**
 * Histórico de métricas.
 * @param {object} data
 * @param {{days?:number, from?:string, to?:string}} options
 */
export function getMetrics(data, { days = 90, from, to, dateKey } = {}) {
  const tz = timezoneOf(data.settings || {});
  const today = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  const safeDays = Math.max(1, Math.min(1100, Math.round(Number(days) || 90)));
  const toKey = to || today;
  const fromKey = from || addDaysKey(toKey, -(safeDays - 1));
  const rows = (data.metrics || [])
    .filter((row) => row && row.date >= fromKey && row.date <= toKey)
    .sort((a, b) => compareDateKeys(a.date, b.date))
    .map(normalizeMetricRow);
  const withData = rows.filter((row) => row.agendaPlanMin > 0 || row.focusRealMin > 0 || row.interruptions > 0 || row.energyAM != null || row.comments);
  const totals = {
    rows: rows.length,
    daysWithData: withData.length,
    focusPlanMin: rows.reduce((sum, row) => sum + row.focusPlanMin, 0),
    focusRealMin: rows.reduce((sum, row) => sum + row.focusRealMin, 0),
    interruptions: rows.reduce((sum, row) => sum + row.interruptions, 0),
    meetingMin: rows.reduce((sum, row) => sum + row.meetingMin, 0),
    agendaPlanMin: rows.reduce((sum, row) => sum + row.agendaPlanMin, 0),
    agendaDoneMin: rows.reduce((sum, row) => sum + row.agendaDoneMin, 0),
    planDays: rows.filter((row) => row.planDaily).length,
    closeDays: rows.filter((row) => row.closeDaily).length,
    weeklyReviewDays: rows.filter((row) => row.weeklyReview).length,
    energyAM: average(rows.map((row) => row.energyAM)),
    energyPM: average(rows.map((row) => row.energyPM)),
    improvements: rows.filter((row) => row.improvement).length,
    comments: rows.filter((row) => row.comments).length
  };
  totals.execution = totals.agendaPlanMin ? Math.round((totals.agendaDoneMin / totals.agendaPlanMin) * 1000) / 1000 : 0;
  return { from: fromKey, to: toKey, days: safeDays, rows, totals, fields: METRIC_FIELDS };
}

function average(values) {
  const finite = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  if (!finite.length) return null;
  return Math.round((finite.reduce((sum, value) => sum + value, 0) / finite.length) * 100) / 100;
}

/** Reporte semanal coherente con el índice (misma fuente de datos). */
export function weeklyReport(data, { dateKey } = {}) {
  const tz = timezoneOf(data.settings || {});
  const today = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  const from = weekStartKey(today);
  const to = weekEndKey(today);
  const rows = (data.agenda || []).filter((event) => {
    const key = safeDateKeyOfIso(event.start, tz);
    return key && key >= from && key <= to;
  });
  const done = rows.filter((event) => event.status === 'Hecho');
  const focusRealMin = done.filter((event) => truthy(event.deepFocus)).reduce((sum, event) => sum + toMinutes(event.actualMin || event.plannedMin), 0);
  const meetingMin = rows.filter((event) => /reuni/i.test(String(event.type || ''))).reduce((sum, event) => sum + toMinutes(event.plannedMin), 0);
  const p95 = computeP95FromData(data, { dateKey: today, timezone: tz });
  const metrics = getMetrics(data, { from, to, days: 7 });
  return {
    period: 'week',
    from,
    to,
    total: rows.length,
    done: done.length,
    execution: rows.length ? Math.round((done.length / rows.length) * 1000) / 1000 : 0,
    focusRealMin,
    meetingMin,
    overdue: p95.inputs.overdue,
    okrProgress: p95.inputs.okrProgress,
    weeklyReview: p95.inputs.weeklyReview === 1,
    p95: p95.index,
    components: p95.components,
    metrics: metrics.rows,
    totals: metrics.totals
  };
}

/** Reporte mensual coherente con el índice. */
export function monthlyReport(data, { dateKey } = {}) {
  const tz = timezoneOf(data.settings || {});
  const today = dateKey || dateKeyOfIso(new Date().toISOString(), tz);
  const month = monthKeyOf(today);
  const { from, to } = monthRange(month);
  const rows = (data.agenda || []).filter((event) => {
    const key = safeDateKeyOfIso(event.start, tz);
    return key && key.slice(0, 7) === month;
  });
  const done = rows.filter((event) => event.status === 'Hecho');
  const meetings = rows.filter((event) => /reuni/i.test(String(event.type || '')));
  const ratings = (data.meetings || []).map((meeting) => Number(meeting.effectiveness)).filter((value) => Number.isFinite(value) && value >= 1 && value <= 5);
  const metrics = getMetrics(data, { from, to, days: daysBetweenKeys(from, to) + 1 });
  const p95 = computeP95FromData(data, { dateKey: today, timezone: tz });
  return {
    period: 'month',
    month,
    from,
    to,
    total: rows.length,
    done: done.length,
    execution: rows.length ? Math.round((done.length / rows.length) * 1000) / 1000 : 0,
    focusRealMin: done.filter((event) => truthy(event.deepFocus)).reduce((sum, event) => sum + toMinutes(event.actualMin || event.plannedMin), 0),
    meetings: meetings.length,
    meetingEffectiveness: ratings.length ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 100) / 100 : 0,
    okrProgress: p95.inputs.okrProgress,
    p95: p95.index,
    components: p95.components,
    metrics: metrics.rows,
    totals: metrics.totals
  };
}

/** Texto del reporte diario de cierre. */
export function formatWeeklyText(report) {
  const lines = [
    `📊 SEMANA P95 — ${report.from} → ${report.to}`,
    `Índice P95: ${report.p95}/100`,
    `Ejecución: ${Math.round(report.execution * 100)}%`,
    `Foco real: ${report.focusRealMin} min`,
    `Vencidas abiertas: ${report.overdue}`,
    `Reuniones: ${report.meetingMin} min`,
    `OKR: ${Math.round(report.okrProgress * 100)}%`,
    `Revisión semanal: ${report.weeklyReview ? 'HECHA' : 'PENDIENTE'}`
  ];
  return lines.join('\n');
}

export function formatMonthlyText(report) {
  return [
    `🗓️ MES P95 — ${report.month}`,
    `Ejecución: ${Math.round(report.execution * 100)}%`,
    `Foco real: ${report.focusRealMin} min`,
    `Reuniones: ${report.meetings}`,
    `Efectividad reuniones: ${report.meetingEffectiveness ? report.meetingEffectiveness.toFixed(1) : '—'}/5`,
    `OKR: ${Math.round(report.okrProgress * 100)}%`,
    `Índice P95 actual: ${report.p95}/100`
  ].join('\n');
}

export { dateKeyOfIso, p95InputsFromData, priorityScore, formatShortDate, formatTime, isoAtLocal };

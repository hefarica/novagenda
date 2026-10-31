/**
 * Punto de entrada del motor de agenda.
 *
 * Uso desde rutas, asistente o tests:
 *   import { computeP95FromData, priorityScore, checkConflicts, ... } from './lib/agenda/index.mjs';
 *
 * Módulos internos:
 * - time.mjs         fechas/horas por zona, festivos, jornada.
 * - p95.mjs          índice P95 de 7 componentes (08_DASHBOARD + 12_CONFIG).
 * - score.mjs        score de prioridad 0-100 (02_AGENDA!Y).
 * - occurrences.mjs  cálculo puro de recurrencias (clamp, festivos, excepciones).
 * - routines.mjs     CRUD unificado, preview, skip y materialización idempotente.
 * - conflicts.mjs    choques (locales + plantillas + Google + día completo) y huecos.
 * - events.mjs       crear/editar/cancelar/completar con validación y sync Google.
 * - google.mjs (../) OAuth, FreeBusy, syncToken, revoke, backoff.
 * - metrics/metrics.mjs  14 campos de 06_METRICAS_DIARIAS y reportes.
 */

export {
  defaultTimezone, timezoneOf, dateKeyOf, timeKeyOf,
  isValidDateKey, isValidIso, isoAtLocal, isoLocalOf, dateKeyOfIso, minutesBetween, overlaps,
  weekdayCodeOfKey, weekStartKey, weekEndKey, weekDateKeys, monthRange, addDaysKey,
  daysBetweenKeys, isWorkingDay, isWeekend, isHoliday, holidaysOfYear, colombiaHolidays,
  normalizeWeekdays, workdayCodes, parseHHMM, minutesToHHMM, formatDateLong, formatTime,
  formatShortDate, localDayRange
} from './time.mjs';

export {
  P95_COMPONENTS, normalizeP95Settings, computeP95, computeP95FromData, p95InputsFromData,
  EXCEL_P95_REFERENCE, excelReferenceP95
} from './p95.mjs';

export {
  PRIORITY_POINTS, priorityPoints, priorityScore, withComputedScore, compareByScore,
  topPriorities, recalculateScores, normalizePriority
} from './score.mjs';

export {
  normalizeRoutine, routinesFromData, findRoutine, normalizeFrequency, routineDueOn,
  routineOccurrencesBetween, nextRoutineOccurrences, routineToEventPayload,
  normalizeExceptionDates, ruleWeekdays, ruleMonthDay, inferRoutineRole
} from './occurrences.mjs';

export {
  createRoutine, updateRoutine, deleteRoutine, setRoutineActive, skipRoutineDate,
  previewRoutine, previewRoutineById, listRoutines, materializeRoutineRange,
  runDailyMaterialization, materializeToday
} from './routines.mjs';

export {
  collectBusy, collectBusyDetailed, checkConflicts, findSlots, findSlotsDetailed,
  describeConflict, detectTodayConflicts, validateRange
} from './conflicts.mjs';

export {
  AgendaError, createAgendaEvent, patchAgendaEvent, cancelAgendaEvent,
  completeAgendaEvent, deleteAgendaEventHard, presentEvent, recalculateAllScores,
  validateEventPayload
} from './events.mjs';

// Métricas y reportes (06_METRICAS_DIARIAS). Se re-exportan aquí para que
// tests/UI tengan un único punto de entrada documentado.
export {
  METRIC_FIELDS, METRIC_FIELD_COUNT, snapshotDailyMetrics, captureDailyMetrics,
  getMetrics, weeklyReport, monthlyReport, formatWeeklyText, formatMonthlyText,
  normalizeMetricRow
} from '../metrics/metrics.mjs';

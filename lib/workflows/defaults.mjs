/**
 * Workflows base del motor de automatizaciones (t8).
 *
 * Los workflows viven EN DATOS (`data.workflows`) y se siembran una sola vez
 * (`data.workflowsMeta.seededVersion`). El usuario puede crearlos, editarlos,
 * desactivarlos o borrarlos por API sin tocar código.
 *
 * Cada workflow declara:
 *   trigger     cuándo se ejecuta (daily | weekly | interval | always | manual)
 *   conditions  filtros declarativos (fin de semana, festivos, silencio)
 *   actions     qué hace (notificar, conciliar Google, recordatorios, métricas…)
 *   llm         si esa ejecución se enriquece con el router de t3 y con qué perfil
 *   channels    canales concretos (vacío = todos los configurados)
 *   compatKey   clave histórica de `notificationLog` para no reenviar al actualizar
 */

export const WORKFLOW_SEED_VERSION = 2;

export const TRIGGER_TYPES = Object.freeze(['daily', 'weekly', 'interval', 'always', 'manual']);
export const ACTION_TYPES = Object.freeze([
  'notify', 'google_reconcile', 'reminders', 'capture_metrics', 'materialize_routines'
]);
export const TEMPLATES = Object.freeze(['brief', 'midday', 'close', 'weekly', 'nightly', 'hourly_changes', 'custom']);
export const NOTIFY_CHANNELS = Object.freeze(['whatsapp', 'telegram', 'email']);
export const LLM_PROFILES = Object.freeze([
  'brief', 'midday', 'close', 'weekly', 'signals', 'schedule_summary', 'conflict', 'channel', 'chat'
]);
export const WEEKDAY_CODES = Object.freeze(['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM']);

/**
 * Alias de días en inglés (UI/API) → códigos internos en español.
 * El motor compara SIEMPRE contra `weekdayCodeOfKey()`, que devuelve LUN..DOM.
 */
export const WEEKDAY_ALIASES = Object.freeze({
  MON: 'LUN', TUE: 'MAR', WED: 'MIE', THU: 'JUE', FRI: 'VIE', SAT: 'SAB', SUN: 'DOM',
  MONDAY: 'LUN', TUESDAY: 'MAR', WEDNESDAY: 'MIE', THURSDAY: 'JUE',
  FRIDAY: 'VIE', SATURDAY: 'SAB', SUNDAY: 'DOM'
});

/**
 * Normaliza una lista de días (español o inglés) a LUN..DOM, sin duplicados.
 * @param {unknown} values
 * @returns {string[]}
 */
export function normalizeWeekdayCodes(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const raw = String(value ?? '').trim().toUpperCase();
    if (!raw) continue;
    const code = WEEKDAY_ALIASES[raw] || raw;
    if (!WEEKDAY_CODES.includes(code)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

export const SIGNAL_TYPES = Object.freeze([
  'conflicts', 'overdue', 'focus_low', 'free_gap', 'meeting_no_result', 'meeting_overload', 'inactivity'
]);

/**
 * Definiciones base. Se copian a datos al sembrar; a partir de ahí manda la copia
 * persistida (editable). No se re-siembran si el usuario las borra.
 * @param {string} [nowIso]
 */
export function baseWorkflows(nowIso = new Date().toISOString()) {
  const stamp = nowIso;
  return [
    {
      id: 'WF-BRIEF',
      name: 'Brief matinal',
      description: 'Resumen del día con Top 3, choques y foco recomendado.',
      active: true,
      trigger: { type: 'daily', at: '06:30', catchUpMaxMin: 720 },
      conditions: { skipWeekend: false, skipHolidays: false, notifyWhenEmpty: true },
      actions: [{ type: 'notify', template: 'brief', subject: 'Brief diario Agenda Copilot' }],
      llm: { enabled: true, profile: 'brief', deadlineMs: 25000 },
      channels: [],
      subject: 'Brief diario Agenda Copilot',
      compatKey: 'brief',
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-MIDDAY',
      name: 'Chequeo de mediodía',
      description: 'Pregunta si la prioridad #1 sigue siendo la correcta y qué ajustar.',
      active: true,
      trigger: { type: 'daily', at: '12:00', catchUpMaxMin: 240 },
      conditions: { skipWeekend: false, skipHolidays: false, notifyWhenEmpty: true },
      actions: [{ type: 'notify', template: 'midday', subject: 'Chequeo de mediodía' }],
      llm: { enabled: true, profile: 'midday', deadlineMs: 25000 },
      channels: [],
      subject: 'Chequeo de mediodía',
      compatKey: 'midday',
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-CLOSE',
      name: 'Cierre diario',
      description: 'Captura las métricas del día y cierra con foco real e índice P95.',
      active: true,
      trigger: { type: 'daily', at: '17:30', catchUpMaxMin: 360 },
      conditions: { skipWeekend: false, skipHolidays: false, notifyWhenEmpty: true },
      actions: [{ type: 'capture_metrics' }, { type: 'notify', template: 'close', subject: 'Cierre diario Agenda Copilot' }],
      llm: { enabled: true, profile: 'close', deadlineMs: 25000 },
      channels: [],
      subject: 'Cierre diario Agenda Copilot',
      compatKey: 'close',
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-WEEKLY',
      name: 'Reporte semanal',
      description: 'Reporte P95 de la semana con riesgos y acciones para la siguiente.',
      active: true,
      trigger: { type: 'weekly', at: '17:45', weekdays: ['VIE'], catchUpMaxMin: 1440 },
      conditions: { skipWeekend: false, skipHolidays: false, notifyWhenEmpty: true },
      actions: [{ type: 'notify', template: 'weekly', subject: 'Reporte semanal P95' }],
      llm: { enabled: true, profile: 'weekly', deadlineMs: 30000 },
      channels: [],
      subject: 'Reporte semanal P95',
      compatKey: 'weekly',
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-GOOGLE-SYNC',
      name: 'Reconciliación Google',
      description: 'Push de pendientes y pull incremental de calendarios cada settings.syncIntervalMin.',
      active: true,
      trigger: { type: 'interval', everyMin: 60, useSettingsInterval: true, catchUpMaxMin: 180 },
      conditions: { skipWeekend: false, skipHolidays: false },
      actions: [{ type: 'google_reconcile' }],
      llm: { enabled: false, profile: 'schedule_summary', deadlineMs: 10000 },
      channels: [],
      subject: 'Reconciliación Google',
      compatKey: null,
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-REMINDERS',
      name: 'Recordatorios por cita',
      description: 'Avisa X minutos antes de cada cita según su campo reminderMin.',
      active: true,
      trigger: { type: 'always', everyMin: 1 },
      conditions: { skipWeekend: false, skipHolidays: false },
      actions: [{ type: 'reminders' }],
      llm: { enabled: false, profile: 'schedule_summary', deadlineMs: 10000 },
      channels: [],
      subject: 'Recordatorio de cita',
      compatKey: null,
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-NIGHTLY',
      name: 'Resumen nocturno',
      description: 'Cierre del día y preparación de mañana (Top 3 y vencidas).',
      active: true,
      trigger: { type: 'daily', at: '21:00', catchUpMaxMin: 240 },
      conditions: { skipWeekend: false, skipHolidays: false, notifyWhenEmpty: true },
      actions: [{ type: 'notify', template: 'nightly', subject: 'Resumen nocturno Agenda Copilot' }],
      llm: { enabled: true, profile: 'schedule_summary', deadlineMs: 25000 },
      channels: [],
      subject: 'Resumen nocturno Agenda Copilot',
      compatKey: null,
      createdAt: stamp,
      updatedAt: stamp
    },
    {
      id: 'WF-HOURLY',
      name: 'Resumen horario de cambios',
      description: 'Cada hora laboral resume citas nuevas, movidas y completadas.',
      active: true,
      trigger: { type: 'interval', everyMin: 60, useSettingsInterval: false, workingDayOnly: true, workHoursOnly: true, catchUpMaxMin: 90 },
      conditions: { skipWeekend: true, skipHolidays: true, notifyWhenEmpty: false },
      actions: [{ type: 'notify', template: 'hourly_changes', subject: 'Cambios en la agenda (última hora)' }],
      llm: { enabled: true, profile: 'schedule_summary', deadlineMs: 25000 },
      channels: [],
      subject: 'Cambios en la agenda (última hora)',
      compatKey: null,
      createdAt: stamp,
      updatedAt: stamp
    }
  ];
}

/**
 * Reglas de señales base (se siembran una vez en `data.signalRules`).
 * `threshold` es el umbral de cada condición; `window` limita la franja local.
 */
export function baseSignalRules() {
  return [
    {
      id: 'SIG-CONFLICTS',
      type: 'conflicts',
      name: 'Choques en la agenda',
      description: 'Avisa cuando dos compromisos se solapan hoy.',
      enabled: true,
      severity: 'high',
      threshold: 1,
      window: { from: '06:00', to: '22:00' },
      cooldownMin: 240,
      channels: [],
      action: { type: 'notify', autoApply: false },
      llm: { enabled: true, profile: 'conflict' },
      params: { includeGoogle: false, maxItems: 3 }
    },
    {
      id: 'SIG-OVERDUE',
      type: 'overdue',
      name: 'Tareas vencidas',
      description: 'Avisa cuando hay demasiadas citas abiertas con fecha pasada.',
      enabled: true,
      severity: 'medium',
      threshold: 3,
      window: { from: '08:00', to: '21:00' },
      cooldownMin: 360,
      channels: [],
      action: { type: 'notify', autoApply: false },
      llm: { enabled: true, profile: 'signals' },
      params: {}
    },
    {
      id: 'SIG-FOCUS-LOW',
      type: 'focus_low',
      name: 'Foco insuficiente',
      description: 'Si el foco real del día no llega al umbral, propone un bloque.',
      enabled: true,
      severity: 'high',
      threshold: 60,
      window: { from: '12:00', to: '20:00' },
      cooldownMin: 180,
      channels: [],
      action: { type: 'propose_focus', autoApply: false },
      llm: { enabled: true, profile: 'signals' },
      params: { durationMin: 90, days: 3, includeGoogle: false }
    },
    {
      id: 'SIG-FREE-GAP',
      type: 'free_gap',
      name: 'Hueco libre',
      description: 'Detecta un hueco libre suficiente dentro de la jornada.',
      enabled: true,
      severity: 'low',
      threshold: 60,
      window: { from: '09:00', to: '17:00' },
      cooldownMin: 120,
      channels: [],
      action: { type: 'notify', autoApply: false },
      llm: { enabled: false, profile: 'signals' },
      params: { includeGoogle: false }
    },
    {
      id: 'SIG-MEETING-NO-RESULT',
      type: 'meeting_no_result',
      name: 'Reunión sin resultado',
      description: 'Reuniones de hoy sin resultado esperado definido.',
      enabled: true,
      severity: 'medium',
      threshold: 1,
      window: { from: '08:00', to: '20:00' },
      cooldownMin: 360,
      channels: [],
      action: { type: 'notify', autoApply: false },
      llm: { enabled: true, profile: 'signals' },
      params: {}
    },
    {
      id: 'SIG-MEETING-OVERLOAD',
      type: 'meeting_overload',
      name: 'Exceso de reuniones',
      description: 'Avisa si hoy hay más minutos de reunión que el umbral.',
      enabled: true,
      severity: 'medium',
      threshold: 240,
      window: { from: '10:00', to: '20:00' },
      cooldownMin: 360,
      channels: [],
      action: { type: 'notify', autoApply: false },
      llm: { enabled: true, profile: 'signals' },
      params: {}
    },
    {
      id: 'SIG-INACTIVITY',
      type: 'inactivity',
      name: 'Inactividad prolongada',
      description: 'Sin cierres ni actividad durante un bloque largo de la jornada.',
      enabled: true,
      severity: 'low',
      threshold: 120,
      window: { from: '09:00', to: '18:00' },
      cooldownMin: 180,
      channels: [],
      action: { type: 'notify', autoApply: false },
      llm: { enabled: false, profile: 'signals' },
      params: {}
    }
  ];
}

export const SIGNAL_SEED_VERSION = 1;

/** Lista de tipos canónicos usados por la UI/documentación. */
export function catalog() {
  return {
    triggers: TRIGGER_TYPES,
    actions: ACTION_TYPES,
    templates: TEMPLATES,
    channels: NOTIFY_CHANNELS,
    llmProfiles: LLM_PROFILES,
    signalTypes: SIGNAL_TYPES
  };
}

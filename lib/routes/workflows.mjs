/**
 * Rutas del motor de workflows y señales (t8).
 *
 * Se montan por auto-descubrimiento (`lib/routes/*.mjs`). Al importarse arranca
 * el scheduler (decisión B): es el ÚNICO dueño de los intervalos de la app.
 *
 * Endpoints del contrato (docs/CONTRATO_API.md §13) + extras de diagnóstico:
 *   GET    /api/workflows
 *   POST   /api/workflows
 *   GET    /api/workflows/runs
 *   GET    /api/workflows/status
 *   GET    /api/workflows/:id
 *   PATCH  /api/workflows/:id
 *   DELETE /api/workflows/:id
 *   POST   /api/workflows/:id/run?dryRun=1
 *   GET    /api/signals?limit=50&type=
 *   POST   /api/signals
 *   POST   /api/signals/evaluate
 *   GET    /api/signals/rules
 *   PATCH  /api/signals/rules/:id
 *   POST   /api/signals/:id/read
 *   POST   /api/signals/:id/dismiss
 */
import { store, nextId } from '../store.mjs';
import { logError } from '../http/logger.mjs';
import { ValidationError } from '../http/errors.mjs';
import {
  arrayOf, assertObject, boolean, enumValue, integer, isPlainObject, pickFields,
  text, timeHHMM, timeZoneValue
} from '../validate.mjs';
import {
  bodyOf, itemEnvelope, listEnvelope, notFound, paramOf, queryBool, queryInt,
  queryString, respond, route
} from '../agenda/http.mjs';
import {
  ensureSeededNow, runWorkflowNow, schedulerStatus, startScheduler, workflowTick
} from '../workflows/scheduler.mjs';
import {
  ACTION_TYPES, LLM_PROFILES, NOTIFY_CHANNELS, SIGNAL_TYPES, TEMPLATES, TRIGGER_TYPES,
  WEEKDAY_CODES, baseSignalRules, baseWorkflows, catalog, normalizeWeekdayCodes
} from '../workflows/defaults.mjs';
import {
  findWorkflow, isPlainObject as isObject, nowIso, workflowsOf
} from '../workflows/state.mjs';
import {
  createManualSignal, dismissSignal, evaluateSignals, listSignals, markSignalRead,
  signalRules, signalStatus, updateSignalRule
} from '../signals/engine.mjs';

export const name = 'workflows';
export const priority = 100;

/* ------------------------------------------------------------------ */
/* Validación de workflows                                             */
/* ------------------------------------------------------------------ */

const WORKFLOW_FIELDS = ['name', 'description', 'trigger', 'conditions', 'actions', 'active', 'llm', 'channels', 'subject'];
const TRIGGER_FIELDS = ['type', 'at', 'weekdays', 'everyMin', 'useSettingsInterval', 'catchUpMaxMin', 'workingDayOnly', 'workHoursOnly', 'timezone'];
const CONDITION_FIELDS = ['skipWeekend', 'skipHolidays', 'notifyWhenEmpty'];
const ACTION_FIELDS = ['type', 'template', 'subject', 'llmProfile', 'text'];
const LLM_FIELDS = ['enabled', 'profile', 'deadlineMs'];

function defaultCatchUp(type) {
  if (type === 'daily') return 720;
  if (type === 'weekly') return 1440;
  if (type === 'interval') return 180;
  return 0;
}

function validateTrigger(raw, existing = null) {
  if (!isObject(raw)) throw new ValidationError('trigger', 'REQUIRED', 'trigger es obligatorio.');
  const input = { ...(existing || {}), ...pickFields(raw, TRIGGER_FIELDS, { field: 'trigger', allowEmpty: false }) };
  const type = enumValue(input.type, TRIGGER_TYPES, { field: 'trigger.type', required: true });
  const out = { type };

  if (type === 'daily' || type === 'weekly') {
    out.at = timeHHMM(input.at, { field: 'trigger.at', required: true });
  }
  if (type === 'weekly') {
    const days = arrayOf(input.weekdays, (value, index) => enumValue(
      normalizeWeekdayCodes([value])[0] || value,
      WEEKDAY_CODES,
      { field: `trigger.weekdays[${index}]` }
    ), {
      field: 'trigger.weekdays',
      max: 7,
      defaultValue: ['VIE']
    });
    const normalized = normalizeWeekdayCodes(days || []);
    out.weekdays = normalized.length ? normalized : ['VIE'];
  }
  if (type === 'interval') {
    out.useSettingsInterval = boolean(input.useSettingsInterval, { field: 'trigger.useSettingsInterval', defaultValue: false });
    if (!out.useSettingsInterval) {
      out.everyMin = integer(input.everyMin, { field: 'trigger.everyMin', required: true, min: 1, max: 1440 });
    } else if (input.everyMin !== undefined) {
      out.everyMin = integer(input.everyMin, { field: 'trigger.everyMin', min: 1, max: 1440 });
    }
  }
  if (type === 'always') {
    out.everyMin = integer(input.everyMin, { field: 'trigger.everyMin', min: 1, max: 1440, defaultValue: 1 });
  }
  out.catchUpMaxMin = integer(input.catchUpMaxMin, {
    field: 'trigger.catchUpMaxMin', min: 0, max: 2880, defaultValue: defaultCatchUp(type)
  });
  out.workingDayOnly = boolean(input.workingDayOnly, { field: 'trigger.workingDayOnly', defaultValue: false });
  out.workHoursOnly = boolean(input.workHoursOnly, { field: 'trigger.workHoursOnly', defaultValue: false });
  if (input.timezone !== undefined && input.timezone !== null && input.timezone !== '') {
    out.timezone = timeZoneValue(input.timezone, { field: 'trigger.timezone' });
  }
  return out;
}

function validateConditions(raw, existing = null) {
  const input = { ...(existing || {}), ...pickFields(raw, CONDITION_FIELDS, { field: 'conditions', allowEmpty: true }) };
  return {
    skipWeekend: boolean(input.skipWeekend, { field: 'conditions.skipWeekend', defaultValue: false }),
    skipHolidays: boolean(input.skipHolidays, { field: 'conditions.skipHolidays', defaultValue: false }),
    notifyWhenEmpty: boolean(input.notifyWhenEmpty, { field: 'conditions.notifyWhenEmpty', defaultValue: true })
  };
}

function validateActions(raw) {
  if (!Array.isArray(raw)) throw new ValidationError('actions', 'INVALID_TYPE', 'actions debe ser una lista.');
  if (raw.length < 1 || raw.length > 5) {
    throw new ValidationError('actions', 'INVALID_RANGE', 'actions debe tener entre 1 y 5 acciones.');
  }
  return raw.map((item, index) => {
    if (!isPlainObject(item)) throw new ValidationError(`actions[${index}]`, 'INVALID_TYPE', 'Cada acción debe ser un objeto.');
    const input = pickFields(item, ACTION_FIELDS, { field: `actions[${index}]`, allowEmpty: false });
    const type = enumValue(input.type, ACTION_TYPES, { field: `actions[${index}].type`, required: true });
    const out = { type };
    if (type === 'notify') {
      out.template = enumValue(input.template, TEMPLATES, { field: `actions[${index}].template`, defaultValue: 'custom' });
      if (out.template === 'custom' || input.text !== undefined) {
        out.text = text(input.text, { field: `actions[${index}].text`, max: 4000, defaultValue: '' });
      }
      if (input.subject !== undefined) {
        out.subject = text(input.subject, { field: `actions[${index}].subject`, max: 120, allowEmpty: false });
      }
      if (input.llmProfile !== undefined) {
        out.llmProfile = enumValue(input.llmProfile, LLM_PROFILES, { field: `actions[${index}].llmProfile` });
      }
    }
    return out;
  });
}

function validateLlm(raw, existing = null) {
  const input = { ...(existing || {}), ...pickFields(raw, LLM_FIELDS, { field: 'llm', allowEmpty: true }) };
  return {
    enabled: boolean(input.enabled, { field: 'llm.enabled', defaultValue: true }),
    profile: enumValue(input.profile, LLM_PROFILES, { field: 'llm.profile', defaultValue: 'signals' }),
    deadlineMs: integer(input.deadlineMs, { field: 'llm.deadlineMs', min: 2000, max: 60000, defaultValue: 25000 })
  };
}

function validateChannels(raw) {
  return arrayOf(raw, (value, index) => enumValue(value, NOTIFY_CHANNELS, { field: `channels[${index}]` }), {
    field: 'channels', max: 3, defaultValue: []
  });
}

function validateWorkflowCreate(body) {
  const input = pickFields(assertObject(body), WORKFLOW_FIELDS, { field: 'body' });
  if (input.trigger === undefined) throw new ValidationError('trigger', 'REQUIRED', 'trigger es obligatorio.');
  if (input.actions === undefined) throw new ValidationError('actions', 'REQUIRED', 'actions es obligatorio.');
  return {
    name: text(input.name, { field: 'name', required: true, min: 1, max: 80, allowEmpty: false }),
    description: text(input.description, { field: 'description', max: 300, defaultValue: '' }),
    active: boolean(input.active, { field: 'active', defaultValue: true }),
    trigger: validateTrigger(input.trigger),
    conditions: validateConditions(input.conditions || {}),
    actions: validateActions(input.actions),
    llm: validateLlm(input.llm || {}),
    channels: validateChannels(input.channels),
    subject: text(input.subject, { field: 'subject', max: 120, defaultValue: null })
  };
}

function validateWorkflowPatch(body, existing) {
  const input = pickFields(assertObject(body), WORKFLOW_FIELDS, { field: 'body' });
  const patch = {};
  if (input.name !== undefined) patch.name = text(input.name, { field: 'name', required: true, min: 1, max: 80, allowEmpty: false });
  if (input.description !== undefined) patch.description = text(input.description, { field: 'description', max: 300, defaultValue: '' });
  if (input.active !== undefined) patch.active = boolean(input.active, { field: 'active', required: true });
  if (input.trigger !== undefined) patch.trigger = validateTrigger(input.trigger, existing.trigger);
  if (input.conditions !== undefined) patch.conditions = validateConditions(input.conditions, existing.conditions);
  if (input.actions !== undefined) patch.actions = validateActions(input.actions);
  if (input.llm !== undefined) patch.llm = validateLlm(input.llm, existing.llm);
  if (input.channels !== undefined) patch.channels = validateChannels(input.channels);
  if (input.subject !== undefined) patch.subject = text(input.subject, { field: 'subject', max: 120, defaultValue: null });
  return patch;
}

/* ------------------------------------------------------------------ */
/* Handlers de workflows                                               */
/* ------------------------------------------------------------------ */

/**
 * Siembra si se puede. En modo solo lectura (store degradado) no se escribe:
 * las lecturas devuelven las definiciones base para que la UI no se rompa.
 */
async function seedReadOnlySafe() {
  try {
    await ensureSeededNow();
  } catch (error) {
    if (!store.isReadOnly()) throw error;
  }
}

function workflowItems() {
  const stored = workflowsOf(store.get());
  return stored.length ? stored : baseWorkflows();
}

async function workflowsList(ctx) {
  await seedReadOnlySafe();
  const items = workflowItems().map((workflow) => ({ ...workflow }));
  const status = schedulerStatus();
  return respond(ctx, 200, {
    ...listEnvelope(items, { total: items.length }),
    scheduler: { started: status.started, tickMs: status.tickMs, lastTickAt: status.lastTickAt }
  });
}

async function workflowsCreate(ctx) {
  const body = await bodyOf(ctx);
  const payload = validateWorkflowCreate(body);
  let item = null;
  await store.mutate((data) => {
    const stamp = nowIso();
    item = {
      id: nextId('WF', workflowsOf(data)),
      ...payload,
      createdAt: stamp,
      updatedAt: stamp
    };
    workflowsOf(data).push(item);
  }, { label: 'workflow-create' });
  return respond(ctx, 201, itemEnvelope(item));
}

async function workflowsGet(ctx) {
  await seedReadOnlySafe();
  const id = paramOf(ctx, 'id');
  const item = workflowItems().find((workflow) => workflow && workflow.id === id) || null;
  if (!item) return notFound(ctx, `Workflow ${id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

async function workflowsPatch(ctx) {
  await seedReadOnlySafe();
  const id = paramOf(ctx, 'id');
  const current = findWorkflow(store.get(), id);
  if (!current) return notFound(ctx, `Workflow ${id}`);
  const body = await bodyOf(ctx);
  const patch = validateWorkflowPatch(body, current);
  let item = null;
  await store.mutate((data) => {
    const workflow = findWorkflow(data, id);
    if (!workflow) return;
    for (const [key, value] of Object.entries(patch)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      workflow[key] = value;
    }
    workflow.updatedAt = nowIso();
    item = workflow;
  }, { label: 'workflow-patch' });
  if (!item) return notFound(ctx, `Workflow ${id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

async function workflowsDelete(ctx) {
  await ensureSeededNow();
  const id = paramOf(ctx, 'id');
  const exists = findWorkflow(store.get(), id);
  if (!exists) return notFound(ctx, `Workflow ${id}`);
  await store.mutate((data) => {
    data.workflows = workflowsOf(data).filter((workflow) => workflow && workflow.id !== id);
  }, { label: 'workflow-delete' });
  return respond(ctx, 200, { ok: true, removed: id });
}

async function workflowsRun(ctx) {
  const id = paramOf(ctx, 'id');
  let body = {};
  try { body = (await bodyOf(ctx, {})) || {}; } catch { body = {}; }
  const dryRun = queryBool(ctx, 'dryRun', false) || body.dryRun === true;
  const result = await runWorkflowNow(id, { dryRun });
  return respond(ctx, 200, { ok: true, run: result.run });
}

async function workflowsRuns(ctx) {
  await seedReadOnlySafe();
  const limit = queryInt(ctx, 'limit', 50, { min: 1, max: 500 });
  const workflowId = queryString(ctx, 'workflowId');
  const status = queryString(ctx, 'status');
  const all = (Array.isArray(store.get().workflowRuns) ? store.get().workflowRuns : [])
    .filter((run) => run && typeof run === 'object')
    .filter((run) => !workflowId || run.workflowId === workflowId)
    .filter((run) => !status || run.status === status)
    .slice()
    .reverse();
  const items = all.slice(0, limit);
  return respond(ctx, 200, {
    items,
    count: items.length,
    total: all.length,
    limit
  });
}

function workflowsStatus(ctx) {
  return respond(ctx, 200, {
    scheduler: schedulerStatus(),
    signals: signalStatus(store.get()),
    catalog: catalog()
  });
}

/* ------------------------------------------------------------------ */
/* Validación de señales                                               */
/* ------------------------------------------------------------------ */

const SIGNAL_FIELDS = ['type', 'source', 'title', 'message', 'severity', 'payload'];
const RULE_FIELDS = ['enabled', 'name', 'description', 'severity', 'threshold', 'cooldownMin', 'window', 'channels', 'action', 'llm', 'params'];
const SIGNAL_SEVERITIES = ['low', 'medium', 'high'];
const SIGNAL_ACTIONS = ['notify', 'propose_focus', 'create_focus', 'ask_llm', 'silent'];

function sanitizeParams(raw) {
  if (!isPlainObject(raw)) throw new ValidationError('params', 'INVALID_TYPE', 'params debe ser un objeto.');
  let clone;
  try { clone = JSON.parse(JSON.stringify(raw)); } catch { throw new ValidationError('params', 'INVALID_VALUE', 'params no es serializable.'); }
  if (JSON.stringify(clone).length > 8000) throw new ValidationError('params', 'TOO_LONG', 'params supera 8 KB.');
  return clone;
}

function validateSignalRulePatch(body) {
  const input = pickFields(assertObject(body), RULE_FIELDS, { field: 'body' });
  const patch = {};
  if (input.enabled !== undefined) patch.enabled = boolean(input.enabled, { field: 'enabled', required: true });
  if (input.name !== undefined) patch.name = text(input.name, { field: 'name', max: 120, allowEmpty: false });
  if (input.description !== undefined) patch.description = text(input.description, { field: 'description', max: 300, defaultValue: '' });
  if (input.severity !== undefined) patch.severity = enumValue(input.severity, SIGNAL_SEVERITIES, { field: 'severity' });
  if (input.threshold !== undefined) patch.threshold = integer(input.threshold, { field: 'threshold', min: 0, max: 100000 });
  if (input.cooldownMin !== undefined) patch.cooldownMin = integer(input.cooldownMin, { field: 'cooldownMin', min: 0, max: 10080 });
  if (input.window !== undefined) {
    const window = pickFields(input.window, ['from', 'to'], { field: 'window', allowEmpty: false });
    patch.window = {
      from: timeHHMM(window.from, { field: 'window.from', required: true }),
      to: timeHHMM(window.to, { field: 'window.to', required: true })
    };
  }
  if (input.channels !== undefined) patch.channels = validateChannels(input.channels);
  if (input.action !== undefined) {
    const action = pickFields(input.action, ['type', 'autoApply'], { field: 'action', allowEmpty: false });
    patch.action = {
      type: enumValue(action.type, SIGNAL_ACTIONS, { field: 'action.type', required: true }),
      autoApply: boolean(action.autoApply, { field: 'action.autoApply', defaultValue: false })
    };
  }
  if (input.llm !== undefined) patch.llm = validateLlm(input.llm);
  if (input.params !== undefined) patch.params = sanitizeParams(input.params);
  return patch;
}

async function signalsList(ctx) {
  await seedReadOnlySafe();
  return respond(ctx, 200, listSignals(store.get(), {
    limit: queryInt(ctx, 'limit', 50, { min: 1, max: 500 }),
    type: queryString(ctx, 'type'),
    unread: queryBool(ctx, 'unread', false),
    includeDismissed: queryBool(ctx, 'includeDismissed', false)
  }));
}

async function signalsCreate(ctx) {
  const body = await bodyOf(ctx);
  const input = pickFields(assertObject(body), SIGNAL_FIELDS, { field: 'body' });
  const payload = {
    type: text(input.type, { field: 'type', required: true, max: 60, allowEmpty: false }),
    source: text(input.source, { field: 'source', max: 60, defaultValue: 'api' }),
    title: text(input.title, { field: 'title', max: 120, defaultValue: null }),
    message: text(input.message, { field: 'message', max: 2000, defaultValue: '' }),
    severity: enumValue(input.severity, SIGNAL_SEVERITIES, { field: 'severity', defaultValue: 'low' }),
    payload: input.payload === undefined ? {} : sanitizeParams(input.payload)
  };
  const item = await createManualSignal(payload);
  return respond(ctx, 201, itemEnvelope(item));
}

async function signalsEvaluate(ctx) {
  let body = {};
  try { body = (await bodyOf(ctx, {})) || {}; } catch { body = {}; }
  const dryRun = body.dryRun === true || queryBool(ctx, 'dryRun', false);
  const types = Array.isArray(body.types)
    ? arrayOf(body.types, (value, index) => enumValue(value, SIGNAL_TYPES, { field: `types[${index}]` }), { field: 'types', max: SIGNAL_TYPES.length, defaultValue: [] })
    : null;
  const result = await evaluateSignals({
    dryRun,
    types,
    notify: body.notify !== false && !dryRun,
    source: 'api'
  });
  return respond(ctx, 200, {
    ok: true,
    dryRun,
    evaluated: result.evaluated,
    emitted: result.emitted,
    items: result.items,
    candidates: result.candidates,
    errors: result.errors
  });
}

async function signalsRules(ctx) {
  await seedReadOnlySafe();
  const stored = signalRules(store.get());
  const items = (stored.length ? stored : baseSignalRules()).map((rule) => ({ ...rule }));
  return respond(ctx, 200, { ...listEnvelope(items, { total: items.length }), types: SIGNAL_TYPES });
}

async function signalsRulePatch(ctx) {
  const id = paramOf(ctx, 'id');
  const patch = validateSignalRulePatch(await bodyOf(ctx));
  const item = await updateSignalRule(id, patch);
  if (!item) return notFound(ctx, `Regla de señal ${id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

async function signalsRead(ctx) {
  const id = paramOf(ctx, 'id');
  const item = await markSignalRead(id);
  if (!item) return notFound(ctx, `Señal ${id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

async function signalsDismiss(ctx) {
  const id = paramOf(ctx, 'id');
  const item = await dismissSignal(id);
  if (!item) return notFound(ctx, `Señal ${id}`);
  return respond(ctx, 200, itemEnvelope(item));
}

/* ------------------------------------------------------------------ */
/* Rutas                                                              */
/* ------------------------------------------------------------------ */

export const routes = [
  { method: 'GET', path: '/api/workflows', name: 'workflows.list', handler: route(workflowsList) },
  { method: 'POST', path: '/api/workflows', name: 'workflows.create', handler: route(workflowsCreate) },
  { method: 'GET', path: '/api/workflows/runs', name: 'workflows.runs', handler: route(workflowsRuns) },
  { method: 'GET', path: '/api/workflows/status', name: 'workflows.status', handler: route(workflowsStatus) },
  { method: 'GET', path: '/api/workflows/:id', name: 'workflows.get', handler: route(workflowsGet) },
  { method: 'PATCH', path: '/api/workflows/:id', name: 'workflows.patch', handler: route(workflowsPatch) },
  { method: 'DELETE', path: '/api/workflows/:id', name: 'workflows.delete', handler: route(workflowsDelete) },
  { method: 'POST', path: '/api/workflows/:id/run', name: 'workflows.run', handler: route(workflowsRun) },
  { method: 'GET', path: '/api/signals', name: 'signals.list', handler: route(signalsList) },
  { method: 'POST', path: '/api/signals', name: 'signals.create', handler: route(signalsCreate) },
  { method: 'POST', path: '/api/signals/evaluate', name: 'signals.evaluate', handler: route(signalsEvaluate) },
  { method: 'GET', path: '/api/signals/rules', name: 'signals.rules', handler: route(signalsRules) },
  { method: 'PATCH', path: '/api/signals/rules/:id', name: 'signals.rules.patch', handler: route(signalsRulePatch) },
  { method: 'POST', path: '/api/signals/:id/read', name: 'signals.read', handler: route(signalsRead) },
  { method: 'POST', path: '/api/signals/:id/dismiss', name: 'signals.dismiss', handler: route(signalsDismiss) }
];

/** Solo para diagnóstico interno (no es una ruta HTTP). */
export { workflowTick };

/* ------------------------------------------------------------------ */
/* Arranque automático (decisión B del capitán)                        */
/* ------------------------------------------------------------------ */

function shouldAutostart() {
  if (String(process.env.WORKFLOWS_AUTOSTART || '') === '0') return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  if (process.argv.some((arg) => arg === '--test' || arg.startsWith('--test='))) return false;
  return true;
}

if (shouldAutostart()) {
  try {
    startScheduler();
  } catch (error) {
    logError('workflows:autostart', error);
  }
}

export default { name, priority, routes };

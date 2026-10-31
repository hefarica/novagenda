/**
 * Centro de automatizaciones y señales.
 *
 * Con el módulo de workflows (t8) montado, la UI es 100 % dirigida por el
 * servidor: workflows reales (trigger/condiciones/acciones), ejecuciones en
 * dry-run, bandeja de señales y reglas con umbrales y ventanas.
 * Si el módulo no existe, degrada a un catálogo de recetas en borrador local.
 */
import { api, endpointState } from './api.js';
import { state } from './state.js';
import {
  loadSignalRules, loadSignals, loadWorkflowRuns, loadWorkflows,
  probeOptionalModules, refreshAll
} from './data.js';
import {
  $, $$, esc, fmtDateTime, setBusy, toast
} from './core.js';

const RECIPE_KEY = 'agenda-p95.recipes.v1';
const RUNS_KEY = 'agenda-p95.runs.v1';
const DAYS = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM'];
const DAY_LABELS = { LUN: 'Lun', MAR: 'Mar', MIE: 'Mié', JUE: 'Jue', VIE: 'Vie', SAB: 'Sáb', DOM: 'Dom', MON: 'Lun', TUE: 'Mar', WED: 'Mié', THU: 'Jue', FRI: 'Vie', SAT: 'Sáb', SUN: 'Dom' };
const DAY_TO_CODE = { MON: 'LUN', TUE: 'MAR', WED: 'MIE', THU: 'JUE', FRI: 'VIE', SAT: 'SAB', SUN: 'DOM' };
const SEVERITY = { high: 'alta', medium: 'media', low: 'baja' };
const TRIGGER_LABELS = { daily: 'diario', weekly: 'semanal', interval: 'por intervalo', always: 'siempre', manual: 'manual' };
const CHANNELS = ['whatsapp', 'telegram', 'email'];

/** Catálogo local de respaldo cuando el módulo de workflows no está montado. */
const FALLBACK_RECIPES = [
  { id: 'briefing', name: 'Briefing de la mañana', icon: '☀', description: 'Resume el día, el Top 3 y los choques antes de empezar.', trigger: { type: 'daily', at: '07:00' } },
  { id: 'closing', name: 'Cierre del día', icon: '☾', description: 'Pide las métricas del día y cierra o reprograma pendientes.', trigger: { type: 'daily', at: '17:30' } },
  { id: 'weekly', name: 'Revisión semanal', icon: '🗓', description: 'Genera el reporte semanal y el plan de la semana siguiente.', trigger: { type: 'weekly', at: '16:30' } },
  { id: 'reminders', name: 'Recordatorios de citas', icon: '⏰', description: 'Avisa antes de cada cita dentro de la ventana horaria.', trigger: { type: 'interval', at: '06:00' } },
  { id: 'materialize', name: 'Materializar rutinas', icon: '↻', description: 'Convierte las plantillas de rutinas en citas reales del día.', trigger: { type: 'daily', at: '06:00' } },
  { id: 'signal-conflict', name: 'Señal de conflicto', icon: '⚡', description: 'Cuando llega una señal con choque, propone alternativas y avisa.', trigger: { type: 'signal' } }
];

let localRecipes = {};
/** Notas por workflow (resultado de la última simulación/guardado). */
const workflowNotes = new Map();
let localRuns = [];
let initialized = false;

/* ------------------------------ almacenamiento local ------------------------------ */
function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ }
}

/* ------------------------------ estado disponible ------------------------------ */
const workflowsAvailable = () => Array.isArray(state.workflows?.items);
const signalsAvailable = () => Array.isArray(state.signals?.items);
const rulesAvailable = () => Array.isArray(state.signalRules?.items);
const serverWorkflows = () => (workflowsAvailable() ? state.workflows.items : []);
const serverSignals = () => (signalsAvailable() ? state.signals.items : []);
const serverRules = () => (rulesAvailable() ? state.signalRules.items : []);

/* ------------------------------ formato ------------------------------ */
function triggerSummary(trigger = {}) {
  const type = String(trigger.type || 'daily');
  const at = trigger.at ? ` · ${trigger.at}` : '';
  if (type === 'weekly') {
    const days = (trigger.weekdays || []).map((day) => DAY_LABELS[String(day).toUpperCase()] || day).join(', ');
    return `${TRIGGER_LABELS.weekly}${days ? ` (${days})` : ''}${at}`;
  }
  if (type === 'interval') {
    const every = trigger.useSettingsInterval ? 'según ajustes' : `${trigger.everyMin || '—'} min`;
    return `${TRIGGER_LABELS.interval} · cada ${every}`;
  }
  if (type === 'always') return `${TRIGGER_LABELS.always} · cada ${trigger.everyMin || 1} min`;
  return `${TRIGGER_LABELS[type] || type}${at}`;
}

function actionSummary(actions) {
  const list = Array.isArray(actions) ? actions : (actions ? [actions] : []);
  return list.map((action) => {
    if (!action) return '';
    if (action.type === 'notify') return `avisar (${action.template || 'mensaje'})`;
    return String(action.type || 'acción');
  }).filter(Boolean).join(' + ') || 'sin acciones';
}

function lastRunFor(workflowId) {
  return (state.workflowRuns || []).find((run) => run.workflowId === workflowId) || null;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return String(iso).slice(0, 16);
  if (diff < 60000) return 'hace segundos';
  if (diff < 3600000) return `hace ${Math.round(diff / 60000)} min`;
  if (diff < 86400000) return `hace ${Math.round(diff / 3600000)} h`;
  return `hace ${Math.round(diff / 86400000)} d`;
}

/* ------------------------------ workflows (servidor) ------------------------------ */
function workflowCard(workflow) {
  const trigger = workflow.trigger || {};
  const conditions = workflow.conditions || {};
  const type = String(trigger.type || 'daily');
  const weekdays = Array.isArray(trigger.weekdays)
    ? trigger.weekdays.map((day) => DAY_TO_CODE[String(day).toUpperCase()] || String(day).toUpperCase())
    : [];
  const days = weekdays.length ? weekdays : (type === 'weekly' ? ['LUN'] : []);
  const channels = Array.isArray(workflow.channels) ? workflow.channels : [];
  const actions = Array.isArray(workflow.actions) ? workflow.actions : (workflow.actions ? [workflow.actions] : []);
  const last = lastRunFor(workflow.id);
  const catalog = state.workflowStatus?.catalog?.triggers || ['daily', 'weekly', 'interval', 'always', 'manual'];
  const llm = workflow.llm || {};
  const profiles = state.workflowStatus?.catalog?.llmProfiles || ['brief', 'midday', 'close', 'weekly', 'signals', 'hourly_changes'];
  return `<div class="recipe-card" data-workflow-id="${esc(workflow.id)}">
    <div class="recipe-head">
      <b>${esc(workflow.name || workflow.id)}</b>
      <div class="chips">
        <span class="tag">${esc(triggerSummary(trigger))}</span>
        <label class="switch" title="Activar o desactivar">
          <input type="checkbox" data-wf-active="${esc(workflow.id)}" ${workflow.active ? 'checked' : ''} aria-label="Activar ${esc(workflow.name || workflow.id)}" />
          <span></span>
        </label>
      </div>
    </div>
    <p>${esc(workflow.description || 'Sin descripción.')}</p>
    <div class="chips">
      <span class="tag">${esc(workflow.id)}</span>
      <span class="tag">${esc(actionSummary(actions))}</span>
      ${workflow.compatKey ? `<span class="tag">${esc(workflow.compatKey)}</span>` : ''}
      ${last ? `<span class="tag ${last.status === 'ok' ? 'ok' : last.status === 'error' ? 'bad' : 'warn'}">última: ${esc(last.status)} · ${esc(relativeTime(last.startedAt))}</span>` : '<span class="tag off">sin ejecuciones</span>'}
    </div>
    <details class="field-group" ${workflow.active ? '' : 'open'}>
      <summary>Disparador, condiciones y canales</summary>
      <div class="recipe-fields">
        <label class="field"><span>Disparador</span>
          <select data-wf-trigger="type">
            ${[...new Set([...catalog, type])].map((option) => `<option value="${esc(option)}" ${option === type ? 'selected' : ''}>${esc(TRIGGER_LABELS[option] || option)}</option>`).join('')}
          </select>
        </label>
        <label class="field" data-wf-only="daily weekly"><span>Hora</span><input data-wf-trigger="at" type="time" value="${esc(trigger.at || '07:00')}" /></label>
        <label class="field" data-wf-only="interval always"><span>Cada (min)</span><input data-wf-trigger="everyMin" type="number" min="1" max="1440" value="${Number(trigger.everyMin) || 60}" /></label>
        <label class="field" data-wf-only="daily weekly interval"><span>Recuperar hasta (min)</span><input data-wf-trigger="catchUpMaxMin" type="number" min="0" max="4320" value="${Number(trigger.catchUpMaxMin) || 180}" /></label>
      </div>
      <div class="chips-field" data-wf-only="weekly"><span class="chips-label">Días de la semana</span>
        <div class="chips">${DAYS.map((day) => `<button type="button" class="chip ${days.includes(day) ? 'active' : ''}" data-wf-day="${day}" aria-pressed="${days.includes(day)}">${DAY_LABELS[day]}</button>`).join('')}</div>
      </div>
      <div class="chips-field"><span class="chips-label">Condiciones</span>
        <div class="chips">
          <label class="check small"><input type="checkbox" data-wf-condition="skipWeekend" ${conditions.skipWeekend ? 'checked' : ''} /><span>Saltar fines de semana</span></label>
          <label class="check small"><input type="checkbox" data-wf-condition="skipHolidays" ${conditions.skipHolidays ? 'checked' : ''} /><span>Saltar festivos</span></label>
          <label class="check small"><input type="checkbox" data-wf-condition="notifyWhenEmpty" ${conditions.notifyWhenEmpty ? 'checked' : ''} /><span>Avisar aunque no haya novedades</span></label>
        </div>
      </div>
      <div class="chips-field"><span class="chips-label">Canales (vacío = todos los configurados)</span>
        <div class="chips">${CHANNELS.map((channel) => `<button type="button" class="chip ${channels.includes(channel) ? 'active' : ''}" data-wf-channel="${channel}" aria-pressed="${channels.includes(channel)}">${esc(channel)}</button>`).join('')}</div>
      </div>
      <div class="recipe-fields">
        <label class="field check"><input type="checkbox" data-wf-llm="enabled" ${llm.enabled ? 'checked' : ''} /><span>Usar LLM para redactar</span></label>
        <label class="field"><span>Perfil del LLM</span>
          <select data-wf-llm="profile">${[...new Set([...profiles, llm.profile].filter(Boolean))].map((profile) => `<option value="${esc(profile)}" ${llm.profile === profile ? 'selected' : ''}>${esc(profile)}</option>`).join('')}</select>
        </label>
      </div>
    </details>
    <div class="recipe-actions">
      <button type="button" class="secondary small" data-wf-save="${esc(workflow.id)}">Guardar</button>
      <button type="button" class="primary small" data-wf-run="${esc(workflow.id)}">Probar ahora (simulación)</button>
      <button type="button" class="ghost small" data-wf-json="${esc(workflow.id)}" aria-expanded="false">Ver JSON</button>
    </div>
    <pre class="report-box hidden" data-wf-json-box="${esc(workflow.id)}"></pre>
    <div class="inline-note" data-wf-note="${esc(workflow.id)}"></div>
  </div>`;
}

function applyTriggerVisibility(root) {
  for (const card of root.querySelectorAll('[data-workflow-id]')) {
    const type = card.querySelector('[data-wf-trigger="type"]')?.value || 'daily';
    for (const element of card.querySelectorAll('[data-wf-only]')) {
      const allowed = String(element.dataset.wfOnly || '').split(/\s+/);
      element.hidden = !allowed.includes(type);
    }
  }
}

function renderWorkflowCards() {
  const container = $('#recipesList');
  if (!container) return;
  const items = serverWorkflows();
  container.innerHTML = items.length
    ? items.map(workflowCard).join('')
    : '<p class="muted small">El planificador no tiene workflows definidos.</p>';
  const meta = $('#recipesMeta');
  if (meta) meta.textContent = `${items.filter((item) => item.active).length}/${items.length} activos`;
  applyTriggerVisibility(container);
  paintAllWorkflowNotes();
}

function readWorkflowConfig(card, workflow) {
  const type = card.querySelector('[data-wf-trigger="type"]').value;
  const original = workflow.trigger || {};
  const trigger = { type };
  const at = card.querySelector('[data-wf-trigger="at"]');
  const every = card.querySelector('[data-wf-trigger="everyMin"]');
  const catchUp = card.querySelector('[data-wf-trigger="catchUpMaxMin"]');
  if (['daily', 'weekly'].includes(type) || original.at !== undefined) trigger.at = at?.value || original.at || '07:00';
  if (['interval', 'always'].includes(type) || original.everyMin !== undefined) trigger.everyMin = Number(every?.value) || original.everyMin || 60;
  if (['daily', 'weekly', 'interval'].includes(type) || original.catchUpMaxMin !== undefined) {
    trigger.catchUpMaxMin = Number(catchUp?.value ?? original.catchUpMaxMin ?? 180);
  }
  if (type === 'weekly' || original.weekdays !== undefined) {
    const days = [...card.querySelectorAll('[data-wf-day].active')].map((chip) => chip.dataset.wfDay);
    trigger.weekdays = days.length ? days : ['LUN'];
  }
  for (const key of ['workingDayOnly', 'workHoursOnly', 'useSettingsInterval']) {
    if (original[key] !== undefined) {
      const input = card.querySelector(`[data-wf-trigger="${key}"]`);
      trigger[key] = input ? input.checked : Boolean(original[key]);
    }
  }
  const conditions = {};
  for (const input of card.querySelectorAll('[data-wf-condition]')) conditions[input.dataset.wfCondition] = input.checked;
  const channels = [...card.querySelectorAll('[data-wf-channel].active')].map((chip) => chip.dataset.wfChannel);
  const llmEnabled = card.querySelector('[data-wf-llm="enabled"]');
  const llmProfile = card.querySelector('[data-wf-llm="profile"]');
  const llm = { ...(workflow.llm || {}), enabled: Boolean(llmEnabled?.checked), profile: llmProfile?.value || workflow.llm?.profile || null };
  return { trigger, conditions, channels, llm };
}

function setWorkflowNote(id, message, ok = true) {
  workflowNotes.set(id, { message, ok });
  paintWorkflowNote(id);
}

function paintWorkflowNote(id) {
  const note = document.querySelector(`[data-wf-note="${id}"]`);
  const stored = workflowNotes.get(id);
  if (!note || !stored) return;
  note.innerHTML = `<span class="${stored.ok ? 'hint' : 'alert'}">${esc(stored.message)}</span>`;
}

function paintAllWorkflowNotes() {
  for (const id of workflowNotes.keys()) paintWorkflowNote(id);
}

async function saveWorkflow(id, button) {
  const card = document.querySelector(`[data-workflow-id="${id}"]`);
  const workflow = serverWorkflows().find((item) => item.id === id);
  if (!card || !workflow) return;
  const payload = readWorkflowConfig(card, workflow);
  workflowNotes.delete(id);
  setBusy(button, true, 'Guardando');
  try {
    await api.patch(`/api/workflows/${encodeURIComponent(id)}`, payload);
    toast('Workflow guardado', 'ok');
    await loadWorkflows();
    await refreshAll();
  } catch (error) {
    setWorkflowNote(id, `No se pudo guardar: ${error?.message || 'error'}${error?.field ? ` (campo ${error.field})` : ''}`, false);
    toast('No se pudo guardar el workflow', 'err');
  } finally {
    setBusy(button, false);
    renderWorkflows();
  }
}

async function toggleWorkflow(id, active, input) {
  try {
    await api.patch(`/api/workflows/${encodeURIComponent(id)}`, { active });
    toast(active ? 'Workflow activado' : 'Workflow pausado', 'ok');
    await loadWorkflows();
    await refreshAll();
  } catch (error) {
    if (input) input.checked = !active;
    toast(error?.message || 'No se pudo cambiar el estado', 'err');
  } finally {
    renderWorkflows();
  }
}

async function dryRunWorkflow(id, button) {
  setBusy(button, true, 'Simulando');
  try {
    const result = await api.post(`/api/workflows/${encodeURIComponent(id)}/run?dryRun=1`, { dryRun: true }, { timeoutMs: 40000 });
    const run = result?.run || {};
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const summary = steps.map((step) => `${step.name || 'paso'}${step.skipped ? ' (omitido)' : step.ok === false ? ' (error)' : ''}`).join(', ') || 'sin pasos';
    setWorkflowNote(id, `Simulación ${run.status || 'ok'} · ${summary}. No se envió ningún mensaje.`, run.status !== 'error');
    toast(`Simulación completada: ${summary}`, run.status === 'error' ? 'err' : 'ok');
    await loadWorkflowRuns();
  } catch (error) {
    setWorkflowNote(id, `No se pudo simular: ${error?.message || 'error'}`, false);
    toast(error?.message || 'No se pudo simular', 'err');
  } finally {
    setBusy(button, false);
    renderWorkflows();
  }
}

/* ------------------------------ ejecuciones ------------------------------ */
function renderRuns() {
  const container = $('#runsList');
  if (!container) return;
  const runs = Array.isArray(state.workflowRuns) ? state.workflowRuns : [];
  container.innerHTML = runs.length
    ? runs.slice(0, 20).map((run) => `<div class="system-row">
        <div>
          <b>${esc(run.workflowName || run.workflowId || 'workflow')}</b>
          <small>${esc(fmtDateTime(run.startedAt))} · ${esc(run.status || '—')}${run.dryRun ? ' · simulación' : ''} · ${Number(run.durationMs) || 0} ms · ${(run.steps || []).length} paso(s)${run.error ? ` · error: ${esc(run.error)}` : ''}</small>
        </div>
        <span class="tag ${run.status === 'ok' ? 'ok' : run.status === 'error' ? 'bad' : 'warn'}">${esc(run.reason || run.status || '')}</span>
      </div>`).join('')
    : '<p class="muted small">Sin ejecuciones reales registradas. Las simulaciones («Probar ahora») se muestran en la tarjeta del workflow y no envían mensajes.</p>';
  const meta = $('#runsMeta');
  if (meta) meta.textContent = runs.length ? `${runs.length} recientes` : 'sin datos';
}

/* ------------------------------ señales ------------------------------ */
function signalMatches(signal) {
  const filter = state.ui.signalFilter || 'all';
  if (filter === 'all') return true;
  if (filter === 'unread') return !signal.read && !signal.dismissed;
  return String(signal.type || '').includes(filter);
}

function signalCard(signal) {
  const severity = SEVERITY[signal.severity] || signal.severity || '';
  return `<div class="system-row ${signal.read ? 'done' : ''}" data-signal-id="${esc(signal.id)}">
    <div>
      <b>${esc(signal.title || signal.type || 'señal')} <span class="tag ${signal.severity === 'high' ? 'bad' : signal.severity === 'medium' ? 'warn' : 'off'}">${esc(severity)}</span></b>
      <small>${esc(signal.type || '')} · ${esc(signal.source || '')} · ${esc(relativeTime(signal.at))}${signal.dismissed ? ' · descartada' : signal.read ? ' · leída' : ' · sin leer'}</small>
      <p class="hint" style="white-space:pre-wrap">${esc(String(signal.message || '').slice(0, 320))}</p>
    </div>
    <div class="chips">
      ${signal.read ? '<span class="tag ok">leída</span>' : `<button type="button" data-signal-read="${esc(signal.id)}">Leer</button>`}
      ${signal.dismissed ? '' : `<button type="button" data-signal-dismiss="${esc(signal.id)}">Descartar</button>`}
    </div>
  </div>`;
}

function renderSignals() {
  const container = $('#signalsList');
  if (!container) return;
  const items = serverSignals().filter(signalMatches);
  container.innerHTML = items.length
    ? items.slice(0, 20).map(signalCard).join('')
    : '<p class="muted small">Sin señales con este filtro.</p>';
  const meta = $('#signalsMeta');
  if (meta) {
    const unread = serverSignals().filter((signal) => !signal.read && !signal.dismissed).length;
    meta.textContent = `${unread} sin leer · ${serverSignals().length} en total`;
  }
}

async function signalAction(id, action) {
  try {
    await api.post(`/api/signals/${encodeURIComponent(id)}/${action}`, {});
    toast(action === 'read' ? 'Señal marcada como leída' : 'Señal descartada', 'ok');
    await loadSignals();
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo actualizar la señal', 'err');
  } finally {
    renderWorkflows();
  }
}

async function evaluateSignals(button) {
  setBusy(button, true, 'Evaluando');
  try {
    const result = await api.post('/api/signals/evaluate?dryRun=1', { dryRun: true, notify: false }, { timeoutMs: 40000 });
    const emitted = Number(result?.emitted) || 0;
    const evaluated = Number(result?.evaluated) || 0;
    toast(`Simulación: ${evaluated} regla(s) evaluadas · ${emitted} señal(es) nuevas · no se notificó nada`, emitted ? 'ok' : 'warn');
    await loadSignals();
  } catch (error) {
    toast(error?.message || 'No se pudieron evaluar las reglas', 'err');
  } finally {
    setBusy(button, false);
    renderWorkflows();
  }
}

async function createTestSignal(button) {
  setBusy(button, true, 'Generando');
  try {
    await api.post('/api/signals', {
      type: 'manual',
      source: 'app',
      title: 'Señal de prueba',
      message: 'Señal creada desde el centro de automatizaciones para comprobar la bandeja.',
      severity: 'low',
      payload: { from: 'ui', at: new Date().toISOString() }
    });
    toast('Señal de prueba creada', 'ok');
    state.ui.signalFilter = 'all';
    await loadSignals();
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo crear la señal', 'err');
  } finally {
    setBusy(button, false);
    renderWorkflows();
  }
}

/* ------------------------------ reglas de señales ------------------------------ */
function ruleCard(rule) {
  return `<div class="recipe-card" data-rule-id="${esc(rule.id)}">
    <div class="recipe-head">
      <b>${esc(rule.name || rule.id)}</b>
      <div class="chips">
        <span class="tag ${rule.enabled ? 'ok' : 'off'}">${rule.enabled ? 'activa' : 'pausada'}</span>
        <label class="switch" title="Activar o desactivar la regla">
          <input type="checkbox" data-rule-enabled ${rule.enabled ? 'checked' : ''} aria-label="Activar regla ${esc(rule.name || rule.id)}" />
          <span></span>
        </label>
      </div>
    </div>
    <p>${esc(rule.description || '')}</p>
    <div class="recipe-fields">
      <label class="field"><span>Umbral</span><input data-rule-field="threshold" type="number" min="0" max="100000" step="1" value="${Number(rule.threshold) || 0}" /></label>
      <label class="field"><span>Ventana desde</span><input data-rule-field="windowFrom" type="time" value="${esc(rule.window?.from || '00:00')}" /></label>
      <label class="field"><span>Ventana hasta</span><input data-rule-field="windowTo" type="time" value="${esc(rule.window?.to || '23:59')}" /></label>
      <label class="field"><span>Enfriamiento (min)</span><input data-rule-field="cooldownMin" type="number" min="0" max="10080" step="5" value="${Number(rule.cooldownMin) || 0}" /></label>
      <label class="field"><span>Severidad</span>
        <select data-rule-field="severity">${['high', 'medium', 'low'].map((level) => `<option value="${level}" ${rule.severity === level ? 'selected' : ''}>${esc(SEVERITY[level] || level)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Acción</span><span class="hint">${esc(rule.action?.type || '—')}${rule.action?.autoApply ? ' (auto)' : ''}</span></label>
    </div>
    <div class="recipe-actions">
      <button type="button" class="secondary small" data-rule-save="${esc(rule.id)}">Guardar umbrales</button>
      <span class="hint">Tipo: ${esc(rule.type || '')} · canales: ${esc((rule.channels || []).join(', ') || 'todos')}</span>
    </div>
    <div class="inline-note" data-rule-note="${esc(rule.id)}"></div>
  </div>`;
}

function renderSignalRules() {
  const container = $('#signalRules');
  if (!container) return;
  const rules = serverRules();
  container.innerHTML = rules.length
    ? rules.map(ruleCard).join('')
    : '<p class="muted small">El servidor no expone reglas de señales.</p>';
  const meta = $('#rulesMeta');
  if (meta) meta.textContent = rules.length ? `${rules.filter((rule) => rule.enabled).length}/${rules.length} activas` : 'sin datos';
}

async function saveRule(id, trigger) {
  const card = document.querySelector(`[data-rule-id="${id}"]`);
  if (!card) return;
  const button = trigger && trigger.tagName === 'BUTTON' ? trigger : card.querySelector('[data-rule-save]');
  const payload = {
    threshold: Number(card.querySelector('[data-rule-field="threshold"]')?.value) || 0,
    window: {
      from: card.querySelector('[data-rule-field="windowFrom"]')?.value || '00:00',
      to: card.querySelector('[data-rule-field="windowTo"]')?.value || '23:59'
    },
    cooldownMin: Number(card.querySelector('[data-rule-field="cooldownMin"]')?.value) || 0,
    severity: card.querySelector('[data-rule-field="severity"]')?.value || 'low',
    enabled: Boolean(card.querySelector('[data-rule-enabled]')?.checked)
  };
  setBusy(button, true, 'Guardando');
  try {
    await api.patch(`/api/signals/rules/${encodeURIComponent(id)}`, payload);
    toast('Regla actualizada', 'ok');
    await loadSignalRules();
    await refreshAll();
  } catch (error) {
    const note = document.querySelector(`[data-rule-note="${id}"]`);
    if (note) note.innerHTML = `<span class="alert">${esc(error?.message || 'No se pudo guardar la regla')}</span>`;
    toast(error?.message || 'No se pudo guardar la regla', 'err');
  } finally {
    setBusy(button, false);
    renderWorkflows();
  }
}

/* ------------------------------ respaldo local ------------------------------ */
function localConfig(recipe) {
  const stored = localRecipes[recipe.id] || {};
  return { enabled: Boolean(stored.enabled), at: stored.at || recipe.trigger.at || '07:00', pendingServer: Boolean(stored.pendingServer) };
}

function fallbackCard(recipe) {
  const config = localConfig(recipe);
  return `<div class="recipe-card" data-recipe-id="${esc(recipe.id)}">
    <div class="recipe-head">
      <b><span aria-hidden="true">${recipe.icon}</span> ${esc(recipe.name)}</b>
      <div class="chips">
        ${config.pendingServer ? '<span class="tag warn">borrador local</span>' : '<span class="tag off">sin guardar</span>'}
        <label class="switch" title="Activar o desactivar">
          <input type="checkbox" data-recipe-toggle="${esc(recipe.id)}" ${config.enabled ? 'checked' : ''} aria-label="Activar ${esc(recipe.name)}" />
          <span></span>
        </label>
      </div>
    </div>
    <p>${esc(recipe.description)}</p>
    <div class="recipe-fields">
      <label class="field"><span>Hora</span><input data-recipe-field="at" type="time" value="${esc(config.at)}" /></label>
    </div>
    <div class="recipe-actions">
      <button type="button" class="secondary small" data-recipe-save="${esc(recipe.id)}">Guardar borrador</button>
      <button type="button" class="primary small" data-recipe-run="${esc(recipe.id)}">Probar ahora (simulación)</button>
    </div>
    <div class="inline-note" data-recipe-note="${esc(recipe.id)}"></div>
  </div>`;
}

function renderFallbackRecipes() {
  const container = $('#recipesList');
  if (!container) return;
  container.innerHTML = FALLBACK_RECIPES.map(fallbackCard).join('');
  const meta = $('#recipesMeta');
  if (meta) meta.textContent = 'módulo no disponible';
}

function saveLocalRecipe(id) {
  const card = document.querySelector(`[data-recipe-id="${id}"]`);
  const recipe = FALLBACK_RECIPES.find((item) => item.id === id);
  if (!card || !recipe) return;
  const at = card.querySelector('[data-recipe-field="at"]')?.value || '07:00';
  const enabled = Boolean(card.querySelector('[data-recipe-toggle]')?.checked);
  localRecipes[id] = { ...(localRecipes[id] || {}), at, enabled, pendingServer: true };
  writeStorage(RECIPE_KEY, localRecipes);
  const note = document.querySelector(`[data-recipe-note="${id}"]`);
  if (note) note.innerHTML = '<span class="hint">Guardada como borrador local: el módulo de workflows aún no está montado.</span>';
  toast('Receta guardada como borrador local (falta el módulo de workflows)', 'warn');
  renderWorkflows();
}

function runLocalRecipe(id, button) {
  const recipe = FALLBACK_RECIPES.find((item) => item.id === id);
  const config = localConfig(recipe);
  setBusy(button, true, 'Simulando');
  const detail = `simulación del plan (sin servidor): a las ${config.at}, sin enviar mensajes`;
  localRuns.unshift({ recipeId: id, status: 'simulated', detail, at: new Date().toISOString() });
  localRuns = localRuns.slice(0, 40);
  writeStorage(RUNS_KEY, localRuns);
  setBusy(button, false);
  const note = document.querySelector(`[data-recipe-note="${id}"]`);
  if (note) note.innerHTML = `<span class="hint">${esc(detail)}</span>`;
  toast('Simulación local: no se envió nada', 'ok');
  renderRunsFallback();
}

function renderRunsFallback() {
  const container = $('#runsList');
  if (!container) return;
  container.innerHTML = localRuns.length
    ? localRuns.slice(0, 20).map((run) => `<div class="system-row">
        <div><b>${esc(FALLBACK_RECIPES.find((item) => item.id === run.recipeId)?.name || run.recipeId)}</b><small>${esc(run.detail)} · ${esc(fmtDateTime(run.at))}</small></div>
        <span class="tag warn">simulación</span>
      </div>`).join('')
    : '<p class="muted small">Sin ejecuciones locales.</p>';
  const meta = $('#runsMeta');
  if (meta) meta.textContent = `${localRuns.length} en esta sesión`;
}

function renderSignalsFallback() {
  const container = $('#signalsList');
  if (!container) return;
  const endpoint = endpointState.get('signals');
  container.innerHTML = `<div class="unavailable">
    <b>Señales no disponibles todavía</b>
    <span>${esc(endpoint?.missing ? 'El servidor no expone /api/signals (módulo de señales pendiente).' : `No pude leer las señales: ${endpoint?.error || 'error'}`)}. Cuando el módulo arranque verás aquí las señales y su historial sin cambiar nada en la interfaz.</span>
    <div class="actions"><button type="button" class="secondary small" data-wf-retry>Reintentar</button></div>
  </div>`;
  const meta = $('#signalsMeta');
  if (meta) meta.textContent = 'no disponible';
}

function renderRulesFallback() {
  const container = $('#signalRules');
  if (!container) return;
  container.innerHTML = '<p class="muted small">Las reglas de señales aparecerán cuando el módulo esté montado.</p>';
  const meta = $('#rulesMeta');
  if (meta) meta.textContent = 'no disponible';
}

/* ------------------------------ banner de estado ------------------------------ */
function renderAutomationStatus() {
  const banner = $('#automationBanner');
  if (!banner) return;
  const scheduler = state.workflowStatus?.scheduler;
  const endpoint = endpointState.get('workflows');
  if (!workflowsAvailable()) {
    banner.innerHTML = `<div class="banner warn">
      <span>${esc(endpoint?.missing ? 'El módulo de workflows aún no está montado en este servidor.' : `No pude leer los workflows: ${endpoint?.error || 'error'}`)} Puedes preparar recetas como borrador local; se aplicarán cuando el módulo exista.</span>
      <div class="actions"><button type="button" class="secondary small" data-wf-retry>Comprobar de nuevo</button></div>
    </div>`;
    return;
  }
  if (!scheduler) {
    banner.innerHTML = '<div class="banner"><span>Workflows cargados. No pude leer el estado del planificador.</span></div>';
    return;
  }
  banner.innerHTML = `<div class="banner ${scheduler.lastError ? 'warn' : ''}">
    <span>Planificador ${scheduler.started ? 'activo' : 'detenido'} · tick ${Math.round((Number(scheduler.tickMs) || 0) / 1000)} s · ${scheduler.activeWorkflows ?? '—'}/${scheduler.workflows ?? '—'} workflows activos · ${state.workflowStatus?.signals?.activeRules ?? '—'} reglas de señales · ${state.workflowStatus?.signals?.unread ?? 0} señales sin leer${scheduler.lastError ? ` · último error: ${esc(scheduler.lastError)}` : ''}.</span>
    <div class="actions"><button type="button" class="secondary small" data-wf-refresh>Actualizar estado</button></div>
  </div>`;
}

/* ------------------------------ render principal ------------------------------ */
export function renderWorkflows() {
  renderAutomationStatus();
  if (workflowsAvailable()) renderWorkflowCards();
  else renderFallbackRecipes();
  if (Array.isArray(state.workflowRuns)) renderRuns();
  else renderRunsFallback();
  if (signalsAvailable()) {
    renderSignals();
    if (rulesAvailable()) renderSignalRules();
    else renderRulesFallback();
  } else {
    renderSignalsFallback();
    renderRulesFallback();
  }
}

/* ------------------------------ eventos ------------------------------ */
export function initWorkflows() {
  if (initialized) return;
  initialized = true;
  localRecipes = readStorage(RECIPE_KEY, {});
  localRuns = Array.isArray(readStorage(RUNS_KEY, [])) ? readStorage(RUNS_KEY, []) : [];
  state.ui.signalFilter = state.ui.signalFilter || 'all';

  $('#recipesList')?.addEventListener('click', async (event) => {
    const save = event.target.closest('[data-wf-save]');
    if (save) { await saveWorkflow(save.dataset.wfSave, save); return; }
    const run = event.target.closest('[data-wf-run]');
    if (run) { await dryRunWorkflow(run.dataset.wfRun, run); return; }
    const json = event.target.closest('[data-wf-json]');
    if (json) {
      const id = json.dataset.wfJson;
      const box = document.querySelector(`[data-wf-json-box="${id}"]`);
      const workflow = serverWorkflows().find((item) => item.id === id);
      if (!box || !workflow) return;
      const open = !box.classList.contains('hidden');
      if (open) { box.classList.add('hidden'); json.setAttribute('aria-expanded', 'false'); return; }
      box.textContent = JSON.stringify(workflow, null, 2);
      box.classList.remove('hidden');
      json.setAttribute('aria-expanded', 'true');
      return;
    }
    const day = event.target.closest('[data-wf-day]');
    if (day) {
      day.classList.toggle('active');
      day.setAttribute('aria-pressed', String(day.classList.contains('active')));
      return;
    }
    const channel = event.target.closest('[data-wf-channel]');
    if (channel) {
      channel.classList.toggle('active');
      channel.setAttribute('aria-pressed', String(channel.classList.contains('active')));
      return;
    }
    const saveLocal = event.target.closest('[data-recipe-save]');
    if (saveLocal) { saveLocalRecipe(saveLocal.dataset.recipeSave); return; }
    const runLocal = event.target.closest('[data-recipe-run]');
    if (runLocal) { runLocalRecipe(runLocal.dataset.recipeRun, runLocal); return; }
    if (event.target.closest('[data-wf-retry]')) {
      await probeOptionalModules();
      await refreshAll();
      renderWorkflows();
      toast('Estado del módulo actualizado');
    }
  });

  $('#recipesList')?.addEventListener('change', (event) => {
    const active = event.target.closest('[data-wf-active]');
    if (active) { toggleWorkflow(active.dataset.wfActive, active.checked, active); return; }
    const type = event.target.closest('[data-wf-trigger="type"]');
    if (type) { applyTriggerVisibility(type.closest('[data-workflow-id]')?.parentElement || document); return; }
    const toggle = event.target.closest('[data-recipe-toggle]');
    if (toggle) {
      const id = toggle.dataset.recipeToggle;
      localRecipes[id] = { ...(localRecipes[id] || {}), enabled: toggle.checked, pendingServer: true };
      writeStorage(RECIPE_KEY, localRecipes);
      toast(toggle.checked ? 'Receta activada como borrador local' : 'Receta desactivada', 'warn');
    }
  });

  $('#signalsList')?.addEventListener('click', (event) => {
    const read = event.target.closest('[data-signal-read]');
    if (read) { signalAction(read.dataset.signalRead, 'read'); return; }
    const dismiss = event.target.closest('[data-signal-dismiss]');
    if (dismiss) signalAction(dismiss.dataset.signalDismiss, 'dismiss');
  });

  $('#signalRules')?.addEventListener('click', async (event) => {
    const save = event.target.closest('[data-rule-save]');
    if (save) await saveRule(save.dataset.ruleSave, save);
  });

  $('#signalRules')?.addEventListener('change', async (event) => {
    const toggle = event.target.closest('[data-rule-enabled]');
    if (!toggle) return;
    const card = toggle.closest('[data-rule-id]');
    if (card) await saveRule(card.dataset.ruleId, toggle);
  });

  $('#signalFilters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-signal-filter]');
    if (!chip) return;
    state.ui.signalFilter = chip.dataset.signalFilter || 'all';
    $$('[data-signal-filter]').forEach((other) => {
      const active = other === chip;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    if (signalsAvailable()) renderSignals();
  });

  $('#signalEvaluate')?.addEventListener('click', (event) => evaluateSignals(event.currentTarget));
  $('#signalTest')?.addEventListener('click', (event) => createTestSignal(event.currentTarget));

  $('#wfRefresh')?.addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, 'Actualizando');
    await probeOptionalModules();
    await refreshAll();
    setBusy(event.currentTarget, false);
    renderWorkflows();
    toast('Automatizaciones actualizadas');
  });

  $('#automationBanner')?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-wf-refresh]')) {
      await probeOptionalModules();
      await refreshAll();
      renderWorkflows();
      toast('Estado del planificador actualizado');
    }
  });
}

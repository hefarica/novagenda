/**
 * Sistema P95: índice de 7 componentes con pesos y metas editables, métricas
 * diarias del modelo Excel, reportes, inbox universal y OKR.
 */
import { api } from './api.js';
import { state } from './state.js';
import { loadMetrics, refreshAll } from './data.js';
import {
  $, $$, esc, setBusy, toast, todayKey
} from './core.js';

const WEIGHT_KEYS = [
  ['agendaExecution', 'Ejecución de agenda'],
  ['deepFocus', 'Foco profundo'],
  ['overdue', 'Pendientes vencidos'],
  ['meetingEffectiveness', 'Efectividad de reuniones'],
  ['okrProgress', 'Progreso de OKR'],
  ['weeklyExecution', 'Ejecución semanal'],
  ['weeklyReview', 'Revisión semanal']
];
const TARGET_FIELDS = [
  ['agendaExecution', 'Meta de ejecución (0–1)', 0, 1, 0.01],
  ['deepFocusDailyMin', 'Minutos de foco al día', 0, 720, 5],
  ['overdueOpen', 'Vencidos tolerados', 0, 100, 1],
  ['meetingEffectiveness', 'Efectividad de reuniones (1–5)', 1, 5, 0.1],
  ['okrProgress', 'Progreso de OKR (0–1)', 0, 1, 0.01],
  ['weeklyExecution', 'Ejecución semanal (0–1)', 0, 1, 0.01],
  ['weeklyReview', 'Revisión semanal (0/1)', 0, 1, 1]
];

let initialized = false;
let metricsLoading = false;

function components() {
  return state.p95?.components || state.dashboard?.p95Components || [];
}

function p95Table() {
  const rows = components();
  if (!rows.length) {
    return `<div class="unavailable"><b>El motor P95 no responde</b><span>El índice y sus componentes se calculan en el servidor (/api/p95). Mientras tanto, la app sigue funcionando con el asistente determinista.</span><div class="actions"><button type="button" class="secondary small" data-system-retry>Reintentar</button></div></div>`;
  }
  const sum = Number(state.p95?.weightsSum ?? Object.values(state.p95?.weights || {}).reduce((total, weight) => total + Number(weight || 0), 0));
  const label = $('#p95SumLabel');
  if (label) label.textContent = `Índice ${Number(state.p95?.index ?? 0).toFixed(1)}/100 · suma de pesos ${sum.toFixed(2)}`;
  return `<table class="p95-table">
    <thead><tr><th>Componente</th><th class="num">Real</th><th class="num">Meta</th><th class="num">Peso</th><th class="num">Puntos</th></tr></thead>
    <tbody>${rows.map((component) => `<tr class="${component.met ? 'met' : 'miss'}">
      <td>${esc(component.label)}</td>
      <td class="num">${esc(formatRaw(component))}</td>
      <td class="num">${esc(formatTarget(component))}</td>
      <td class="num">${(Number(component.weight) || 0).toFixed(2)}</td>
      <td class="num">${(Number(component.points) || 0).toFixed(2)}</td>
    </tr>`).join('')}</tbody>
  </table>
  <p class="hint">Fórmula del modelo Excel: ROUND(SUM(MIN(1, real/meta) × peso) × 100, 1). Los pesos deben sumar entre 0.90 y 1.10.</p>`;
}

function formatRaw(component) {
  const value = Number(component.raw);
  if (!Number.isFinite(value)) return '—';
  if (component.unit === 'min') return `${Math.round(value)} min`;
  if (component.unit === 'ratio') return `${Math.round(value * 100)}%`;
  return String(Number.isInteger(value) ? value : value.toFixed(2));
}

function formatTarget(component) {
  const value = Number(component.target);
  if (!Number.isFinite(value)) return '—';
  if (component.unit === 'min') return `${Math.round(value)} min`;
  if (component.unit === 'ratio') return `${Math.round(value * 100)}%`;
  return String(Number.isInteger(value) ? value : value.toFixed(2));
}

function renderP95Form() {
  const form = $('#p95Form');
  if (!form) return;
  const settings = state.settings?.p95 || {};
  const weights = state.p95?.weights || settings.weights || {};
  const targets = state.p95?.targets || {};
  form.innerHTML = `
    <fieldset class="field-group">
      <legend>Pesos (suma 0.90 – 1.10)</legend>
      <div class="two">
        ${WEIGHT_KEYS.map(([key, label]) => `<label class="field"><span>${esc(label)}</span>
          <input type="number" name="weight_${key}" min="0" max="1" step="0.01" value="${Number(weights[key] ?? 0.14).toFixed(2)}" />
        </label>`).join('')}
      </div>
      <p class="hint" id="weightsSum">Suma actual: —</p>
    </fieldset>
    <fieldset class="field-group">
      <legend>Metas por componente</legend>
      <div class="two">
        ${TARGET_FIELDS.map(([key, label, min, max, step]) => `<label class="field"><span>${esc(label)}</span>
          <input type="number" name="target_${key}" min="${min}" max="${max}" step="${step}" value="${Number(settings[key] ?? targets[key] ?? 0)}" />
        </label>`).join('')}
      </div>
    </fieldset>
    <div class="chips">
      <button type="submit" class="primary small">Guardar pesos y metas</button>
      <button type="button" class="ghost small" data-system-retry>Recalcular</button>
    </div>
    <p class="hint" id="p95FormStatus" role="status"></p>`;
  updateWeightsSum();
  form.addEventListener('input', updateWeightsSum);
}

function updateWeightsSum() {
  const form = $('#p95Form');
  const label = $('#weightsSum');
  if (!form || !label) return;
  let sum = 0;
  for (const [key] of WEIGHT_KEYS) sum += Number(form.elements[`weight_${key}`]?.value || 0);
  const ok = sum >= 0.9 && sum <= 1.1;
  label.textContent = `Suma actual: ${sum.toFixed(2)} ${ok ? '✓' : '— debe quedar entre 0.90 y 1.10'}`;
  label.className = ok ? 'hint' : 'alert';
}

function renderMetricsForm() {
  const form = $('#metricsForm');
  if (!form) return;
  form.innerHTML = `
    <label class="field"><span>Fecha</span><input name="date" type="date" value="${todayKey()}" /></label>
    <div class="two">
      <label class="field"><span>Energía AM</span>
        <select name="energyAM">${['Alta', 'Media', 'Baja'].map((value) => `<option>${value}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Energía PM</span>
        <select name="energyPM">${['Alta', 'Media', 'Baja'].map((value) => `<option selected>Media</option><option>Alta</option><option>Baja</option>`).join('')}</select>
      </label>
    </div>
    <div class="two">
      <label class="field"><span>Interrupciones</span><input name="interruptions" type="number" min="0" max="999" step="1" value="0" /></label>
      <label class="field"><span>Mejora 1% (1–10)</span><input name="improvement" type="number" min="0" max="10" step="1" value="5" /></label>
    </div>
    <div class="chips">
      <label class="check small"><input type="checkbox" name="planDaily" /><span>Hice el plan diario</span></label>
      <label class="check small"><input type="checkbox" name="closeDaily" /><span>Hice el cierre</span></label>
      <label class="check small"><input type="checkbox" name="weeklyReview" /><span>Revisión semanal</span></label>
    </div>
    <label class="field"><span>Comentarios</span><textarea name="comments" rows="2" maxlength="1000" placeholder="Qué funcionó y qué no"></textarea></label>
    <button type="submit" class="primary small">Guardar métricas de hoy</button>
    <p class="hint" id="metricsStatus" role="status"></p>`;
}

function metricsTable() {
  const data = state.metrics;
  if (!data) {
    return metricsLoading
      ? '<div class="loading"><span class="spin" aria-hidden="true"></span> Cargando métricas…</div>'
      : '<p class="muted small">Sin métricas cargadas.</p>';
  }
  const rows = Array.isArray(data.items) ? data.items.slice(-10).reverse() : [];
  if (!rows.length) return '<p class="muted small">Aún no hay métricas registradas. Guarda la primera arriba.</p>';
  const totals = data.totals || {};
  return `<div class="chips" style="margin:10px 0">
      <span class="tag">P95 ${Number(data.p95 || 0).toFixed(1)}</span>
      <span class="tag">Foco real ${Math.round(Number(totals.focusRealMin || 0))} min</span>
      <span class="tag">Interrupciones ${Number(totals.interruptions || 0)}</span>
      <span class="tag">Plan ${Number(totals.planDays || 0)} días</span>
    </div>
    <table class="p95-table">
      <thead><tr><th>Fecha</th><th class="num">Foco real</th><th class="num">Interr.</th><th>Plan</th><th>Cierre</th><th>Energía</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${esc(row.date)}</td>
        <td class="num">${Math.round(Number(row.focusRealMin || 0))} min</td>
        <td class="num">${Number(row.interruptions || 0)}</td>
        <td>${row.planDaily ? '✓' : '—'}</td>
        <td>${row.closeDaily ? '✓' : '—'}</td>
        <td>${esc(row.energyAM || '')}/${esc(row.energyPM || '')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

function inboxList() {
  const items = state.inbox.slice().sort((a, b) => new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0));
  const count = items.filter((item) => !item.processed && !item.dismissed).length;
  const badge = $('#inboxCount');
  if (badge) badge.textContent = `${count} abierta(s)`;
  if (!items.length) return '<p class="muted small">Inbox vacío.</p>';
  return items.slice(0, 12).map((item) => `<div class="system-row ${item.processed ? 'done' : ''}">
    <div><b>${esc(item.input)}</b><small>${esc(item.source || 'Captura')} · ${esc(item.priority || 'P2')}${item.agendaId ? ` · ${esc(item.agendaId)}` : ''}</small></div>
    <div class="chips">
      ${item.processed ? '<span class="tag ok">procesada</span>' : `
        <button type="button" data-inbox-convert="${esc(item.id)}">Convertir</button>
        <button type="button" data-inbox-process="${esc(item.id)}">Procesar</button>
        <button type="button" data-inbox-dismiss="${esc(item.id)}">Descartar</button>`}
    </div>
  </div>`).join('');
}

function okrGrid() {
  if (!state.okrs.length) return '<p class="muted small">Sin OKR definidos.</p>';
  return state.okrs.map((okr) => `<div class="okr-card">
    <div class="card-head"><h4>${esc(okr.id)} · ${esc(okr.objective)}</h4>${`<span class="badge ${okr.priority || 'P2'}">${esc(okr.priority || 'P2')}</span>`}</div>
    <p class="muted small">${esc(okr.keyResult)}</p>
    <div class="progress"><i style="width:${Math.min(100, Math.round((Number(okr.progress) || 0) * 100))}%"></i></div>
    <div class="metric-line"><span>Progreso ${Math.round((Number(okr.progress) || 0) * 100)}%</span><span>Confianza ${esc(okr.confidence || '—')}/5</span></div>
    <p class="hint">Próxima acción: ${esc(okr.nextAction || '—')}</p>
  </div>`).join('');
}

export function renderSystem() {
  const table = $('#p95Table');
  if (table) table.innerHTML = p95Table();
  renderP95Form();
  renderMetricsForm();
  const metrics = $('#metricsTable');
  if (metrics) metrics.innerHTML = metricsTable();
  const inbox = $('#inboxList');
  if (inbox) inbox.innerHTML = inboxList();
  const okr = $('#okrGrid');
  if (okr) okr.innerHTML = okrGrid();
  if (!state.metrics && !metricsLoading) {
    metricsLoading = true;
    loadMetrics().then(() => { metricsLoading = false; const box = $('#metricsTable'); if (box) box.innerHTML = metricsTable(); });
  }
}

async function saveP95() {
  const form = $('#p95Form');
  const status = $('#p95FormStatus');
  const weights = {};
  let sum = 0;
  for (const [key] of WEIGHT_KEYS) {
    const value = Number(form.elements[`weight_${key}`].value);
    weights[key] = value;
    sum += value;
  }
  if (sum < 0.9 || sum > 1.1) {
    if (status) { status.textContent = `La suma de pesos es ${sum.toFixed(2)}: debe quedar entre 0.90 y 1.10.`; status.className = 'alert'; }
    return;
  }
  const p95 = { weights };
  for (const [key, , min, max] of TARGET_FIELDS) {
    const value = Number(form.elements[`target_${key}`].value);
    if (!Number.isFinite(value) || value < min || value > max) {
      if (status) { status.textContent = `Valor fuera de rango en ${key} (${min}–${max}).`; status.className = 'alert'; }
      return;
    }
    p95[key] = value;
  }
  if (status) { status.textContent = 'Guardando…'; status.className = 'hint'; }
  try {
    await api.post('/api/settings', { p95 });
    if (status) { status.textContent = 'Guardado. Índice recalculado.'; status.className = 'hint'; }
    toast('Pesos y metas guardados', 'ok');
    await refreshAll();
  } catch (error) {
    if (status) { status.textContent = error?.message || 'No se pudo guardar'; status.className = 'alert'; }
    toast(error?.message || 'No se pudieron guardar los pesos', 'err');
  }
}

async function saveMetrics() {
  const form = $('#metricsForm');
  const status = $('#metricsStatus');
  const body = {
    date: form.elements.date.value || todayKey(),
    energyAM: form.elements.energyAM.value,
    energyPM: form.elements.energyPM.value,
    interruptions: Number(form.elements.interruptions.value || 0),
    improvement: Number(form.elements.improvement.value || 0),
    comments: form.elements.comments.value.trim(),
    planDaily: form.elements.planDaily.checked,
    closeDaily: form.elements.closeDaily.checked,
    weeklyReview: form.elements.weeklyReview.checked
  };
  if (status) status.textContent = 'Guardando…';
  try {
    await api.post('/api/metrics', body);
    if (status) status.textContent = 'Métricas guardadas.';
    toast('Métricas del día guardadas', 'ok');
    await refreshAll();
    await loadMetrics();
    const box = $('#metricsTable');
    if (box) box.innerHTML = metricsTable();
  } catch (error) {
    if (status) status.textContent = error?.message || 'No se pudieron guardar';
    toast(error?.message || 'No se pudieron guardar las métricas', 'err');
  }
}

async function loadReport(kind, button) {
  setBusy(button, true, 'Generando');
  try {
    const data = await api.get(`/api/report/${kind}`);
    const box = $('#reportsBox');
    if (box) box.textContent = `${data.text || '(sin texto)'}${data.monthly ? `\n\n${data.monthly}` : ''}`;
  } catch (error) {
    toast(error?.message || 'No se pudo generar el reporte', 'err');
  } finally {
    setBusy(button, false);
  }
}

async function inboxAction(action, id) {
  const item = state.inbox.find((entry) => entry.id === id);
  try {
    if (action === 'process') {
      await api.patch(`/api/inbox/${id}`, { processed: !item?.processed });
    } else if (action === 'dismiss') {
      await api.post(`/api/inbox/${id}/dismiss`, {});
      toast('Captura descartada', 'ok');
    } else if (action === 'convert') {
      const result = await api.post(`/api/inbox/${id}/convert`, {}, { timeoutMs: 30000 });
      toast(`Creada ${result?.event?.id || 'cita'} desde el inbox`, 'ok');
    }
    await refreshAll();
  } catch (error) {
    if (error?.code === 'NO_SLOT') toast('No hay huecos libres: crea la cita manualmente.', 'err');
    else if (error?.code === 'ALREADY_PROCESSED') toast('Esa captura ya fue convertida.', 'warn');
    else if (error?.code === 'CONFLICT') toast('Ese horario choca con otro compromiso.', 'err');
    else toast(error?.message || 'No se pudo procesar la captura', 'err');
  }
}

export function initSystem() {
  if (initialized) return;
  initialized = true;

  $('#p95Form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveP95();
  });
  $('#metricsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveMetrics();
  });
  $$('[data-report]').forEach((button) => button.addEventListener('click', () => loadReport(button.dataset.report, button)));
  $('#inboxList')?.addEventListener('click', (event) => {
    const convert = event.target.closest('[data-inbox-convert]');
    if (convert) { inboxAction('convert', convert.dataset.inboxConvert); return; }
    const process = event.target.closest('[data-inbox-process]');
    if (process) { inboxAction('process', process.dataset.inboxProcess); return; }
    const dismiss = event.target.closest('[data-inbox-dismiss]');
    if (dismiss) inboxAction('dismiss', dismiss.dataset.inboxDismiss);
  });
  $('#systemRefresh')?.addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, 'Actualizando');
    await refreshAll();
    await loadMetrics();
    setBusy(event.currentTarget, false);
    renderSystem();
    toast('Sistema P95 actualizado');
  });
  document.addEventListener('click', async (event) => {
    const retry = event.target.closest('[data-system-retry]');
    if (!retry) return;
    await refreshAll();
    renderSystem();
    toast('Recalculado');
  });
}

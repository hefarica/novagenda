/**
 * Objetivos y resultados clave (OKR): crear, medir avance, pausar/completar y borrar.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, emptyState, promptDialog } from './core.js';

let initialized = false;
let state = { items: [], stats: null };

export function initOkr() {
  if (initialized) return;
  initialized = true;
  $('#okrForm')?.addEventListener('submit', createObjective);
  $('#okrKrForm')?.addEventListener('submit', createKeyResult);
  $('#okrRefresh')?.addEventListener('click', () => refresh());
  $('#okrPrintBtn')?.addEventListener('click', printOkr);
  $('#okrExportCsv')?.addEventListener('click', () => {
    const anchor = document.createElement('a');
    anchor.href = '/api/okr/export.csv';
    anchor.download = 'objetivos.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    toast('CSV de objetivos descargado', 'ok');
  });
  window.addEventListener('beforeprint', updateOkrPrintStamp);
  $('#okrList')?.addEventListener('click', onAction);
}

export function renderOkr() {
  if (!initialized) initOkr();
  refresh().catch(() => {});
}

async function refresh() {
  const [objectives, stats] = await Promise.all([
    api.get('/api/okr/objectives'),
    api.get('/api/okr/stats')
  ]);
  state.items = Array.isArray(objectives?.items) ? objectives.items : [];
  state.stats = stats || null;
  renderStats();
  renderSelect();
  renderList();
}

function renderStats() {
  const box = $('#okrStats');
  const summary = $('#okrSummary');
  const stats = state.stats;
  if (box && stats) {
    box.textContent = `${stats.total || 0} objetivo(s) · ${stats.active || 0} activo(s) · avance ${stats.averageProgress || 0}%`;
  }
  if (summary) {
    summary.className = 'muted small';
    const risk = stats?.atRisk || [];
    summary.textContent = risk.length
      ? `En riesgo (<40 %): ${risk.map((item) => `${item.title} (${item.progress}%)`).join(' · ')}`
      : 'Ningún objetivo activo por debajo del 40 %.';
  }
}

function renderSelect() {
  const select = $('#okrObjectiveSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">—</option>'
    + state.items.map((item) => `<option value="${esc(item.id)}">${esc(item.id)} · ${esc(item.title)}</option>`).join('');
  if (current && state.items.some((item) => item.id === current)) select.value = current;
}

function renderList() {
  const box = $('#okrList');
  if (!box) return;
  if (!state.items.length) {
    box.innerHTML = emptyState('Aún no hay objetivos. Crea el primero con el formulario.', '◎');
    return;
  }
  box.innerHTML = state.items.map((objective) => {
    const progress = Number(objective.progress) || 0;
    const statusTag = objective.status === 'done' ? 'ok' : objective.status === 'paused' ? 'warn' : '';
    return `
      <article class="card glass">
        <div class="okr-card-head">
          <div>
            <h3>${esc(objective.title)}</h3>
            <small class="muted">${esc(objective.id)}${objective.owner ? ` · ${esc(objective.owner)}` : ''}${objective.quarter ? ` · ${esc(objective.quarter)}` : ''} · ${esc(objective.status)}</small>
          </div>
          <span class="tag ${statusTag}">${progress}%</span>
        </div>
        <div class="okr-bar"><div class="okr-fill ${progress < 40 ? 'low' : ''}" style="width:${Math.max(0, Math.min(100, progress))}%"></div></div>
        <div class="okr-krs">
          ${(objective.keyResults || []).length ? objective.keyResults.map((kr) => `
            <div class="okr-kr">
              <div>
                <b>${esc(kr.title)}</b>
                <small>${kr.current} / ${kr.target} ${esc(kr.unit || '')} · ${kr.progress}%</small>
              </div>
              <div class="okr-kr-actions">
                <input type="number" min="0" step="any" value="${kr.current}" data-okr-current="${esc(kr.id)}" data-okr-objective="${esc(objective.id)}" aria-label="Avance de ${esc(kr.title)}" />
                <button type="button" class="secondary small" data-okr-action="save-kr" data-okr-objective="${esc(objective.id)}" data-okr-kr="${esc(kr.id)}">Guardar</button>
                <button type="button" class="ghost small" data-okr-action="edit-kr" data-okr-objective="${esc(objective.id)}" data-okr-kr="${esc(kr.id)}">Editar</button>
                <button type="button" class="ghost small" data-okr-action="delete-kr" data-okr-objective="${esc(objective.id)}" data-okr-kr="${esc(kr.id)}">Borrar</button>
              </div>
            </div>`).join('') : '<p class="muted small">Sin resultados clave todavía.</p>'}
        </div>
        <div class="okr-card-actions">
          ${objective.status === 'done'
            ? `<button type="button" class="secondary small" data-okr-action="status" data-okr-objective="${esc(objective.id)}" data-okr-status="active">Reactivar</button>`
            : `<button type="button" class="secondary small" data-okr-action="status" data-okr-objective="${esc(objective.id)}" data-okr-status="done">Completar</button>`}
          ${objective.status === 'active'
            ? `<button type="button" class="ghost small" data-okr-action="status" data-okr-objective="${esc(objective.id)}" data-okr-status="paused">Pausar</button>`
            : objective.status === 'paused'
              ? `<button type="button" class="ghost small" data-okr-action="status" data-okr-objective="${esc(objective.id)}" data-okr-status="active">Reactivar</button>`
              : ''}
          <button type="button" class="ghost small" data-okr-action="edit-objective" data-okr-objective="${esc(objective.id)}">Editar</button>
          <button type="button" class="ghost small" data-okr-action="delete-objective" data-okr-objective="${esc(objective.id)}">Borrar objetivo</button>
        </div>
      </article>`;
  }).join('');
}

async function createObjective(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#okrCreate');
  const title = String(form.elements.title.value || '').trim();
  const owner = String(form.elements.owner.value || '').trim();
  const quarter = String(form.elements.quarter.value || '').trim();
  if (!title) { toast('El objetivo es obligatorio', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post('/api/okr/objectives', { title, ...(owner ? { owner } : {}), ...(quarter ? { quarter } : {}) });
    form.elements.title.value = '';
    form.elements.owner.value = '';
    form.elements.quarter.value = '';
    toast(`Objetivo ${result?.item?.id || ''} creado`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function createKeyResult(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#okrKrCreate');
  const objectiveId = String(form.elements.objective.value || '');
  const title = String(form.elements.title.value || '').trim();
  const target = Number(form.elements.target.value);
  const current = Number(form.elements.current.value);
  const unit = String(form.elements.unit.value || '').trim();
  if (!objectiveId) { toast('Elige un objetivo', 'err'); return; }
  if (!title) { toast('El resultado es obligatorio', 'err'); return; }
  setBusy(button, true);
  try {
    await api.post(`/api/okr/objectives/${encodeURIComponent(objectiveId)}/key-results`, {
      title, target, current, ...(unit ? { unit } : {})
    });
    form.elements.title.value = '';
    form.elements.current.value = '0';
    toast('Resultado añadido', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function onAction(event) {
  const button = event.target.closest('[data-okr-action]');
  if (!button) return;
  const action = button.dataset.okrAction;
  const objectiveId = button.dataset.okrObjective;
  if (action === 'edit-objective') {
    const objective = state.items.find((item) => item.id === objectiveId);
    if (!objective) return;
    const title = await promptDialog({
      title: 'Editar objetivo',
      text: 'Cambia el título. El avance y los resultados clave se conservan.',
      label: 'Título del objetivo',
      value: objective.title || ''
    });
    if (title === null) return;
    const clean = String(title || '').trim();
    if (clean.length < 3) { toast('El título necesita al menos 3 caracteres', 'err'); return; }
    setBusy(button, true);
    try {
      await api.patch(`/api/okr/objectives/${encodeURIComponent(objectiveId)}`, { title: clean });
      toast('Objetivo actualizado', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    } finally {
      setBusy(button, false);
    }
    return;
  }
  if (action === 'edit-kr') {
    const objective = state.items.find((item) => item.id === objectiveId);
    const kr = (objective?.keyResults || []).find((item) => item.id === button.dataset.okrKr);
    if (!objective || !kr) return;
    const title = await promptDialog({
      title: 'Editar resultado clave',
      text: 'Cambia el nombre del resultado. El avance actual se conserva.',
      label: 'Resultado clave',
      value: kr.title || ''
    });
    if (title === null) return;
    const clean = String(title || '').trim();
    if (clean.length < 3) { toast('El título necesita al menos 3 caracteres', 'err'); return; }
    const target = await promptDialog({
      title: 'Meta del resultado',
      text: `Meta actual: ${kr.target} ${kr.unit || ''}. Debe ser mayor que cero.`,
      label: 'Nueva meta',
      value: String(kr.target ?? ''),
      type: 'number',
      min: 0.01,
      step: 'any'
    });
    if (target === null) return;
    const targetValue = Number(target);
    if (!Number.isFinite(targetValue) || targetValue <= 0) { toast('Meta inválida', 'err'); return; }
    setBusy(button, true);
    try {
      await api.patch(`/api/okr/objectives/${encodeURIComponent(objectiveId)}/key-results/${encodeURIComponent(kr.id)}`, { title: clean, target: targetValue });
      toast('Resultado actualizado', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    } finally {
      setBusy(button, false);
    }
    return;
  }
  if (action === 'save-kr') {
    const input = button.closest('.okr-kr')?.querySelector('[data-okr-current]');
    const current = Number(input?.value);
    if (!Number.isFinite(current) || current < 0) { toast('Avance inválido', 'err'); return; }
    setBusy(button, true);
    try {
      await api.patch(`/api/okr/objectives/${encodeURIComponent(objectiveId)}/key-results/${encodeURIComponent(button.dataset.okrKr)}`, { current });
      toast('Avance actualizado', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    } finally {
      setBusy(button, false);
    }
    return;
  }
  if (action === 'delete-kr') {
    const ok = await confirmDialog({ title: 'Borrar resultado', text: 'Se elimina este resultado clave. No se puede deshacer.', okLabel: 'Borrar', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/okr/objectives/${encodeURIComponent(objectiveId)}/key-results/${encodeURIComponent(button.dataset.okrKr)}`);
      toast('Resultado borrado', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    }
    return;
  }
  if (action === 'status') {
    try {
      await api.patch(`/api/okr/objectives/${encodeURIComponent(objectiveId)}`, { status: button.dataset.okrStatus });
      toast(`Objetivo ${button.dataset.okrStatus === 'done' ? 'completado' : button.dataset.okrStatus === 'paused' ? 'pausado' : 'activo'}`, 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    }
    return;
  }
  if (action === 'delete-objective') {
    const ok = await confirmDialog({ title: 'Borrar objetivo', text: 'Se eliminan el objetivo y sus resultados. No se puede deshacer.', okLabel: 'Borrar', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/okr/objectives/${encodeURIComponent(objectiveId)}`);
      toast('Objetivo borrado', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    }
  }
}


function updateOkrPrintStamp() {
  const stamp = $('#okrPrintStamp');
  if (!stamp) return;
  const stats = state.stats || {};
  const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  stamp.textContent = `Héctor Fabio Riascos C. · ${stats.total || 0} objetivo(s) · ${stats.active || 0} activo(s) · avance ${stats.averageProgress || 0}% · ${date}`;
}

function printOkr() {
  updateOkrPrintStamp();
  window.print();
}

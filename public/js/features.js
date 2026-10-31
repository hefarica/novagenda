/**
 * Laboratorio de funciones: activa cada plugin en off / shadow / on y permite
 * pausarlo con el kill switch. Consume la API /api/features (sin lógica propia
 * de política). Cada cambio lo audita el backend en el ledger.
 */
import { api } from './api.js';
import { $, esc, toast } from './core.js';

const MODES = ['off', 'shadow', 'on'];
const LABEL = { off: 'Apagada', shadow: 'Sombra', on: 'Activa' };
const TAG = { off: 'off', shadow: 'warn', on: 'ok' };

let items = [];

function row(item) {
  const paused = item.paused === true;
  return `<div class="feature-row" data-id="${esc(item.id)}">
    <div class="feature-meta">
      <b>${esc(item.name || item.id)}</b>
      <small>${esc(item.id)} · ${esc(item.description || '')}</small>
    </div>
    <span class="tag ${TAG[item.status] || 'off'}">${paused ? 'Pausada' : (LABEL[item.status] || item.status)}</span>
    <select data-feature-mode="${esc(item.id)}" aria-label="Modo de ${esc(item.name || item.id)}" ${paused ? 'disabled' : ''}>
      ${MODES.map((mode) => `<option value="${mode}" ${item.mode === mode ? 'selected' : ''}>${LABEL[mode]}</option>`).join('')}
    </select>
    <button type="button" class="${paused ? 'secondary' : 'ghost'} small" data-feature-pause="${esc(item.id)}" data-paused="${paused ? '1' : '0'}">
      ${paused ? 'Reanudar' : 'Pausar'}
    </button>
  </div>`;
}

function render(summary) {
  const body = $('#featuresBody');
  const state = $('#featuresState');
  if (!body) return;
  if (state) {
    const parts = [`${summary?.on ?? 0} activas`, `${summary?.shadow ?? 0} en sombra`, `${summary?.off ?? 0} apagadas`];
    if (summary?.paused) parts.push(`${summary.paused} pausadas`);
    if (summary?.globalPaused) parts.push('kill switch global');
    state.textContent = parts.join(' · ');
    state.className = `tag ${summary?.on || summary?.shadow ? 'warn' : 'off'}`;
  }
  body.innerHTML = items.length
    ? items.map(row).join('')
    : '<p class="hint">Sin funciones registradas.</p>';
}

async function load() {
  const data = await api.get('/api/features');
  items = Array.isArray(data.items) ? data.items : [];
  render(data.summary);
}

export async function renderFeaturesLab() {
  if (!$('#featuresBody')) return;
  try {
    await load();
  } catch (error) {
    const body = $('#featuresBody');
    if (body) body.innerHTML = `<p class="hint">No pude cargar el laboratorio: ${esc(error?.message || 'error')}</p>`;
  }
}

export function initFeaturesLab() {
  const body = $('#featuresBody');
  if (!body) return;

  body.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-feature-mode]');
    if (!select) return;
    const id = select.getAttribute('data-feature-mode');
    const mode = select.value;
    select.disabled = true;
    try {
      await api.post(`/api/features/${encodeURIComponent(id)}`, { mode });
      toast(`${id}: ${LABEL[mode]}`, 'ok');
      await load();
    } catch (error) {
      toast(error?.message || 'No se pudo cambiar la función', 'err');
      select.disabled = false;
    }
  });

  body.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-feature-pause]');
    if (!button) return;
    const id = button.getAttribute('data-feature-pause');
    const paused = button.getAttribute('data-paused') === '1';
    button.disabled = true;
    try {
      await api.post(`/api/features/${encodeURIComponent(id)}/${paused ? 'resume' : 'pause'}`);
      toast(paused ? `${id} reanudada` : `${id} pausada`, 'ok');
      await load();
    } catch (error) {
      toast(error?.message || 'No se pudo pausar', 'err');
      button.disabled = false;
    }
  });

  $('#featuresRefresh')?.addEventListener('click', () => renderFeaturesLab());
  $('#featuresPauseAll')?.addEventListener('click', async () => {
    try { await api.post('/api/features/pause-all'); toast('Todas pausadas', 'ok'); await load(); }
    catch (error) { toast(error?.message || 'No se pudo pausar', 'err'); }
  });
  $('#featuresResumeAll')?.addEventListener('click', async () => {
    try { await api.post('/api/features/resume-all'); toast('Todas reanudadas', 'ok'); await load(); }
    catch (error) { toast(error?.message || 'No se pudo reanudar', 'err'); }
  });
}

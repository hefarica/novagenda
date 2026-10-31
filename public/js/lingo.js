/**
 * Léxico (Lingo): términos canónicos, variantes, aprobación y prueba.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, emptyState } from './core.js';

const STATUS_META = {
  approved: { label: 'Aprobado', tag: 'ok' },
  shadow: { label: 'En sombra', tag: 'warn' },
  rejected: { label: 'Rechazado', tag: 'bad' }
};

let initialized = false;
let state = { items: [], stats: null, total: 0, query: '', status: 'all' };
let searchTimer = null;

export function initLingo() {
  if (initialized) return;
  initialized = true;

  $('#lingoForm')?.addEventListener('submit', createTerm);
  $('#lingoApplyForm')?.addEventListener('submit', applyTest);
  $('#lingoRefresh')?.addEventListener('click', () => refresh());
  $('#lingoStatus')?.addEventListener('change', (event) => {
    state.status = event.target.value || 'all';
    refresh();
  });
  $('#lingoSearch')?.addEventListener('input', (event) => {
    state.query = String(event.target.value || '').trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(), 250);
  });
  $('#lingoTerms')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-lingo-status]');
    if (!button) return;
    await setStatus(button.dataset.lingoId, button.dataset.lingoStatus, button);
  });
}

export function renderLingo() {
  if (!initialized) initLingo();
  refresh().catch(() => {});
}

async function refresh() {
  const params = new URLSearchParams({ limit: '200' });
  if (state.status && state.status !== 'all') params.set('status', state.status);
  if (state.query) params.set('q', state.query);
  const result = await api.get(`/api/lingo/terms?${params.toString()}`);
  state.items = Array.isArray(result?.items) ? result.items : [];
  state.stats = result?.stats || null;
  state.total = Number(result?.total) || state.items.length;
  renderStats();
  renderTerms();
}

function renderStats() {
  const stats = state.stats;
  const box = $('#lingoStats');
  if (box && stats) {
    box.textContent = `${stats.total || 0} término(s) · ${stats.counts?.approved || 0} aprobado(s) · ${stats.counts?.shadow || 0} en sombra`;
  }
}

function renderTerms() {
  const list = $('#lingoTerms');
  const count = $('#lingoCount');
  if (count) count.textContent = `${state.total} término(s)`;
  if (!list) return;
  if (!state.items.length) {
    list.innerHTML = emptyState(state.query || state.status !== 'all'
      ? 'No hay términos que coincidan con el filtro.'
      : 'Aún no hay términos. Añade el primero con el formulario.', '◇');
    return;
  }
  list.innerHTML = state.items.map((term) => {
    const meta = STATUS_META[term.status] || { label: term.status, tag: 'warn' };
    const variants = (term.variants || []).length
      ? `<small>Variantes: ${esc((term.variants || []).join(', '))}</small>`
      : '<small>Sin variantes</small>';
    const context = term.context ? ` · ${esc(term.context)}` : '';
    return `
      <div class="doc-row">
        <div class="doc-icon" aria-hidden="true">LG</div>
        <div>
          <b>${esc(term.term)}</b>
          <small>${esc(term.id)} · usos ${Number(term.uses) || 0} · correcciones ${Number(term.corrections) || 0}${context}</small>
          ${variants}
        </div>
        <div class="doc-actions">
          <span class="tag ${meta.tag}">${esc(meta.label)}</span>
          ${term.status !== 'approved' ? `<button type="button" data-lingo-status="approved" data-lingo-id="${esc(term.id)}">Aprobar</button>` : ''}
          ${term.status !== 'shadow' ? `<button type="button" data-lingo-status="shadow" data-lingo-id="${esc(term.id)}">Sombra</button>` : ''}
          ${term.status !== 'rejected' ? `<button type="button" data-lingo-status="rejected" data-lingo-id="${esc(term.id)}">Rechazar</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

async function createTerm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#lingoCreate');
  const term = String(form.elements.term.value || '').trim();
  const variants = String(form.elements.variants.value || '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const context = String(form.elements.context.value || '').trim();
  if (!term) { toast('La forma canónica es obligatoria', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post('/api/lingo/terms', { term, variants, ...(context ? { context } : {}) });
    form.elements.term.value = '';
    form.elements.variants.value = '';
    form.elements.context.value = '';
    toast(result?.created === false ? 'Término actualizado' : `Término guardado en sombra (${result?.item?.id || ''})`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function setStatus(id, status, button) {
  if (!id || !status) return;
  const label = STATUS_META[status]?.label || status;
  if (status === 'rejected') {
    const ok = await confirmDialog({
      title: `Rechazar ${id}`,
      text: 'Dejará de aplicarse al redactar, pero se conserva el término en el léxico.',
      okLabel: 'Rechazar',
      danger: true
    });
    if (!ok) return;
  }
  setBusy(button, true);
  try {
    await api.patch(`/api/lingo/terms/${encodeURIComponent(id)}`, { status });
    toast(`${id}: ${label}`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function applyTest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const box = $('#lingoApplyResult');
  const text = String(form.elements.text.value || '').trim();
  if (!text) { toast('Escribe un texto para probar', 'err'); return; }
  const button = $('#lingoApplyButton');
  setBusy(button, true);
  if (box) { box.className = 'muted small'; box.textContent = 'Aplicando…'; }
  try {
    const result = await api.post('/api/lingo/apply', { text, includeShadow: true });
    if (box) {
      box.className = 'muted small';
      box.innerHTML = result?.changed
        ? `<b>Resultado:</b> ${esc(result.text)}<br><small>${(result.changes || []).map((change) => `${esc(change.from)} → ${esc(change.to)}`).join(' · ')}</small>`
        : `Sin cambios: no hay variantes del léxico en ese texto.`;
    }
  } catch (error) {
    if (box) { box.className = 'hint bad'; box.textContent = formatError(error); }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

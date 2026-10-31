/**
 * Búsqueda global (Ctrl/Cmd + K).
 * Consulta /api/search, agrupa, filtra por sección y salta al resultado.
 */
import { api } from './api.js';
import { $, esc } from './core.js';
import { emit } from './state.js';

let initialized = false;
let timer = null;
let seq = 0;
let filter = 'all';
let lastGroups = [];
let lastTotal = 0;

function dialog() {
  return $('#dlg-global-search');
}

function updateFilterUI() {
  for (const button of document.querySelectorAll('#globalSearchFilters [data-search-filter]')) {
    const active = button.dataset.searchFilter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function resultButtons() {
  return [...document.querySelectorAll('#globalSearchResults .search-result')];
}

function renderGroups() {
  const results = $('#globalSearchResults');
  const hint = $('#globalSearchHint');
  if (!results) return;
  const groups = filter === 'all' ? lastGroups : lastGroups.filter((group) => group.key === filter);
  const visible = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (!groups.length || !visible) {
    results.innerHTML = `<p class="hint">No hay resultados${filter === 'all' ? '' : ' en esta sección'}.</p>`;
    if (hint) hint.textContent = `${visible} de ${lastTotal} resultado(s).`;
    return;
  }
  results.innerHTML = groups.map((group) => `
    <section class="search-group" aria-label="${esc(group.label)}">
      <h3>${esc(group.label)}</h3>
      ${group.items.map((item) => `
        <button type="button" class="search-result" data-search-view="${esc(item.view)}" data-search-id="${esc(item.id || '')}">
          <span class="search-result-title">${esc(item.title)}</span>
          ${item.subtitle ? `<small>${esc(item.subtitle)}</small>` : ''}
          <span class="search-result-meta">${esc(item.meta || item.view)}</span>
        </button>`).join('')}
    </section>`).join('');
  if (hint) hint.textContent = `${visible} de ${lastTotal} resultado(s). Flechas para moverte; Enter abre; Esc cierra.`;
}

function openSearch() {
  const dlg = dialog();
  const input = $('#globalSearchInput');
  if (!dlg || !input) return;
  if (!dlg.open) dlg.showModal();
  input.value = '';
  filter = 'all';
  lastGroups = [];
  lastTotal = 0;
  updateFilterUI();
  const results = $('#globalSearchResults');
  if (results) results.innerHTML = '';
  const hint = $('#globalSearchHint');
  if (hint) hint.textContent = 'Escribe al menos 2 letras: agenda, tareas, rutinas, documentos, wiki o tablas.';
  input.focus();
  input.select();
}

function closeSearch() {
  const dlg = dialog();
  if (dlg?.open) dlg.close();
}

async function runSearch(value) {
  const q = String(value || '').trim();
  const results = $('#globalSearchResults');
  const hint = $('#globalSearchHint');
  if (!results) return;
  if (q.length < 2) {
    lastGroups = [];
    lastTotal = 0;
    results.innerHTML = '';
    if (hint) hint.textContent = 'Escribe al menos 2 letras.';
    return;
  }
  const current = ++seq;
  if (hint) hint.textContent = 'Buscando…';
  try {
    const data = await api.get(`/api/search?q=${encodeURIComponent(q)}&limit=8`);
    if (current !== seq) return;
    lastGroups = Array.isArray(data?.groups) ? data.groups : [];
    lastTotal = Number(data?.total) || 0;
    renderGroups();
    if (!lastTotal && hint) hint.textContent = `No encontré «${q}». Prueba con otra palabra o revisa la sección directamente.`;
  } catch (error) {
    if (current !== seq) return;
    lastGroups = [];
    lastTotal = 0;
    results.innerHTML = `<p class="hint">No pude buscar: ${esc(error?.message || 'error')}</p>`;
    if (hint) hint.textContent = 'Error de búsqueda.';
  }
}

function activateResult() {
  const focused = document.activeElement?.closest?.('.search-result');
  if (focused) {
    focused.click();
    return;
  }
  resultButtons()[0]?.click();
}

function moveFocus(delta) {
  const buttons = resultButtons();
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  const next = index < 0 ? (delta > 0 ? 0 : buttons.length - 1) : (index + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

function highlightResult(id) {
  if (!id) return;
  const safe = String(id).replace(/["\\]/g, '');
  const element = document.querySelector(`[data-id="${safe}"], [data-routine-id="${safe}"]`);
  if (!element) return;
  try { element.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* navegador antiguo */ }
  element.classList.remove('search-hit');
  void element.offsetWidth;
  element.classList.add('search-hit');
  setTimeout(() => element.classList.remove('search-hit'), 4200);
}

export function initGlobalSearch() {
  if (initialized) return;
  initialized = true;
  $('#searchBtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    openSearch();
  });
  $('#globalSearchClose')?.addEventListener('click', closeSearch);
  $('#globalSearchInput')?.addEventListener('input', (event) => {
    clearTimeout(timer);
    const value = event.target.value;
    timer = setTimeout(() => runSearch(value), 180);
  });
  $('#globalSearchInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      activateResult();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    }
  });
  $('#globalSearchFilters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-search-filter]');
    if (!chip) return;
    filter = chip.dataset.searchFilter || 'all';
    updateFilterUI();
    renderGroups();
  });
  dialog()?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    }
  });
  $('#globalSearchResults')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-search-view]');
    if (!button) return;
    const view = button.dataset.searchView;
    const id = button.dataset.searchId;
    closeSearch();
    if (view) {
      setTimeout(() => {
        emit('navigate', view);
        if (id) setTimeout(() => highlightResult(id), 450);
      }, 30);
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
  });
}

/**
 * Wiki interna: memoria escrita de la oficina.
 * Lista con búsqueda, editor y borrado. Todo se escapa al pintar.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, emptyState } from './core.js';

let initialized = false;
let pages = [];
let selectedId = null;
let searchTimer = null;

export function initWiki() {
  if (initialized) return;
  initialized = true;

  $('#wikiForm')?.addEventListener('submit', savePage);
  $('#wikiNew')?.addEventListener('click', newPage);
  $('#wikiRefresh')?.addEventListener('click', () => refreshWiki());
  $('#wikiCancel')?.addEventListener('click', newPage);
  $('#wikiDelete')?.addEventListener('click', deleteCurrent);
  $('#wikiList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-wiki-id]');
    if (button) selectPage(button.dataset.wikiId);
  });
  $('#wikiSearch')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshWiki({ keepSelection: true }), 250);
  });
}

export function renderWiki() {
  if (!initialized) initWiki();
  renderList();
  refreshWiki({ keepSelection: true }).catch(() => {});
}

async function refreshWiki({ keepSelection = false } = {}) {
  const query = String($('#wikiSearch')?.value || '').trim();
  const result = await api.get(`/api/wiki/pages?limit=100${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  pages = Array.isArray(result?.items) ? result.items : [];
  const stats = $('#wikiStats');
  if (stats) stats.textContent = `${result?.total ?? pages.length} página(s)${query ? ' · búsqueda' : ''}`;
  renderList();
  if (!keepSelection && selectedId && !pages.some((page) => page.id === selectedId)) newPage();
}

function renderList() {
  const list = $('#wikiList');
  if (!list) return;
  if (!pages.length) {
    const query = String($('#wikiSearch')?.value || '').trim();
    list.innerHTML = emptyState(query ? `No hay páginas que coincidan con «${query}».` : 'La wiki está vacía. Crea la primera página con el formulario.', '✎');
    return;
  }
  list.innerHTML = pages.map((page) => `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">WK</div>
      <div>
        <b>${esc(page.title)}</b>
        <small>${esc(String(page.updatedAt || '').slice(0, 10))} · ${page.words || 0} palabras${page.tags?.length ? ` · ${page.tags.map((tag) => `#${esc(tag)}`).join(' ')}` : ''}</small>
        <small>${esc(page.bodyPreview || '')}</small>
      </div>
      <div class="doc-actions">
        <button type="button" data-wiki-id="${esc(page.id)}">Abrir</button>
      </div>
    </div>`).join('');
}

async function selectPage(id) {
  try {
    const result = await api.get(`/api/wiki/pages/${encodeURIComponent(id)}`);
    const page = result?.item;
    if (!page) throw new Error('Página no encontrada');
    selectedId = page.id;
    const form = $('#wikiForm');
    form.elements.title.value = page.title || '';
    form.elements.tags.value = (page.tags || []).join(', ');
    form.elements.body.value = page.body || '';
    const title = $('#wikiEditorTitle');
    if (title) title.textContent = page.title;
    const state = $('#wikiEditorState');
    if (state) state.textContent = `Editando ${page.id}`;
    const del = $('#wikiDelete');
    if (del) del.hidden = false;
    const cancel = $('#wikiCancel');
    if (cancel) cancel.hidden = false;
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

function newPage() {
  selectedId = null;
  const form = $('#wikiForm');
  if (!form) return;
  form.reset();
  const title = $('#wikiEditorTitle');
  if (title) title.textContent = 'Nueva página';
  const state = $('#wikiEditorState');
  if (state) state.textContent = 'Se guarda en el servidor';
  const del = $('#wikiDelete');
  if (del) del.hidden = true;
  const cancel = $('#wikiCancel');
  if (cancel) cancel.hidden = true;
  form.elements.title?.focus();
}

async function savePage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#wikiSave');
  const title = String(form.elements.title.value || '').trim();
  const body = String(form.elements.body.value || '');
  const tags = String(form.elements.tags.value || '');
  if (!title) { toast('El título es obligatorio', 'err'); return; }
  if (!body.trim()) { toast('El contenido es obligatorio', 'err'); return; }
  setBusy(button, true);
  try {
    const saved = selectedId
      ? await api.patch(`/api/wiki/pages/${encodeURIComponent(selectedId)}`, { title, body, tags })
      : await api.post('/api/wiki/pages', { title, body, tags });
    const item = saved?.item;
    toast(selectedId ? 'Página actualizada' : 'Página creada', 'ok');
    await refreshWiki({ keepSelection: true });
    if (item?.id) await selectPage(item.id);
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function deleteCurrent() {
  if (!selectedId) return;
  const page = pages.find((item) => item.id === selectedId);
  const ok = await confirmDialog({
    title: `Borrar ${selectedId}`,
    text: `Se borrará «${page?.title || selectedId}» de la wiki. Esta acción no se puede deshacer.`,
    okLabel: 'Borrar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/wiki/pages/${encodeURIComponent(selectedId)}`);
    toast('Página borrada', 'ok');
    newPage();
    await refreshWiki();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

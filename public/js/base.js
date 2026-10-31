/**
 * Base de tablas: tablas con columnas tipadas, filas editables y borrado.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, emptyState, promptDialog } from './core.js';

let initialized = false;
let tables = [];
let selectedId = null;
let selected = null;
let editingRowId = null;
let activeFilters = [];
let activeSort = null;

export function initBase() {
  if (initialized) return;
  initialized = true;

  $('#baseTableForm')?.addEventListener('submit', createTable);
  $('#baseAskForm')?.addEventListener('submit', askBase);
  $('#baseRefresh')?.addEventListener('click', () => refreshTables({ keepSelection: true }));
  $('#baseDeleteTable')?.addEventListener('click', deleteTable);
  $('#baseRenameTable')?.addEventListener('click', renameTable);
  $('#baseAddColumn')?.addEventListener('click', addColumn);
  $('#baseRenameColumn')?.addEventListener('click', renameColumn);
  $('#baseDeleteColumn')?.addEventListener('click', deleteColumn);
  $('#basePrintBtn')?.addEventListener('click', printBase);
  window.addEventListener('beforeprint', updateBasePrintStamp);
  $('#baseExportCsv')?.addEventListener('click', exportCsv);
  $('#baseExportXlsx')?.addEventListener('click', exportXlsx);
  $('#baseImportCsv')?.addEventListener('click', () => $('#baseImportFile')?.click());
  $('#baseImportFile')?.addEventListener('change', importCsv);
  $('#baseFilterApply')?.addEventListener('click', applyFilter);
  $('#baseFilterClear')?.addEventListener('click', clearFilter);
  $('#baseSaveView')?.addEventListener('click', saveView);
  $('#baseViews')?.addEventListener('click', onViewClick);
  $('#baseRowForm')?.addEventListener('submit', saveRow);
  $('#baseRowCancel')?.addEventListener('click', cancelEdit);
  $('#baseTablesList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-base-table]');
    if (button) selectTable(button.dataset.baseTable);
  });
  $('#baseRows')?.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-base-edit-row]');
    if (edit) { startEdit(edit.dataset.baseEditRow); return; }
    const duplicate = event.target.closest('[data-base-duplicate-row]');
    if (duplicate) { await duplicateRow(duplicate.dataset.baseDuplicateRow); return; }
    const sortButton = event.target.closest('[data-base-sort]');
    if (sortButton) { toggleSort(sortButton.dataset.baseSort); return; }
    const remove = event.target.closest('[data-base-delete-row]');
    if (remove) await deleteRow(remove.dataset.baseDeleteRow);
  });
}

export function renderBase() {
  if (!initialized) initBase();
  renderTables();
  refreshTables({ keepSelection: true }).catch(() => {});
}

async function refreshTables({ keepSelection = false } = {}) {
  const result = await api.get('/api/base/tables');
  tables = Array.isArray(result?.items) ? result.items : [];
  renderTables();
  if (!tables.length) { clearSelection(); return; }
  const exists = tables.some((table) => table.id === selectedId);
  if (!exists && !keepSelection) { selectedId = tables[0].id; }
  if (!selectedId) selectedId = tables[0].id;
  await selectTable(selectedId);
}

function renderTables() {
  const list = $('#baseTablesList');
  const state = $('#baseTablesState');
  if (state) state.textContent = `${tables.length} tabla(s)`;
  if (!list) return;
  if (!tables.length) {
    list.innerHTML = emptyState('Aún no hay tablas. Crea la primera con el formulario.', '▦');
    return;
  }
  list.innerHTML = tables.map((table) => `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">TB</div>
      <div>
        <b>${esc(table.name)}</b>
        <small>${esc(table.id)} · ${table.columns.length} columna(s) · ${table.rowCount} fila(s)</small>
      </div>
      <div class="doc-actions">
        <button type="button" data-base-table="${esc(table.id)}">${table.id === selectedId ? 'Abierta' : 'Abrir'}</button>
      </div>
    </div>`).join('');
}

async function selectTable(id) {
  if (selectedId !== id) { activeFilters = []; activeSort = null; }
  selectedId = id;
  const result = await api.get(`/api/base/tables/${encodeURIComponent(id)}`);
  selected = result?.item || null;
  renderTables();
  renderSelected();
}

function clearSelection() {
  selectedId = null;
  selected = null;
  editingRowId = null;
  activeFilters = [];
  activeSort = null;
  renderSelected();
}

function renderSelected() {
  const title = $('#baseTableTitle');
  const count = $('#baseTableCount');
  const tools = $('#baseTableTools');
  const form = $('#baseRowForm');
  const rows = $('#baseRows');
  if (!selected) {
    if (title) title.textContent = 'Selecciona una tabla';
    if (count) count.textContent = '';
    if (tools) tools.hidden = true;
    if (form) form.hidden = true;
    if (rows) rows.innerHTML = '<p class="muted small">Elige una tabla de la izquierda o crea una nueva.</p>';
    return;
  }
  if (title) title.textContent = selected.name;
  const visible = filteredRows().length;
  if (count) count.textContent = activeFilters.length ? `${visible} de ${selected.rows.length} fila(s)` : `${selected.rows.length} fila(s)`;
  if (tools) tools.hidden = false;
  if (form) form.hidden = false;
  renderRowForm();
  renderFilterBar();
  renderViews();
  renderRows();
}

function renderRowForm() {
  const box = $('#baseRowFields');
  if (!box || !selected) return;
  box.innerHTML = selected.columns.map((column) => {
    if (column.type === 'checkbox') {
      return `<label class="field check"><input type="checkbox" name="col_${esc(column.id)}" /><span>${esc(column.name)}</span></label>`;
    }
    const type = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text';
    const step = column.type === 'number' ? ' step="any"' : '';
    return `<label class="field"><span>${esc(column.name)}</span><input type="${type}"${step} name="col_${esc(column.id)}" autocomplete="off" /></label>`;
  }).join('');
  const save = $('#baseRowSave');
  if (save) save.textContent = editingRowId ? 'Guardar cambios' : 'Añadir fila';
  const cancel = $('#baseRowCancel');
  if (cancel) cancel.hidden = !editingRowId;
}

function renderRows() {
  const box = $('#baseRows');
  if (!box) return;
  if (!selected) { box.innerHTML = ''; return; }
  if (!selected.rows.length) {
    box.innerHTML = '<p class="base-empty">Sin filas todavía. Añade la primera con el formulario.</p>';
    return;
  }
  const visibleRows = sortedRows(filteredRows());
  if (!visibleRows.length) {
    box.innerHTML = '<p class="base-empty">Ninguna fila coincide con el filtro.</p>';
    return;
  }
  box.innerHTML = `
    <div class="base-table-wrap">
      <table class="base-table">
        <thead><tr>
          ${selected.columns.map((column) => { const arrow = activeSort?.columnId === column.id ? (activeSort.direction === 'asc' ? ' ↑' : ' ↓') : ''; return `<th><button type="button" class="base-sort" data-base-sort="${esc(column.id)}">${esc(column.name)}${arrow}</button></th>`; }).join('')}
          <th>Acciones</th>
        </tr></thead>
        <tbody>
          ${visibleRows.map((row) => `
            <tr>
              ${selected.columns.map((column) => `<td>${esc(displayValue(column, row.values[column.id]))}</td>`).join('')}
              <td><div class="base-row-actions">
                <button type="button" data-base-edit-row="${esc(row.id)}">Editar</button>
            <button type="button" data-base-duplicate-row="${esc(row.id)}">Duplicar</button>
                <button type="button" data-base-delete-row="${esc(row.id)}">Borrar</button>
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function displayValue(column, value) {
  if (column.type === 'checkbox') return value === true ? '✓' : '—';
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function readRowForm() {
  const form = $('#baseRowForm');
  if (!form || !selected) return {};
  const values = {};
  for (const column of selected.columns) {
    const input = form.elements[`col_${column.id}`];
    if (!input) continue;
    values[column.id] = column.type === 'checkbox' ? input.checked : input.value;
  }
  return values;
}

function resetRowForm() {
  editingRowId = null;
  const form = $('#baseRowForm');
  form?.reset();
  renderRowForm();
}

async function createTable(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#baseTableCreate');
  const name = String(form.elements.name.value || '').trim();
  const columns = String(form.elements.columns.value || '').trim();
  if (!name) { toast('El nombre es obligatorio', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post('/api/base/tables', { name, columns });
    form.elements.name.value = '';
    toast(`Tabla ${result?.item?.name || name} creada`, 'ok');
    selectedId = result?.item?.id || null;
    await refreshTables();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function saveRow(event) {
  event.preventDefault();
  if (!selected) return;
  const button = $('#baseRowSave');
  const values = readRowForm();
  setBusy(button, true);
  try {
    if (editingRowId) {
      await api.patch(`/api/base/tables/${encodeURIComponent(selected.id)}/rows/${encodeURIComponent(editingRowId)}`, { values });
      toast('Fila actualizada', 'ok');
    } else {
      await api.post(`/api/base/tables/${encodeURIComponent(selected.id)}/rows`, { values });
      toast('Fila añadida', 'ok');
    }
    resetRowForm();
    await selectTable(selected.id);
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function startEdit(rowId) {
  if (!selected) return;
  const row = selected.rows.find((item) => item.id === rowId);
  if (!row) return;
  editingRowId = rowId;
  const form = $('#baseRowForm');
  for (const column of selected.columns) {
    const input = form?.elements[`col_${column.id}`];
    if (!input) continue;
    if (column.type === 'checkbox') input.checked = row.values[column.id] === true;
    else input.value = row.values[column.id] ?? '';
  }
  renderRowForm();
  form?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function cancelEdit() {
  resetRowForm();
}

async function duplicateRow(rowId) {
  if (!selected) return;
  try {
    const result = await api.post('/api/base/tables/' + encodeURIComponent(selected.id) + '/rows/' + encodeURIComponent(rowId) + '/duplicate', {});
    toast('Fila duplicada', 'ok');
    await refreshTables({ keepSelection: true });
    return result;
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function deleteRow(rowId) {
  if (!selected) return;
  const ok = await confirmDialog({
    title: `Borrar ${rowId}`,
    text: 'Se borrará esta fila de la tabla. No se puede deshacer.',
    okLabel: 'Borrar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/base/tables/${encodeURIComponent(selected.id)}/rows/${encodeURIComponent(rowId)}`);
    toast('Fila borrada', 'ok');
    if (editingRowId === rowId) resetRowForm();
    await selectTable(selected.id);
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function deleteTable() {
  if (!selected) return;
  const ok = await confirmDialog({
    title: `Borrar ${selected.name}`,
    text: 'Se borrará la tabla completa con todas sus filas. No se puede deshacer.',
    okLabel: 'Borrar tabla',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/base/tables/${encodeURIComponent(selected.id)}`);
    toast('Tabla borrada', 'ok');
    selectedId = null;
    selected = null;
    resetRowForm();
    await refreshTables();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function askBase(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const question = String(form.elements.question.value || '').trim();
  const button = $('#baseAskBtn');
  const answer = $('#baseAskAnswer');
  const rowsBox = $('#baseAskRows');
  if (!question) { toast('Escribe una pregunta', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post('/api/base/ask', { question });
    if (answer) {
      answer.className = result.ambiguous ? 'hint bad' : 'hint';
      answer.textContent = result.answer || 'Sin respuesta.';
    }
    if (!rowsBox) return;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!rows.length || !result.table) { rowsBox.innerHTML = ''; return; }
    const columns = result.table.columns || [];
    rowsBox.innerHTML = `
      <div class="base-table-wrap">
        <table class="base-table">
          <thead><tr>${columns.map((column) => `<th>${esc(column.name)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${esc(row.values?.[column.name] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      ${result.note ? `<p class="muted small">${esc(result.note)}</p>` : ''}`;
  } catch (error) {
    if (answer) { answer.className = 'hint bad'; answer.textContent = formatError(error); }
    if (rowsBox) rowsBox.innerHTML = '';
  } finally {
    setBusy(button, false);
  }
}


function exportCsv() {
  if (!selectedId) { toast('Abre una tabla para exportarla', 'warn'); return; }
  const link = document.createElement('a');
  link.href = `/api/base/tables/${encodeURIComponent(selectedId)}/export.csv`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast('CSV de la tabla descargado', 'ok');
}


async function importCsv(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  if (!selectedId) { toast('Abre una tabla para importar', 'warn'); input.value = ''; return; }
  if (file.size > 500000) { toast('El CSV supera 500 KB', 'err'); input.value = ''; return; }
  try {
    const csv = await file.text();
    const result = await api.post(`/api/base/tables/${encodeURIComponent(selectedId)}/import.csv`, { csv });
    toast(`${result?.imported || 0} fila(s) importadas`, 'ok');
    await selectTable(selectedId);
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    input.value = '';
  }
}


function exportXlsx() {
  if (!selectedId) { toast('Abre una tabla para exportarla', 'warn'); return; }
  const link = document.createElement('a');
  link.href = `/api/base/tables/${encodeURIComponent(selectedId)}/export.xlsx`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast('Excel de la tabla descargado', 'ok');
}


function matchesFilter(row, filter) {
  const column = selected?.columns.find((item) => item.id === filter.columnId);
  if (!column) return true;
  const raw = row.values[filter.columnId];
  if (column.type === 'checkbox') {
    const wanted = ['sí', 'si', 'true', '1', 'x', 'on'].includes(String(filter.value).toLowerCase());
    return Boolean(raw) === wanted;
  }
  if (column.type === 'number') {
    const a = Number(raw);
    const b = Number(filter.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (filter.op === 'eq') return a === b;
    if (filter.op === 'neq') return a !== b;
    if (filter.op === 'gt') return a > b;
    if (filter.op === 'gte') return a >= b;
    if (filter.op === 'lt') return a < b;
    if (filter.op === 'lte') return a <= b;
    return true;
  }
  const a = String(raw ?? '').toLowerCase();
  const b = String(filter.value ?? '').toLowerCase();
  if (filter.op === 'eq') return a === b;
  if (filter.op === 'neq') return a !== b;
  if (filter.op === 'gt') return a > b;
  if (filter.op === 'gte') return a >= b;
  if (filter.op === 'lt') return a < b;
  if (filter.op === 'lte') return a <= b;
  return a.includes(b);
}

function filteredRows() {
  if (!selected) return [];
  if (!activeFilters.length) return selected.rows;
  return selected.rows.filter((row) => activeFilters.every((filter) => matchesFilter(row, filter)));
}

function renderFilterBar() {
  const bar = $('#baseFilterBar');
  if (!bar || !selected) return;
  bar.hidden = false;
  const select = $('#baseFilterColumn');
  if (select && select.options.length !== selected.columns.length) {
    select.innerHTML = selected.columns.map((column) => `<option value="${esc(column.id)}">${esc(column.name)}</option>`).join('');
  }
  const first = activeFilters[0];
  if (first) {
    if (select) select.value = first.columnId;
    const op = $('#baseFilterOp');
    if (op) op.value = first.op;
    const value = $('#baseFilterValue');
    if (value) value.value = first.value;
  }
}

function renderViews() {
  const box = $('#baseViews');
  if (!box || !selected) return;
  const views = selected.views || [];
  box.hidden = views.length === 0;
  box.innerHTML = views.map((view) => `<span class="base-view"><button type="button" class="chip" data-base-view="${esc(view.id)}">${esc(view.name)}</button><button type="button" class="chip-x" data-base-view-delete="${esc(view.id)}" aria-label="Borrar vista ${esc(view.name)}">×</button></span>`).join('');
}

function applyFilter() {
  if (!selected) return;
  const columnId = $('#baseFilterColumn')?.value;
  const op = $('#baseFilterOp')?.value || 'contains';
  const value = $('#baseFilterValue')?.value ?? '';
  if (!columnId) return;
  activeFilters = [{ columnId, op, value }];
  renderSelected();
}

function clearFilter() {
  activeFilters = [];
  activeSort = null;
  const value = $('#baseFilterValue');
  if (value) value.value = '';
  renderSelected();
}

async function saveView() {
  if (!selected) return;
  const columnId = $('#baseFilterColumn')?.value;
  if (!columnId) { toast('Elige una columna para filtrar', 'warn'); return; }
  const name = await promptDialog({ title: 'Guardar vista', text: 'Nombre para reutilizar este filtro.', label: 'Nombre', value: '' });
  if (!name) return;
  try {
    await api.post(`/api/base/tables/${encodeURIComponent(selected.id)}/views`, {
      name: String(name),
      filters: [{ columnId, op: $('#baseFilterOp')?.value || 'contains', value: $('#baseFilterValue')?.value ?? '' }],
      sort: activeSort || undefined
    });
    toast('Vista guardada', 'ok');
    await selectTable(selected.id);
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function onViewClick(event) {
  const apply = event.target.closest('[data-base-view]');
  if (apply) {
    const view = (selected?.views || []).find((item) => item.id === apply.dataset.baseView);
    if (!view) return;
    activeFilters = view.filters.map((filter) => ({ ...filter }));
    activeSort = view.sort ? { ...view.sort } : null;
    renderSelected();
    return;
  }
  const remove = event.target.closest('[data-base-view-delete]');
  if (!remove) return;
  const ok = await confirmDialog({ title: 'Borrar vista', text: 'Solo se elimina el filtro guardado, no las filas.', okLabel: 'Borrar', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/base/tables/${encodeURIComponent(selected.id)}/views/${encodeURIComponent(remove.dataset.baseViewDelete)}`);
    toast('Vista borrada', 'ok');
    await selectTable(selected.id);
  } catch (error) {
    toast(formatError(error), 'err');
  }
}


function toggleSort(columnId) {
  if (!selected?.columns.some((column) => column.id === columnId)) return;
  if (activeSort?.columnId === columnId) {
    activeSort = { columnId, direction: activeSort.direction === 'asc' ? 'desc' : 'asc' };
  } else {
    activeSort = { columnId, direction: 'asc' };
  }
  renderRows();
}

function sortedRows(rows) {
  if (!activeSort) return rows;
  const column = selected?.columns.find((item) => item.id === activeSort.columnId);
  if (!column) return rows;
  const factor = activeSort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = a.values[column.id];
    const right = b.values[column.id];
    if (column.type === 'number') return (Number(left || 0) - Number(right || 0)) * factor;
    if (column.type === 'checkbox') return (Number(Boolean(left)) - Number(Boolean(right))) * factor;
    return String(left ?? '').localeCompare(String(right ?? ''), 'es', { numeric: true }) * factor;
  });
}

async function renameTable() {
  if (!selected) return;
  const name = await promptDialog({
    title: 'Renombrar tabla',
    text: 'Cambia el nombre visible; las filas, columnas y vistas se conservan.',
    label: 'Nombre',
    value: selected.name
  });
  if (name === null) return;
  const clean = String(name || '').trim();
  if (!clean || clean === selected.name) return;
  try {
    await api.patch('/api/base/tables/' + encodeURIComponent(selected.id), { name: clean });
    toast('Tabla renombrada', 'ok');
    await refreshTables({ keepSelection: true });
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function addColumn() {
  if (!selected) return;
  const name = await promptDialog({
    title: 'Nueva columna',
    text: 'Se agregará al final de la tabla; las filas existentes quedan con el campo vacío.',
    label: 'Nombre de la columna',
    value: ''
  });
  if (name === null) return;
  const clean = String(name || '').trim();
  if (!clean) return;
  const type = await promptDialog({
    title: 'Tipo de columna',
    text: 'Escribe texto, número, fecha o casilla.',
    label: 'Tipo',
    value: 'texto'
  });
  if (type === null) return;
  try {
    await api.post('/api/base/tables/' + encodeURIComponent(selected.id) + '/columns', { name: clean, type: String(type || 'texto').trim() });
    toast('Columna agregada', 'ok');
    await refreshTables({ keepSelection: true });
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function renameColumn() {
  if (!selected || !selected.columns?.length) return;
  const current = await promptDialog({
    title: 'Renombrar columna',
    text: 'Escribe el nombre actual de la columna (sin distinguir mayúsculas).',
    label: 'Columna actual',
    value: selected.columns[0].name
  });
  if (current === null) return;
  const column = selected.columns.find((item) => String(item.name).toLowerCase() === String(current || '').trim().toLowerCase());
  if (!column) {
    toast('No encontré esa columna', 'err');
    return;
  }
  const next = await promptDialog({
    title: 'Nuevo nombre',
    text: 'Cambia la etiqueta sin tocar el id, las filas ni las vistas.',
    label: 'Nuevo nombre',
    value: column.name
  });
  if (next === null) return;
  const clean = String(next || '').trim();
  if (!clean || clean === column.name) return;
  try {
    await api.patch('/api/base/tables/' + encodeURIComponent(selected.id) + '/columns/' + encodeURIComponent(column.id), { name: clean });
    toast('Columna renombrada', 'ok');
    await refreshTables({ keepSelection: true });
  } catch (error) {
    toast(formatError(error), 'err');
  }
}


async function deleteColumn() {
  if (!selected || !selected.columns?.length) return;
  if (selected.columns.length <= 1) {
    toast('La tabla necesita al menos una columna', 'err');
    return;
  }
  const current = await promptDialog({
    title: 'Eliminar columna',
    text: 'Escribe el nombre de la columna que quieres eliminar.',
    label: 'Columna',
    value: selected.columns[0].name
  });
  if (current === null) return;
  const column = selected.columns.find((item) => String(item.name).toLowerCase() === String(current || '').trim().toLowerCase());
  if (!column) {
    toast('No encontré esa columna', 'err');
    return;
  }
  const ok = await confirmDialog({
    title: 'Eliminar columna',
    text: `Se borrarán los valores de «${column.name}» en todas las filas. Las vistas que dependan solo de esta columna se eliminarán. No se puede deshacer.`,
    okLabel: 'Eliminar',
    danger: true
  });
  if (!ok) return;
  try {
    const result = await api.del('/api/base/tables/' + encodeURIComponent(selected.id) + '/columns/' + encodeURIComponent(column.id));
    const removed = Array.isArray(result?.removedViews) ? result.removedViews.length : 0;
    toast(removed ? `Columna eliminada; ${removed} vista(s) también` : 'Columna eliminada', 'ok');
    await refreshTables({ keepSelection: true });
  } catch (error) {
    toast(formatError(error), 'err');
  }
}


function updateBasePrintStamp() {
  const stamp = $('#basePrintStamp');
  if (!stamp) return;
  const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  stamp.textContent = `Héctor Fabio Riascos C. · ${selected?.name || 'Base'} · ${date}`;
}

function printBase() {
  if (!selected) {
    toast('Selecciona una tabla antes de imprimir', 'err');
    return;
  }
  updateBasePrintStamp();
  window.print();
}

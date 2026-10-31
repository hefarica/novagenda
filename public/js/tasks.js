/**
 * Tareas y compromisos: listado con filtros, creación, edición inline,
 * cierre/reapertura y borrado. Consume `/api/tasks` (CRUD completo).
 * Todo se escapa antes de pintar; ninguna acción sale sin pasar por la API.
 */
import { api } from './api.js';
import { $, esc, toast } from './core.js';

const STATUS_LABEL = { open: 'Abierta', done: 'Hecha', cancelled: 'Cancelada' };
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
let items = [];
let status = 'all';
let query = '';
let editing = null;
let searchTimer = null;

function priorityOptions(current) {
  return PRIORITIES.map((p) => `<option value="${p}" ${p === current ? 'selected' : ''}>${p}</option>`).join('');
}

function row(task) {
  if (editing === task.id) {
    return `<div class="task-row ${task.status}" data-id="${esc(task.id)}">
      <div class="task-edit">
        <label class="field"><span>Título</span><input data-edit-title maxlength="160" value="${esc(task.title)}" /></label>
        <label class="field"><span>Vence</span><input data-edit-due type="date" value="${esc(task.due || '')}" /></label>
        <label class="field"><span>Prioridad</span><select data-edit-priority>${priorityOptions(task.priority)}</select></label>
        <label class="field"><span>Responsable</span><input data-edit-owner maxlength="120" value="${esc(task.owner || '')}" /></label>
      </div>
      <div class="task-actions">
        <button type="button" class="primary small" data-task-save>Guardar</button>
        <button type="button" class="ghost small" data-task-cancel>Cancelar</button>
      </div>
    </div>`;
  }
  const meta = [];
  if (task.priority) meta.push(`<span class="badge ${esc(task.priority)}">${esc(task.priority)}</span>`);
  meta.push(`<span class="tag ${task.status === 'done' ? 'ok' : task.status === 'cancelled' ? 'off' : 'warn'}">${STATUS_LABEL[task.status] || esc(task.status)}</span>`);
  if (task.due) meta.push(`<span>vence ${esc(task.due)}</span>`);
  if (task.owner) meta.push(`<span>· ${esc(task.owner)}</span>`);
  if (task.origin) meta.push(`<span>· ${esc(task.origin)}</span>`);
  const close = task.status === 'done'
    ? '<button type="button" class="ghost small" data-task-reopen>Reabrir</button>'
    : '<button type="button" class="secondary small" data-task-close>Cerrar</button>';
  return `<div class="task-row ${task.status}" data-id="${esc(task.id)}">
    <div class="task-main">
      <span class="task-title">${esc(task.title)}</span>
      <span class="task-meta">${meta.join(' ')}</span>
      ${task.notes ? `<small class="muted">${esc(task.notes)}</small>` : ''}
    </div>
    <div class="task-actions">
      ${close}
      <button type="button" class="ghost small" data-task-duplicate>Duplicar</button>
      <button type="button" class="ghost small" data-task-edit>Editar</button>
      <button type="button" class="danger small" data-task-delete>Eliminar</button>
    </div>
  </div>`;
}

function paint(summary) {
  const list = $('#taskList');
  if (!list) return;
  list.innerHTML = items.length ? items.map(row).join('') : '<p class="muted small">No hay tareas con este filtro.</p>';
  const meta = $('#tasksMeta');
  if (meta) {
    const open = summary?.open ?? items.filter((t) => t.status === 'open').length;
    const done = summary?.done ?? items.filter((t) => t.status === 'done').length;
    meta.textContent = `${open} abiertas · ${done} hechas`;
    meta.className = `tag ${open ? 'warn' : 'ok'}`;
  }
  for (const button of document.querySelectorAll('#taskFilters .chip')) {
    const active = button.getAttribute('data-status') === status;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

export async function duplicateTask(task) {
  try {
    const copy = {
      title: `${task.title} (copia)`,
      priority: task.priority || 'P2',
      owner: task.owner || '',
      notes: task.notes || ''
    };
    if (task.due) copy.due = task.due;
    await api.post('/api/tasks', copy);
    toast('Tarea duplicada', 'ok');
    await renderTasks();
  } catch (error) {
    toast(error?.message || 'No se pudo duplicar la tarea', 'err');
  }
}

export async function renderTasks() {
  const list = $('#taskList');
  if (!list) return;
  try {
    const params = new URLSearchParams({ status, limit: '500' });
    if (query) params.set('q', query);
    const data = await api.get(`/api/tasks?${params.toString()}`);
    items = Array.isArray(data.items) ? data.items : [];
    paint(data.summary);
  } catch (error) {
    list.innerHTML = `<p class="hint">No pude cargar las tareas: ${esc(error?.message || 'error')}</p>`;
  }
}

export function initTasks() {
  $('#taskPrintBtn')?.addEventListener('click', printTasks);
  $('#taskExportCsv')?.addEventListener('click', () => {
    const params = new URLSearchParams({ status, limit: '2000' });
    if (query) params.set('q', query);
    const anchor = document.createElement('a');
    anchor.href = `/api/tasks/export.csv?${params.toString()}`;
    anchor.download = 'tareas.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    toast('CSV de tareas descargado', 'ok');
  });
  window.addEventListener('beforeprint', updateTasksPrintStamp);
  const list = $('#taskList');
  const form = $('#taskForm');
  if (!list || !form) return;

  $('#taskNewBtn')?.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input[name="title"]')?.focus();
  });
  $('#taskFormCancel')?.addEventListener('click', () => { form.hidden = true; form.reset(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      title: String(data.get('title') || '').trim(),
      priority: String(data.get('priority') || 'P2'),
      origin: 'manual'
    };
    if (!body.title) return;
    const due = String(data.get('due') || '').trim();
    if (due) body.due = due;
    const owner = String(data.get('owner') || '').trim();
    if (owner) body.owner = owner;
    const notes = String(data.get('notes') || '').trim();
    if (notes) body.notes = notes;
    try {
      await api.post('/api/tasks', body);
      toast('Tarea creada', 'ok');
      form.reset();
      form.hidden = true;
      editing = null;
      await renderTasks();
    } catch (error) {
      toast(error?.message || 'No se pudo crear la tarea', 'err');
    }
  });

  $('#taskFilters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-status]');
    if (!chip) return;
    status = chip.getAttribute('data-status') || 'all';
    renderTasks();
  });

  $('#taskSearch')?.addEventListener('input', (event) => {
    const value = String(event.target.value || '').trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = value; renderTasks(); }, 250);
  });

  list.addEventListener('click', async (event) => {
    const task = event.target.closest('.task-row');
    if (!task) return;
    const id = task.getAttribute('data-id');
    if (event.target.closest('[data-task-duplicate]')) {
      const task = items.find((item) => item.id === id);
      if (task) await duplicateTask(task);
      return;
    }
    if (event.target.closest('[data-task-edit]')) { editing = id; paint(); return; }
    if (event.target.closest('[data-task-cancel]')) { editing = null; renderTasks(); return; }
    if (event.target.closest('[data-task-save]')) {
      const title = String(task.querySelector('[data-edit-title]')?.value || '').trim();
      if (!title) { toast('La tarea necesita un título', 'err'); return; }
      const body = { title };
      const due = String(task.querySelector('[data-edit-due]')?.value || '').trim();
      if (due) body.due = due;
      const priority = String(task.querySelector('[data-edit-priority]')?.value || '');
      if (priority) body.priority = priority;
      const owner = String(task.querySelector('[data-edit-owner]')?.value || '').trim();
      if (owner) body.owner = owner;
      try {
        await api.patch(`/api/tasks/${encodeURIComponent(id)}`, body);
        toast('Tarea actualizada', 'ok');
        editing = null;
        await renderTasks();
      } catch (error) {
        toast(error?.message || 'No se pudo guardar', 'err');
      }
      return;
    }
    if (event.target.closest('[data-task-close]')) {
      try { await api.post(`/api/tasks/${encodeURIComponent(id)}/close`, {}); toast('Tarea cerrada', 'ok'); await renderTasks(); }
      catch (error) { toast(error?.message || 'No se pudo cerrar', 'err'); }
      return;
    }
    if (event.target.closest('[data-task-reopen]')) {
      try { await api.post(`/api/tasks/${encodeURIComponent(id)}/reopen`, {}); toast('Tarea reabierta', 'ok'); await renderTasks(); }
      catch (error) { toast(error?.message || 'No se pudo reabrir', 'err'); }
      return;
    }
    if (event.target.closest('[data-task-delete]')) {
      if (!window.confirm('¿Eliminar esta tarea?')) return;
      try { await api.del(`/api/tasks/${encodeURIComponent(id)}`); toast('Tarea eliminada', 'ok'); editing = null; await renderTasks(); }
      catch (error) { toast(error?.message || 'No se pudo eliminar', 'err'); }
    }
  });
}


function updateTasksPrintStamp() {
  const stamp = $('#tasksPrintStamp');
  if (!stamp) return;
  const open = items.filter((task) => task.status === 'open').length;
  const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  stamp.textContent = `Héctor Fabio Riascos C. · ${open} tarea(s) abierta(s) · ${date}`;
}

function printTasks() {
  updateTasksPrintStamp();
  window.print();
}

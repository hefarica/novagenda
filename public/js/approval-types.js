/**
 * Tipos de aprobación declarativos y solicitudes.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, promptDialog, emptyState } from './core.js';

let initialized = false;
const state = { types: [], requests: [] };
let editingTypeId = null;

export function initApprovalTypes() {
  if (initialized) return;
  initialized = true;
  $('#approvalTypeForm')?.addEventListener('submit', createType);
  $('#approvalRequestForm')?.addEventListener('submit', createRequest);
  $('#approvalTypeSelect')?.addEventListener('change', renderRequestFields);
  $('#approvalTypesList')?.addEventListener('click', onAction);
  $('#approvalTypeCancelEdit')?.addEventListener('click', resetTypeForm);
  $('#approvalRequestsList')?.addEventListener('click', onAction);
}

export function renderApprovalTypes() {
  if (!initialized) initApprovalTypes();
  refresh().catch(() => {});
}

async function refresh() {
  const [types, requests] = await Promise.all([
    api.get('/api/approval-types'),
    api.get('/api/approval-requests?status=pending')
  ]);
  state.types = Array.isArray(types?.items) ? types.items : [];
  state.requests = Array.isArray(requests?.items) ? requests.items : [];
  renderTypes();
  renderSelect();
  renderRequestFields();
  renderRequests();
}

function renderTypes() {
  const box = $('#approvalTypesList');
  if (!box) return;
  if (!state.types.length) {
    box.innerHTML = emptyState('Crea un tipo para empezar.', '✓');
    return;
  }
  box.innerHTML = state.types.map((type) => `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">${esc(type.level)}</div>
      <div>
        <b>${esc(type.name)}</b>
        <small>${esc(type.description || 'sin descripción')} · ${(type.fields || []).length} campo(s) · SLA ${esc(String(type.slaHours || 48))} h</small>
      </div>
      <div class="approval-actions">
        <button type="button" class="ghost small" data-approval-type-action="edit" data-approval-type-id="${esc(type.id)}">Editar</button>
        <button type="button" class="ghost small" data-approval-type-action="delete" data-approval-type-id="${esc(type.id)}">Borrar</button>
      </div>
    </div>`).join('');
}

function renderSelect() {
  const select = $('#approvalTypeSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">—</option>'
    + state.types.map((type) => `<option value="${esc(type.id)}">${esc(type.name)} · ${esc(type.level)}</option>`).join('');
  if (current && state.types.some((type) => type.id === current)) select.value = current;
  else if (state.types.length) select.value = state.types[0].id;
}

function renderRequestFields() {
  const box = $('#approvalRequestFields');
  if (!box) return;
  const type = state.types.find((item) => item.id === $('#approvalTypeSelect')?.value);
  if (!type) { box.innerHTML = '<p class="hint">Elige un tipo para ver sus campos.</p>'; return; }
  box.innerHTML = (type.fields || []).map((field) => {
    if (field.type === 'checkbox') {
      return `<label class="field check"><input type="checkbox" name="${esc(field.key)}" /><span>${esc(field.label)}</span></label>`;
    }
    const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
    return `<label class="field"><span>${esc(field.label)} *</span><input type="${inputType}" name="${esc(field.key)}" ${field.type === 'number' ? 'step="any"' : ''} required /></label>`;
  }).join('');
}

function renderRequests() {
  const box = $('#approvalRequestsList');
  const count = $('#approvalRequestsCount');
  if (count) count.textContent = `${state.requests.length} pendiente(s)`;
  if (!box) return;
  if (!state.requests.length) {
    box.innerHTML = emptyState('No hay solicitudes pendientes.', '✓');
    return;
  }
  box.innerHTML = state.requests.map((request) => `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">${esc(request.level || 'N2')}</div>
      <div>
        <b>${esc(request.title)}</b>
        <small>${esc(request.typeName)} · ${esc(request.id)} · vence ${esc(String(request.dueAt || '').slice(0, 16).replace('T', ' '))}${request.overdue ? ` · vencida ${request.overdueHours} h` : ''}</small>
        <div class="approval-meta">${(request.values ? Object.entries(request.values) : []).map(([key, value]) => `<span class="tag">${esc(key)}: ${esc(String(value))}</span>`).join('')}</div>
      </div>
      <div class="approval-actions">
        <button type="button" class="primary" data-approval-request-action="approve" data-approval-request-id="${esc(request.id)}">Aprobar</button>
        <button type="button" class="ghost" data-approval-request-action="reject" data-approval-request-id="${esc(request.id)}">Rechazar</button>
      </div>
    </div>`).join('');
}

async function createType(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#approvalTypeCreate');
  const editId = form.dataset.editId || null;
  const payload = {
    name: form.elements.name.value.trim(),
    level: form.elements.level.value,
    slaHours: Number(form.elements.slaHours?.value || 48),
    description: form.elements.description.value.trim()
  };
  setBusy(button, true);
  try {
    if (editId) {
      await api.patch(`/api/approval-types/${encodeURIComponent(editId)}`, payload);
      toast('Tipo actualizado', 'ok');
    } else {
      await api.post('/api/approval-types', { ...payload, fields: form.elements.fields.value.trim() });
      toast('Tipo creado', 'ok');
    }
    if (editId || !form.dataset.editId) resetTypeForm();
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function createRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#approvalRequestCreate');
  const type = state.types.find((item) => item.id === form.elements.type.value);
  if (!type) { toast('Elige un tipo', 'err'); return; }
  const values = {};
  for (const field of type.fields || []) {
    const input = form.elements.namedItem(field.key);
    if (!input) continue;
    values[field.key] = field.type === 'checkbox' ? input.checked : input.value;
  }
  setBusy(button, true);
  try {
    await api.post('/api/approval-requests', {
      typeId: type.id,
      title: form.elements.title.value.trim(),
      values
    });
    form.elements.title.value = '';
    for (const input of form.querySelectorAll('#approvalRequestFields [name]')) {
      if (input.type === 'checkbox') input.checked = false; else input.value = '';
    }
    toast('Solicitud creada', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function onAction(event) {
  const typeButton = event.target.closest('[data-approval-type-action]');
  if (typeButton) {
    if (typeButton.dataset.approvalTypeAction === 'edit') {
      startEditType(typeButton.dataset.approvalTypeId);
      return;
    }
    const ok = await confirmDialog({ title: 'Borrar tipo', text: 'Las solicitudes existentes conservan su nombre.', okLabel: 'Borrar', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/approval-types/${encodeURIComponent(typeButton.dataset.approvalTypeId)}`);
      toast('Tipo borrado', 'ok');
      await refresh();
    } catch (error) { toast(formatError(error), 'err'); }
    return;
  }
  const requestButton = event.target.closest('[data-approval-request-action]');
  if (!requestButton) return;
  const id = requestButton.dataset.approvalRequestId;
  if (requestButton.dataset.approvalRequestAction === 'approve') {
    const ok = await confirmDialog({ title: `Aprobar ${id}`, text: 'Queda registrado en el ledger con tu aprobación.', okLabel: 'Aprobar' });
    if (!ok) return;
    try {
      await api.post(`/api/approval-requests/${encodeURIComponent(id)}/approve`, { by: 'owner' });
      toast('Solicitud aprobada', 'ok');
      await refresh();
    } catch (error) { toast(formatError(error), 'err'); }
    return;
  }
  const reason = await promptDialog({ title: `Rechazar ${id}`, text: 'Motivo opcional.', label: 'Motivo', value: '' });
  if (reason === null) return;
  try {
    await api.post(`/api/approval-requests/${encodeURIComponent(id)}/reject`, { by: 'owner', reason: String(reason || '') });
    toast('Solicitud rechazada', 'ok');
    await refresh();
  } catch (error) { toast(formatError(error), 'err'); }
}



function startEditType(id) {
  const type = state.types.find((item) => item.id === id);
  const form = $('#approvalTypeForm');
  if (!type || !form) return;
  editingTypeId = type.id;
  form.dataset.editId = type.id;
  form.elements.name.value = type.name || '';
  form.elements.level.value = type.level || 'N2';
  form.elements.slaHours.value = String(type.slaHours || 48);
  form.elements.description.value = type.description || '';
  form.elements.fields.value = (type.fields || []).map((field) => `${field.label}:${field.type}`).join(', ');
  form.elements.fields.disabled = true;
  const button = $('#approvalTypeCreate');
  if (button) button.textContent = 'Guardar tipo';
  const cancel = $('#approvalTypeCancelEdit');
  if (cancel) cancel.hidden = false;
  form.scrollIntoView({ block: 'center' });
  form.elements.name.focus();
}

function resetTypeForm() {
  editingTypeId = null;
  const form = $('#approvalTypeForm');
  if (form) delete form.dataset.editId;
  form?.reset();
  if (form?.elements.fields) form.elements.fields.disabled = false;
  if (form?.elements.level) form.elements.level.value = 'N2';
  if (form?.elements.slaHours) form.elements.slaHours.value = '48';
  const button = $('#approvalTypeCreate');
  if (button) button.textContent = 'Crear tipo';
  const cancel = $('#approvalTypeCancelEdit');
  if (cancel) cancel.hidden = true;
}

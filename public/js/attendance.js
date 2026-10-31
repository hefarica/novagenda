/**
 * Jornada: entrada, salida, pausas y horas por rango.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, promptDialog, emptyState } from './core.js';

let initialized = false;
let editingId = null;
const state = { from: '', to: '', data: null };

function pad(value) {
  return String(value).padStart(2, '0');
}

function key(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function initAttendance() {
  if (initialized) return;
  initialized = true;
  const today = new Date();
  state.to = key(today);
  state.from = key(new Date(today.getTime() - 6 * 86_400_000));
  const from = $('#attendanceFrom');
  const to = $('#attendanceTo');
  if (from) { from.value = state.from; from.addEventListener('change', () => { state.from = from.value; refresh(); }); }
  if (to) { to.value = state.to; to.addEventListener('change', () => { state.to = to.value; refresh(); }); }
  $('#attendanceRefresh')?.addEventListener('click', () => refresh());
  $('#attendancePrintBtn')?.addEventListener('click', printAttendance);
  $('#attendanceExportCsv')?.addEventListener('click', () => {
    const query = new URLSearchParams({ from: state.from, to: state.to });
    const anchor = document.createElement('a');
    anchor.href = `/api/attendance/export.csv?${query.toString()}`;
    anchor.download = 'jornada.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    toast('CSV de jornada descargado', 'ok');
  });
  window.addEventListener('beforeprint', updateAttendancePrintStamp);
  $('#attendanceIn')?.addEventListener('click', clockIn);
  $('#attendanceOut')?.addEventListener('click', clockOut);
  $('#attendanceBreak')?.addEventListener('click', addBreak);
  $('#attendanceList')?.addEventListener('click', onAction);
}

export function renderAttendance() {
  if (!initialized) initAttendance();
  refresh().catch(() => {});
}

async function refresh() {
  const query = `from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
  state.data = await api.get(`/api/attendance?${query}`);
  render();
}

function render() {
  const data = state.data || {};
  const summary = data.summary || {};
  const open = data.open || null;
  const status = $('#attendanceStatus');
  if (status) status.textContent = open ? `Abierta desde ${formatTime(open.start)}` : 'Sin jornada abierta';
  const counts = $('#attendanceCounts');
  if (counts) {
    counts.innerHTML = [
      ['Horas', formatMinutes(summary.minutes || 0), ''],
      ['Días', String(summary.days || 0), ''],
      ['Promedio', formatMinutes(summary.averageMinutes || 0), ''],
      ['Turnos', String(summary.shifts || 0), '']
    ].map(([label, value, className]) => `
      <div class="approval-metric ${className}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');
  }
  const hint = $('#attendanceHint');
  if (hint) hint.textContent = open
    ? `Llevas ${formatMinutes(elapsedMinutes(open.start))} desde la entrada${open.breakMinutes ? `, con ${open.breakMinutes} min de pausa` : ''}.`
    : 'Pulsa Entrada para abrir la jornada. La salida calcula las horas y descuenta las pausas.';
  const range = $('#attendanceRange');
  if (range) range.textContent = `${data.from || state.from} → ${data.to || state.to}`;
  const inButton = $('#attendanceIn');
  const outButton = $('#attendanceOut');
  const breakButton = $('#attendanceBreak');
  if (inButton) inButton.disabled = Boolean(open);
  if (outButton) outButton.disabled = !open;
  if (breakButton) breakButton.disabled = !open;
  renderList(data.items || []);
}

function renderList(items) {
  const box = $('#attendanceList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = emptyState('Todavía no hay turnos en este rango.', '◷');
    return;
  }
  box.innerHTML = items.map((shift) => {
    if (editingId === shift.id) {
      return `
    <div class="attendance-edit" data-shift-edit="${esc(shift.id)}">
      <label class="field"><span>Entrada</span><input type="datetime-local" data-shift-start value="${esc(localInput(shift.start))}" /></label>
      <label class="field"><span>Salida (vacío = abierta)</span><input type="datetime-local" data-shift-end value="${esc(localInput(shift.end))}" /></label>
      <label class="field"><span>Pausa (min)</span><input type="number" min="0" max="480" step="1" data-shift-break value="${esc(String(shift.breakMinutes || 0))}" /></label>
      <label class="field"><span>Nota</span><input maxlength="240" data-shift-note value="${esc(shift.note || '')}" /></label>
      <div class="attendance-edit-actions">
        <button type="button" class="primary small" data-attendance-action="save" data-attendance-id="${esc(shift.id)}">Guardar</button>
        <button type="button" class="ghost small" data-attendance-action="cancel" data-attendance-id="${esc(shift.id)}">Cancelar</button>
      </div>
    </div>`;
    }
    return `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">${shift.open ? '●' : '◷'}</div>
      <div>
        <b>${esc(shift.date)} · ${esc(formatTime(shift.start))}${shift.end ? `–${esc(formatTime(shift.end))}` : ' · abierta'}</b>
        <small>${shift.open ? 'en curso' : formatMinutes(shift.minutes)}${shift.breakMinutes ? ` · pausa ${shift.breakMinutes} min` : ''}${shift.note ? ` · ${esc(shift.note)}` : ''}</small>
      </div>
      <div class="approval-actions">
        <button type="button" class="ghost small" data-attendance-action="edit" data-attendance-id="${esc(shift.id)}">Editar</button>
        <button type="button" class="ghost small" data-attendance-action="delete" data-attendance-id="${esc(shift.id)}">Borrar</button>
      </div>
    </div>`;
  }).join('');
}

function localInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function saveShift(button) {
  const row = button.closest('[data-shift-edit]');
  const id = button.dataset.attendanceId;
  if (!row || !id) return;
  const start = row.querySelector('[data-shift-start]')?.value || '';
  const end = row.querySelector('[data-shift-end]')?.value || '';
  const breakMinutes = Number(row.querySelector('[data-shift-break]')?.value || 0);
  const note = String(row.querySelector('[data-shift-note]')?.value || '').trim();
  if (!start) { toast('La entrada es obligatoria', 'err'); return; }
  const original = (state.data?.items || []).find((shift) => shift.id === id);
  const startDate = original && start === localInput(original.start) ? new Date(original.start) : new Date(start);
  const endDate = end
    ? (original && end === localInput(original.end) ? new Date(original.end) : new Date(end))
    : null;
  if (!Number.isFinite(startDate.getTime())) { toast('Entrada inválida', 'err'); return; }
  if (endDate && !Number.isFinite(endDate.getTime())) { toast('Salida inválida', 'err'); return; }
  setBusy(button, true);
  try {
    await api.patch(`/api/attendance/${encodeURIComponent(id)}`, {
      start: startDate.toISOString(),
      end: endDate ? endDate.toISOString() : null,
      breakMinutes,
      note
    });
    editingId = null;
    toast('Turno actualizado', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function clockIn() {
  const button = $('#attendanceIn');
  setBusy(button, true);
  try {
    await api.post('/api/attendance/clock-in', {});
    toast('Jornada abierta', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function clockOut() {
  const button = $('#attendanceOut');
  setBusy(button, true);
  try {
    await api.post('/api/attendance/clock-out', {});
    toast('Jornada cerrada', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function addBreak() {
  const value = await promptDialog({
    title: 'Registrar pausa',
    text: 'Minutos de pausa que se descuentan de la jornada abierta.',
    label: 'Minutos',
    value: '15',
    type: 'number',
    min: 1,
    max: 480
  });
  if (value === null) return;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
    toast('La pausa debe ser un entero entre 1 y 480 minutos', 'err');
    return;
  }
  const button = $('#attendanceBreak');
  setBusy(button, true);
  try {
    await api.post('/api/attendance/break', { minutes });
    toast(`Pausa de ${minutes} min registrada`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function onAction(event) {
  const button = event.target.closest('[data-attendance-action]');
  if (!button) return;
  const action = button.dataset.attendanceAction;
  if (action === 'edit') {
    editingId = button.dataset.attendanceId;
    renderList(state.data?.items || []);
    return;
  }
  if (action === 'cancel') {
    editingId = null;
    renderList(state.data?.items || []);
    return;
  }
  if (action === 'save') {
    await saveShift(button);
    return;
  }
  if (action !== 'delete') return;
  const ok = await confirmDialog({
    title: 'Borrar turno',
    text: 'Se elimina este turno y sus horas del historial. No se puede deshacer.',
    okLabel: 'Borrar',
    danger: true
  });
  if (!ok) return;
  setBusy(button, true);
  try {
    await api.del(`/api/attendance/${encodeURIComponent(button.dataset.attendanceId)}`);
    toast('Turno borrado', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function elapsedMinutes(start) {
  const from = Date.parse(start);
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, Math.round((Date.now() - from) / 60_000));
}

function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return `${hours} h ${String(rest).padStart(2, '0')} min`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}


function updateAttendancePrintStamp() {
  const stamp = $('#attendancePrintStamp');
  if (!stamp) return;
  const summary = state.data?.summary || {};
  const range = `${state.data?.from || state.from} → ${state.data?.to || state.to}`;
  const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  stamp.textContent = `Héctor Fabio Riascos C. · ${range} · ${formatMinutes(summary.minutes || 0)} · ${summary.shifts || 0} turno(s) · ${date}`;
}

function printAttendance() {
  updateAttendancePrintStamp();
  window.print();
}

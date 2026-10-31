/**
 * Salas físicas: alta, disponibilidad por día y reservas con control de cruces.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, emptyState } from './core.js';
import { openEventDialog } from './agenda.js';

let initialized = false;
let state = { date: todayKey(), rooms: [], stats: null };
let editingRoomId = null;
let editingReservationId = null;

function pad(value) {
  return String(value).padStart(2, '0');
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function initRooms() {
  if (initialized) return;
  initialized = true;
  const dateInput = $('#roomsDate');
  if (dateInput) {
    dateInput.value = state.date;
    dateInput.addEventListener('change', () => { state.date = dateInput.value || todayKey(); refresh(); });
  }
  $('#roomsRefresh')?.addEventListener('click', () => refresh());
  $('#roomForm')?.addEventListener('submit', createRoom);
  $('#roomCancelEdit')?.addEventListener('click', resetRoomForm);
  $('#reservationCancelEdit')?.addEventListener('click', resetReservationForm);
  $('#reservationForm')?.addEventListener('submit', createReservation);
  $('#roomsList')?.addEventListener('click', onAction);
}

export function renderRooms() {
  if (!initialized) initRooms();
  refresh().catch(() => {});
}

async function refresh() {
  const [list, stats] = await Promise.all([
    api.get(`/api/rooms?date=${encodeURIComponent(state.date)}`),
    api.get('/api/rooms/stats')
  ]);
  state.rooms = Array.isArray(list?.items) ? list.items : [];
  state.stats = stats || null;
  render();
}

function render() {
  const stats = $('#roomsStats');
  const summary = $('#roomsSummary');
  const free = state.rooms.filter((room) => !(room.reservations || []).length).length;
  if (stats) stats.textContent = `${state.rooms.length} sala(s) · ${free} libre(s)`;
  if (summary) summary.textContent = state.rooms.length
    ? `${state.date}: ${free} de ${state.rooms.length} salas sin reservas.`
    : 'Todavía no hay salas. Crea la primera.';
  renderSelect();
  renderList();
}

function renderSelect() {
  const select = $('#roomsSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">—</option>'
    + state.rooms.filter((room) => room.active !== false)
      .map((room) => `<option value="${esc(room.id)}">${esc(room.name)}${room.location ? ` · ${esc(room.location)}` : ''}</option>`).join('');
  if (current && state.rooms.some((room) => room.id === current)) select.value = current;
}

function renderList() {
  const box = $('#roomsList');
  if (!box) return;
  if (!state.rooms.length) {
    box.innerHTML = emptyState('No hay salas registradas. Crea una para empezar a reservar.', '▣');
    return;
  }
  box.innerHTML = state.rooms.map((room) => {
    const reservations = room.reservations || [];
    return `
      <article class="card glass">
        <div class="room-head">
          <div>
            <h3>${esc(room.name)}</h3>
            <small class="muted">${room.location ? `${esc(room.location)} · ` : ''}${room.capacity ? `${room.capacity} personas` : 'sin capacidad definida'}</small>
            ${room.notes ? `<small class="muted"> · ${esc(room.notes)}</small>` : ''}
          </div>
          <div class="room-head-actions"><button type="button" class="ghost small" data-room-action="edit-room" data-room-id="${esc(room.id)}">Editar</button><button type="button" class="ghost small" data-room-action="delete-room" data-room-id="${esc(room.id)}">Borrar sala</button></div>
        </div>
        <div class="okr-krs" style="margin-top:8px">
          ${reservations.length ? reservations.map((reservation) => `
            <div class="room-res">
              <div>
                <b>${esc(reservation.title)}</b>
                <small>${esc(reservation.start)}–${esc(reservation.end)} · ${esc(reservation.by || 'owner')}</small>
              </div>
              <div class="room-res-actions">
                <button type="button" class="ghost small" data-room-action="edit-reservation" data-reservation-id="${esc(reservation.id)}" data-room-id="${esc(room.id)}">Editar</button>
                <button type="button" class="ghost small" data-room-action="agenda-reservation" data-room-id="${esc(room.id)}" data-title="${esc(reservation.title)}" data-date="${esc(reservation.date)}" data-start="${esc(reservation.start)}" data-end="${esc(reservation.end)}">Agendar</button>
                <button type="button" class="ghost small" data-room-action="cancel-reservation" data-reservation-id="${esc(reservation.id)}">Cancelar</button>
              </div>
            </div>`).join('') : '<p class="room-free">Libre este día.</p>'}
        </div>
      </article>`;
  }).join('');
}

async function createRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#roomCreate');
  const editId = form.dataset.editId || null;
  const wasEditing = Boolean(editId);
  const name = String(form.elements.name.value || '').trim();
  if (!name) { toast('La sala necesita nombre', 'err'); return; }
  setBusy(button, true);
  const payload = {
    name,
    location: String(form.elements.location.value || '').trim(),
    capacity: Number(form.elements.capacity.value || 0),
    notes: String(form.elements.notes.value || '').trim()
  };
  try {
    if (editId) {
      await api.patch(`/api/rooms/${encodeURIComponent(editId)}`, payload);
      toast('Sala actualizada', 'ok');
    } else {
      await api.post('/api/rooms', payload);
      toast('Sala creada', 'ok');
    }
    if (wasEditing || !form.dataset.editId) resetRoomForm();
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function createReservation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#reservationCreate');
  const editId = form.dataset.editId || null;
  const roomId = String(form.elements.room.value || '');
  const title = String(form.elements.title.value || '').trim();
  const date = String(form.elements.date.value || state.date);
  const start = String(form.elements.start.value || '');
  const end = String(form.elements.end.value || '');
  if (!roomId) { toast('Elige una sala', 'err'); return; }
  if (!title) { toast('Escribe el motivo de la reserva', 'err'); return; }
  if (!date || !start || !end) { toast('Completa fecha, inicio y fin', 'err'); return; }
  setBusy(button, true);
  try {
    if (editId) {
      await api.patch(`/api/rooms/reservations/${encodeURIComponent(editId)}`, { title, date, start, end });
      toast('Reserva actualizada', 'ok');
      resetReservationForm();
    } else {
      await api.post(`/api/rooms/${encodeURIComponent(roomId)}/reservations`, { title, date, start, end, by: 'owner' });
      form.elements.title.value = '';
      toast('Sala reservada', 'ok');
    }
    state.date = date;
    const dateInput = $('#roomsDate');
    if (dateInput) dateInput.value = date;
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function onAction(event) {
  const button = event.target.closest('[data-room-action]');
  if (!button) return;
  if (button.dataset.roomAction === 'delete-room') {
    const room = state.rooms.find((item) => item.id === button.dataset.roomId);
    const ok = await confirmDialog({
      title: 'Borrar sala',
      text: `Se eliminará «${room?.name || button.dataset.roomId}». Solo se puede si no tiene reservas activas.`,
      okLabel: 'Borrar',
      danger: true
    });
    if (!ok) return;
    setBusy(button, true);
    try {
      await api.del(`/api/rooms/${encodeURIComponent(button.dataset.roomId)}`);
      toast('Sala borrada', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    } finally {
      setBusy(button, false);
    }
    return;
  }
  if (button.dataset.roomAction === 'edit-room') {
    startEditRoom(button.dataset.roomId);
    return;
  }
  if (button.dataset.roomAction === 'edit-reservation') {
    startEditReservation(button.dataset.reservationId, button.dataset.roomId);
    return;
  }
  if (button.dataset.roomAction === 'agenda-reservation') {
    const { title, date, start, end } = button.dataset;
    const room = state.rooms.find((item) => item.id === button.dataset.roomId);
    openEventDialog({
      preset: {
        title: `${title || 'Reunión'} · ${room?.name || 'sala'}`,
        start: `${date}T${start}`,
        end: `${date}T${end}`,
        type: 'Reunión',
        location: room?.location || room?.name || '',
        notes: `Reserva de ${room?.name || 'sala'} (${date} ${start}–${end}).`
      }
    });
    return;
  }
  if (button.dataset.roomAction === 'cancel-reservation') {
    const ok = await confirmDialog({
      title: 'Cancelar reserva',
      text: 'La sala quedará libre en ese horario.',
      okLabel: 'Cancelar reserva',
      danger: true
    });
    if (!ok) return;
    setBusy(button, true);
    try {
      await api.del(`/api/rooms/reservations/${encodeURIComponent(button.dataset.reservationId)}`);
      toast('Reserva cancelada', 'ok');
      await refresh();
    } catch (error) {
      toast(formatError(error), 'err');
    } finally {
      setBusy(button, false);
    }
  }
}



function startEditRoom(id) {
  const room = state.rooms.find((item) => item.id === id);
  const form = $('#roomForm');
  if (!room || !form) return;
  editingRoomId = room.id;
  form.dataset.editId = room.id;
  form.elements.name.value = room.name || '';
  form.elements.location.value = room.location || '';
  form.elements.capacity.value = String(room.capacity || 0);
  form.elements.notes.value = room.notes || '';
  const button = $('#roomCreate');
  if (button) button.textContent = 'Guardar sala';
  const cancel = $('#roomCancelEdit');
  if (cancel) cancel.hidden = false;
  form.scrollIntoView({ block: 'center' });
  form.elements.name.focus();
}

function resetRoomForm() {
  editingRoomId = null;
  const form = $('#roomForm');
  if (form) delete form.dataset.editId;
  form?.reset();
  if (form?.elements.capacity) form.elements.capacity.value = '0';
  const button = $('#roomCreate');
  if (button) button.textContent = 'Crear sala';
  const cancel = $('#roomCancelEdit');
  if (cancel) cancel.hidden = true;
}

function startEditReservation(id, roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  const reservation = room?.reservations?.find((item) => item.id === id);
  const form = $('#reservationForm');
  if (!reservation || !form) return;
  editingReservationId = reservation.id;
  form.dataset.editId = reservation.id;
  form.elements.room.value = roomId;
  form.elements.room.disabled = true;
  form.elements.title.value = reservation.title || '';
  form.elements.date.value = reservation.date || state.date;
  form.elements.start.value = reservation.start || '09:00';
  form.elements.end.value = reservation.end || '10:00';
  const button = $('#reservationCreate');
  if (button) button.textContent = 'Guardar reserva';
  const cancel = $('#reservationCancelEdit');
  if (cancel) cancel.hidden = false;
  form.scrollIntoView({ block: 'center' });
  form.elements.title.focus();
}

function resetReservationForm() {
  editingReservationId = null;
  const form = $('#reservationForm');
  if (form) delete form.dataset.editId;
  form?.reset();
  if (form?.elements.room) form.elements.room.disabled = false;
  if (form?.elements.date) form.elements.date.value = state.date;
  const button = $('#reservationCreate');
  if (button) button.textContent = 'Reservar';
  const cancel = $('#reservationCancelEdit');
  if (cancel) cancel.hidden = true;
}

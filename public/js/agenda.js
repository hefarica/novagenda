/**
 * Vista de agenda: lista editable, búsqueda, filtros, vista semanal y
 * gestión completa de citas (editar, completar, posponer, cancelar, borrar).
 * Al chocar con otro compromiso ofrece alternativas reales del servidor.
 */
import { api, formatError, isAlreadyDeleted } from './api.js';
import { checkEventTravel, generateMeet, fillEventTravel, fillPlaceDatalist, renderTravel } from './travel.js';
import { state, externalEvents } from './state.js';
import { refreshAll } from './data.js';
import {
  $, $$, esc, addDaysKey, addMinutesToInput, confirmDialog, dateKeyOf, debounce, emptyState,
  fmtDateTime, humanDuration, isDateOnly, minutesBetween, openDialog,
  priorityBadge, promptDialog, relativeDayLabel, roundToNextStep, startOfWeekKey,
  timeLabel, toast, todayKey, toZonedInput, weekKeys, labelForKey
} from './core.js';

const EVENT_COLORS = { P1: '#ff9f43', focus: '#9b7bff', google: '#20c997', normal: '#159dff' };

let draft = { id: null, type: 'Compromiso', force: false, allowUnverified: false };
let initialized = false;

export function googleItems() {
  return externalEvents().map((event) => {
    const allDay = Boolean(event.allDay) || isDateOnly(event.start);
    return {
      id: `google:${event.connectionId || 'x'}:${event.eventId || event.title}`,
      eventId: event.eventId,
      title: event.title || '(sin título)',
      start: event.start,
      end: event.end,
      allDay,
      type: 'Google',
      priority: 'EXT',
      status: 'Pendiente',
      context: event.location || '',
      notes: '',
      result: '',
      account: event.account || '',
      calendarId: event.calendarId || '',
      htmlLink: event.htmlLink || '',
      readOnly: true,
      deepFocus: false,
      google: event
    };
  });
}

export function agendaItems() {
  const local = state.agenda.map((event) => ({ ...event, readOnly: false }));
  return [...local, ...googleItems()];
}

function itemColor(item) {
  if (item.readOnly) return EVENT_COLORS.google;
  if (item.priority === 'P1') return EVENT_COLORS.P1;
  if (item.deepFocus) return EVENT_COLORS.focus;
  return EVENT_COLORS.normal;
}

function itemDayKey(item) {
  return dateKeyOf(item.start);
}

function matchesFilter(item, filter) {
  const today = todayKey();
  const key = itemDayKey(item);
  switch (filter) {
    case 'today': return key === today;
    case 'tomorrow': return key === addDaysKey(today, 1);
    case 'week': {
      const start = startOfWeekKey(today);
      return key >= start && key <= addDaysKey(start, 6);
    }
    case 'p1': return item.priority === 'P1';
    case 'focus': return Boolean(item.deepFocus);
    case 'done': return item.status === 'Hecho';
    case 'cancelled': return item.status === 'Cancelada';
    case 'pending': return item.status !== 'Hecho' && item.status !== 'Cancelada';
    default: return true;
  }
}

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function matchesQuery(item, query) {
  if (!query) return true;
  const haystack = normalize([
    item.title, item.context, item.notes, item.result, item.type, item.id,
    item.account, item.calendarId, item.owner
  ].join(' '));
  return haystack.includes(query);
}

function statusLabel(item) {
  if (item.readOnly) return `${item.account || 'Google'} · externa`;
  const parts = [item.type || 'Cita'];
  if (item.status && item.status !== 'Pendiente') parts.push(item.status);
  if (item.google) parts.push('Google ✓');
  if (item.syncError) parts.push('sync pendiente');
  return parts.join(' · ');
}

/** Muestra la vista activa de agenda (lista, semana o viajes). */
function applyAgendaMode() {
  const mode = state.ui.agendaMode || 'list';
  $$('[data-view-mode]').forEach((button) => {
    const active = button.dataset.viewMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const list = $('#agendaList');
  const week = $('#agendaWeek');
  const travel = $('#agendaTravel');
  if (list) list.hidden = mode !== 'list';
  if (week) week.hidden = mode !== 'week';
  if (travel) travel.hidden = mode !== 'travel';
}

function rowHTML(item) {
  const key = itemDayKey(item);
  const endTime = item.allDay ? '' : timeLabel(item.end);
  const duration = item.allDay ? '' : humanDuration(minutesBetween(item.start, item.end));
  const statusClass = item.status === 'Hecho' ? 'done' : item.status === 'Cancelada' ? 'cancelled' : '';
  const travelBadge = item.travel?.feasible === false || item.travelWarning
    ? `<span class="travel-warn" title="${esc(item.travelWarning || 'No llegas a tiempo')}">⚠ no llegas</span>` : '';
  const meetUrl = item.meetLink || item.meet?.link || '';
  const meetLink = meetUrl
    ? ` · <a href="${esc(meetUrl)}" target="_blank" rel="noopener noreferrer">${item.meet?.provider === 'jitsi' ? 'Jitsi' : 'Meet'} ↗</a>` : '';
  const whenMain = item.allDay ? 'Todo el día' : timeLabel(item.start);
  const whenSub = item.allDay ? labelForKey(key) : `${endTime}${duration ? ` · ${duration}` : ''}`;
  const actions = item.readOnly
    ? `${item.htmlLink ? `<a class="ghost small" href="${esc(item.htmlLink)}" target="_blank" rel="noopener noreferrer">Abrir en Google</a>` : ''}`
    : [
      `<button type="button" data-act="edit-event" data-id="${esc(item.id)}" aria-label="Editar ${esc(item.title)}">Editar</button>`,
      `<button type="button" data-act="duplicate-event" data-id="${esc(item.id)}" aria-label="Duplicar ${esc(item.title)}">Duplicar</button>`,
      item.status !== 'Hecho' && item.status !== 'Cancelada'
        ? `<button type="button" data-act="complete-event" data-id="${esc(item.id)}" aria-label="Completar ${esc(item.title)}">✓ Hecha</button>` : '',
      item.status !== 'Cancelada'
        ? `<button type="button" data-act="postpone-event" data-id="${esc(item.id)}" aria-label="Posponer ${esc(item.title)}">+30</button>` : '',
      item.status !== 'Cancelada'
        ? `<button type="button" data-act="cancel-event" data-id="${esc(item.id)}" aria-label="Cancelar ${esc(item.title)}">Cancelar</button>` : '',
      `<button type="button" data-act="delete-event" data-id="${esc(item.id)}" aria-label="Borrar definitivamente ${esc(item.title)}">Borrar</button>`
    ].join('');
  return `
    <div class="agenda-row ${statusClass}" data-id="${esc(item.id)}" style="--event:${itemColor(item)}">
      <div class="when"><b>${esc(whenMain)}</b><small>${esc(whenSub)}</small></div>
      <div class="title">
        <b title="${esc(item.title)}">${esc(item.title)}</b>
        <small>${esc(statusLabel(item))}${meetLink ? ` · ${meetLink}` : ''} ${travelBadge}</small>
      </div>
      ${priorityBadge(item.priority)}
      <div class="row-actions">${actions}</div>
    </div>`;
}

function dayGroupHTML(key, items) {
  const minutes = items.reduce((total, item) => total + (item.allDay ? 0 : minutesBetween(item.start, item.end)), 0);
  const count = items.filter((item) => item.status !== 'Cancelada').length;
  return `
    <section class="agenda-day glass" aria-label="Citas de ${esc(relativeDayLabel(key))}">
      <div class="agenda-day-head">
        <b>${esc(relativeDayLabel(key))} · ${esc(labelForKey(key))}</b>
        <span class="muted small">${count} cita${count === 1 ? '' : 's'}${minutes ? ` · ${humanDuration(minutes)}` : ''}</span>
      </div>
      ${items.map(rowHTML).join('')}
    </section>`;
}

export function renderAgenda() {
  const list = $('#agendaList');
  if (!list) return;
  applyAgendaMode();
  const query = normalize(state.ui.agendaQuery);
  const items = agendaItems()
    .filter((item) => matchesFilter(item, state.ui.agendaFilter) && matchesQuery(item, query))
    .sort((a, b) => {
      const diff = new Date(a.start) - new Date(b.start);
      if (diff) return diff;
      return String(a.title).localeCompare(String(b.title));
    });
  const groups = new Map();
  for (const item of items) {
    const key = itemDayKey(item) || 'sin-fecha';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sortedKeys = [...groups.keys()].sort();
  list.innerHTML = sortedKeys.length
    ? sortedKeys.map((key) => dayGroupHTML(key, groups.get(key).sort((a, b) => new Date(a.start) - new Date(b.start)))).join('')
    : emptyState(query ? `Ningún título coincide con «${state.ui.agendaQuery}».` : 'No hay citas con este filtro.', '▦');
  renderWeek();
}

export function renderWeek() {
  const grid = $('#weekGrid');
  if (!grid) return;
  const start = state.ui.weekStart || startOfWeekKey(todayKey());
  state.ui.weekStart = start;
  const keys = weekKeys(start);
  const today = todayKey();
  const label = $('#weekLabel');
  if (label) label.textContent = `${labelForKey(keys[0])} — ${labelForKey(keys[6])}`;
  const local = agendaItems().filter((item) => item.status !== 'Cancelada');
  /* Una rutina ya materializada como cita no debe aparecer dos veces en la semana. */
  const materialized = new Set(local.map((item) => {
    const routineId = item.routineId || item.recurrentId || item.meetingId || '';
    return `${routineId}|${itemDayKey(item)}`;
  }));
  let weekMinutes = 0;
  grid.innerHTML = keys.map((key) => {
    const events = local.filter((item) => itemDayKey(item) === key);
    const occurrences = state.occurrences.filter((occurrence) => (
      occurrence.date === key && !materialized.has(`${occurrence.routineId || ''}|${key}`)
    ));
    const entries = [
      ...events.map((item) => ({ kind: 'event', item })),
      ...occurrences.map((occurrence) => ({ kind: 'routine', occurrence }))
    ].sort((a, b) => new Date(a.kind === 'event' ? a.item.start : a.occurrence.start) - new Date(b.kind === 'event' ? b.item.start : b.occurrence.start));
    weekMinutes += events.reduce((total, item) => total + (item.allDay ? 0 : minutesBetween(item.start, item.end)), 0);
    const isToday = key === today;
    const blocks = entries.slice(0, 8).map((entry) => {
      if (entry.kind === 'routine') {
        const occurrence = entry.occurrence;
        return `<div class="week-block routine ${occurrence.skipped ? 'gdone' : ''}" title="Rutina ${esc(occurrence.routineId || '')}">
          <b>${esc(occurrence.title || 'Rutina')}</b>
          <small>${esc(timeLabel(occurrence.start))}${occurrence.skipped ? ' · omitida' : ''}</small>
        </div>`;
      }
      const item = entry.item;
      return `<button type="button" class="week-block ${item.status === 'Hecho' ? 'gdone' : ''}" style="--event:${itemColor(item)}"
        data-act="week-open" data-id="${esc(item.id)}" title="${esc(item.title)}">
        <b>${esc(item.allDay ? 'Todo el día' : timeLabel(item.start))} · ${esc(item.title)}</b>
        <small>${esc(item.type || '')}${item.readOnly ? ' · Google' : ''}</small>
      </button>`;
    }).join('');
    const more = entries.length > 8 ? `<div class="week-empty">+${entries.length - 8} más</div>` : '';
    return `<div class="week-col ${isToday ? 'today' : ''}">
      <div class="week-head">
        <b>${esc(labelForKey(key))}</b>
        <small>${entries.length} elem.${isToday ? ' · hoy' : ''}</small>
        <button type="button" class="skip-small" data-act="week-new" data-date="${key}" aria-label="Nueva cita el ${esc(labelForKey(key))}">＋ añadir</button>
      </div>
      ${entries.length ? blocks + more : '<div class="week-empty">Libre</div>'}
    </div>`;
  }).join('');
  const meta = $('#weekMeta');
  if (meta) meta.textContent = `${humanDuration(weekMinutes)} de agenda esta semana`;
}

/* ------------------------------ Diálogo de cita ------------------------------ */
function setTypeChips(type) {
  draft.type = type || 'Compromiso';
  $$('#eventTypeChips .chip').forEach((chip) => {
    const active = chip.dataset.type === draft.type;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
}

function updateDurationHint() {
  const form = $('#eventForm');
  if (!form) return;
  const start = form.elements.start.value;
  const end = form.elements.end.value;
  const hint = $('#eventDurationHint');
  if (!start || !end) { if (hint) hint.textContent = 'Indica inicio y fin.'; return; }
  const minutes = minutesBetween(`${start}:00`, `${end}:00`);
  if (hint) {
    hint.textContent = minutes > 0
      ? `Dura ${humanDuration(minutes)}. Se guarda en ${state.timezone}.`
      : 'El fin debe ser posterior al inicio.';
  }
}

export function openEventDialog({ event = null, preset = {} } = {}) {
  const form = $('#eventForm');
  if (!form) return;
  form.reset();
  draft = { id: event?.id || null, type: event?.type || preset.type || 'Compromiso', force: false, allowUnverified: false };
  $('#eventTitle').textContent = event?.id ? `Editar ${event.id}` : 'Nueva cita';
  const startValue = event?.start ? toZonedInput(event.start) : (preset.start || roundToNextStep(30));
  const endValue = event?.end ? toZonedInput(event.end) : (preset.end || addMinutesToInput(startValue, state.settings?.defaultDurationMin || 60));
  form.elements.title.value = event?.title || preset.title || '';
  form.elements.start.value = startValue;
  form.elements.end.value = endValue;
  form.elements.priority.value = event?.priority && event.priority !== 'EXT' ? event.priority : 'P2';
  form.elements.energy.value = event?.energy || 'Media';
  form.elements.reminderMin.value = event?.reminderMin ?? state.settings?.reminderMin ?? 10;
  form.elements.impact.value = event?.impact ?? 3;
  form.elements.urgency.value = event?.urgency ?? 3;
  form.elements.deepFocus.checked = Boolean(event?.deepFocus);
  form.elements.context.value = event?.context || '';
  if (form.elements.location) form.elements.location.value = event?.location || preset.location || '';
  if (form.elements.travelMode) form.elements.travelMode.value = event?.travelMode || 'auto';
  if (form.elements.attendees) form.elements.attendees.value = Array.isArray(event?.attendees) ? event.attendees.join(', ') : '';
  fillPlaceDatalist();
  fillEventTravel(event);
  form.elements.result.value = event?.result || '';
  form.elements.notes.value = event?.notes || preset.notes || '';
  setTypeChips(draft.type);
  updateImpactHints();
  updateDurationHint();
  $('#eventAlternatives').hidden = true;
  $('#eventSlots').innerHTML = '';
  $('#eventAllowUnverified').checked = false;
  const alertBox = $('#eventAlert');
  alertBox.hidden = true;
  alertBox.className = 'alert';
  $('#eventMeta').textContent = event
    ? `${event.id} · creada ${event.createdAt ? fmtDateTime(event.createdAt) : 'sin fecha'}${event.google ? ' · vinculada a Google' : ''}`
    : `Se validan fechas imposibles y choques antes de guardar. Zona: ${state.timezone}`;
  openDialog('#dlg-event');
}

function updateImpactHints() {
  const form = $('#eventForm');
  if (!form) return;
  const impact = Number(form.elements.impact.value || 3);
  const urgency = Number(form.elements.urgency.value || 3);
  const impactHint = $('#impactHint');
  const urgencyHint = $('#urgencyHint');
  if (impactHint) impactHint.textContent = `Impacto ${impact}${impact >= 5 ? ' · mueve el objetivo' : impact <= 2 ? ' · bajo' : ''}`;
  if (urgencyHint) urgencyHint.textContent = `Urgencia ${urgency}${urgency >= 5 ? ' · hoy' : urgency <= 2 ? ' · puede esperar' : ''}`;
}

function eventPayload() {
  const form = $('#eventForm');
  const elements = form.elements;
  return {
    title: elements.title.value.trim(),
    start: `${elements.start.value}:00`,
    end: `${elements.end.value}:00`,
    type: draft.type,
    priority: elements.priority.value,
    energy: elements.energy.value,
    impact: Number(elements.impact.value),
    urgency: Number(elements.urgency.value),
    reminderMin: Number(elements.reminderMin.value || 0),
    deepFocus: elements.deepFocus.checked,
    context: elements.context.value.trim(),
    result: elements.result.value.trim(),
    notes: elements.notes.value.trim(),
    location: elements.location ? elements.location.value.trim() : '',
    travelMode: elements.travelMode ? elements.travelMode.value : 'auto',
    attendees: elements.attendees
      ? elements.attendees.value.split(/[,;]+/).map((value) => value.trim()).filter(Boolean)
      : []
  };
}

function showEventAlert(message, kind = 'error') {
  const box = $('#eventAlert');
  if (!box) return;
  box.hidden = false;
  box.className = `alert${kind === 'warn' ? ' warn' : kind === 'info' ? ' info' : ''}`;
  box.textContent = message;
}

async function submitEvent({ force = false } = {}) {
  const form = $('#eventForm');
  const payload = eventPayload();
  if (!payload.title) { showEventAlert('Ponle un nombre a la actividad.'); form.elements.title.focus(); return; }
  if (!form.elements.start.value || !form.elements.end.value) { showEventAlert('Indica inicio y fin.'); return; }
  if (minutesBetween(`${form.elements.start.value}:00`, `${form.elements.end.value}:00`) <= 0) {
    showEventAlert('El fin debe ser posterior al inicio.'); return;
  }
  const body = { ...payload };
  if (draft.allowUnverified) body.allowUnverified = true;
  if (force || draft.force) body.force = true;
  const save = $('#eventSave');
  save.disabled = true;
  try {
    let savedId = draft.id;
    if (draft.id) {
      const result = await api.patch(`/api/agenda/${draft.id}`, body);
      const changed = Array.isArray(result?.changed) ? result.changed : [];
      toast(changed.length ? `Actualizado: ${changed.join(', ')}` : 'Cita actualizada', 'ok');
    } else {
      const result = await api.post('/api/agenda', body);
      savedId = result?.item?.id || null;
      toast(`Creada ${savedId || 'cita'}`, 'ok');
    }
    draft.force = false;
    if (savedId && body.location) {
      const travel = await checkEventTravel(savedId).catch(() => null);
      if (travel?.feasible === false) {
        toast('No llegas a tiempo a esa cita. Revisa las alternativas en Agenda → Viajes.', 'warn');
      }
    }
    $('#dlg-event').close();
    await refreshAll();
  } catch (error) {
    if (error?.status === 409 && error.code === 'CONFLICT') {
      const conflicts = error.details?.conflicts || [];
      showEventAlert(`Choque de horario con ${conflicts.length || 'otro'} compromiso(s). Busca un hueco libre o fuerza el alta.`, 'warn');
      const alternatives = $('#eventAlternatives');
      alternatives.hidden = false;
      alternatives.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      await loadSlots();
    } else if (error?.status === 409 && error.code === 'FREEBUSY_UNAVAILABLE') {
      showEventAlert('No se pudo verificar Google Calendar (FreeBusy). Puedes agendar aceptando el riesgo con la casilla de abajo.', 'warn');
      $('#eventAlternatives').hidden = false;
      $('#eventAllowUnverified').checked = true;
      draft.allowUnverified = true;
    } else if (error?.code === 'INVALID_DATE' || error?.code === 'INVALID_RANGE') {
      showEventAlert(`${error.message}${error.field ? ` (campo: ${error.field})` : ''}`);
    } else if (error?.code === 'FIELD_NOT_EDITABLE' || error?.code === 'UNKNOWN_FIELD') {
      showEventAlert(`${error.message} (campo: ${error.field})`);
    } else {
      showEventAlert(formatError(error));
    }
  } finally {
    save.disabled = false;
  }
}

async function loadSlots() {
  const container = $('#eventSlots');
  if (!container) return;
  container.innerHTML = '<div class="loading"><span class="spin" aria-hidden="true"></span> Buscando huecos…</div>';
  const form = $('#eventForm');
  const duration = Math.max(5, minutesBetween(`${form.elements.start.value}:00`, `${form.elements.end.value}:00`) || 30);
  const from = form.elements.start.value || '';
  const query = new URLSearchParams({ durationMin: String(duration), days: '7', count: '4' });
  if (from) query.set('from', `${from}:00`);
  if (draft.id) query.set('ignoreId', draft.id);
  try {
    const result = await api.get(`/api/agenda/slots?${query.toString()}`);
    const slots = Array.isArray(result?.slots) ? result.slots : [];
    if (!slots.length) {
      container.innerHTML = `<p class="hint">No encontré huecos libres de ${humanDuration(duration)} en los próximos 7 días dentro de tu jornada.</p>`;
      return;
    }
    container.innerHTML = slots.map((slot) => `
      <button type="button" class="slot" data-slot-start="${esc(slot.start)}" data-slot-end="${esc(slot.end)}">
        <span>${esc(relativeDayLabel(dateKeyOf(slot.start)))} · ${esc(timeLabel(slot.start))}–${esc(timeLabel(slot.end))}</span>
        <small>${esc(slot.weekday || '')}${slot.unverified ? ' · sin verificar' : ''}</small>
      </button>`).join('') + (result.unknown ? '<p class="hint">Google no confirmó disponibilidad: los huecos son parciales.</p>' : '');
  } catch (error) {
    container.innerHTML = `<p class="hint">No se pudieron calcular alternativas: ${esc(formatError(error))}</p>`;
  }
}

async function completeEvent(id) {
  const event = state.agenda.find((item) => item.id === id);
  if (!event) return;
  const form = $('#completeForm');
  form.reset();
  $('#completeTitle').textContent = `Completar ${event.id}`;
  $('#completeSubtitle').textContent = `${event.title} · ${fmtDateTime(event.start)}`;
  const planned = Number(event.plannedMin) || minutesBetween(event.start, event.end) || 30;
  form.elements.actualMin.value = planned;
  form.elements.notes.value = event.notes || '';
  form.dataset.id = id;
  openDialog('#dlg-complete');
}

async function postponeEvent(id, minutes) {
  const event = state.agenda.find((item) => item.id === id);
  if (!event) return;
  const previousStart = event.start;
  const previousEnd = event.end;
  const start = new Date(new Date(event.start).getTime() + minutes * 60000).toISOString();
  const end = new Date(new Date(event.end).getTime() + minutes * 60000).toISOString();
  try {
    await api.patch(`/api/agenda/${id}`, { start, end });
    toast(`Movida ${minutes > 0 ? '+' : ''}${minutes} min · 10 s para deshacer`, 'ok', {
      actionLabel: 'Deshacer',
      duration: 10000,
      onAction: async () => {
        try {
          await api.patch(`/api/agenda/${id}`, { start: previousStart, end: previousEnd });
          toast('Horario restaurado', 'ok');
          await refreshAll();
        } catch (undoError) { toast(formatError(undoError), 'err'); }
      }
    });
    await refreshAll();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

/* ------------------------------ Semana ------------------------------ */
function shiftWeek(delta) {
  const start = state.ui.weekStart || startOfWeekKey(todayKey());
  state.ui.weekStart = addDaysKey(start, delta * 7);
  renderWeek();
}

/* ------------------------------ Eventos ------------------------------ */
export function initAgenda() {
  if (initialized) return;
  initialized = true;

  $$('[data-filter]').forEach((chip) => chip.addEventListener('click', () => {
    state.ui.agendaFilter = chip.dataset.filter;
    $$('[data-filter]').forEach((other) => {
      const active = other === chip;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    renderAgenda();
  }));

  const search = $('#agendaSearch');
  if (search) {
    const apply = debounce(() => { state.ui.agendaQuery = search.value; renderAgenda(); }, 140);
    search.addEventListener('input', apply);
  }

  $$('[data-view-mode]').forEach((button) => button.addEventListener('click', () => {
    state.ui.agendaMode = button.dataset.viewMode;
    $$('[data-view-mode]').forEach((other) => {
      const active = other === button;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    applyAgendaMode();
    if (state.ui.agendaMode === 'week') renderWeek();
    if (state.ui.agendaMode === 'travel') renderTravel();
  }));

  $('#agendaNewBtn')?.addEventListener('click', () => openEventDialog({}));
  $('#agendaPrintBtn')?.addEventListener('click', () => { updatePrintStamp(); window.print(); });
  window.addEventListener('beforeprint', updatePrintStamp);
  $('#agendaIcsBtn')?.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = '/api/agenda/export.ics';
    link.download = 'agenda.ics';
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast('Copia .ics descargada; impórtala en tu calendario', 'ok');
  });
  $('#weekPrev')?.addEventListener('click', () => shiftWeek(-1));
  $('#weekNext')?.addEventListener('click', () => shiftWeek(1));
  $('#weekToday')?.addEventListener('click', () => { state.ui.weekStart = startOfWeekKey(todayKey()); renderWeek(); });

  $('#agendaList')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    const id = action.dataset.id;
    handleAgendaAction(action.dataset.act, id, action);
  });

  $('#weekGrid')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    if (action.dataset.act === 'week-new') {
      openEventDialog({ preset: { start: `${action.dataset.date}T09:00` } });
      return;
    }
    if (action.dataset.act === 'week-open') {
      const item = agendaItems().find((entry) => entry.id === action.dataset.id);
      if (item && !item.readOnly) openEventDialog({ event: item });
      else if (item?.htmlLink) window.open(item.htmlLink, '_blank', 'noopener');
    }
  });

  $('#eventTypeChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-type]');
    if (chip) setTypeChips(chip.dataset.type);
  });

  $('#eventDurationChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-min]');
    if (!chip) return;
    const form = $('#eventForm');
    form.elements.end.value = addMinutesToInput(`${form.elements.start.value}:00`, Number(chip.dataset.min));
    updateDurationHint();
  });

  const eventForm = $('#eventForm');
  eventForm?.elements.start.addEventListener('change', () => {
    const form = $('#eventForm');
    const start = form.elements.start.value;
    const end = form.elements.end.value;
    if (!end || minutesBetween(`${start}:00`, `${end}:00`) <= 0) {
      form.elements.end.value = addMinutesToInput(`${start}:00`, Number(state.settings?.defaultDurationMin) || 60);
    }
    updateDurationHint();
  });
  eventForm?.elements.end.addEventListener('change', updateDurationHint);
  eventForm?.elements.impact.addEventListener('input', updateImpactHints);
  eventForm?.elements.urgency.addEventListener('input', updateImpactHints);

  eventForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitEvent();
  });

  $('#eventTravelCheck')?.addEventListener('click', async () => {
    if (!draft.id) { toast('Guarda la cita y vuelve a abrirla para comprobar el viaje.', 'warn'); return; }
    await checkEventTravel(draft.id);
  });
  $('#eventMeetBtn')?.addEventListener('click', async () => {
    if (!draft.id) { toast('Guarda la cita primero para generar el Meet.', 'warn'); return; }
    await generateMeet(draft.id);
    await refreshAll();
  });

  $('#eventFindSlots')?.addEventListener('click', () => loadSlots());
  $('#eventForce')?.addEventListener('click', () => submitEvent({ force: true }));
  $('#eventAllowUnverified')?.addEventListener('change', (event) => {
    draft.allowUnverified = event.target.checked;
  });

  $('#eventSlots')?.addEventListener('click', (event) => {
    const slot = event.target.closest('[data-slot-start]');
    if (!slot) return;
    const form = $('#eventForm');
    form.elements.start.value = toZonedInput(slot.dataset.slotStart);
    form.elements.end.value = toZonedInput(slot.dataset.slotEnd);
    updateDurationHint();
    toast('Horario aplicado. Guarda para confirmar.');
  });

  $('#completeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.dataset.id;
    if (!id) return;
    const actualMin = Number(form.elements.actualMin.value);
    if (!Number.isFinite(actualMin) || actualMin < 0) { toast('Minutos reales inválidos', 'err'); return; }
    try {
      await api.post(`/api/agenda/${id}/complete`, { actualMin, notes: form.elements.notes.value.trim() });
      $('#dlg-complete').close();
      toast('Cita completada', 'ok');
      await refreshAll();
    } catch (error) {
      toast(formatError(error), 'err');
    }
  });
}

export async function handleAgendaAction(action, id, element) {
  if (!action) return;
  const item = agendaItems().find((entry) => entry.id === id);
  if (action === 'edit-event') {
    if (item && !item.readOnly) openEventDialog({ event: item });
    return;
  }
  if (action === 'duplicate-event') {
    if (item && !item.readOnly) {
      openEventDialog({ event: { ...item, id: null, google: null, createdAt: null, updatedAt: null, htmlLink: null, readOnly: false } });
    }
    return;
  }
  if (action === 'complete-event') { await completeEvent(id); return; }
  if (action === 'postpone-event') {
    const minutes = await promptDialog({
      title: 'Posponer cita',
      text: 'Minutos para mover el inicio y el fin. Usa un número negativo para adelantarla.',
      label: 'Minutos',
      value: '30',
      type: 'number',
      min: -10080,
      max: 10080,
      step: 5
    });
    if (minutes === null) return;
    await postponeEvent(id, Number(minutes) || 0);
    return;
  }
  if (action === 'cancel-event') {
    const ok = await confirmDialog({
      title: 'Cancelar cita',
      text: 'La cita quedará como Cancelada (no se borra) y se sincronizará con Google si estaba vinculada.',
      okLabel: 'Cancelar cita',
      danger: true
    });
    if (!ok) return;
    await cancelEvent(id);
    return;
  }
  if (action === 'delete-event') {
    const ok = await confirmDialog({
      title: 'Borrar definitivamente',
      text: 'Se elimina la cita del almacén (no queda registro). Si estaba en Google también se intentará borrar allí.',
      okLabel: 'Borrar',
      danger: true
    });
    if (!ok) return;
    await hardDeleteEvent(id);
  }
}

/**
 * Cancela una cita (borrado lógico). Si falla por red, ofrece "Reintentar"
 * sin volver a pedir confirmación (ya estaba confirmado).
 */
async function cancelEvent(id) {
  const previous = state.agenda.find((item) => item.id === id);
  try {
    const result = await api.del(`/api/agenda/${id}`);
    const undone = isAlreadyDeleted(result);
    toast(undone ? 'La cita ya estaba cancelada' : 'Cita cancelada · tienes 10 s para deshacer', 'ok', {
      actionLabel: undone ? '' : 'Deshacer',
      duration: 10000,
      onAction: undone ? null : async () => {
        try {
          await api.patch(`/api/agenda/${id}`, { status: previous?.status || 'Pendiente' });
          toast('Cita restaurada', 'ok');
          await refreshAll();
        } catch (undoError) { toast(formatError(undoError), 'err'); }
      }
    });
    await refreshAll();
  } catch (error) {
    toast(formatError(error), 'err', {
      actionLabel: 'Reintentar',
      onAction: () => cancelEvent(id)
    });
  }
}

/**
 * Borra definitivamente una cita. Reintento manual desde el aviso; el cliente
 * ya reintenta solo una vez los DELETE y trata el 404 del reintento como éxito.
 */
async function hardDeleteEvent(id) {
  try {
    const result = await api.del(`/api/agenda/${id}/hard`);
    toast(isAlreadyDeleted(result) ? 'La cita ya estaba borrada' : 'Cita borrada', 'ok');
    await refreshAll();
  } catch (error) {
    toast(formatError(error), 'err', {
      actionLabel: 'Reintentar',
      onAction: () => hardDeleteEvent(id)
    });
  }
}

export function focusSearch() {
  const input = $('#agendaSearch');
  if (input) { input.focus(); input.select(); }
}




function updatePrintStamp() {
  const stamp = $('#agendaPrintStamp');
  if (!stamp) return;
  const tz = state.timezone || 'America/Bogota';
  const now = new Date();
  const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: tz }).format(now);
  const time = new Intl.DateTimeFormat('es-CO', { timeStyle: 'short', timeZone: tz }).format(now);
  stamp.textContent = `Héctor Fabio Riascos C. · ${date} · ${time}`;
}

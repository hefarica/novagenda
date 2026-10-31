/**
 * Rutinas: listado, creación/edición guiada, activar/pausar, saltar un día,
 * vista de próximas apariciones y modo "escribir con lenguaje natural".
 */
import { api } from './api.js';
import { state } from './state.js';
import { refreshAll } from './data.js';
import { interpretRoutineText } from './nlp.js';
import {
  $, $$, daysFromRule, esc, confirmDialog, debounce, emptyState, humanDuration,
  humanFrequency, normalizeRuleFromDays, openDialog, relativeDayLabel, timeLabel, toast,
  todayKey
} from './core.js';

const PURPOSE_PREFIX = 'Propósito: ';
const BASE_ROUTINES = [
  { title: 'Plan diario + Top 3', frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '07:00', durationMin: 15, type: 'Administrativo', result: 'Top 3 definidos y agenda saneada', priority: 'P1', impact: 5, urgency: 5, reminderMin: 10, deepFocus: false, role: 'plan', purpose: 'Decidir el día antes de que el día decida por ti.' },
  { title: 'Bloque de foco #1', frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '07:30', durationMin: 90, type: 'Foco', result: 'Avance verificable del objetivo principal', priority: 'P1', impact: 5, urgency: 4, reminderMin: 10, deepFocus: true, purpose: 'Proteger la mejor energía para el trabajo que mueve la aguja.' },
  { title: 'Procesar INBOX', frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '11:45', durationMin: 15, type: 'Administrativo', result: 'Inbox procesado, delegado o agendado', priority: 'P2', impact: 4, urgency: 3, reminderMin: 5, deepFocus: false, purpose: 'Vaciar la bandeja en un bloque acotado, no todo el día.' },
  { title: 'Cierre diario', frequency: 'LABORABLES', rule: 'LUN-MAR-MIE-JUE-VIE', time: '17:30', durationMin: 15, type: 'Administrativo', result: 'Pendientes cerrados o reprogramados', priority: 'P1', impact: 5, urgency: 4, reminderMin: 10, deepFocus: false, role: 'close', purpose: 'Cerrar el bucle mental para poder descansar de verdad.' },
  { title: 'Revisión semanal P95', frequency: 'SEMANAL', rule: 'VIE', time: '16:30', durationMin: 45, type: 'Reporte', result: 'Informe y plan de la siguiente semana', priority: 'P1', impact: 5, urgency: 4, reminderMin: 30, deepFocus: false, role: 'weeklyReview', purpose: 'Comparar plan vs realidad y ajustar el sistema.' },
  { title: 'Revisión mensual y OKR', frequency: 'MENSUAL', rule: '1', time: '08:00', durationMin: 60, type: 'Reporte', result: 'Objetivos y prioridades actualizados', priority: 'P1', impact: 5, urgency: 4, reminderMin: 60, deepFocus: true, purpose: 'Mirar el mes completo y decidir qué se abandona.' }
];

let draft = {
  id: null,
  kind: 'recurrence',
  type: 'Foco',
  frequency: 'LABORABLES',
  days: ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'],
  monthDay: 1,
  active: true
};
let initialized = false;
let previewController = null;

/* ----------------------------- utilidades ----------------------------- */
function splitPurpose(routine) {
  const notes = String(routine?.notes || '');
  const purpose = String(routine?.purpose || '');
  if (purpose) return { purpose, notes };
  const match = new RegExp(`^${PURPOSE_PREFIX}([^\\n]*)\\n?`).exec(notes);
  if (match) return { purpose: match[1].trim(), notes: notes.slice(match[0].length) };
  return { purpose: '', notes };
}

function composeNotes(purpose, notes, kind) {
  if (kind === 'meeting') return notes;
  return purpose ? `${PURPOSE_PREFIX}${purpose}\n${notes}`.trim() : notes;
}

function routinePurposeText(routine) {
  return splitPurpose(routine).purpose;
}

export function routineOccurrencesFor(routineId) {
  return state.occurrences.filter((occurrence) => occurrence.routineId === routineId);
}

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isVisible(routine) {
  const filter = state.ui.routineFilter;
  if (filter === 'meeting' && routine.kind !== 'meeting') return false;
  if (filter === 'recurrence' && routine.kind !== 'recurrence') return false;
  if (filter === 'paused' && routine.active) return false;
  const query = normalize(state.ui.routineQuery);
  if (!query) return true;
  return normalize(`${routine.title} ${routine.id} ${routine.notes} ${routine.purpose} ${routine.result}`).includes(query);
}

/* ----------------------------- render ----------------------------- */
function occurrencesChips(routine) {
  const items = routineOccurrencesFor(routine.id).slice(0, 7);
  if (!items.length) {
    return routine.nextDate
      ? `<span class="occurrence muted">Próxima: ${esc(relativeDayLabel(routine.nextDate))} · ${esc(timeLabel(routine.nextStart))}</span>`
      : '<span class="occurrence muted">Sin apariciones próximas</span>';
  }
  return items.map((occurrence) => `
    <span class="occurrence ${occurrence.skipped ? 'skipped' : ''}" title="${esc(occurrence.date)} ${esc(timeLabel(occurrence.start))}">
      ${esc(relativeDayLabel(occurrence.date))} · ${esc(timeLabel(occurrence.start))}${occurrence.skipped ? ' · omitida' : ''}
    </span>`).join('');
}

function routineCard(routine) {
  const purpose = routinePurposeText(routine);
  const kindLabel = routine.kind === 'meeting' ? 'Reunión' : 'Rutina';
  const channels = [
    routine.whatsapp ? 'recordatorio' : '',
    routine.calendar ? 'Calendar' : ''
  ].filter(Boolean).join(' · ');
  return `
  <article class="routine-card ${routine.active ? '' : 'paused'}" data-routine-id="${esc(routine.id)}">
    <div class="routine-top">
      <div class="grow">
        <h3>
          <span aria-hidden="true">${routine.kind === 'meeting' ? '👥' : routine.type === 'Foco' ? '🎯' : '↻'}</span>
          ${esc(routine.title)}
          <span class="tag ${routine.active ? 'ok' : 'off'}">${routine.active ? 'Activa' : 'Pausada'}</span>
          ${routine.invalid ? '<span class="tag bad">Hora inválida</span>' : ''}
        </h3>
        <div class="routine-meta">
          <span class="tag">${esc(kindLabel)}</span>
          <span class="tag">${routine.priority || 'P2'}</span>
          <span class="tag">${esc(humanFrequency(routine))}</span>
          <span class="tag">${esc(routine.time || '—')} · ${esc(humanDuration(routine.durationMin))}</span>
          <span class="tag">${esc(routine.type || '')}</span>
          ${routine.role ? `<span class="tag">rol: ${esc(routine.role)}</span>` : ''}
          ${routine.reminderMin ? `<span class="tag">aviso ${Number(routine.reminderMin)} min</span>` : ''}
          ${channels ? `<span class="tag">${esc(channels)}</span>` : ''}
        </div>
        ${purpose ? `<p class="routine-purpose">${esc(purpose)}</p>` : ''}
        ${routine.result ? `<p class="routine-purpose"><b>Resultado:</b> ${esc(routine.result)}</p>` : ''}
      </div>
      <label class="switch" title="Activar o pausar">
        <input type="checkbox" data-act="toggle-routine" data-id="${esc(routine.id)}" ${routine.active ? 'checked' : ''} aria-label="Activar ${esc(routine.title)}" />
        <span></span>
      </label>
    </div>
    <div class="occurrence-chips" aria-label="Próximas apariciones de ${esc(routine.title)}">${occurrencesChips(routine)}</div>
    <div class="routine-actions">
      <button type="button" class="ghost small" data-act="edit-routine" data-id="${esc(routine.id)}">Editar</button>
              <button type="button" class="ghost small" data-act="duplicate-routine" data-id="${esc(routine.id)}">Duplicar</button>
      <button type="button" class="ghost small" data-act="skip-routine" data-id="${esc(routine.id)}">Saltar hoy</button>
      <button type="button" class="ghost small" data-act="preview-routine" data-id="${esc(routine.id)}" aria-expanded="false">Ver 7 próximas</button>
      ${routine.kind === 'meeting' ? `<button type="button" class="secondary small" data-act="meeting-acta" data-id="${esc(routine.id)}">Acta</button>` : ''}
      <button type="button" class="secondary small" data-act="delete-routine" data-id="${esc(routine.id)}">Eliminar</button>
    </div>
    <div class="preview-list hidden" data-preview-for="${esc(routine.id)}"></div>
  </article>`;
}

export function renderRoutines() {
  const container = $('#routinesList');
  if (!container) return;
  const routines = state.routines.filter(isVisible);
  const active = routines.filter((routine) => routine.active);
  const meetingCount = routines.filter((routine) => routine.kind === 'meeting').length;
  container.innerHTML = routines.length
    ? routines
      .slice()
      .sort((a, b) => Number(b.active) - Number(a.active) || String(a.time).localeCompare(String(b.time)))
      .map(routineCard)
      .join('')
    : emptyState(
      state.routines.length
        ? 'Ninguna rutina coincide con el filtro o la búsqueda.'
        : 'Aún no tienes rutinas. Carga la base P95 en un clic o crea la primera.',
      '↻'
    );
  const meta = $('#routineTodayMeta');
  if (meta) meta.textContent = `${active.length} activa${active.length === 1 ? '' : 's'}${meetingCount ? ` · ${meetingCount} reunión(es)` : ''}`;
}

/* ----------------------------- formulario ----------------------------- */
function setKind(kind) {
  draft.kind = kind === 'meeting' ? 'meeting' : 'recurrence';
  $$('#routineKindChips .chip').forEach((chip) => {
    const active = chip.dataset.kind === draft.kind;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  const titleLabel = $('#routineForm [name="title"]')?.closest('.field')?.querySelector('span');
  if (titleLabel) titleLabel.textContent = draft.kind === 'meeting' ? 'Nombre de la reunión *' : 'Nombre de la rutina *';
}

function setFrequency(frequency) {
  draft.frequency = frequency;
  $$('#routineFreqChips .chip').forEach((chip) => {
    const active = chip.dataset.freq === frequency;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  const weekly = frequency === 'SEMANAL';
  const monthly = frequency === 'MENSUAL' || frequency === 'TRIMESTRAL';
  const ruleWrap = $('#routineRuleWrap');
  const weekdayWrap = $('#routineWeekdayChipsWrap');
  const monthWrap = $('#routineMonthDayWrap');
  if (ruleWrap) ruleWrap.hidden = !(weekly || monthly);
  if (weekdayWrap) weekdayWrap.hidden = !weekly;
  if (monthWrap) monthWrap.hidden = !monthly;
  const hint = $('#freqHint');
  if (hint) {
    hint.textContent = weekly
      ? 'Elige los días. Se generará una cita por cada día marcado.'
      : monthly
        ? 'Si el mes no tiene ese día se usa el último disponible (31 → 28/29/30).'
        : frequency === 'LABORABLES'
          ? 'Lunes a viernes según tus ajustes de jornada y festivos.'
          : 'Se generará una cita cada día.';
  }
  schedulePreview();
}

function setType(type) {
  draft.type = type;
  $$('#routineTypeChips .chip').forEach((chip) => {
    const active = chip.dataset.type === type;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
}

function setDays(days) {
  draft.days = [...new Set(days)];
  $$('#routineWeekdayChips .chip').forEach((chip) => {
    const active = draft.days.includes(chip.dataset.day);
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  schedulePreview();
}

function currentRule() {
  if (draft.frequency === 'SEMANAL') return normalizeRuleFromDays(draft.days.length ? draft.days : ['LUN']);
  if (draft.frequency === 'MENSUAL' || draft.frequency === 'TRIMESTRAL') return String(draft.monthDay || 1);
  if (draft.frequency === 'LABORABLES') return 'LUN-MAR-MIE-JUE-VIE';
  return '';
}

function readForm() {
  const form = $('#routineForm');
  const elements = form.elements;
  const purpose = elements.purpose.value.trim();
  const notes = elements.notes.value.trim();
  return {
    kind: draft.kind,
    active: draft.active,
    title: elements.title.value.trim(),
    frequency: draft.frequency,
    rule: currentRule(),
    time: elements.time.value || '09:00',
    durationMin: Number(elements.durationMin.value || 30),
    type: draft.type,
    priority: elements.priority.value,
    impact: Number(elements.impact.value || 3),
    urgency: Number(elements.urgency.value || 3),
    deepFocus: elements.deepFocus.checked,
    energy: elements.deepFocus.checked ? 'Alta' : 'Media',
    reminderMin: Number(elements.reminderMin.value || 0),
    whatsapp: elements.whatsapp.checked,
    calendar: elements.calendar.checked,
    skipHolidays: elements.skipHolidays.checked,
    purpose,
    result: elements.result.value.trim(),
    startDate: elements.startDate.value || undefined,
    endDate: elements.endDate.value || undefined,
    role: elements.role.value || undefined,
    notes: composeNotes(purpose, notes, draft.kind)
  };
}

function fillForm(routine) {
  const form = $('#routineForm');
  const elements = form.elements;
  const { purpose, notes } = splitPurpose(routine || {});
  elements.title.value = routine?.title || '';
  elements.time.value = routine?.time || '09:00';
  elements.durationMin.value = routine?.durationMin || 30;
  elements.reminderMin.value = routine?.reminderMin ?? 10;
  elements.priority.value = routine?.priority || 'P2';
  elements.impact.value = routine?.impact ?? 3;
  elements.urgency.value = routine?.urgency ?? 3;
  elements.purpose.value = purpose;
  elements.result.value = routine?.result || routine?.requiredOutput || '';
  elements.startDate.value = routine?.startDate || '';
  elements.endDate.value = routine?.endDate || '';
  elements.notes.value = notes;
  elements.role.value = routine?.role || '';
  elements.deepFocus.checked = Boolean(routine?.deepFocus);
  elements.whatsapp.checked = routine ? Boolean(routine.whatsapp ?? routine.whatsappReminder) : true;
  elements.calendar.checked = routine ? Boolean(routine.calendar) : true;
  elements.skipHolidays.checked = routine ? Boolean(routine.skipHolidays) : true;
  elements.monthDay.value = /^\d{1,2}$/.test(String(routine?.rule || '')) ? routine.rule : 1;
  setKind(routine?.kind || 'recurrence');
  setType(routine?.type && ['Foco', 'Administrativo', 'Reunión', 'Reporte'].includes(routine.type) ? routine.type : (routine?.deepFocus ? 'Foco' : 'Administrativo'));
  setFrequency(routine?.frequency || 'LABORABLES');
  const rule = routine?.rule || 'LUN-MAR-MIE-JUE-VIE';
  const days = daysFromRule(rule);
  setDays(days.length ? days : ['LUN', 'MAR', 'MIE', 'JUE', 'VIE']);
}

function openRoutineDialog({ routine = null, prefill = null } = {}) {
  const form = $('#routineForm');
  if (!form) return;
  form.reset();
  draft = {
    id: routine?.id || null,
    kind: routine?.kind || prefill?.kind || 'recurrence',
    type: routine?.type || prefill?.type || 'Foco',
    frequency: routine?.frequency || prefill?.frequency || 'LABORABLES',
    days: daysFromRule(routine?.rule || prefill?.rule || 'LUN-MAR-MIE-JUE-VIE'),
    monthDay: Number(prefill?.rule) || 1,
    active: routine ? Boolean(routine.active) : true
  };
  if (!draft.days.length) draft.days = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'];
  $('#routineTitle').textContent = routine?.id ? `Editar ${routine.id}` : 'Nueva rutina';
  fillForm(routine);
  if (prefill) {
    const elements = form.elements;
    elements.title.value = prefill.title || '';
    elements.time.value = prefill.time || '09:00';
    elements.durationMin.value = prefill.durationMin || 30;
    elements.purpose.value = prefill.purpose || '';
    elements.result.value = prefill.result || '';
    elements.notes.value = prefill.notes || '';
    elements.reminderMin.value = prefill.reminderMin ?? 10;
    elements.priority.value = prefill.priority || 'P2';
    elements.deepFocus.checked = Boolean(prefill.deepFocus);
    if (prefill.frequency === 'SEMANAL') {
      const days = daysFromRule(prefill.rule);
      if (days.length) setDays(days);
    }
    if (prefill.frequency === 'MENSUAL' || prefill.frequency === 'TRIMESTRAL') {
      elements.monthDay.value = Number(prefill.rule) || 1;
      draft.monthDay = Number(prefill.rule) || 1;
    }
    setType(['Foco', 'Administrativo', 'Reunión', 'Reporte'].includes(prefill.type) ? prefill.type : 'Administrativo');
    setKind(prefill.kind || 'recurrence');
    setFrequency(prefill.frequency || 'LABORABLES');
  }
  const alertBox = $('#routineAlert');
  alertBox.hidden = true;
  $('#routinePreview').innerHTML = '<p class="hint">Completa el nombre y los datos para ver la vista previa.</p>';
  $('#routinePreviewSummary').innerHTML = '';
  $('#routinePreviewMeta').textContent = '';
  openDialog('#dlg-routine');
  schedulePreview();
}

function previewDraft(fields) {
  return api.post('/api/routines/preview', { ...fields, count: 7 }, { timeoutMs: 12000 });
}

function renderPreviewError(message) {
  const box = $('#routinePreview');
  if (box) box.innerHTML = `<p class="hint">${esc(message)}</p>`;
}

function renderPreview(result) {
  const box = $('#routinePreview');
  const summary = $('#routinePreviewSummary');
  const meta = $('#routinePreviewMeta');
  const items = Array.isArray(result?.items) ? result.items : [];
  if (meta) meta.textContent = `${items.length} aparición(es)`;
  if (!items.length) {
    box.innerHTML = '<p class="hint">No hay apariciones con esta configuración. Revisa la fecha de vigencia o los días.</p>';
    summary.innerHTML = '';
    return;
  }
  box.innerHTML = items.map((occurrence) => `
    <div class="preview-item ${occurrence.skipped ? 'skipped' : ''}">
      <span>${esc(relativeDayLabel(occurrence.date))} · ${esc(timeLabel(occurrence.start))}–${esc(timeLabel(occurrence.end))}</span>
      <small>${occurrence.skipped ? 'omitida' : esc(occurrence.due ? 'genera cita' : '')}</small>
    </div>`).join('');
  const first = items.find((occurrence) => !occurrence.skipped) || items[0];
  summary.innerHTML = `
    <div><b>Próxima:</b> ${esc(relativeDayLabel(first.date))} a las ${esc(timeLabel(first.start))}</div>
    <div><b>Total en 7:</b> ${items.filter((item) => !item.skipped).length} cita(s) generadas</div>`;
}

function schedulePreview() {
  if (previewController) previewController.cancel();
  previewController = debounce(async () => {
    const dialog = $('#dlg-routine');
    if (!dialog || !dialog.open) return;
    const fields = readForm();
    if (!fields.title || fields.title.length < 2) {
      renderPreviewError('Escribe un nombre para calcular las próximas apariciones.');
      return;
    }
    const box = $('#routinePreview');
    if (box) box.innerHTML = '<div class="loading"><span class="spin" aria-hidden="true"></span> Calculando…</div>';
    try {
      const result = await previewDraft(fields);
      renderPreview(result);
    } catch (error) {
      renderPreviewError(error?.message || 'No se pudo calcular la vista previa.');
    }
  }, 420);
  previewController();
}

/* ----------------------------- acciones ----------------------------- */
async function saveRoutine() {
  const form = $('#routineForm');
  const alertBox = $('#routineAlert');
  const fields = readForm();
  const fail = (message) => {
    alertBox.hidden = false;
    alertBox.className = 'alert';
    alertBox.textContent = message;
  };
  if (!fields.title || fields.title.length < 2) { fail('Ponle un nombre a la rutina.'); form.elements.title.focus(); return; }
  if (!fields.time) { fail('Indica la hora de inicio.'); return; }
  if (fields.durationMin < 5 || fields.durationMin > 720) { fail('La duración debe estar entre 5 y 720 minutos.'); return; }
  if (draft.frequency === 'SEMANAL' && !draft.days.length) { fail('Marca al menos un día de la semana.'); return; }
  const saveButton = $('#routineSave');
  saveButton.disabled = true;
  try {
    if (draft.id) {
      await api.patch(`/api/routines/${draft.id}`, fields);
      toast('Rutina actualizada', 'ok');
    } else {
      const result = await api.post('/api/routines', fields);
      toast(`Rutina creada ${result?.item?.id || ''}`.trim(), 'ok');
    }
    $('#dlg-routine').close();
    await refreshAll();
  } catch (error) {
    if (error?.field) {
      fail(`${error.message} (campo: ${error.field})`);
      const input = form.elements[error.field];
      if (input && input.focus) input.focus();
    } else {
      fail(error?.message || 'No se pudo guardar la rutina.');
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function toggleRoutine(id, active) {
  try {
    await api.post(`/api/routines/${id}/toggle`, { active });
    toast(active ? 'Rutina activada' : 'Rutina pausada', 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo cambiar el estado', 'err');
  }
}

async function skipToday(id) {
  const routine = state.routines.find((item) => item.id === id);
  const ok = await confirmDialog({
    title: 'Saltar la aparición de hoy',
    text: `Se añade una excepción para hoy en «${routine?.title || id}» y se cancela la cita ya generada si existe.`,
    okLabel: 'Saltar hoy'
  });
  if (!ok) return;
  try {
    const result = await api.post(`/api/routines/${id}/skip`, { date: todayKey(), reason: 'Omitida desde la app' });
    toast(`Excepción guardada${result?.cancelled ? ` · ${result.cancelled} cita(s) canceladas` : ''}`, 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo saltar el día', 'err');
  }
}

async function deleteRoutine(id) {
  const routine = state.routines.find((item) => item.id === id);
  const ok = await confirmDialog({
    title: 'Eliminar rutina',
    text: `«${routine?.title || id}» se elimina del sistema. Las citas ya generadas se conservan para no perder historial.`,
    okLabel: 'Eliminar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/routines/${id}?keepGenerated=true`);
    toast('Rutina eliminada', 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo eliminar', 'err');
  }
}

async function showPreviewInline(id, button) {
  const container = document.querySelector(`[data-preview-for="${id}"]`);
  if (!container) return;
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    container.innerHTML = '';
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  container.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  container.innerHTML = '<div class="loading"><span class="spin" aria-hidden="true"></span> Calculando…</div>';
  try {
    const result = await api.get(`/api/routines/${id}/preview?count=7`);
    const items = Array.isArray(result?.items) ? result.items : [];
    container.innerHTML = items.length
      ? items.map((occurrence) => `<div class="preview-item ${occurrence.skipped ? 'skipped' : ''}">
          <span>${esc(relativeDayLabel(occurrence.date))} · ${esc(timeLabel(occurrence.start))}–${esc(timeLabel(occurrence.end))}</span>
          <small>${occurrence.skipped ? 'omitida' : ''}</small>
        </div>`).join('')
      : '<p class="hint">Sin apariciones próximas.</p>';
  } catch (error) {
    container.innerHTML = `<p class="hint">${esc(error?.message || 'No se pudo calcular la vista previa')}</p>`;
  }
}

export async function loadBaseRoutines() {
  const existing = new Set(state.routines.map((routine) => normalize(routine.title)));
  const pending = BASE_ROUTINES.filter((routine) => !existing.has(normalize(routine.title)));
  if (!pending.length) {
    toast('La rutina P95 base ya está cargada.', 'ok');
    return;
  }
  const button = $('#routineBaseBtn');
  if (button) { button.disabled = true; button.textContent = `Cargando 0/${pending.length}…`; }
  let created = 0;
  const failures = [];
  for (const [index, routine] of pending.entries()) {
    if (button) button.textContent = `Cargando ${index + 1}/${pending.length}…`;
    try {
      await api.post('/api/routines', {
        kind: 'recurrence',
        active: true,
        title: routine.title,
        frequency: routine.frequency,
        rule: routine.rule,
        time: routine.time,
        durationMin: routine.durationMin,
        type: routine.type,
        priority: routine.priority,
        impact: routine.impact,
        urgency: routine.urgency,
        reminderMin: routine.reminderMin,
        deepFocus: routine.deepFocus,
        role: routine.role,
        result: routine.result,
        purpose: routine.purpose,
        notes: composeNotes(routine.purpose, '', 'recurrence'),
        whatsapp: true,
        calendar: true,
        skipHolidays: true
      });
      created += 1;
    } catch (error) {
      failures.push(`${routine.title}: ${error?.message || 'error'}`);
    }
  }
  if (button) { button.disabled = false; button.textContent = '⚡ Cargar rutina P95 base'; }
  if (created) toast(`Rutina P95 base: ${created} creada(s)`, 'ok');
  if (failures.length) toast(`No se pudieron crear ${failures.length}: ${failures[0]}`, 'err');
  await refreshAll();
}

/* ----------------------------- lenguaje natural ----------------------------- */
function setNlStatus(text, kind = '') {
  const status = $('#routineNlStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `hint${kind === 'err' ? ' alert' : ''}`;
}

async function interpretAndOpen() {
  const input = $('#routineNlText');
  const button = $('#routineNlBtn');
  const text = input?.value.trim();
  if (!text) { setNlStatus('Escribe la rutina con tus palabras para interpretarla.', 'err'); input?.focus(); return; }
  button.disabled = true;
  setNlStatus('Interpretando…');
  try {
    const result = await interpretRoutineText(text);
    const sourceLabel = result.source === 'local' ? 'interpretación local (sin LLM)' : result.source.startsWith('llm') ? `modelo: ${result.source}` : result.source;
    setNlStatus(`Entendí: ${result.interpretation.join(' · ')} — ${sourceLabel}. Revisa y ajusta antes de guardar.`);
    const tag = $('#nlEngineTag');
    if (tag) tag.textContent = result.source === 'local' ? 'Interpretación local' : `Modelo: ${result.source.replace('llm-autocomplete', 'autocompletado')}`;
    openRoutineDialog({ prefill: result.fields });
  } catch (error) {
    setNlStatus(`No pude interpretarlo: ${error?.message || 'error'}. Puedes crear la rutina con el formulario.`, 'err');
  } finally {
    button.disabled = false;
  }
}

/* ----------------------------- eventos ----------------------------- */
export function initRoutines() {
  if (initialized) return;
  initialized = true;

  $$('[data-routine-filter]').forEach((chip) => chip.addEventListener('click', () => {
    state.ui.routineFilter = chip.dataset.routineFilter;
    $$('[data-routine-filter]').forEach((other) => {
      const active = other === chip;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    renderRoutines();
  }));

  const search = $('#routineSearch');
  if (search) {
    const apply = debounce(() => { state.ui.routineQuery = search.value; renderRoutines(); }, 140);
    search.addEventListener('input', apply);
  }

  $('#routineNewBtn')?.addEventListener('click', () => openRoutineDialog({}));
  $('#routinePrintBtn')?.addEventListener('click', printRoutines);
  window.addEventListener('beforeprint', updateRoutinesPrintStamp);
  $('#routineBaseBtn')?.addEventListener('click', () => loadBaseRoutines());

  $('#routineNlForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    interpretAndOpen();
  });

  $('#routinesList')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    const id = action.dataset.id;
    if (action.dataset.act === 'edit-routine') {
      const routine = state.routines.find((item) => item.id === id);
      if (routine) openRoutineDialog({ routine });
    } else if (action.dataset.act === 'duplicate-routine') {
      const routine = state.routines.find((item) => item.id === id);
      if (routine) openRoutineDialog({ routine: { ...routine, id: null, active: true } });
    } else if (action.dataset.act === 'skip-routine') {
      skipToday(id);
    } else if (action.dataset.act === 'delete-routine') {
      deleteRoutine(id);
    } else if (action.dataset.act === 'preview-routine') {
      showPreviewInline(id, action);
    } else if (action.dataset.act === 'meeting-acta') {
      createMeetingActa(id, action);
    }
  });

  $('#routinesList')?.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-act="toggle-routine"]');
    if (!toggle) return;
    toggleRoutine(toggle.dataset.id, toggle.checked);
  });

  $('#routineKindChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-kind]');
    if (chip) setKind(chip.dataset.kind);
  });
  $('#routineFreqChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-freq]');
    if (chip) setFrequency(chip.dataset.freq);
  });
  $('#routineTypeChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-type]');
    if (chip) setType(chip.dataset.type);
  });
  $('#routineWeekdayChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-day]');
    if (!chip) return;
    const day = chip.dataset.day;
    setDays(draft.days.includes(day) ? draft.days.filter((value) => value !== day) : [...draft.days, day]);
  });

  const form = $('#routineForm');
  form?.elements.monthDay.addEventListener('input', () => {
    draft.monthDay = Number(form.elements.monthDay.value) || 1;
    schedulePreview();
  });
  ['time', 'durationMin', 'reminderMin', 'priority', 'purpose', 'result', 'deepFocus', 'title'].forEach((name) => {
    form?.elements[name]?.addEventListener('input', schedulePreview);
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveRoutine();
  });
}

export { openRoutineDialog };


/** Genera un acta borrador desde una reunión, con sus datos ya cargados. */
function buildActaPayload(routine) {
  const participants = String(routine.participants || '')
    .split(/[,;]/).map((name) => name.trim()).filter(Boolean);
  const agenda = [routine.purpose, routine.requiredOutput].filter(Boolean);
  return {
    type: 'docx',
    template: 'acta',
    title: `Acta · ${routine.title}`,
    date: todayKey(),
    author: 'Héctor Fabio Riascos C.',
    attendees: participants.length ? participants : ['Equipo'],
    agenda: agenda.length ? agenda : ['Revisar el estado de la reunión'],
    body: `Acta de la reunión «${routine.title}». ${routine.purpose || ''}`.trim(),
    time: routine.time || ''
  };
}

async function createMeetingActa(id, button) {
  const routine = state.routines.find((item) => item.id === id && item.kind === 'meeting');
  if (!routine) return;
  button.disabled = true;
  try {
    const result = await api.post('/api/docs', buildActaPayload(routine));
    const doc = result?.item || result;
    const tasks = Array.isArray(doc?.tasks) ? doc.tasks.length : 0;
    toast(tasks ? `Acta creada · ${tasks} tarea(s) desde acuerdos` : 'Acta creada en Documentos', 'ok');
    document.querySelector('.drawer-nav [data-nav="docs"]')?.click();
  } catch (error) {
    toast(error?.message || 'No se pudo crear el acta', 'err');
  } finally {
    button.disabled = false;
  }
}



function updateRoutinesPrintStamp() {
  const stamp = $('#routinesPrintStamp');
  if (!stamp) return;
  const active = state.routines.filter((routine) => routine.active).length;
  const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  stamp.textContent = `Héctor Fabio Riascos C. · ${active} rutina(s) activa(s) · ${date}`;
}

function printRoutines() {
  updateRoutinesPrintStamp();
  window.print();
}

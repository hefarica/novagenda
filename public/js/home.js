/**
 * Inicio: índice P95, Top 3, agenda de hoy, captura rápida, rutinas del día,
 * integraciones y actividad reciente.
 */
import { state, externalEvents } from './state.js';
import { captureOrQueue, subscribeQueue } from './offline.js';
import { refreshAll } from './data.js';
import { openEventDialog } from './agenda.js';
import {
  $, $$, dateKeyOf, esc, labelForKey, priorityBadge,
  scorePill, timeLabel, toast, todayKey, fmtDateTime
} from './core.js';

let initialized = false;

function greeting() {
  const hour = new Date().getHours();
  const base = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';
  return `${base} 👋`;
}

function todayEvents() {
  const key = todayKey();
  const local = state.agenda.filter((event) => event.status !== 'Cancelada' && dateKeyOf(event.start) === key);
  const google = externalEvents()
    .filter((event) => dateKeyOf(event.start) === key)
    .map((event) => ({
      id: event.eventId || event.title,
      title: event.title,
      start: event.start,
      end: event.end,
      priority: 'EXT',
      type: 'Google',
      context: event.account,
      status: 'Pendiente',
      external: true
    }));
  return [...local, ...google].sort((a, b) => new Date(a.start) - new Date(b.start));
}

function eventRow(event) {
  const color = event.priority === 'P1' ? '#ff9f43' : event.deepFocus ? '#9b7bff' : event.priority === 'EXT' ? '#20c997' : '#159dff';
  const allDay = typeof event.start === 'string' && event.start.length === 10;
  return `<div class="event" style="--event:${color}">
    <div class="event-time">${esc(allDay ? 'Todo el día' : timeLabel(event.start))}<small>${esc(allDay ? '' : timeLabel(event.end))}</small></div>
    <div class="event-title"><b>${esc(event.title)}</b><small>${esc([event.type, event.context, event.status].filter(Boolean).join(' · '))}</small></div>
    ${priorityBadge(event.priority)}
  </div>`;
}

function miniBars() {
  const components = state.p95?.components || state.dashboard?.p95Components || [];
  if (!components.length) return '<p class="hint">El desglose estará disponible cuando el motor P95 responda.</p>';
  return components.map((component) => {
    const ratio = Math.max(0, Math.min(1, Number(component.ratio) || 0));
    return `<div class="mini-bar ${component.met ? '' : 'miss'}" title="${esc(component.label)}: ${esc(String(component.raw))} / meta ${esc(String(component.target))}">
      <span>${esc(component.label)}<i><b style="width:${Math.round(ratio * 100)}%"></b></i></span>
      <small>${Math.round(ratio * 100)}%</small>
    </div>`;
  }).join('');
}

function suggestions() {
  const dashboard = state.dashboard || {};
  const components = state.p95?.components || [];
  const items = [];
  for (const component of components.filter((entry) => !entry.met).slice(0, 3)) {
    if (component.key === 'deepFocus') items.push(`Te faltan ${Math.max(0, Number(component.target) - Number(component.raw))} min de foco profundo hoy.`);
    else if (component.key === 'overdue') items.push(`${component.raw} pendiente(s) vencidos abiertos: prográmalos o ciérralos.`);
    else if (component.key === 'weeklyReview') items.push('Aún no marcas la revisión semanal de esta semana.');
    else items.push(`${component.label}: ${Math.round((Number(component.ratio) || 0) * 100)}% de la meta.`);
  }
  if (dashboard.conflicts) items.push(`${dashboard.conflicts} conflicto(s) hoy: resuélvelos antes de añadir citas.`);
  if (!items.length) items.push(dashboard.p95 >= 80 ? 'Tu sistema está estable. Protege el Top 3 y no abras frentes nuevos.' : 'Buen momento para reservar un bloque de foco y cerrar pendientes.');
  return items.slice(0, 2).map((text, index) => `<div class="suggestion"><p>✦ ${esc(text)}</p>${index === 0 ? '<button type="button" class="ghost small" data-nav="system">Ver desglose</button>' : ''}</div>`).join('');
}

function integrationSummary() {
  const items = [];
  const llm = state.llm;
  items.push({
    icon: '✦',
    name: 'Modelo de lenguaje',
    detail: llm?.available ? `${llm.provider || 'LLM'} · ${llm.model || ''}` : 'Fallback determinista activo',
    on: Boolean(llm?.available)
  });
  for (const [key, label] of [['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['email', 'Correo']]) {
    const channel = state.channels?.[key] || {};
    items.push({ icon: key === 'whatsapp' ? '◉' : key === 'telegram' ? '➤' : '✉', name: label, detail: channel.configured ? 'Configurado' : 'Sin configurar', on: Boolean(channel.configured) });
  }
  items.push({
    icon: '▦',
    name: 'Google Calendar + Gmail',
    detail: state.googleConnections.length ? `${state.googleConnections.length} cuenta(s)` : 'Sin conectar',
    on: state.googleConnections.length > 0
  });
  return items.map((item) => `<div class="integration-item">
    <span class="mini-icon" aria-hidden="true">${item.icon}</span>
    <div><b>${esc(item.name)}</b><small>${esc(item.detail)}</small></div>
    <span class="status ${item.on ? '' : 'off'}">${item.on ? 'Conectado' : 'Configurar'}</span>
  </div>`).join('');
}

function activityList() {
  if (!state.activity.length) return '<p class="muted small">Sin actividad reciente.</p>';
  return state.activity.slice(0, 5).map((entry) => `<div class="activity-item">
    <span class="mini-icon" aria-hidden="true">${entry.type === 'email' ? '✉' : entry.type === 'calendar' ? '▦' : '✦'}</span>
    <div><b>${esc(entry.text)}</b><small>${esc(entry.at ? fmtDateTime(entry.at) : '')}</small></div>
  </div>`).join('');
}

function routineToday() {
  const key = todayKey();
  const occurrences = state.occurrences.filter((occurrence) => occurrence.date === key);
  if (!occurrences.length) return '<p class="muted small">No hay rutinas programadas para hoy.</p>';
  return occurrences.slice(0, 6).map((occurrence) => `<div class="system-row">
    <div><b>${esc(occurrence.title || occurrence.routineId)}</b><small>${esc(timeLabel(occurrence.start))} · ${esc(occurrence.skipped ? 'omitida hoy' : occurrence.kind === 'meeting' ? 'reunión' : 'rutina')}</small></div>
    <span class="tag ${occurrence.skipped ? 'off' : 'ok'}">${occurrence.skipped ? 'Omitida' : 'Programada'}</span>
  </div>`).join('');
}

function inboxPreview() {
  const pending = state.inbox.filter((item) => !item.processed && !item.dismissed).slice(0, 3);
  if (!pending.length) return '<p class="muted small">Inbox al día.</p>';
  return pending.map((item) => `<div class="system-row">
    <div><b>${esc(item.input)}</b><small>${esc(item.source || 'Captura')} · ${esc(item.capturedAt ? fmtDateTime(item.capturedAt) : '')}</small></div>
    <span class="tag">${esc(item.priority || 'P2')}</span>
  </div>`).join('');
}

export function renderHome() {
  const hello = $('#hello');
  if (hello) hello.textContent = greeting();
  const todayLabel = $('#todayLabel');
  if (todayLabel) todayLabel.textContent = `${labelForKey(todayKey())} · ${state.timezone}`;

  const dashboard = state.dashboard || {};
  const index = Number(state.p95?.index ?? dashboard.p95 ?? 0);
  const ring = $('#p95Ring');
  if (ring) {
    ring.style.setProperty('--value', String(Math.max(0, Math.min(100, index))));
    ring.setAttribute('aria-label', `Índice P95: ${index.toFixed(1)} de 100`);
  }
  const value = $('#p95Value');
  if (value) value.textContent = Number.isFinite(index) ? index.toFixed(1) : '—';
  const stamp = $('#p95Stamp');
  if (stamp) stamp.textContent = state.p95 ? `Pesos: ${Object.values(state.p95.weights || {}).reduce((sum, weight) => sum + Number(weight || 0), 0).toFixed(2)}` : 'Sin datos del motor';
  const headline = $('#p95Headline');
  if (headline) {
    const met = (state.p95?.components || []).filter((component) => component.met).length;
    headline.textContent = state.p95
      ? `${met}/7 componentes en meta · ejecución ${Math.round((dashboard.execution || 0) * 100)}%`
      : 'El motor P95 aún no responde. La app sigue funcionando con el asistente determinista.';
  }
  const mini = $('#p95Mini');
  if (mini) mini.innerHTML = miniBars();

  const top3 = dashboard.top3 || [];
  const top3List = $('#top3List');
  if (top3List) {
    top3List.innerHTML = top3.length
      ? top3.map((event, index) => `<div class="top3-item">
          <span class="rank" aria-hidden="true">${index + 1}</span>
          <div><b>${esc(event.title)}</b><small>${esc(fmtDateTime(event.start))} · ${esc(event.type || '')}</small></div>
          <div class="row-actions">${scorePill(event.score)}<button type="button" class="ghost small" data-home-event="${esc(event.id)}">Abrir</button></div>
        </div>`).join('')
      : '<p class="muted small">Sin pendientes para hoy. Buen momento para planificar mañana.</p>';
  }

  const events = todayEvents();
  const todayList = $('#todayList');
  if (todayList) todayList.innerHTML = events.length ? events.slice(0, 8).map(eventRow).join('') : '<p class="muted small">No hay compromisos para hoy.</p>';
  const todayMeta = $('#todayMeta');
  if (todayMeta) todayMeta.textContent = `${events.length} cita(s)`;

  const stats = $('#dayStats');
  if (stats) {
    stats.innerHTML = [
      { label: 'Ejecución del día', value: `${Math.round(Number(dashboard.execution || 0) * 100)}%`, tone: '' },
      { label: 'Foco real', value: `${Number(dashboard.focusMin || 0)} min`, tone: Number(dashboard.focusMin || 0) >= Number(state.settings?.p95?.deepFocusDailyMin || 120) ? '' : 'warn' },
      { label: 'Reuniones', value: `${Number(dashboard.meetingMin || 0)} min`, tone: '' },
      { label: 'Pendientes', value: String(Number(dashboard.pending || 0)), tone: '' },
      { label: 'Conflictos', value: String(Number(dashboard.conflicts || 0)), tone: Number(dashboard.conflicts) ? 'bad' : '' },
      { label: 'Vencidos', value: String(Number(dashboard.overdue || 0)), tone: Number(dashboard.overdue) ? 'warn' : '' }
    ].map((stat) => `<div class="stat ${stat.tone}"><b>${esc(stat.value)}</b><small>${esc(stat.label)}</small></div>`).join('');
  }
  const suggestionsBox = $('#daySuggestions');
  if (suggestionsBox) suggestionsBox.innerHTML = suggestions();

  const inbox = $('#inboxPreview');
  if (inbox) inbox.innerHTML = inboxPreview();
  const routineBox = $('#routineToday');
  if (routineBox) routineBox.innerHTML = routineToday();
  const routineMeta = $('#routineTodayMeta');
  if (routineMeta) {
    const key = todayKey();
    const count = state.occurrences.filter((occurrence) => occurrence.date === key).length;
    routineMeta.textContent = `${count} hoy`;
  }

  const integrations = $('#integrationsSummary');
  if (integrations) integrations.innerHTML = integrationSummary();
  const integrationsMeta = $('#integrationsMeta');
  if (integrationsMeta) {
    const ready = integrationSummary().match(/Conectado/g)?.length || 0;
    integrationsMeta.textContent = `${ready} conectada(s)`;
  }
  const activity = $('#activityList');
  if (activity) activity.innerHTML = activityList();
}

export function initHome() {
  if (initialized) return;
  initialized = true;

  $('#captureForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#captureInput');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const text = input?.value.trim();
    if (!text) { input?.focus(); return; }
    button.disabled = true;
    try {
      const result = await captureOrQueue(text, { source: 'App' });
      input.value = '';
      if (result.queued) {
        toast('Sin conexión: captura guardada en la cola. Se enviará al volver.', 'warn');
        updateQueueChip();
      } else {
        toast('Capturado en el Inbox', 'ok');
        await refreshAll();
      }
    } catch (error) {
      toast(error?.message || 'No se pudo capturar', 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('#homeNewEvent')?.addEventListener('click', () => openEventDialog({}));

  $('#top3List')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-home-event]');
    if (!button) return;
    const item = (state.dashboard?.top3 || []).find((entry) => entry.id === button.dataset.homeEvent);
    if (item) openEventDialog({ event: item });
  });

  subscribeQueue((count) => { state.queued = count; updateQueueChip(); });
}

export function updateQueueChip() {
  const chip = $('#queueChip');
  const dot = $('#queueDot');
  const count = state.queued || 0;
  if (chip) {
    chip.hidden = count === 0;
    chip.textContent = `${count} sin enviar`;
    chip.className = `tag ${count ? 'warn' : 'off'}`;
  }
  if (dot) dot.hidden = count === 0;
}

/**
 * Momentos: resumen semanal de la oficina.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, emptyState } from './core.js';

let initialized = false;
let state = { data: null };

export function initMoments() {
  if (initialized) return;
  initialized = true;
  $('#momentsRefresh')?.addEventListener('click', () => refresh());
  $('#momentsCopy')?.addEventListener('click', copySummary);
}

export function renderMoments() {
  if (!initialized) initMoments();
  refresh().catch(() => {});
}

async function refresh() {
  const data = await api.get('/api/moments/weekly');
  state.data = data;
  render();
}

function render() {
  const data = state.data;
  if (!data) return;
  const counts = data.counts || {};
  const range = $('#momentsRange');
  if (range) range.textContent = data.today ? `Hoy ${data.today}` : '';
  const summary = $('#momentsSummary');
  if (summary) {
    summary.className = 'muted small';
    summary.textContent = `Cerraste ${counts.tasksDone || 0} tarea(s), tuviste ${counts.eventsPast || 0} evento(s) y generaste ${counts.docsCreated || 0} documento(s). Te esperan ${(data.needsYou?.approvals || []).length} aprobación(es) y ${(data.needsYou?.overdueTasks || []).length} tarea(s) vencida(s).`;
  }
  const countsBox = $('#momentsCounts');
  if (countsBox) {
    countsBox.innerHTML = [
      ['Tareas cerradas', counts.tasksDone || 0, ''],
      ['Eventos', counts.eventsPast || 0, ''],
      ['Documentos', counts.docsCreated || 0, ''],
      ['Aprobadas', counts.proposalsApproved || 0, ''],
      ['Ejecutadas', counts.proposalsExecuted || 0, ''],
      ['Salas', counts.reservationsNext || 0, '']
    ].map(([label, value, className]) => `
      <div class="approval-metric ${className}">
        <span>${esc(label)}</span>
        <b>${esc(String(value))}</b>
      </div>`).join('');
  }
  renderNeeds();
  renderWins();
  renderNext();
  renderRooms();
}

function row(icon, title, detail, tag = '') {
  return `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">${esc(icon)}</div>
      <div><b>${esc(title)}</b><small>${detail}</small></div>
      ${tag ? `<span class="tag ${tag.className || ''}">${esc(tag.label)}</span>` : ''}
    </div>`;
}

function renderNeeds() {
  const box = $('#momentsNeeds');
  if (!box) return;
  const needs = state.data.needsYou || {};
  const parts = [];
  for (const item of needs.approvals || []) {
    parts.push(row('AP', item.subject || item.id, `${esc(item.level || 'N2')} · ${esc(item.id || '')}`, { label: 'aprobar', className: 'warn' }));
  }
  for (const task of needs.overdueTasks || []) {
    parts.push(row('!', task.title, `vence ${esc(task.due || '')} · ${esc(task.priority || '')}`, { label: 'vencida', className: 'bad' }));
  }
  for (const objective of needs.atRisk || []) {
    parts.push(row('◎', objective.title, `avance ${objective.progress}%`, { label: 'en riesgo', className: 'warn' }));
  }
  box.innerHTML = parts.length ? parts.join('') : emptyState('Nada urgente ahora mismo.', '✓');
}

function renderWins() {
  const box = $('#momentsWins');
  if (!box) return;
  const wins = state.data.wins || {};
  const parts = [];
  for (const task of wins.tasks || []) parts.push(row('✓', task.title, 'tarea cerrada'));
  for (const doc of wins.documents || []) parts.push(row('▤', doc.title, `documento ${doc.type || ''}`));
  for (const approval of wins.approvals || []) parts.push(row('→', approval.subject || approval.id, 'ejecutada'));
  if (wins.okrProgress !== undefined && wins.okrProgress > 0) parts.push(row('◎', 'Avance medio de objetivos', `${wins.okrProgress}%`));
  box.innerHTML = parts.length ? parts.join('') : emptyState('Todavía no hay avances esta semana.', '·');
}

function renderNext() {
  const box = $('#momentsNext');
  if (!box) return;
  const next = state.data.next || [];
  if (!next.length) { box.innerHTML = emptyState('Sin eventos en los próximos 7 días.', '▦'); return; }
  box.innerHTML = next.map((event) => row('▦', event.title, `${formatDate(event.start)} · ${formatTime(event.start)}${event.location ? ` · ${esc(event.location)}` : ''}`)).join('');
}

function renderRooms() {
  const box = $('#momentsRooms');
  if (!box) return;
  const reservations = state.data.reservations || [];
  if (!reservations.length) { box.innerHTML = emptyState('Sin salas reservadas esta semana.', '▣'); return; }
  box.innerHTML = reservations.map((reservation) => row('▣', reservation.title, `${formatDate(reservation.date)} · ${reservation.start}–${reservation.end}`)).join('');
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(String(value || ''));
  return date.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

async function copySummary() {
  const text = state.data?.text;
  if (!text) { toast('No hay resumen para copiar', 'err'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Resumen copiado', 'ok');
  } catch {
    toast('El navegador no dejó copiar; selecciona el texto a mano.', 'warn');
  }
}

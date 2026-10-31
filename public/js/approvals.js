/**
 * Centro de aprobaciones: propuestas pendientes, aprobadas por ejecutar y
 * correo en cuarentena, con acciones directas.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, confirmDialog, promptDialog, emptyState } from './core.js';

let initialized = false;
let state = { pending: [], approved: [], quarantine: [], metrics: null, codes: {}, error: null };
let loading = false;

export function initApprovals() {
  if (initialized) return;
  initialized = true;
  $('#approvalsRefresh')?.addEventListener('click', () => refresh());
  for (const id of ['approvalPending', 'approvalApproved', 'approvalQuarantine']) {
    $(`#${id}`)?.addEventListener('click', onAction);
  }
}

export function renderApprovals() {
  if (!initialized) initApprovals();
  refresh().catch(() => {});
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const [pending, held, approved, quarantine, metrics] = await Promise.all([
      api.get('/api/office/proposals?status=pending&limit=100'),
      api.get('/api/office/proposals?status=held&limit=100').catch(() => ({ proposals: [] })),
      api.get('/api/office/proposals?status=approved&limit=100'),
      api.get('/api/mail/quarantine?status=held&limit=50').catch(() => ({ items: [] })),
      api.get('/api/approvals/metrics').catch(() => null)
    ]);
    const rows = (result) => result?.proposals || result?.items || [];
    state.pending = [...rows(pending), ...rows(held)]
      .filter((item) => item.status === 'pending' || item.status === 'held')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    state.approved = rows(approved);
    state.quarantine = rows(quarantine);
    state.metrics = metrics || null;
    state.error = null;
    render();
  } catch (error) {
    state.error = formatError(error);
    render();
  } finally {
    loading = false;
  }
}

function render() {
  renderStats();
  renderMetrics();
  renderPending();
  renderApproved();
  renderQuarantine();
}

function renderStats() {
  const stats = $('#approvalsStats');
  const summary = $('#approvalsSummary');
  const oldest = state.pending[0];
  const age = oldest ? ageHours(oldest.createdAt) : null;
  const n3 = state.pending.filter((item) => item.level === 'N3').length;
  if (stats) stats.textContent = `${state.pending.length} pendiente(s) · ${state.approved.length} por ejecutar`;
  if (summary) {
    if (state.error) { summary.className = 'hint bad'; summary.textContent = state.error; return; }
    summary.className = 'muted small';
    const parts = [];
    if (oldest) parts.push(`La más antigua lleva ${formatAge(age)} esperando.`);
    else parts.push('No hay propuestas pendientes.');
    if (n3) parts.push(`${n3} exige(n) código N3.`);
    if (state.quarantine.length) parts.push(`${state.quarantine.length} correo(s) en cuarentena.`);
    summary.textContent = parts.join(' ');
  }
  setCount('#approvalsPendingCount', state.pending.length);
  setCount('#approvalsApprovedCount', state.approved.length);
  setCount('#approvalsQuarantineCount', state.quarantine.length);
}

function setCount(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value ? `${value} elemento(s)` : '';
}

function renderMetrics() {
  const box = $('#approvalMetrics');
  if (!box) return;
  const m = state.metrics;
  if (!m) { box.innerHTML = ''; return; }
  const hours = (value) => (value === null || value === undefined ? '—' : value < 1 ? `${Math.round(value * 60)} min` : `${Math.round(value)} h`);
  box.innerHTML = [
    ['Tiempo medio', hours(m.averageApprovalHours), ''],
    ['Pendiente más antigua', hours(m.oldestPendingHours), (m.oldestPendingHours || 0) > (m.slaHours || 24) ? 'bad' : ''],
    ['Fuera de SLA', `${m.slaBreaches || 0}`, m.slaBreaches ? 'bad' : ''],
    [`Aprobadas ${m.windowDays || 7} d`, `${m.recent?.approved || 0}`, ''],
    ['Ejecutadas', `${m.executed || 0}`, ''],
    ['Cuarentena', `${m.quarantine || 0}`, m.quarantine ? 'bad' : '']
  ].map(([label, value, className]) => `
    <div class="approval-metric ${className}">
      <span>${esc(label)}</span>
      <b>${esc(value)}</b>
    </div>`).join('');
}

function renderPending() {
  const box = $('#approvalPending');
  if (!box) return;
  if (!state.pending.length) {
    box.innerHTML = emptyState('Nada espera tu aprobación ahora mismo.', '✓');
    return;
  }
  box.innerHTML = state.pending.map((item) => `
    <div class="doc-row" data-id="${esc(item.id)}">
      <div class="doc-icon" aria-hidden="true">AP</div>
      <div>
        <b>${esc(item.subject || item.kind || item.id)}</b>
        <small>${esc(item.id)} · ${esc(item.kind || '')} · ${esc(item.channel || '')} · ${formatAge(ageHours(item.createdAt))}</small>
        <div class="approval-meta">
          <span class="tag ${item.level === 'N3' ? 'bad' : 'warn'}">${esc(item.level || 'N2')}</span>
          <span class="tag">riesgo ${Number(item.risk?.score) || 0}/10</span>
          <span class="tag">${(item.recipients || []).length} destino(s)</span>
          ${item.status === 'held' ? '<span class="tag bad">retenida</span>' : ''}
        </div>
      </div>
      <div class="approval-actions">
        <button type="button" class="primary" data-approval-action="approve" data-approval-id="${esc(item.id)}">Aprobar</button>
        <button type="button" class="ghost" data-approval-action="reject" data-approval-id="${esc(item.id)}">Rechazar</button>
      </div>
    </div>`).join('');
}

function renderApproved() {
  const box = $('#approvalApproved');
  if (!box) return;
  if (!state.approved.length) {
    box.innerHTML = emptyState('No hay propuestas aprobadas esperando ejecución.', '▶');
    return;
  }
  box.innerHTML = state.approved.map((item) => `
    <div class="doc-row" data-id="${esc(item.id)}">
      <div class="doc-icon" aria-hidden="true">OK</div>
      <div>
        <b>${esc(item.subject || item.kind || item.id)}</b>
        <small>${esc(item.id)} · ${esc(item.kind || '')} · ${esc(item.channel || '')} · aprobada ${formatAge(ageHours(item.approvedAt || item.updatedAt || item.createdAt))}</small>
        <div class="approval-meta">
          <span class="tag ok">${esc(item.level || 'N2')}</span>
          <span class="tag">riesgo ${Number(item.risk?.score) || 0}/10</span>
          ${item.level === 'N3' ? `<span class="tag warn">${state.codes[item.id] ? `código ${esc(state.codes[item.id])}` : 'pide código'}</span>` : ''}
        </div>
      </div>
      <div class="approval-actions">
        <button type="button" class="secondary" data-approval-action="execute" data-approval-id="${esc(item.id)}">Ejecutar</button>
      </div>
    </div>`).join('');
}

function renderQuarantine() {
  const box = $('#approvalQuarantine');
  if (!box) return;
  if (!state.quarantine.length) {
    box.innerHTML = emptyState('No hay correo retenido por las reglas.', '⚑');
    return;
  }
  box.innerHTML = state.quarantine.map((item) => `
    <div class="doc-row" data-id="${esc(item.id)}">
      <div class="doc-icon" aria-hidden="true">Q</div>
      <div>
        <b>${esc(item.subject || '(sin asunto)')}</b>
        <small>${esc(item.from?.email || item.from || '')} · ${esc(item.reason || 'regla de correo')} · ${formatAge(ageHours(item.createdAt))}</small>
      </div>
      <div class="approval-actions">
        <button type="button" class="secondary" data-approval-action="release" data-approval-id="${esc(item.id)}">Liberar</button>
        <button type="button" class="ghost" data-approval-action="discard" data-approval-id="${esc(item.id)}">Descartar</button>
      </div>
    </div>`).join('');
}

async function onAction(event) {
  const button = event.target.closest('[data-approval-action]');
  if (!button) return;
  const id = button.dataset.approvalId;
  const action = button.dataset.approvalAction;
  if (action === 'approve') await approve(id, button);
  else if (action === 'reject') await reject(id, button);
  else if (action === 'execute') await execute(id, button);
  else if (action === 'release') await releaseQuarantine(id, button);
  else if (action === 'discard') await discardQuarantine(id, button);
}

async function approve(id, button) {
  const item = state.pending.find((row) => row.id === id);
  if (!item) return;
  const ok = await confirmDialog({
    title: `Aprobar ${id}`,
    text: `${item.level} · riesgo ${Number(item.risk?.score) || 0}/10 · ${item.level === 'N3' ? 'N3 pedirá código al ejecutar.' : 'Aprobar no envía: habilita la ejecución.'}`,
    okLabel: 'Aprobar'
  });
  if (!ok) return;
  setBusy(button, true);
  try {
    const result = await api.post(`/api/office/proposals/${encodeURIComponent(id)}/approve`, { by: 'owner', note: '' });
    if (result?.code) {
      state.codes[id] = result.code;
      toast(`Aprobada ${id} · código ${result.code}`, 'ok');
    } else {
      toast(`Aprobada ${id}`, 'ok');
    }
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function reject(id, button) {
  const reason = await promptDialog({
    title: `Rechazar ${id}`,
    text: 'Motivo opcional. Queda en el ledger junto al rechazo.',
    label: 'Motivo',
    value: ''
  });
  if (reason === null) return;
  setBusy(button, true);
  try {
    await api.post(`/api/office/proposals/${encodeURIComponent(id)}/reject`, { by: 'owner', reason: String(reason || '').trim() });
    toast(`Rechazada ${id}`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function execute(id, button) {
  const item = state.approved.find((row) => row.id === id);
  if (!item) return;
  let code = state.codes[id] || null;
  if (item.level === 'N3' && !code) {
    const entered = await promptDialog({
      title: `Código N3 para ${id}`,
      text: 'Escribe el código que devolvió la aprobación.',
      label: 'Código',
      value: ''
    });
    if (entered === null) return;
    code = String(entered || '').trim().toUpperCase();
  }
  setBusy(button, true);
  try {
    const result = await api.post(`/api/office/proposals/${encodeURIComponent(id)}/execute`, code ? { code } : {});
    toast(result?.executed ? `Ejecutada ${id}` : `Ejecución en curso (${result?.status || 'ok'})`, 'ok');
    await refresh();
  } catch (error) {
    if (error?.code === 'EXECUTOR_UNAVAILABLE' || error?.status === 503) {
      toast('Aprobada, pero el ejecutor no está conectado. No se marcó como ejecutada.', 'warn');
    } else {
      toast(formatError(error), 'err');
    }
  } finally {
    setBusy(button, false);
  }
}

async function releaseQuarantine(id, button) {
  const ok = await confirmDialog({
    title: 'Liberar correo',
    text: 'Sale de cuarentena. No se redacta ni se envía nada automáticamente.',
    okLabel: 'Liberar'
  });
  if (!ok) return;
  setBusy(button, true);
  try {
    await api.post(`/api/mail/quarantine/${encodeURIComponent(id)}/release`, { compose: false });
    toast('Correo liberado', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function discardQuarantine(id, button) {
  const ok = await confirmDialog({
    title: 'Descartar correo',
    text: 'Se marca como descartado. No se puede deshacer.',
    okLabel: 'Descartar',
    danger: true
  });
  if (!ok) return;
  setBusy(button, true);
  try {
    await api.post(`/api/mail/quarantine/${encodeURIComponent(id)}/discard`, {});
    toast('Correo descartado', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function ageHours(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (Date.now() - time) / 3_600_000);
}

function formatAge(hours) {
  if (hours === null || hours === undefined) return 'sin fecha';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} día(s)`;
}


/**
 * Oficina: organigrama de 7 roles, bandeja de propuestas con riesgo y
 * opiniones, aprobación/rechazo/corrección, código N3, modo y ledger.
 */
import { api, formatError } from './api.js';
import { state, emit } from './state.js';
import { loadApprovals } from './data.js';
import { loadOffice as fetchOffice, capability } from './data.js';
import {
  $, $$, esc, confirmDialog, promptDialog, toast, setBusy, emptyState, unavailableState,
  fmtDateTime, openDialog, closeDialog
} from './core.js';

let initialized = false;
const LEVEL_ORDER = ['N0', 'N1', 'N2', 'N3'];
const STATUS_LABEL = {
  pending: 'Pendiente', held: 'Retenida', approved: 'Aprobada', rejected: 'Rechazada',
  executing: 'Ejecutando…', executed: 'Ejecutada', failed: 'Falló', reverted: 'Deshecha'
};

export function initOffice() {
  if (initialized) return;
  initialized = true;

  $('#officeMode')?.addEventListener('change', async (event) => {
    const select = event.currentTarget;
    const previous = state.office.mode?.mode;
    select.disabled = true;
    try {
      await api.post('/api/office/mode', { mode: select.value, by: 'owner' });
      toast(`Modo ${select.value} activo`, 'ok');
      await refreshOffice();
    } catch (error) {
      toast(formatError(error), 'err');
      if (previous) select.value = previous;
    } finally {
      select.disabled = false;
    }
  });

  $('#officeFilters')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-office-status]');
    if (!chip) return;
    state.office.filter = chip.dataset.officeStatus;
    $$('#officeFilters [data-office-status]').forEach((other) => {
      const active = other === chip;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    renderOfficeProposals();
  });

  $('#officeProposals')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-office-act]');
    if (!button) return;
    const item = state.office.proposals.find((proposal) => proposal.id === button.dataset.id);
    if (!item) return;
    const act = button.dataset.officeAct;
    if (act === 'approve') approveProposal(item);
    else if (act === 'reject') rejectProposal(item);
    else if (act === 'correct') correctProposal(item);
    else if (act === 'edit') editProposal(item);
    else if (act === 'execute') executeProposal(item);
    else if (act === 'send') sendCard(item, button);
  });

  $('#proposalEditForm')?.addEventListener('submit', saveProposalEdit);

  $('#officeVerify')?.addEventListener('click', verifyLedger);
  $('#officeExportLedger')?.addEventListener('click', () => {
    window.open('/api/office/ledger/export', '_blank', 'noopener');
  });
}

export async function refreshOffice() {
  const result = await fetchOffice({ force: true }).catch(() => ({ ok: false }));
  renderOffice();
  emit('office', result);
  return result;
}

export function renderOffice() {
  const rosterBox = $('#officeRoster');
  if (!rosterBox) return;
  if (!capability('office')) {
    rosterBox.innerHTML = unavailableState({ title: 'La Oficina no está disponible en este servidor', detail: 'El módulo de oficina no está montado.' });
    const proposals = $('#officeProposals');
    if (proposals) proposals.innerHTML = '';
    return;
  }
  renderStatusBar();
  renderOutboundNotice();
  renderModeSelect();
  renderRoster();
  renderOfficeProposals();
  renderLedger();
}

function renderStatusBar() {
  const box = $('#officeStatusBar');
  if (!box) return;
  const status = state.office.status;
  const mode = state.office.mode?.mode || status?.mode || '—';
  const modeInfo = state.office.mode?.info || state.office.mode?.modeInfo || status?.modeInfo;
  const pending = status?.pending ?? state.office.proposals.filter((item) => item.status === 'pending' || item.status === 'held').length;
  const counts = status?.counts || {};
  const ledger = status?.ledger || {};
  box.innerHTML = `
    <span class="status-pill ${mode === 'sombra' ? 'warn' : 'ok'}"><b>${esc(mode)}</b> ${esc(modeInfo?.label || 'modo')}</span>
    <span class="status-pill ${pending ? 'warn' : 'ok'}"><b>${pending}</b> pendientes</span>
    <span class="status-pill"><b>${counts.approved || 0}</b> aprobadas</span>
    <span class="status-pill"><b>${counts.executed || 0}</b> ejecutadas</span>
    <span class="status-pill"><b>${ledger.entries ?? state.office.ledger.length}</b> entradas de ledger</span>
    <span class="status-pill"><b>${status?.contacts ?? 0}</b> contactos conocidos</span>`;
}

function renderOutboundNotice() {
  const notice = $('#officeOutboundNotice');
  if (!notice) return;
  if (!state.approvals?.loadedAt) loadApprovals().then(() => renderOutboundNotice()).catch(() => {});
  const status = state.office.status || {};
  const enforce = status.enforceOutbound ?? state.health?.office?.enforceOutbound;
  if (!enforce) { notice.hidden = true; return; }
  notice.hidden = false;
  notice.className = 'banner';
  const autonomy = state.approvals?.config?.allowAutonomousOutbound === true;
  notice.innerHTML = '<span>Envíos a terceros requieren aprobación (N2): nada sale sin tu aprobación y ejecución.</span>'
    + (autonomy ? '<span class="tag warn" title="Solo modo total/autónomo, riesgo ≤2, contacto conocido y nunca N3">autonomía activa (riesgo ≤2)</span>' : '')
    + (status.allowDirectSend ? '<span class="tag warn">envío directo permitido</span>' : '');
}

function renderModeSelect() {
  const select = $('#officeMode');
  if (!select) return;
  const modes = state.office.mode?.modes || state.office.roster?.modes || [];
  const current = state.office.mode?.mode || state.office.roster?.mode || 'asistido';
  if (!modes.length) {
    select.innerHTML = `<option value="${esc(current)}">${esc(current)}</option>`;
    return;
  }
  select.innerHTML = modes.map((mode) => `<option value="${esc(mode.id)}"${mode.id === current ? ' selected' : ''} title="${esc(mode.description || '')}">${esc(mode.label || mode.id)}</option>`).join('');
  select.value = current;
}

function renderRoster() {
  const box = $('#officeRoster');
  if (!box) return;
  const roles = state.office.roster?.items || [];
  const meta = $('#officeRosterMeta');
  if (meta) meta.textContent = `${roles.length} roles · ${state.office.roster?.voiceThreshold ?? 0.75} de voz mínima`;
  if (!roles.length) { box.innerHTML = emptyState('No pude cargar el organigrama.', '▣'); return; }
  box.innerHTML = roles.map((role) => `
    <article class="roster-role">
      <h4>${esc(role.nombre)} <span class="tag ${role.puede_ejecutar ? 'ok' : 'off'}">${role.puede_ejecutar ? 'ejecuta' : 'solo opina'}</span></h4>
      <p>${esc(role.descripcion || '')}</p>
      <div class="caps">${(role.capacidades || []).slice(0, 5).map((cap) => `<span>${esc(cap)}</span>`).join('')}</div>
      <p class="duty">Salida: <b>${esc(role.canal_de_salida || 'interno')}</b> · ${role.puede_proponer ? 'propone' : 'no propone'}</p>
    </article>`).join('');
}

function proposalsForFilter() {
  const filter = state.office.filter || 'pending';
  const items = state.office.proposals || [];
  if (filter === 'pending') return items.filter((item) => item.status === 'pending' || item.status === 'held');
  if (filter === 'approved') return items.filter((item) => item.status === 'approved' || item.status === 'executing');
  return items;
}

export function renderOfficeProposals() {
  const box = $('#officeProposals');
  if (!box) return;
  const items = proposalsForFilter();
  const counts = $('#officeCounts');
  if (counts) counts.textContent = `${items.length} de ${state.office.proposals.length}`;
  if (!items.length) {
    box.innerHTML = emptyState(
      state.office.filter === 'pending' ? 'No hay propuestas pendientes. La oficina está al día.' : 'No hay propuestas en este filtro.',
      '▣'
    );
    return;
  }
  box.innerHTML = items.map(proposalCard).join('');
}

function riskClass(score = 0) {
  return score >= 7 ? 'risk-high' : score >= 4 ? 'risk-mid' : '';
}

function waitingLabel(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'menos de 1 h';
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
}

function verdictClass(verdict = '') {
  if (verdict === 'aprobar') return 'approve';
  if (verdict === 'rechazar') return 'reject';
  return 'review';
}

function proposalCard(item) {
  const risk = item.risk || {};
  const score = Number(risk.score ?? 0);
  const flags = Array.isArray(item.flags) && item.flags.length ? item.flags : (risk.flags || []).map((flag) => flag.code);
  const opinions = Array.isArray(item.opinions) ? item.opinions : [];
  const status = item.status || 'pending';
  const pending = status === 'pending' || status === 'held';
  const approved = status === 'approved';
  const canSend = pending && capability('channels');
  const code = state.office.codes[item.id];
  return `
    <article class="proposal-card" data-proposal="${esc(item.id)}">
      <div class="p-head">
        <div>
          <div class="p-title">${esc(item.id)} · ${esc(item.level || '')} · ${esc(item.channel || '')}</div>
          <div class="p-sub">${esc(item.subject || '(sin asunto)')}</div>
        </div>
        <span class="tag ${status === 'approved' ? 'ok' : status === 'rejected' || status === 'failed' ? 'bad' : pending ? 'warn' : 'off'}">${esc(STATUS_LABEL[status] || status)}</span>
      </div>
      <div class="p-meta">
        <span>Para: ${esc((item.recipients || []).join(', ') || 'interno')}</span>
        <span>Nivel ${esc(item.level || '')}</span>
        <span>Voz ${Number(item.voice || 0).toFixed(2)}</span>
        ${pending && waitingLabel(item.createdAt) ? `<span>Esperando ${esc(waitingLabel(item.createdAt))}</span>` : ''}
        ${code ? `<span>Código ${esc(code)}</span>` : ''}
      </div>
      <div class="risk-meter">
        <div class="risk-bar ${riskClass(score)}"><i style="width:${Math.min(100, (score / 10) * 100)}%"></i></div>
        <small class="muted">Riesgo ${score}/10 · ${esc(flags.join(', ') || 'sin señales')}</small>
      </div>
      ${item.body ? `<div class="p-body">${esc(String(item.body).slice(0, 400))}</div>` : ''}
      ${item.rejectReason ? `<p class="hint">Rechazada: ${esc(item.rejectReason)}</p>` : ''}
      <div class="opinion-grid">${opinions.map((opinion) => `
        <div class="opinion ${verdictClass(opinion.verdict)}">
          <b>${esc(opinion.nombre || opinion.role)}</b>
          <span>${esc(opinion.verdict)} · ${(Number(opinion.score) * 100).toFixed(0)}%</span>
          <small>${esc(opinion.note || '')}</small>
        </div>`).join('')}</div>
      ${item.policy?.reason ? `<p class="hint">${esc(item.policy.reason)}</p>` : ''}
      ${item.approval ? `<p class="hint">Aprobada por ${esc(item.approval.by || item.approvedBy || 'owner')}${item.approval.expiresAt ? ` · firma válida hasta ${esc(fmtDateTime(item.approval.expiresAt))}` : ''}. Aprobar no ejecuta: usa «Ejecutar» cuando quieras.</p>` : ''}
      <div class="p-actions">
        ${pending ? `<button type="button" class="primary small" data-office-act="approve" data-id="${esc(item.id)}">Aprobar</button>` : ''}
        ${pending ? `<button type="button" class="secondary small" data-office-act="edit" data-id="${esc(item.id)}">Editar</button>` : ''}
        ${pending ? `<button type="button" class="secondary small" data-office-act="correct" data-id="${esc(item.id)}">Corregir</button>` : ''}
        ${pending || approved ? `<button type="button" class="ghost small" data-office-act="reject" data-id="${esc(item.id)}">Rechazar</button>` : ''}
        ${approved ? `<button type="button" class="primary small" data-office-act="execute" data-id="${esc(item.id)}">${item.level === 'N3' ? 'Ejecutar con código' : 'Ejecutar'}</button>` : ''}
        ${canSend ? `<button type="button" class="secondary small" data-office-act="send" data-id="${esc(item.id)}">Enviar tarjeta</button>` : ''}
      </div>
    </article>`;
}

async function approveProposal(item) {
  const ok = await confirmDialog({
    title: `Aprobar ${item.id}`,
    text: `Nivel ${item.level} · riesgo ${item.risk?.score ?? 0}/10 · ${item.level === 'N3' ? 'N3 exige código de ejecución.' : 'Aprobar mueve el gate; la ejecución es otro paso.'}`,
    okLabel: 'Aprobar'
  });
  if (!ok) return;
  const button = $(`[data-office-act="approve"][data-id="${item.id}"]`);
  setBusy(button, true, 'Aprobando');
  try {
    const result = await api.post(`/api/office/proposals/${encodeURIComponent(item.id)}/approve`, { by: 'owner', note: '' });
    if (result?.code) {
      state.office.codes[item.id] = result.code;
      await promptDialog({
        title: 'Código de ejecución N3',
        text: 'Guarda este código de 6 caracteres: lo pedirá la ejecución. También queda visible en la tarjeta.',
        label: 'Código',
        value: result.code
      });
    }
    const outbound = ['email', 'channel-send', 'document-send'].includes(item.kind);
    if (outbound) {
      toast(`Aprobada ${item.id} · lista para ejecutar`, 'ok', {
        actionLabel: 'Ejecutar ahora',
        duration: 12000,
        onAction: () => executeProposal(item)
      });
    } else {
      toast(`Aprobada ${item.id}`, 'ok');
    }
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
    await refreshOffice();
  }
}

async function rejectProposal(item) {
  const reason = await promptDialog({
    title: `Rechazar ${item.id}`,
    text: 'Motivo opcional. Queda en el ledger junto al rechazo.',
    label: 'Motivo',
    value: ''
  });
  if (reason === null) return;
  try {
    await api.post(`/api/office/proposals/${encodeURIComponent(item.id)}/reject`, { by: 'owner', reason: String(reason).slice(0, 500) });
    toast(`Rechazada ${item.id}`, 'ok');
    await refreshOffice();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

function editProposal(item) {
  const form = $('#proposalEditForm');
  if (!form) return;
  if (item.status !== 'pending' && item.status !== 'held') {
    toast('Solo se editan propuestas pendientes', 'warn');
    return;
  }
  form.dataset.id = item.id;
  form.elements.subject.value = item.subject || '';
  form.elements.body.value = item.body || '';
  openDialog('#dlg-proposal-edit');
}

async function saveProposalEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.id;
  const button = $('#proposalEditSave');
  if (!id) return;
  const subject = String(form.elements.subject.value || '').trim();
  const body = String(form.elements.body.value || '');
  if (!body.trim()) { toast('El cuerpo no puede quedar vacío', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post(`/api/office/proposals/${encodeURIComponent(id)}/revise`, {
      by: 'owner', subject, body
    });
    const item = result?.item || {};
    closeDialog('#dlg-proposal-edit');
    toast(`Propuesta revisada · ${item.level || ''} · riesgo ${item.risk?.score || 0}/10`, 'ok');
    await refreshOffice();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function correctProposal(item) {
  const text = await promptDialog({
    title: `Corregir ${item.id}`,
    text: 'Escribe qué hay que cambiar. La propuesta se rechaza con la corrección anotada para que la oficina la rehaga.',
    label: 'Corrección',
    value: ''
  });
  if (text === null || !String(text).trim()) return;
  try {
    await api.post(`/api/office/proposals/${encodeURIComponent(item.id)}/reject`, {
      by: 'owner',
      reason: `Corregir: ${String(text).trim().slice(0, 480)}`
    });
    toast('Corrección enviada (propuesta rechazada para rehacer)', 'ok');
    await refreshOffice();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function executeProposal(item) {
  let code = state.office.codes[item.id] || '';
  if (item.level === 'N3' || item.policy?.requiresCode) {
    const input = await promptDialog({
      title: `Ejecutar ${item.id}`,
      text: 'La propuesta N3 exige el código de 6 caracteres que se entregó al aprobar.',
      label: 'Código',
      value: code
    });
    if (input === null) return;
    code = String(input).trim();
  }
  const ok = await confirmDialog({
    title: 'Ejecutar propuesta',
    text: `Se ejecutará ${item.id}. La ejecución es el paso único y queda en el ledger.`,
    okLabel: 'Ejecutar'
  });
  if (!ok) return;
  try {
    const result = await api.post(`/api/office/proposals/${encodeURIComponent(item.id)}/execute`, { code });
    toast(result?.executed ? `Ejecutada ${item.id}` : `Ejecución enviada (${result?.status || 'en curso'})`, 'ok');
  } catch (error) {
    if (error?.code === 'EXECUTOR_UNAVAILABLE' || error?.status === 503) {
      toast('Quedó aprobada, pero el ejecutor no está conectado en este servidor. No se marcó como ejecutada.', 'warn');
    } else {
      toast(formatError(error), 'err');
    }
  } finally {
    await refreshOffice();
  }
}

async function sendCard(item, button) {
  const channel = await promptDialog({
    title: `Enviar tarjeta de ${item.id}`,
    text: 'Canal: whatsapp, telegram, email, simulator o generic. El simulador sirve para probar sin credenciales.',
    label: 'Canal',
    value: 'simulator'
  });
  if (channel === null) return;
  const target = String(channel).trim().toLowerCase();
  if (!target) return;
  setBusy(button, true, 'Enviando');
  try {
    const result = await api.post(`/api/channels/approvals/${encodeURIComponent(item.id)}/send`, {
      channel: target,
      ...(target === 'simulator' ? { to: 'demo-owner' } : {})
    });
    toast(`Tarjeta enviada por ${result?.channel || target}${result?.to ? ` a ${result.to}` : ''}`, 'ok');
  } catch (error) {
    if (error?.code === 'OWNER_NOT_CONFIGURED') {
      toast('Ese canal no tiene dueño autorizado. Configúralo en Integraciones.', 'warn');
    } else if (error?.code === 'ALREADY_DECIDED') {
      toast('Esa gestión ya se decidió.', 'warn');
    } else {
      toast(formatError(error), 'err');
    }
  } finally {
    setBusy(button, false);
  }
}

function renderLedger() {
  const box = $('#officeLedger');
  if (!box) return;
  const entries = [...(state.office.ledger || [])].reverse();
  const status = $('#officeLedgerStatus');
  if (status) {
    const verify = state.office.ledgerVerify;
    if (verify) {
      status.textContent = verify.ok
        ? `Cadena verificada: ${verify.entries} entradas, sin eslabones roto.`
        : `Cadena rota en ${verify.broken?.length || 0} entrada(s): revisa el ledger.`;
      status.className = verify.ok ? 'hint ok' : 'hint bad';
    } else {
      status.textContent = 'Cadena SHA-256 con génesis y encadenamiento por entrada. Verifica para comprobar que nadie la manipuló.';
      status.className = 'hint';
    }
  }
  if (!entries.length) { box.innerHTML = emptyState('El ledger está vacío: aún no hay eventos.', '⛓'); return; }
  box.innerHTML = entries.map((entry) => `
    <div class="ledger-row ${entry.broken ? 'ledger-bad' : ''}">
      <b>#${entry.seq}</b>
      <div>
        <b>${esc(entry.action)}</b>
        <small>${esc(entry.actor || 'api')} · ${esc(entry.ts ? fmtDateTime(entry.ts) : '')}</small>
      </div>
      <code title="${esc(entry.hash || '')}">${esc(String(entry.hash || '').slice(0, 10))}…</code>
    </div>`).join('');
}

async function verifyLedger() {
  try {
    const result = await api.get('/api/office/ledger/verify');
    state.office.ledgerVerify = result;
    renderLedger();
    toast(result.ok ? 'Cadena verificada: intacta' : 'La cadena tiene entradas rotas', result.ok ? 'ok' : 'err');
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

/** Aprueba por voz: «aprobar» o «aprobar OF-0007». */
export async function approveByVoice(text = '') {
  const match = /OF-\d+/i.exec(String(text));
  const item = match
    ? state.office.proposals.find((proposal) => proposal.id.toUpperCase() === match[0].toUpperCase())
    : state.office.proposals.find((proposal) => proposal.status === 'pending' || proposal.status === 'held');
  if (!item) { toast('No hay propuestas pendientes que aprobar', 'warn'); return false; }
  await approveProposal(item);
  return true;
}

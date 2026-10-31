/**
 * Reglas de correo y cuarentena: apartar remitentes/asuntos antes del
 * auto-borrador. Nada retenido se responde ni se envía sin acción del jefe.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, emptyState, fmtDateTime } from './core.js';

let initialized = false;
let rules = [];
let held = [];

export function initMailGuard() {
  if (initialized) return;
  initialized = true;

  $('#mailRuleForm')?.addEventListener('submit', addRule);
  $('#mailRulesList')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-mail-rule-delete]');
    if (!button) return;
    await removeRule(button.dataset.mailRuleDelete, button);
  });
  $('#mailQuarantineList')?.addEventListener('click', async (event) => {
    const release = event.target.closest('[data-quarantine-release]');
    if (release) { await releaseItem(release.dataset.quarantineRelease, release); return; }
    const discard = event.target.closest('[data-quarantine-discard]');
    if (discard) await discardItem(discard.dataset.quarantineDiscard, discard);
  });
}

export function renderMailGuard() {
  if (!initialized) initMailGuard();
  renderRules();
  renderHeld();
  refreshMailGuard().catch(() => {});
}

async function refreshMailGuard() {
  const [rulesResult, heldResult] = await Promise.all([
    api.get('/api/mail/rules').catch(() => ({ items: [] })),
    api.get('/api/mail/quarantine?status=held').catch(() => ({ items: [] }))
  ]);
  rules = Array.isArray(rulesResult?.items) ? rulesResult.items : [];
  held = Array.isArray(heldResult?.items) ? heldResult.items : [];
  renderRules();
  renderHeld();
  const state = $('#mailGuardState');
  if (state) state.textContent = `${rules.length} regla(s) · ${held.length} retenido(s)`;
}

function renderRules() {
  const list = $('#mailRulesList');
  if (!list) return;
  if (!rules.length) {
    list.innerHTML = '<p class="muted small">Sin reglas. El auto-borrador solo omite remitentes automáticos y boletines.</p>';
    return;
  }
  const fieldLabel = { from: 'Remitente', subject: 'Asunto' };
  const matchLabel = { contains: 'contiene', equals: 'igual a', domain: 'dominio' };
  const actionLabel = { quarantine: 'Retener', skip: 'Omitir' };
  list.innerHTML = rules.map((rule) => `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">MR</div>
      <div>
        <b>${esc(fieldLabel[rule.field] || rule.field)} ${esc(matchLabel[rule.match] || rule.match)} «${esc(rule.value)}»</b>
        <small>${esc(actionLabel[rule.action] || rule.action)} · ${esc(rule.id)}</small>
      </div>
      <div class="doc-actions">
        <button type="button" data-mail-rule-delete="${esc(rule.id)}">Quitar</button>
      </div>
    </div>`).join('');
}

function renderHeld() {
  const list = $('#mailQuarantineList');
  if (!list) return;
  if (!held.length) {
    list.innerHTML = emptyState('No hay correos retenidos. Cuando una regla aparte uno, aparecerá aquí.', '⛨');
    return;
  }
  list.innerHTML = held.map((item) => `
    <div class="doc-row">
      <div class="doc-icon" aria-hidden="true">Q</div>
      <div>
        <b>${esc(item.subject || '(sin asunto)')}</b>
        <small>${esc(item.from?.email || item.from?.name || 'remitente desconocido')} · ${esc(item.reason || '')}${item.date ? ` · ${esc(String(item.date).slice(0, 16))}` : ''}</small>
        <small>${esc(item.id)} · ${esc(fmtDateTime(item.createdAt))}</small>
      </div>
      <div class="doc-actions">
        <button type="button" data-quarantine-release="${esc(item.id)}">Redactar</button>
        <button type="button" data-quarantine-discard="${esc(item.id)}">Descartar</button>
      </div>
    </div>`).join('');
}

async function addRule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#mailRuleAdd');
  setBusy(button, true);
  try {
    await api.post('/api/mail/rules', {
      field: form.elements.field.value,
      match: form.elements.match.value,
      value: String(form.elements.value.value || '').trim(),
      action: form.elements.action.value
    });
    form.elements.value.value = '';
    toast('Regla añadida', 'ok');
    await refreshMailGuard();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function removeRule(id, button) {
  setBusy(button, true);
  try {
    await api.del(`/api/mail/rules/${encodeURIComponent(id)}`);
    toast('Regla eliminada', 'ok');
    await refreshMailGuard();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function releaseItem(id, button) {
  setBusy(button, true);
  try {
    const result = await api.post(`/api/mail/quarantine/${encodeURIComponent(id)}/release`, { compose: true });
    toast(result?.proposal?.id ? `Propuesta ${result.proposal.id} creada en la Oficina` : 'Mensaje liberado', 'ok');
    await refreshMailGuard();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function discardItem(id, button) {
  setBusy(button, true);
  try {
    await api.post(`/api/mail/quarantine/${encodeURIComponent(id)}/discard`, {});
    toast('Mensaje descartado', 'ok');
    await refreshMailGuard();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

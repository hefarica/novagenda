/**
 * Cuentas SMTP propias: configuración en Integraciones, sin Google.
 * La contraseña solo viaja al servidor al guardar; nunca se relee.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy } from './core.js';

let initialized = false;
let accounts = [];

export function initEmailAccounts() {
  if (initialized) return;
  initialized = true;

  $('#emailAccountForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await createAccount(event.currentTarget);
  });

  $('#emailAccountsList')?.addEventListener('click', async (event) => {
    const test = event.target.closest('[data-mail-test]');
    if (test) { await testAccount(test.dataset.mailTest, test); return; }
    const remove = event.target.closest('[data-mail-delete]');
    if (remove) { await deleteAccount(remove.dataset.mailDelete, remove); }
  });

  $('#emailAccountsRefresh')?.addEventListener('click', () => refresh());
}

export async function renderEmailAccounts() {
  await refresh();
}

async function refresh() {
  const box = $('#emailAccountsList');
  if (!box) return;
  try {
    const result = await api.get('/api/email/accounts');
    accounts = Array.isArray(result?.items) ? result.items : [];
    renderList();
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
  }
}

function renderList() {
  const box = $('#emailAccountsList');
  const state = $('#emailAccountsState');
  if (state) {
    state.textContent = accounts.length ? `${accounts.length} cuenta(s)` : 'Sin cuentas';
    state.className = `tag ${accounts.length ? 'ok' : 'off'}`;
  }
  if (!box) return;
  if (!accounts.length) {
    box.innerHTML = '<p class="hint">Aún no hay cuentas SMTP. Sin ellas, el correo real depende de Google.</p>';
    return;
  }
  box.innerHTML = accounts.map((account) => {
    const last = account.lastSendAt ? new Date(account.lastSendAt).toLocaleString('es-CO') : 'nunca';
    const error = account.lastError?.message
      ? `<p class="hint bad">Último error: ${esc(account.lastError.message)}</p>` : '';
    return `
    <article class="integration-item">
      <div class="card-head">
        <b>${esc(account.label || account.fromEmail)}</b>
        <span class="tag ${account.enabled ? 'ok' : 'off'}">${account.enabled ? 'Activa' : 'Pausada'}</span>
      </div>
      <p class="muted small">${esc(account.fromName ? `${account.fromName} · ` : '')}${esc(account.fromEmail)}</p>
      <p class="muted small">SMTP ${esc(account.host)}:${Number(account.port)} · ${account.secure ? 'TLS directo' : account.allowInsecure ? 'sin cifrar (solo prueba)' : 'STARTTLS'} · último envío: ${esc(last)}</p>
      ${error}
      <div class="row-actions">
        <button type="button" class="secondary small" data-mail-test="${esc(account.id)}">Probar envío</button>
        <button type="button" class="ghost small" data-mail-delete="${esc(account.id)}">Eliminar</button>
      </div>
    </article>`;
  }).join('');
}

async function createAccount(form) {
  const data = new FormData(form);
  const payload = {
    label: String(data.get('label') || '').trim() || undefined,
    fromEmail: String(data.get('fromEmail') || '').trim(),
    fromName: String(data.get('fromName') || '').trim() || undefined,
    host: String(data.get('host') || '').trim(),
    port: Number(data.get('port') || 465),
    secure: String(data.get('secure')) !== 'false',
    user: String(data.get('user') || '').trim(),
    password: String(data.get('password') || ''),
    allowInsecure: data.get('allowInsecure') === 'on'
  };
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true);
  try {
    await api.post('/api/email/accounts', payload);
    form.reset();
    const secureSelect = form.querySelector('select[name="secure"]');
    if (secureSelect) secureSelect.value = 'true';
    const port = form.querySelector('input[name="port"]');
    if (port) port.value = '465';
    toast('Cuenta SMTP guardada', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function testAccount(id, button) {
  setBusy(button, true);
  try {
    const result = await api.post(`/api/email/accounts/${encodeURIComponent(id)}/test`, {});
    toast(result?.account
      ? `Enviado desde ${result.account}: ${result.accepted?.length || 1} destinatario(s)`
      : 'Correo de prueba enviado', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
    await refresh();
  } finally {
    setBusy(button, false);
  }
}

async function deleteAccount(id, button) {
  if (!window.confirm('¿Eliminar esta cuenta SMTP? Dejará de usarse para enviar correo.')) return;
  setBusy(button, true);
  try {
    await api.delete(`/api/email/accounts/${encodeURIComponent(id)}`);
    toast('Cuenta SMTP eliminada', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}



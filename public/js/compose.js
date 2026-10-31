/**
 * Redacción y envío de correo desde la interfaz (también lo usa el dictado por
 * voz con «dictar correo»). Usa /api/gmail/send y la expansión de identidad.
 */
import { api, formatError } from './api.js';
import { state } from './state.js';
import { $, esc, toast, setBusy, openDialog, closeDialog, approvalNoticeHTML, autonomousNoticeHTML, isAutonomousSend, isPendingApproval } from './core.js';

let initialized = false;

export function initCompose() {
  if (initialized) return;
  initialized = true;

  $('#composeOpenBtn')?.addEventListener('click', () => openCompose({}));

  $('#composeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await sendCompose();
  });

  $('#composeExpand')?.addEventListener('click', expandRecipients);
  $('#composePeople')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-compose-email]');
    if (!chip) {
      const button = event.target.closest('[data-compose-person]');
      if (!button) return;
      const emails = String(button.dataset.composePerson || '').split(',').filter(Boolean);
      if (emails.length) {
        const field = $('#composeForm')?.elements.to;
        field.value = emails.join(', ');
        toast(`${emails.length} destinatario(s) añadidos`, 'ok');
      }
      return;
    }
    const field = $('#composeForm')?.elements.to;
    const current = field.value.split(/[,;]+/).map((value) => value.trim()).filter(Boolean);
    if (!current.includes(chip.dataset.composeEmail)) current.push(chip.dataset.composeEmail);
    field.value = current.join(', ');
  });
}

export function openCompose({ to = '', subject = '', body = '' } = {}) {
  const form = $('#composeForm');
  if (!form) return;
  form.reset();
  form.elements.to.value = to;
  form.elements.subject.value = subject;
  form.elements.body.value = body;
  const alertBox = $('#composeAlert');
  if (alertBox) { alertBox.hidden = true; alertBox.className = 'alert'; alertBox.setAttribute('role', 'alert'); }
  const people = $('#composePeople');
  if (people) people.textContent = '';
  openDialog('#dlg-compose');
}

async function expandRecipients() {
  const form = $('#composeForm');
  const query = form?.elements.to.value.trim();
  const box = $('#composePeople');
  if (!query || !box) { if (box) box.textContent = 'Escribe un nombre o correo primero.'; return; }
  box.textContent = 'Buscando…';
  try {
    const result = await api.post('/api/identity/expand', { query });
    if (!result?.people?.length) {
      box.innerHTML = '<span class="hint">Sin coincidencias. Escribe el correo completo.</span>';
      return;
    }
    const people = result.people.map((person) => `
      <button type="button" class="chip" data-compose-person="${esc((person.emails || []).join(','))}" title="${esc((person.evidence || []).slice(0, 2).map((item) => item.type || '').join(' · '))}">
        ${esc(person.name)} · ${esc((person.emails || [])[0] || '')}${person.requiresConfirmation ? ' ⚠' : ''}
      </button>`).join(' ');
    box.innerHTML = `<span class="muted small">${result.requiresConfirmation ? 'Confirma el destinatario: ' : 'Sugerencias: '}</span> ${people}`;
  } catch (error) {
    box.innerHTML = `<span class="hint bad">${esc(formatError(error))}</span>`;
  }
}

async function sendCompose() {
  const form = $('#composeForm');
  if (!form) return;
  const alertBox = $('#composeAlert');
  const to = form.elements.to.value.trim();
  const subject = form.elements.subject.value.trim();
  const body = form.elements.body.value.trim();
  const showAlert = (message, kind) => {
    if (!alertBox) return;
    alertBox.hidden = false;
    alertBox.setAttribute('role', 'alert');
    alertBox.className = `alert ${kind || ''}`.trim();
    alertBox.textContent = message;
  };
  if (!to) { showAlert('Escribe el destinatario.', 'warn'); form.elements.to.focus(); return; }
  if (!body) { showAlert('El mensaje está vacío.', 'warn'); form.elements.body.focus(); return; }
  const button = $('#composeSend');
  setBusy(button, true, 'Enviando');
  try {
    const result = await api.post('/api/gmail/send', { to, subject: subject || 'Mensaje', body });
    if (isAutonomousSend(result)) {
      if (alertBox) {
        alertBox.hidden = false;
        alertBox.className = 'alert ok';
        alertBox.setAttribute('role', 'status');
        alertBox.innerHTML = autonomousNoticeHTML(result);
      }
      toast('Enviado automáticamente por autonomía', 'ok');
      return;
    }
    if (isPendingApproval(result)) {
      if (alertBox) {
        alertBox.hidden = false;
        alertBox.className = 'alert info';
        alertBox.setAttribute('role', 'status');
        alertBox.innerHTML = approvalNoticeHTML(result);
      }
      toast('Preparado y enviado a la Oficina para tu aprobación', 'ok');
      return;
    }
    toast('Correo enviado', 'ok');
    closeDialog('#dlg-compose');
  } catch (error) {
    if (error?.status === 502 || error?.code === 'CHANNEL_ERROR' || error?.status === 503) {
      const message = 'No se pudo enviar: Gmail no está configurado o no tiene permiso de envío. Revisa Integraciones → Google.';
      showAlert(message, 'warn');
      toast(message, 'warn');
    } else {
      showAlert(formatError(error), 'warn');
      toast(formatError(error), 'err');
    }
  } finally {
    setBusy(button, false);
  }
}

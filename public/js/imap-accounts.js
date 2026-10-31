/**
 * Bandejas IMAP propias: configuración, prueba, últimos mensajes y tarea.
 * Solo lectura; nunca devuelve la contraseña al navegador.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, promptDialog } from './core.js';

let initialized = false;
let accounts = [];
let lastMessages = new Map();
let currentAccountId = null;
let watchInfo = null;
let pendingReply = null;
let pendingInstructions = '';

export function initImapAccounts() {
  if (initialized) return;
  initialized = true;

  $('#imapAccountForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await createAccount(event.currentTarget);
  });

  $('#imapAccountsList')?.addEventListener('click', async (event) => {
    const test = event.target.closest('[data-imap-test]');
    if (test) { await testAccount(test.dataset.imapTest, test); return; }
    const messages = event.target.closest('[data-imap-messages]');
    if (messages) { await showMessages(messages.dataset.imapMessages, messages); return; }
    const check = event.target.closest('[data-imap-check]');
    if (check) { await checkNow(check.dataset.imapCheck, check); return; }
    const auto = event.target.closest('[data-imap-autodraft]');
    if (auto) { await runAutoDraft(auto.dataset.imapAutodraft, auto); return; }
    const remove = event.target.closest('[data-imap-delete]');
    if (remove) { await deleteAccount(remove.dataset.imapDelete, remove); }
  });

  $('#imapAccountsList')?.addEventListener('change', async (event) => {
    const toggle = event.target.closest('[data-imap-auto]');
    if (!toggle) return;
    await toggleAutoDraft(toggle.dataset.imapAuto, toggle.checked, toggle);
  });

  $('#imapMessages')?.addEventListener('click', async (event) => {
    const task = event.target.closest('[data-imap-task]');
    if (task) { await createTask(Number(task.dataset.imapTask), task); return; }
    const reply = event.target.closest('[data-imap-reply]');
    if (reply) { await proposeReply(Number(reply.dataset.imapReply), reply); return; }
    const translate = event.target.closest('[data-imap-translate]');
    if (translate) { await translateMessage(Number(translate.dataset.imapTranslate), translate); return; }
    const create = event.target.closest('[data-imap-create]');
    if (create) { await createReplyProposal(create); return; }
    if (event.target.closest('[data-imap-discard]')) {
      pendingReply = null;
      const box = $('#imapReplyDraft');
      if (box) box.innerHTML = '';
      toast('Borrador descartado', 'ok');
      return;
    }
    if (event.target.closest('[data-imap-office]')) {
      document.querySelector('.drawer-nav [data-nav="office"], [data-nav="office"]')?.click();
    }
  });

  $('#imapAccountsRefresh')?.addEventListener('click', () => refresh());
}

export async function renderImapAccounts() {
  await refresh();
}

async function refresh() {
  const box = $('#imapAccountsList');
  if (!box) return;
  try {
    const result = await api.get('/api/imap/accounts');
    accounts = Array.isArray(result?.items) ? result.items : [];
    watchInfo = result?.watch || null;
    renderList();
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
  }
}

function renderList() {
  const box = $('#imapAccountsList');
  const state = $('#imapAccountsState');
  if (state) {
    const minutes = watchInfo?.running && watchInfo.everyMs ? Math.round(watchInfo.everyMs / 60000) : null;
    state.textContent = accounts.length
      ? `${accounts.length} bandeja(s)${minutes ? ` · vigilancia cada ${minutes} min` : ''}`
      : 'Sin bandejas';
    state.className = `tag ${accounts.length ? 'ok' : 'off'}`;
  }
  const messages = $('#imapMessages');
  if (messages) messages.innerHTML = '';
  if (!box) return;
  if (!accounts.length) {
    box.innerHTML = '<p class="hint">Aún no hay bandejas IMAP. Sin ellas, la entrada de correo sigue siendo solo Gmail.</p>';
    return;
  }
  box.innerHTML = accounts.map((account) => {
    const last = account.lastCheckAt ? new Date(account.lastCheckAt).toLocaleString('es-CO') : 'nunca';
    const error = account.lastError?.message ? `<p class="hint bad">Último error: ${esc(account.lastError.message)}</p>` : '';
    return `
    <article class="integration-item">
      <div class="card-head"><b>${esc(account.label || account.email)}</b><span class="tag ok">Lectura</span>${Number(account.newCount) > 0 ? `<span class="tag warn">${Number(account.newCount)} nuevo(s)</span>` : ''}</div>
      <p class="muted small">${esc(account.email)} · IMAP ${esc(account.host)}:${Number(account.port)} TLS · última revisión: ${esc(last)}</p>
      ${error}
      <div class="row-actions">
        <button type="button" class="secondary small" data-imap-test="${esc(account.id)}">Probar</button>
        <button type="button" class="ghost small" data-imap-check="${esc(account.id)}">Buscar nuevos</button>
        <button type="button" class="ghost small" data-imap-autodraft="${esc(account.id)}">Redactar nuevos</button>
        <button type="button" class="ghost small" data-imap-messages="${esc(account.id)}">Ver últimos</button>
        <label class="check small" title="La oficina redacta respuestas y las deja en la Oficina; nunca envía sola"><input type="checkbox" data-imap-auto="${esc(account.id)}" ${account.autoDraft ? 'checked' : ''} /> Auto-borrador</label>
        <button type="button" class="ghost small" data-imap-delete="${esc(account.id)}">Eliminar</button>
      </div>
    </article>`;
  }).join('');
}

async function createAccount(form) {
  const data = new FormData(form);
  const payload = {
    label: String(data.get('label') || '').trim() || undefined,
    email: String(data.get('email') || '').trim(),
    host: String(data.get('host') || '').trim(),
    port: Number(data.get('port') || 993),
    user: String(data.get('user') || '').trim(),
    password: String(data.get('password') || '')
  };
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true);
  try {
    await api.post('/api/imap/accounts', payload);
    form.reset();
    const port = form.querySelector('input[name="port"]');
    if (port) port.value = '993';
    toast('Bandeja IMAP guardada', 'ok');
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
    const result = await api.post(`/api/imap/accounts/${encodeURIComponent(id)}/test`, {});
    toast(`Conectada: ${Number(result?.messages || 0)} mensaje(s)${result?.lastSubject ? ` · «${result.lastSubject}»` : ''}`, 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
    await refresh();
  } finally {
    setBusy(button, false);
  }
}

async function showMessages(id, button) {
  const box = $('#imapMessages');
  if (!box) return;
  setBusy(button, true);
  box.innerHTML = '<p class="hint">Leyendo la bandeja…</p>';
  try {
    const result = await api.get(`/api/imap/accounts/${encodeURIComponent(id)}/messages?limit=5`);
    const items = Array.isArray(result?.messages) ? result.messages : [];
    lastMessages.set(id, items);
    currentAccountId = id;
    if (!items.length) { box.innerHTML = '<p class="hint">La bandeja no tiene mensajes.</p>'; return; }
    box.innerHTML = `<h4 class="muted small">Últimos ${items.length} mensaje(s) · ${esc(result.account?.email || '')}</h4>` +
      items.map((message, index) => `
        <article class="imap-card">
          <div class="card-head"><b>${esc(message.subject || '(sin asunto)')}</b><span class="tag">${esc(message.date ? new Date(message.date).toLocaleDateString('es-CO') : '')}</span></div>
          <p class="muted small">${esc(message.from?.name || '')} &lt;${esc(message.from?.email || '')}&gt;</p>
          <p class="small">${esc(message.excerpt || '')}</p>
          <div class="row-actions">
            <button type="button" class="secondary small" data-imap-reply="${index}">Proponer respuesta</button>
            <button type="button" class="ghost small" data-imap-translate="${index}">Traducir</button>
            <button type="button" class="ghost small" data-imap-task="${index}">Crear tarea</button>
          </div>
        </article>`).join('') + '<div id="imapReplyDraft"></div>';
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
  } finally {
    setBusy(button, false);
  }
}

async function createTask(index, button) {
  const message = (lastMessages.get(currentAccountId) || [])[index] || null;
  if (!message) { toast('No pude recuperar ese mensaje', 'err'); return; }
  setBusy(button, true);
  try {
    await api.post('/api/tasks', {
      title: `Responder: ${message.subject || '(sin asunto)'}`,
      notes: `De ${message.from?.name || ''} <${message.from?.email || ''}>: ${message.excerpt || ''}`.slice(0, 600),
      origin: 'correo',
      priority: 'P2'
    });
    toast('Tarea creada desde el correo', 'ok');
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function deleteAccount(id, button) {
  if (!window.confirm('¿Eliminar esta bandeja IMAP? Solo deja de leerse; no borra correo del servidor.')) return;
  setBusy(button, true);
  try {
    await api.del(`/api/imap/accounts/${encodeURIComponent(id)}`);
    toast('Bandeja IMAP eliminada', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}


async function proposeReply(index, button) {
  const message = (lastMessages.get(currentAccountId) || [])[index] || null;
  if (!message) { toast('No pude recuperar ese mensaje', 'err'); return; }
  const instructions = await promptDialog({
    title: 'Proponer respuesta',
    text: `Se redactará con tu estilo. Podrás corregirla antes de que entre a tu aprobación. Destinatario: ${message.from?.email || 'el remitente'}.`,
    label: '¿Qué quieres decir? (opcional)',
    value: ''
  });
  if (instructions === null) return;
  setBusy(button, true);
  try {
    const result = await api.post(`/api/imap/accounts/${encodeURIComponent(currentAccountId)}/messages/${message.uid}/reply-proposal`, {
      instructions: String(instructions || '').slice(0, 600),
      preview: true
    });
    const draft = result?.draft || {};
    pendingReply = { message, instructions: String(instructions || '') };
    pendingInstructions = String(instructions || '');
    const engineLabel = draft.engine === 'llm' ? 'modelo de lenguaje' : 'reglas de estilo';
    const box = $('#imapReplyDraft');
    if (box) {
      box.innerHTML = `
        <article class="imap-card">
          <div class="card-head"><b>Borrador editable · ${esc(engineLabel)}</b><span class="tag">sin propuesta todavía</span></div>
          <label class="field"><span>Asunto</span><input id="imapReplySubject" value="${esc(draft.subject || '')}" maxlength="250" /></label>
          <label class="field"><span>Cuerpo (puedes corregirlo)</span><textarea id="imapReplyBody" class="draft-body" rows="10">${esc(draft.body || '')}</textarea></label>
          <div class="row-actions">
            <button type="button" class="primary small" data-imap-create>Crear propuesta para aprobación</button>
            <button type="button" class="ghost small" data-imap-discard>Descartar</button>
          </div>
        </article>`;
    }
    toast('Borrador listo para editar', 'ok');
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function createReplyProposal(button) {
  if (!pendingReply) { toast('No hay borrador pendiente', 'err'); return; }
  const subject = $('#imapReplySubject')?.value || '';
  const body = $('#imapReplyBody')?.value || '';
  if (!String(body).trim()) { toast('El cuerpo no puede quedar vacío', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post(`/api/imap/accounts/${encodeURIComponent(currentAccountId)}/messages/${pendingReply.message.uid}/reply-proposal`, {
      instructions: pendingInstructions,
      subject,
      body
    });
    const draft = result?.draft || {};
    const box = $('#imapReplyDraft');
    if (box) {
      box.innerHTML = `
        <article class="imap-card">
          <div class="card-head"><b>Propuesta creada · ${esc(draft.engine === 'editado' ? 'texto corregido por ti' : 'borrador')}</b><span class="tag">N2 · sin enviar</span></div>
          <p class="muted small">${esc(draft.subject || subject)} → ${esc(pendingReply.message.from?.email || '')}</p>
          <pre class="draft-body">${esc(draft.body || body)}</pre>
          <div class="row-actions"><button type="button" class="primary small" data-imap-office>Revisar y aprobar en Oficina</button></div>
        </article>`;
    }
    pendingReply = null;
    toast('Propuesta creada · apruébala en Oficina', 'ok');
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}


async function checkNow(id, button) {
  setBusy(button, true);
  try {
    const result = await api.post(`/api/imap/accounts/${encodeURIComponent(id)}/check`, {});
    const count = Number(result?.newCount) || 0;
    toast(count ? `${count} correo(s) nuevo(s)` : 'Sin correo nuevo', count ? 'warn' : 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
    await refresh();
  } finally {
    setBusy(button, false);
  }
}



async function toggleAutoDraft(id, enabled, input) {
  input.disabled = true;
  try {
    await api.patch(`/api/imap/accounts/${encodeURIComponent(id)}`, { autoDraft: enabled === true });
    toast(enabled ? 'Auto-borrador activado · solo propuestas, nada se envía' : 'Auto-borrador desactivado', 'ok');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
    input.checked = !enabled;
  } finally {
    input.disabled = false;
  }
}

async function runAutoDraft(id, button) {
  setBusy(button, true);
  try {
    const result = await api.post(`/api/imap/accounts/${encodeURIComponent(id)}/auto-draft`, {});
    const created = Number(result?.created) || 0;
    toast(created ? `${created} propuesta(s) redactada(s) · revísalas en Oficina` : 'Sin correos nuevos que redactar', created ? 'ok' : 'warn');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function translateMessage(index, button) {
  const message = (lastMessages.get(currentAccountId) || [])[index] || null;
  if (!message) { toast('No pude recuperar ese mensaje', 'err'); return; }
  const target = await promptDialog({
    title: 'Traducir correo',
    text: 'Idioma destino: es, en, pt, fr, de o it. El texto se envía al proveedor LLM configurado.',
    label: 'Idioma',
    value: 'es'
  });
  if (target === null) return;
  const code = String(target).trim().toLowerCase();
  const text = String(message.text || message.excerpt || '').trim();
  if (!text) { toast('El mensaje no tiene texto para traducir', 'err'); return; }
  setBusy(button, true);
  try {
    const result = await api.post('/api/translate', { text, to: code });
    const article = button.closest('article.imap-card');
    if (article) {
      article.querySelector('.translation-body')?.remove();
      const pre = document.createElement('pre');
      pre.className = 'translation-body';
      pre.textContent = result?.translation || '';
      article.appendChild(pre);
    }
    toast(`Traducido a ${result?.to || code}`, 'ok');
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

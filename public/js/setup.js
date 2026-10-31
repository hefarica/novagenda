/**
 * Puesta en marcha asistida. La configuración técnica vive en presets;
 * el usuario solo escribe credenciales. Camila explica y ordena los pasos.
 */
import { api, formatError } from './api.js';
import { $, esc, setBusy, toast } from './core.js';
import { refreshAll } from './data.js';
import { renderMessage } from './markdown.js';

const STYLE_REGISTERS = [
  ['cliente', 'Cliente'], ['proveedor', 'Proveedor'], ['entidad', 'Entidad pública'],
  ['colega', 'Colega'], ['familiar', 'Familiar']
];

let initialized = false;
let overview = null;
let loading = false;
let openStep = null;
let chatStarted = false;
let sending = false;
let recognition = null;

function statusLabel(status) {
  if (status === 'done') return 'Listo';
  if (status === 'partial') return 'A medias';
  return 'Pendiente';
}

function statusClass(status) {
  return status === 'done' ? 'ok' : status === 'partial' ? 'warn' : 'off';
}

function stepById(id) {
  return overview?.steps?.find((step) => step.id === id) || null;
}

function field(step, selector) {
  return document.querySelector(`#setupSteps [data-step="${step}"] ${selector}`);
}

function setResult(step, message, kind = 'info') {
  const box = document.querySelector(`[data-setup-result="${step}"]`);
  if (!box) return;
  box.hidden = false;
  box.className = `alert ${kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : 'info'} setup-result`;
  box.textContent = message;
}

function clearResult(step) {
  const box = document.querySelector(`[data-setup-result="${step}"]`);
  if (box) { box.hidden = true; box.textContent = ''; }
}

function renderHero() {
  const score = Math.max(0, Math.min(100, Number(overview?.score) || 0));
  const ring = $('#setupRing');
  if (ring) ring.style.setProperty('--setup-score', String(score));
  const scoreNode = $('#setupScore');
  if (scoreNode) scoreNode.textContent = `${score}%`;
  const meter = $('#setupMeterBar');
  if (meter) meter.style.width = `${score}%`;
  const count = $('#setupCount');
  if (count) count.textContent = `${overview.done} de ${overview.total} conexiones listas · ${overview.partial} a medias`;
  const next = $('#setupNext');
  if (next) next.textContent = overview.next ? `Siguiente: ${overview.next.title}` : 'Todo lo esencial está listo';
  const headline = $('#setupHeadline');
  if (headline) {
    headline.textContent = score === 100
      ? 'Tu oficina está conectada'
      : score >= 50 ? 'Vas por buen camino' : 'Empecemos por lo esencial';
  }
  const sub = $('#setupSub');
  if (sub) {
    sub.textContent = overview.next
      ? `Lo siguiente es ${overview.next.title.toLowerCase()}. Tú pones las credenciales; el resto lo dejo configurado.`
      : 'Revisa los detalles o pídeme una prueba real contigo delante.';
  }
  const team = $('#setupTeam');
  if (team) {
    team.innerHTML = (overview.team || []).map((member) => `
      <span class="setup-person" title="${esc(member.role)} · ${esc(member.tone)}">
        <i>${esc(member.initials)}</i><span><b>${esc(member.name)}</b><small>${esc(member.role)}</small></span>
      </span>`).join('');
  }
}

function emailForm() {
  const presets = overview?.presets?.email || [];
  return `
    <div class="setup-form-grid">
      <label class="field"><span>Proveedor</span>
        <select data-email-provider>
          ${presets.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.label)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Correo electrónico</span>
        <input type="email" data-email-address autocomplete="username" placeholder="tu@correo.com" />
      </label>
      <label class="field"><span>Contraseña de aplicación</span>
        <input type="password" data-email-password autocomplete="new-password" placeholder="No es tu contraseña normal si tienes 2FA" />
      </label>
      <label class="field"><span>Tu nombre en la firma</span>
        <input data-email-from-name value="Héctor Fabio Riascos C." autocomplete="name" />
      </label>
    </div>
    <p class="hint" data-email-note></p>
    <div class="setup-gmail-help" data-email-gmail-help hidden>
      <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Crear contraseña de aplicación en Google</a>
      <button type="button" class="ghost small" data-setup-open="google">Conectar Gmail con Google OAuth</button>
    </div>
    <details class="setup-advanced">
      <summary>Servidores ya configurados (solo si tu proveedor es distinto)</summary>
      <div class="setup-form-grid setup-form-grid-4">
        <label class="field"><span>SMTP</span><input data-email-smtp-host placeholder="smtp.tuproveedor.com" /></label>
        <label class="field"><span>Puerto SMTP</span><input data-email-smtp-port type="number" min="1" max="65535" /></label>
        <label class="field"><span>IMAP</span><input data-email-imap-host placeholder="imap.tuproveedor.com" /></label>
        <label class="field"><span>Puerto IMAP</span><input data-email-imap-port type="number" min="1" max="65535" /></label>
      </div>
      <label class="check small"><input type="checkbox" data-email-secure /><span>SMTP con TLS directo (465). Desmárcalo solo si tu proveedor usa STARTTLS (587).</span></label>
    </details>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="email-connect">Conectar, probar y enviar prueba</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="email" hidden></div>`;
}

function googleForm() {
  return `
    <p class="muted">Pega las dos credenciales del proyecto OAuth. Yo ya tengo los permisos y las URLs de retorno preparados.</p>
    <div class="setup-form-grid">
      <label class="field"><span>Client ID</span><input data-google-id placeholder="…apps.googleusercontent.com" autocomplete="off" /></label>
      <label class="field"><span>Client Secret</span><input type="password" data-google-secret placeholder="GOCSPX-…" autocomplete="new-password" /></label>
    </div>
    <div class="setup-redirects">
      <span>URL de retorno autorizada</span>
      <code>${esc(overview.redirects.google)}</code>
      <button type="button" class="ghost small" data-copy="${esc(overview.redirects.google)}">Copiar</button>
    </div>
    <p class="hint">En Google Cloud: APIs y servicios → Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web. Añade tu cuenta como usuario de prueba.</p>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="google-save">Guardar y autorizar cuenta</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="google" hidden></div>`;
}

function telegramForm() {
  return `
    <div class="setup-form-grid">
      <label class="field"><span>Token del bot</span><input type="password" data-tg-token placeholder="123456:ABC…" autocomplete="new-password" /></label>
      <label class="field"><span>Tu chat ID</span><input data-tg-chat placeholder="Escríbele al bot y usa su chat.id" autocomplete="off" /></label>
    </div>
    <p class="hint">Modo local <b>polling</b> ya configurado: no necesitas abrir puertos ni HTTPS. Yo guardo el token cifrado y hago una prueba de mensaje. También entiendo <b>notas de voz</b>: se transcriben localmente con Whisper, sin subirlas a la nube.</p>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="telegram-save">Guardar y probar</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="telegram" hidden></div>`;
}

function whatsappForm() {
  return `
    <div class="setup-form-grid">
      <label class="field"><span>Access Token de Meta</span><input type="password" data-wa-token placeholder="EAA…" autocomplete="new-password" /></label>
      <label class="field"><span>Phone Number ID</span><input data-wa-phone placeholder="1234567890" autocomplete="off" /></label>
      <label class="field"><span>Tu número con código de país</span><input data-wa-to placeholder="573001112233" autocomplete="tel" /></label>
    </div>
    <p class="hint">Esta es la vía oficial de WhatsApp Business API. No uso tu WhatsApp personal ni un puente no oficial. El número debe estar verificado en Meta.</p>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="whatsapp-save">Guardar y probar</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="whatsapp" hidden></div>`;
}

function llmForm() {
  const presets = overview?.presets?.llm || [];
  return `
    <div class="setup-form-grid">
      <label class="field"><span>Proveedor</span>
        <select data-llm-preset>${presets.map((preset) => `<option value="${esc(preset.id)}">${esc(preset.label)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Clave de API</span><input type="password" data-llm-key placeholder="sk-… (no vuelve al navegador)" autocomplete="new-password" /></label>
      <label class="field"><span>Modelo</span><input data-llm-model autocomplete="off" /></label>
      <label class="field"><span>URL base</span><input data-llm-url autocomplete="off" /></label>
    </div>
    <p class="hint" data-llm-note></p>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="llm-save">Guardar y probar modelo</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="llm" hidden></div>`;
}

function mcpForm() {
  const presets = overview?.presets?.mcp || [];
  return `
    <p class="muted">Crea el preset desactivado. Así lo revisas y lo activas solo cuando quieras que la oficina toque tu equipo.</p>
    <div class="setup-preset-list">
      ${presets.map((preset) => `
        <label class="setup-preset">
          <input type="radio" name="setup-mcp-preset" value="${esc(preset.id)}" data-mcp-preset />
          <span><b>${esc(preset.label)}</b><small>${esc(preset.description)}</small></span>
        </label>`).join('')}
    </div>
    <p class="hint" data-mcp-note>Elige uno y lo dejo preparado en Ajustes → MCP.</p>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="mcp-save">Crear preset desactivado</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="mcp" hidden></div>`;
}

function styleForm() {
  return `
    <div class="setup-form-grid">
      <label class="field"><span>Registro</span>
        <select data-style-register>${STYLE_REGISTERS.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}</select>
      </label>
    </div>
    <label class="field"><span>Pega 25–50 correos tuyos (separados por una línea con ---)</span>
      <textarea data-style-samples rows="6" placeholder="Hola Andrés, …&#10;---&#10;Cordialmente,&#10;Héctor Fabio Riascos C."></textarea>
    </label>
    <p class="hint">Sin muestras reales solo puedo escribir un formal genérico. Las muestras se analizan localmente; no se envían a ningún modelo.</p>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="style-save">Analizar y guardar muestras</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="style" hidden></div>`;
}

function nudgesForm() {
  const connections = overview.connections || {};
  const checked = new Set(connections.nudgeChannels || []);
  const options = [
    ['email', 'Correo', connections.smtp > 0],
    ['telegram', 'Telegram', connections.telegram],
    ['whatsapp', 'WhatsApp', connections.whatsapp]
  ];
  return `
    <p class="muted">Elige por dónde quieres que te avise. El motor ya está activo; sin canal no tiene por dónde entregarte nada.</p>
    <div class="setup-channels">
      ${options.map(([value, label, ready]) => `
        <label class="check"><input type="checkbox" value="${value}" data-nudge-channel ${checked.has(value) ? 'checked' : ''} ${ready ? '' : 'disabled'} />
          <span>${esc(label)}${ready ? '' : ' · conecta el canal primero'}</span></label>`).join('')}
    </div>
    <div class="row-actions">
      <button type="button" class="primary" data-setup-action="nudges-save">Guardar recordatorios</button>
      <button type="button" class="ghost" data-setup-action="close">Cancelar</button>
    </div>
    <div class="alert info setup-result" data-setup-result="nudges" hidden></div>`;
}

function formFor(stepId) {
  if (stepId === 'email') return emailForm();
  if (stepId === 'google') return googleForm();
  if (stepId === 'telegram') return telegramForm();
  if (stepId === 'whatsapp') return whatsappForm();
  if (stepId === 'llm') return llmForm();
  if (stepId === 'mcp') return mcpForm();
  if (stepId === 'style') return styleForm();
  if (stepId === 'nudges') return nudgesForm();
  return '';
}

function renderSteps() {
  const box = $('#setupSteps');
  if (!box || !overview) return;
  box.innerHTML = overview.steps.map((step) => `
    <article class="setup-step ${openStep === step.id ? 'open' : ''}" data-step="${esc(step.id)}">
      <div class="setup-step-head">
        <div class="setup-step-icon" aria-hidden="true">${esc(step.icon)}</div>
        <div class="setup-step-copy"><h3>${esc(step.title)}</h3><p>${esc(step.why)}</p><small>${esc(step.detail)}</small></div>
        <span class="tag ${statusClass(step.status)}">${statusLabel(step.status)}</span>
        <button type="button" class="ghost small" data-setup-open="${esc(step.id)}">${openStep === step.id ? 'Cerrar' : step.action}</button>
      </div>
      ${openStep === step.id ? `<div class="setup-step-body">${formFor(step.id)}</div>` : ''}
    </article>`).join('');
  if (openStep === 'email') syncEmailPreset();
  if (openStep === 'llm') applyLlmPreset();
}

function renderChatIntro() {
  if (chatStarted) return;
  chatStarted = true;
  const chat = $('#setupChat');
  if (chat) chat.innerHTML = '';
  const pending = overview.next
    ? `Nos falta **${overview.next.title}** y alguna cosa más. Empezaría por ahí; dime si quieres que te explique qué poner.`
    : 'Ya tienes lo esencial. Puedo revisar detalles o preparar una prueba real contigo delante.';
  addBotMessage(`Hola, soy Camila. ${pending}`);
}

function addUserMessage(text) {
  const chat = $('#setupChat');
  if (!chat) return;
  chat.insertAdjacentHTML('beforeend', `<div class="setup-msg user"><b>Tú</b><p>${esc(text)}</p></div>`);
  chat.scrollTop = chat.scrollHeight;
}

function addBotMessage(text, source = '') {
  const chat = $('#setupChat');
  if (!chat) return;
  chat.insertAdjacentHTML('beforeend', `<div class="setup-msg bot"><b>Camila</b><div class="chat-md">${renderMessage(text)}</div></div>`);
  chat.scrollTop = chat.scrollHeight;
}

function addTyping() {
  const chat = $('#setupChat');
  if (!chat) return null;
  const node = document.createElement('div');
  node.className = 'setup-msg bot setup-typing';
  node.innerHTML = '<b>Camila</b><p><i></i><i></i><i></i></p>';
  chat.appendChild(node);
  chat.scrollTop = chat.scrollHeight;
  return node;
}

async function sendChat(text) {
  const message = String(text || '').trim();
  if (!message || sending) return;
  sending = true;
  addUserMessage(message);
  const typing = addTyping();
  const input = $('#setupChatInput');
  if (input) input.value = '';
  try {
    const result = await api.post('/api/setup/assist', { message }, { timeoutMs: 35000 });
    typing?.remove();
    addBotMessage(result?.reply || 'No pude responder, pero puedes seguir con el siguiente paso.', result?.source);
    if (result?.overview) { overview = result.overview; renderHero(); }
  } catch (error) {
    typing?.remove();
    addBotMessage(`No pude consultar al equipo: ${formatError(error)}. Puedes seguir con el paso que te muestro al lado.`);
  } finally {
    sending = false;
  }
}

function syncEmailPreset() {
  const select = field('email', '[data-email-provider]');
  if (!select) return;
  const preset = (overview.presets.email || []).find((item) => item.id === select.value);
  if (!preset) return;
  const smtpHost = field('email', '[data-email-smtp-host]');
  const smtpPort = field('email', '[data-email-smtp-port]');
  const imapHost = field('email', '[data-email-imap-host]');
  const imapPort = field('email', '[data-email-imap-port]');
  const secure = field('email', '[data-email-secure]');
  if (smtpHost) smtpHost.value = preset.smtp.host;
  if (smtpPort) smtpPort.value = preset.smtp.port;
  if (imapHost) imapHost.value = preset.imap.host;
  if (imapPort) imapPort.value = preset.imap.port;
  if (secure) secure.checked = preset.smtp.secure;
  const note = field('email', '[data-email-note]');
  if (note) note.textContent = preset.note;
  const gmailHelp = field('email', '[data-email-gmail-help]');
  if (gmailHelp) gmailHelp.hidden = preset.id !== 'gmail';
}

function detectEmailProvider(address) {
  const domain = String(address || '').toLowerCase().split('@')[1] || '';
  const preset = (overview.presets.email || []).find((item) => item.domains.includes(domain));
  const select = field('email', '[data-email-provider]');
  if (!preset || !select || select.value === preset.id) return;
  select.value = preset.id;
  syncEmailPreset();
}

function applyLlmPreset() {
  const select = field('llm', '[data-llm-preset]');
  if (!select) return;
  const preset = (overview.presets.llm || []).find((item) => item.id === select.value);
  if (!preset) return;
  const url = field('llm', '[data-llm-url]');
  const model = field('llm', '[data-llm-model]');
  const note = field('llm', '[data-llm-note]');
  const key = field('llm', '[data-llm-key]');
  if (url) url.value = preset.baseUrl;
  if (model) model.value = preset.model;
  if (note) note.textContent = preset.note;
  if (key) key.disabled = preset.provider === 'ollama';
}

async function saveSecret(name, value) {
  if (!value) return false;
  await api.put(`/api/secrets/${encodeURIComponent(name)}`, { value });
  return true;
}

async function connectEmail(button) {
  const address = field('email', '[data-email-address]')?.value.trim() || '';
  const password = field('email', '[data-email-password]')?.value || '';
  const fromName = field('email', '[data-email-from-name]')?.value.trim() || 'Héctor Fabio Riascos C.';
  const smtpHost = field('email', '[data-email-smtp-host]')?.value.trim() || '';
  const smtpPort = Number(field('email', '[data-email-smtp-port]')?.value || 465);
  const imapHost = field('email', '[data-email-imap-host]')?.value.trim() || '';
  const imapPort = Number(field('email', '[data-email-imap-port]')?.value || 993);
  const secure = field('email', '[data-email-secure]')?.checked !== false;
  const provider = field('email', '[data-email-provider]')?.value || '';
  if (!address || !password) return setResult('email', 'Escribe tu correo y la contraseña de aplicación.', 'warn');
  if (!smtpHost || !imapHost) return setResult('email', 'Falta el servidor SMTP o IMAP. Elige un proveedor o escríbelos en la sección avanzada.', 'warn');
  if (provider === 'gmail' && password.replace(/\s/g, '').length !== 16) {
    return setResult('email', 'Gmail rechaza tu contraseña normal. Activa la verificación en dos pasos, crea una Contraseña de aplicación de 16 caracteres y pégala sin espacios. También puedes usar el botón “Conectar Gmail con Google OAuth”.', 'warn');
  }
  setBusy(button, true, 'Conectando');
  setResult('email', 'Creando cuenta de envío y bandeja…', 'info');
  try {
    const accounts = await api.get('/api/email/accounts');
    const existing = (accounts.items || []).find((item) => item.user === address || item.fromEmail === address);
    const body = { host: smtpHost, port: smtpPort, secure, user: address, password, fromEmail: address, fromName, label: address };
    let smtp;
    if (existing) smtp = await api.patch(`/api/email/accounts/${encodeURIComponent(existing.id)}`, body);
    else smtp = await api.post('/api/email/accounts', body);
    const smtpId = smtp.item?.id;
    if (!smtpId) throw new Error('No se pudo crear la cuenta de envío.');
    setResult('email', 'Envío creado. Enviando correo de prueba a tu propia dirección…', 'info');
    const smtpTest = await api.post(`/api/email/accounts/${encodeURIComponent(smtpId)}/test`, { to: address }, { timeoutMs: 60000 });
    setResult('email', `Envío listo: ${smtpTest.messageId || 'correo de prueba aceptado'}. Ahora la bandeja IMAP…`, 'info');
    const imaps = await api.get('/api/imap/accounts');
    const oldImap = (imaps.items || []).find((item) => item.email === address);
    if (oldImap) await api.del(`/api/imap/accounts/${encodeURIComponent(oldImap.id)}`).catch(() => {});
    const imap = await api.post('/api/imap/accounts', { host: imapHost, port: imapPort, secure: true, user: address, password, email: address, label: address });
    const imapId = imap.item?.id;
    if (!imapId) throw new Error('No se pudo crear la bandeja IMAP.');
    const imapTest = await api.post(`/api/imap/accounts/${encodeURIComponent(imapId)}/test`, {}, { timeoutMs: 30000 });
    await refreshAll();
    await finishStep('email', `✓ Correo y bandeja conectados. Prueba enviada y ${imapTest.messages ?? 0} mensaje(s) visibles en la bandeja.`, 'ok', 'Correo conectado y probado');
  } catch (error) {
    const raw = formatError(error);
    const gmailAuth = /534|5\.7\.9|InvalidSecondFactor|Application-specific password/i.test(raw);
    setResult('email', gmailAuth
      ? 'Gmail rechazó la contraseña porque no es una contraseña de aplicación válida. No uses tu contraseña normal: activa la verificación en dos pasos, crea una Contraseña de aplicación de 16 caracteres y pégala sin espacios. Si tu cuenta es de empresa y no aparece esa opción, pide a tu administrador o usa Google OAuth.'
      : `No quedó completo: ${raw}. El envío pudo quedar guardado; revisa el dato y vuelve a intentar.`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function saveGoogle(button) {
  const id = field('google', '[data-google-id]')?.value.trim() || '';
  const secret = field('google', '[data-google-secret]')?.value.trim() || '';
  if (!id || !secret) return setResult('google', 'Faltan Client ID o Client Secret.', 'warn');
  setBusy(button, true, 'Guardando');
  try {
    await saveSecret('google.clientId', id);
    await saveSecret('google.clientSecret', secret);
    setResult('google', 'Credenciales guardadas. Abriendo Google para autorizar tu cuenta…', 'ok');
    window.location.assign('/api/auth/google/start?label=Personal');
  } catch (error) {
    setResult('google', `No se pudieron guardar: ${formatError(error)}`, 'warn');
    setBusy(button, false);
  }
}

async function saveTelegram(button) {
  const token = field('telegram', '[data-tg-token]')?.value.trim() || '';
  const chatId = field('telegram', '[data-tg-chat]')?.value.trim() || '';
  if (!token) return setResult('telegram', 'Pega el token de @BotFather.', 'warn');
  setBusy(button, true, 'Probando');
  try {
    await saveSecret('channels.telegram.botToken', token);
    if (chatId) await saveSecret('channels.telegram.defaultChatId', chatId);
    await saveSecret('channels.telegram.enabled', 'true');
    setResult('telegram', 'Token guardado. Enviando mensaje de prueba…', 'info');
    await api.post('/api/telegram/test', { chatId, text: 'Prueba de la oficina · Camila ya está contigo.' }, { timeoutMs: 30000 });
    await finishStep('telegram', '✓ Telegram conectado y mensaje de prueba aceptado.', 'ok', 'Telegram conectado');
  } catch (error) {
    await saveSecret('channels.telegram.enabled', 'false').catch(() => {});
    setResult('telegram', `Token guardado, pero la prueba falló: ${formatError(error)}. Revisa el chat ID o vuelve a intentarlo.`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function saveWhatsApp(button) {
  const token = field('whatsapp', '[data-wa-token]')?.value.trim() || '';
  const phone = field('whatsapp', '[data-wa-phone]')?.value.trim() || '';
  const to = field('whatsapp', '[data-wa-to]')?.value.trim() || '';
  if (!token || !phone || !to) return setResult('whatsapp', 'Faltan el token, el Phone Number ID o tu número de destino.', 'warn');
  setBusy(button, true, 'Probando');
  try {
    await saveSecret('channels.whatsapp.accessToken', token);
    await saveSecret('channels.whatsapp.phoneNumberId', phone);
    await saveSecret('channels.whatsapp.defaultTo', to);
    await saveSecret('channels.whatsapp.enabled', 'true');
    setResult('whatsapp', 'Credenciales guardadas. Enviando mensaje de prueba…', 'info');
    await api.post('/api/whatsapp/test', { to, text: 'Prueba de la oficina · Camila ya está contigo.' }, { timeoutMs: 30000 });
    await finishStep('whatsapp', '✓ WhatsApp oficial conectado y prueba aceptada.', 'ok', 'WhatsApp conectado');
  } catch (error) {
    await saveSecret('channels.whatsapp.enabled', 'false').catch(() => {});
    setResult('whatsapp', `Credenciales guardadas, pero la prueba falló: ${formatError(error)}. Revisa el token y el número.`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function saveLlm(button) {
  const preset = (overview.presets.llm || []).find((item) => item.id === field('llm', '[data-llm-preset]')?.value);
  const key = field('llm', '[data-llm-key]')?.value.trim() || '';
  const model = field('llm', '[data-llm-model]')?.value.trim() || preset?.model;
  const url = field('llm', '[data-llm-url]')?.value.trim() || preset?.baseUrl;
  if (!preset) return setResult('llm', 'Elige un proveedor.', 'warn');
  if (preset.provider !== 'ollama' && !key) return setResult('llm', 'Falta la clave de API.', 'warn');
  setBusy(button, true, 'Guardando');
  const body = preset.provider === 'ollama'
    ? { provider: 'ollama', ollamaUrl: url, ollamaModel: model, enabled: true }
    : { provider: 'openai', baseUrl: url, model, enabled: true, ...(key ? { apiKey: key } : {}) };
  try {
    await api.post('/api/llm/config', body);
    setResult('llm', 'Configuración guardada. Probando el modelo…', 'info');
    const test = await api.post('/api/llm/test', {}, { timeoutMs: 35000 });
    const message = test?.ok
      ? `✓ Modelo respondiendo (${test.provider || preset.label}, ${test.latencyMs || '—'} ms).`
      : `Guardado, pero el modelo no respondió: ${test?.error || 'sin detalle'}.`;
    await finishStep('llm', message, test?.ok ? 'ok' : 'warn', test?.ok ? 'Modelo conectado' : '');
  } catch (error) {
    setResult('llm', `No se pudo configurar: ${formatError(error)}`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function saveMcp(button) {
  const input = document.querySelector('#setupSteps [data-mcp-preset]:checked');
  const preset = (overview.presets.mcp || []).find((item) => item.id === input?.value);
  if (!preset) return setResult('mcp', 'Elige Desktop Commander o Playwright.', 'warn');
  setBusy(button, true, 'Creando');
  try {
    const servers = await api.get('/api/mcp/servers');
    if ((servers.items || []).some((server) => server.name === preset.label)) {
      setResult('mcp', `Ya existe un servidor «${preset.label}». Actívalo en Ajustes → MCP cuando quieras.`, 'info');
      return;
    }
    const command = /Windows/i.test(navigator.userAgent) ? 'npx.cmd' : 'npx';
    await api.post('/api/mcp/servers', {
      name: preset.label,
      transport: 'stdio',
      command,
      args: preset.args,
      enabled: false,
      timeoutMs: 20000
    });
    await finishStep('mcp', `✓ Preset «${preset.label}» creado desactivado. Actívalo en Ajustes → MCP después de revisarlo.`, 'ok', 'Preset MCP creado');
  } catch (error) {
    setResult('mcp', `No se pudo crear: ${formatError(error)}`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function saveStyle(button) {
  const register = field('style', '[data-style-register]')?.value || 'cliente';
  const raw = field('style', '[data-style-samples]')?.value || '';
  const samples = raw.split(/\n\s*---\s*\n|\n{2,}/).map((s) => s.trim()).filter((s) => s.length >= 20);
  if (!samples.length) return setResult('style', 'Pega al menos un correo completo (20 caracteres o más).', 'warn');
  if (samples.length > 50) return setResult('style', 'Máximo 50 muestras por vez.', 'warn');
  setBusy(button, true, 'Analizando');
  try {
    const result = await api.post('/api/style/samples', { register, samples });
    await finishStep('style', `✓ ${result.added ?? samples.length} muestra(s) añadidas. Total del registro: ${result.samples ?? '—'}.`, 'ok', 'Muestras de estilo guardadas');
  } catch (error) {
    setResult('style', `No se pudieron guardar: ${formatError(error)}`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function saveNudges(button) {
  const channels = [...document.querySelectorAll('#setupSteps [data-nudge-channel]:checked')].map((input) => input.value);
  if (!channels.length) return setResult('nudges', 'Marca al menos un canal por el que quieras recibir avisos.', 'warn');
  setBusy(button, true, 'Guardando');
  try {
    await api.post('/api/nudges/config', { channels, enabled: true });
    await finishStep('nudges', `✓ Recordatorios activos por ${channels.join(', ')}.`, 'ok', 'Recordatorios configurados');
  } catch (error) {
    setResult('nudges', `No se pudieron guardar: ${formatError(error)}`, 'warn');
  } finally {
    setBusy(button, false);
  }
}

async function onStepClick(event) {
  const copy = event.target.closest('[data-copy]');
  if (copy) { copyText(copy.dataset.copy || ''); return; }
  const open = event.target.closest('[data-setup-open]');
  if (open) {
    openStep = openStep === open.dataset.setupOpen ? null : open.dataset.setupOpen;
    renderSteps();
    if (openStep) document.querySelector(`[data-step="${openStep}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const action = event.target.closest('[data-setup-action]')?.dataset.setupAction;
  if (!action) return;
  const button = event.target.closest('[data-setup-action]');
  if (action === 'close') { openStep = null; renderSteps(); return; }
  if (action === 'email-connect') return connectEmail(button);
  if (action === 'google-save') return saveGoogle(button);
  if (action === 'telegram-save') return saveTelegram(button);
  if (action === 'whatsapp-save') return saveWhatsApp(button);
  if (action === 'llm-save') return saveLlm(button);
  if (action === 'mcp-save') return saveMcp(button);
  if (action === 'style-save') return saveStyle(button);
  if (action === 'nudges-save') return saveNudges(button);
}

function onStepInput(event) {
  if (event.target.matches('[data-email-address]')) detectEmailProvider(event.target.value);
  if (event.target.matches('[data-email-provider]')) syncEmailPreset();
  if (event.target.matches('[data-llm-preset]')) applyLlmPreset();
  if (event.target.matches('[data-mcp-preset]')) {
    const preset = (overview.presets.mcp || []).find((item) => item.id === event.target.value);
    const note = field('mcp', '[data-mcp-note]');
    if (preset && note) note.textContent = preset.note;
  }
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copiado', 'ok')).catch(() => toast('No se pudo copiar', 'warn'));
}

async function loadOverview() {
  if (loading) return;
  loading = true;
  try {
    overview = await api.get('/api/setup/overview');
    renderHero();
    renderSteps();
    renderChatIntro();
    const feedback = $('#setupFeedback');
    if (feedback) feedback.textContent = overview.next ? `Camila sugiere: ${overview.next.action}.` : 'Todo listo para trabajar.';
  } catch (error) {
    const box = $('#setupSteps');
    if (box) box.innerHTML = `<div class="alert warn">No pude leer el estado de las conexiones: ${esc(formatError(error))}. <button type="button" class="ghost small" data-setup-retry>Reintentar</button></div>`;
    throw error;
  } finally {
    loading = false;
  }
}

async function finishStep(step, message, kind = 'ok', toastText = '') {
  await loadOverview();
  setResult(step, message, kind);
  if (toastText) toast(toastText, 'ok');
}

export async function renderSetup() {
  await loadOverview();
}

export function initSetup() {
  if (initialized) return;
  initialized = true;
  const refresh = async () => { try { await loadOverview(); } catch { /* ya se muestra */ } };
  $('#setupRefresh')?.addEventListener('click', refresh);
  $('#setupSteps')?.addEventListener('click', onStepClick);
  $('#setupSteps')?.addEventListener('input', onStepInput);
  $('#setupSteps')?.addEventListener('change', onStepInput);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-setup-retry]')) refresh();
  });
  $('#setupChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-setup-ask]');
    if (chip) sendChat(chip.dataset.setupAsk);
  });
  $('#setupChatForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    sendChat($('#setupChatInput')?.value);
  });
  $('#setupMic')?.addEventListener('click', () => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return toast('Este navegador no soporta dictado.', 'warn');
    if (recognition) { recognition.stop(); recognition = null; return; }
    recognition = new Ctor();
    recognition.lang = 'es-CO';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { $('#setupMic')?.classList.add('listening'); $('#setupChatInput')?.focus(); };
    recognition.onend = () => { $('#setupMic')?.classList.remove('listening'); recognition = null; };
    recognition.onerror = () => { toast('No se pudo dictar; escribe el mensaje.', 'warn'); };
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || '';
      const input = $('#setupChatInput');
      if (input && text) { input.value = text; sendChat(text); }
    };
    try { recognition.start(); } catch { toast('El micrófono no está disponible.', 'warn'); }
  });
}



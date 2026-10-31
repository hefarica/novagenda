/**
 * Centro de integraciones: LLM, canales, Google, datos/respaldo, zona horaria,
 * jornada y seguridad. Todo degrada con "no disponible" si el módulo del
 * servidor aún no existe; los secretos se guardan cifrados y nunca se muestran.
 */
import { api, endpointState } from './api.js';
import { state } from './state.js';
import { capability, loadApprovals, loadChannelCenter, loadGoogleEvents, loadSecrets, probeOptionalModules, refreshAll } from './data.js';
import {
  $, $$, approvalNoticeHTML, autonomousNoticeHTML, confirmDialog, esc, isAutonomousSend, isPendingApproval, openDialog, promptDialog, setBusy, toast
} from './core.js';

const SECRET_CATALOG = [
  { name: 'llm.provider', label: 'Proveedor del LLM', group: 'llm', hint: 'auto, ollama u openai', placeholder: 'auto' },
  { name: 'llm.ollama.url', label: 'URL de Ollama', group: 'llm', placeholder: 'http://127.0.0.1:11434' },
  { name: 'llm.ollama.model', label: 'Modelo Ollama', group: 'llm', placeholder: 'llama3.2:3b' },
  { name: 'llm.openai.baseUrl', label: 'URL base OpenAI-compatible', group: 'llm', placeholder: 'https://api.openai.com/v1' },
  { name: 'llm.openai.model', label: 'Modelo OpenAI-compatible', group: 'llm', placeholder: 'gpt-4o-mini' },
  { name: 'llm.openai.apiKey', label: 'API key del proveedor', group: 'llm', placeholder: 'sk-…' },
  { name: 'llm.timeoutMs', label: 'Tiempo máximo del LLM (ms)', group: 'llm', placeholder: '20000' },

  { name: 'channels.whatsapp.enabled', label: 'WhatsApp activado', group: 'whatsapp', placeholder: 'true' },
  { name: 'channels.whatsapp.accessToken', label: 'WhatsApp · token de acceso', group: 'whatsapp', placeholder: 'EAA…' },
  { name: 'channels.whatsapp.phoneNumberId', label: 'WhatsApp · Phone Number ID', group: 'whatsapp', placeholder: '1234567890' },
  { name: 'channels.whatsapp.verifyToken', label: 'WhatsApp · verify token', group: 'whatsapp', placeholder: 'cadena secreta' },
  { name: 'channels.whatsapp.appSecret', label: 'WhatsApp · app secret (firma)', group: 'whatsapp', placeholder: 'cadena secreta' },
  { name: 'channels.whatsapp.defaultTo', label: 'WhatsApp · destino por defecto', group: 'whatsapp', placeholder: '573001112233' },
  { name: 'channels.whatsapp.templateName', label: 'WhatsApp · plantilla proactiva', group: 'whatsapp', placeholder: 'opcional' },

  { name: 'channels.telegram.enabled', label: 'Telegram activado', group: 'telegram', placeholder: 'true' },
  { name: 'channels.telegram.botToken', label: 'Telegram · token del bot', group: 'telegram', placeholder: '123456:ABC…' },
  { name: 'channels.telegram.defaultChatId', label: 'Telegram · chat por defecto', group: 'telegram', placeholder: '123456789' },
  { name: 'channels.telegram.webhookSecret', label: 'Telegram · secreto del webhook', group: 'telegram', placeholder: 'cadena secreta' },

  { name: 'channels.email.enabled', label: 'Correo activado', group: 'email', placeholder: 'true' },
  { name: 'channels.email.to', label: 'Correo · destinatario por defecto', group: 'email', placeholder: 'tu@correo.com' },

  { name: 'webhooks.generic.secret', label: 'Secreto del webhook genérico', group: 'webhooks', placeholder: 'cadena secreta' },
  { name: 'google.clientId', label: 'Google · Client ID', group: 'google', placeholder: '…apps.googleusercontent.com' },
  { name: 'google.clientSecret', label: 'Google · Client Secret', group: 'google', placeholder: 'GOCSPX-…' },
  { name: 'app.publicUrl', label: 'URL pública de la app', group: 'app', placeholder: 'https://mi-dominio' }
];

const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp Cloud API', icon: '◉', enabledSecret: 'channels.whatsapp.enabled', help: 'Webhook oficial de Meta. Con la app en local necesitas un túnel (APP_URL) para recibir mensajes.' },
  { key: 'telegram', label: 'Telegram', icon: '➤', enabledSecret: 'channels.telegram.enabled', help: 'Bot con long-polling o webhook. El secreto del webhook evita mensajes falsos.' },
  { key: 'email', label: 'Correo (Gmail)', icon: '✉', enabledSecret: 'channels.email.enabled', help: 'Sale desde una cuenta Google conectada; el asunto y el cuerpo los escribe el agente.' },
  { key: 'webhook', label: 'Webhook genérico', icon: '⇢', enabledSecret: 'webhooks.generic.secret', help: 'Un POST con secreto crea una señal y el agente decide qué hacer.', noTest: true }
];

const channelResults = {};
const simLog = [];
let llmResult = null;
let initialized = false;

/* ------------------------------ utilidades ------------------------------ */
function secretInfo(name) {
  const fromApi = (state.secrets?.items || []).find((item) => item.name === name);
  if (fromApi) return fromApi;
  const fromVault = (state.vault || []).find((item) => item.name === name);
  return fromVault
    ? { ...fromVault, hint: '', env: '', value: undefined, updatedAt: null }
    : { name, label: name, group: 'otros', secret: true, configured: false, source: null, hint: '', value: undefined };
}

function statusTag(configured, yes = 'Configurado', no = 'Sin configurar') {
  return `<span class="tag ${configured ? 'ok' : 'off'}">${configured ? yes : no}</span>`;
}

function secretRow(name) {
  const catalog = SECRET_CATALOG.find((entry) => entry.name === name) || { name, label: name };
  const info = secretInfo(name);
  const hasValue = typeof info.value === 'string' && info.value.length > 0;
  const current = info.secret ? (info.hint ? `${info.hint}` : '') : (hasValue ? info.value : '');
  return `<div class="secret-row">
    <div class="secret-head">
      <b>${esc(info.label || catalog.label)}</b>
      ${statusTag(info.configured, info.secret ? 'Guardado' : 'Definido', 'Vacío')}
    </div>
    <div class="secret-form">
      <label class="sr-only" for="secret-${esc(name)}">${esc(catalog.label)}</label>
      <input id="secret-${esc(name)}" data-secret-input="${esc(name)}" type="${info.secret ? 'password' : 'text'}"
        placeholder="${esc(info.secret ? (current || catalog.placeholder || '') : (catalog.placeholder || ''))}"
        ${info.secret ? 'autocomplete="new-password"' : `value="${esc(current)}"`} />
      <button type="button" class="secondary" data-secret-save="${esc(name)}">Guardar</button>
      <button type="button" class="ghost" data-secret-clear="${esc(name)}" ${info.configured ? '' : 'disabled'}>Borrar</button>
    </div>
    <small class="hint">Origen: ${esc(info.source || '—')}${info.env ? ` · variable ${esc(info.env)}` : ''}${info.updatedAt ? ` · actualizado ${esc(String(info.updatedAt).slice(0, 10))}` : ''}</small>
  </div>`;
}

async function saveSecret(name) {
  const input = document.querySelector(`[data-secret-input="${name}"]`);
  const value = input?.value ?? '';
  if (!value.trim()) { toast('Escribe un valor antes de guardar.', 'warn'); input?.focus(); return; }
  try {
    await api.put(`/api/secrets/${encodeURIComponent(name)}`, { value: value.trim() });
    if (input) input.value = '';
    toast('Secreto guardado (cifrado en el servidor)', 'ok');
    /* Pintar el estado nuevo de inmediato (una sola lectura) y refrescar el
       resto en segundo plano para que la UI responda al instante. */
    await loadSecrets();
    renderIntegrations();
    refreshAll().catch(() => {});
    loadChannelCenter().then(() => renderIntegrations()).catch(() => {});
  } catch (error) {
    toast(error?.message || 'No se pudo guardar el secreto', 'err');
  }
}

async function clearSecret(name) {
  const ok = await confirmDialog({
    title: 'Borrar secreto',
    text: `Se eliminará «${name}» de la bóveda. La integración que lo use dejará de funcionar.`,
    okLabel: 'Borrar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/secrets/${encodeURIComponent(name)}`);
    toast('Secreto borrado', 'ok');
    await loadSecrets();
    renderIntegrations();
    refreshAll().catch(() => {});
  } catch (error) {
    toast(error?.message || 'No se pudo borrar', 'err');
  }
}

/* ------------------------------ LLM ------------------------------ */
function llmStatusLine() {
  const llm = state.llm;
  const endpoint = endpointState.get('llm');
  if (!endpoint || endpoint.missing) {
    return { tag: 'no disponible', cls: 'off', text: 'El módulo del LLM aún no está montado en este servidor. Puedes guardar claves igualmente: se usarán cuando el módulo arranque.' };
  }
  if (!endpoint.ok) {
    return { tag: 'error', cls: 'bad', text: `El estado del LLM falló: ${endpoint.error || 'error'}` };
  }
  if (llm?.available) {
    return { tag: 'disponible', cls: 'ok', text: `Proveedor ${llm.provider || '—'} · modelo ${llm.model || '—'}${llm.latencyMs ? ` · ${llm.latencyMs} ms` : ''}${llm.fallback ? ` · fallback ${llm.fallback}` : ''}` };
  }
  return { tag: 'sin motor', cls: 'warn', text: `Ningún proveedor respondió${llm?.lastError ? `: ${llm.lastError}` : ''}. La app sigue con el motor determinista.` };
}

function renderLlm() {
  const body = $('#llmBody');
  const tag = $('#llmState');
  if (!body) return;
  const status = llmStatusLine();
  if (tag) { tag.textContent = status.tag; tag.className = `tag ${status.cls}`; }
  const provider = secretInfo('llm.provider');
  const providerValue = String(provider.value || 'auto');
  const configuredKey = secretInfo('llm.openai.apiKey').configured;
  const ollamaConfigured = secretInfo('llm.ollama.model').configured;
  body.innerHTML = `
    <div class="alert ${status.cls === 'ok' ? 'info' : status.cls === 'bad' ? '' : 'warn'}">${esc(status.text)}</div>
    <div class="recipe-fields">
      <label class="field"><span>Proveedor</span>
        <select data-llm-provider>
          ${['auto', 'ollama', 'openai'].map((option) => `<option value="${option}" ${providerValue === option ? 'selected' : ''}>${option}</option>`).join('')}
        </select>
        <small class="hint">auto prueba Ollama local y luego OpenAI-compatible.</small>
      </label>
      <div class="field"><span>Estado de claves</span>
        <div class="chips">
          ${statusTag(configuredKey, 'API key lista', 'API key pendiente')}
          ${statusTag(ollamaConfigured, 'Ollama configurado', 'Ollama sin modelo')}
        </div>
      </div>
      <div class="field"><span>Consumo observado</span>
        <span class="hint">${llmResult ? esc(llmResult) : 'Sin pruebas en esta sesión.'}</span>
      </div>
    </div>
    <div class="chips">
      <button type="button" class="primary small" data-llm-test>Probar el modelo</button>
      <button type="button" class="ghost small" data-llm-refresh>Actualizar estado</button>
      ${capability('llm') ? '<a class="ghost small" href="/api/llm/models" target="_blank" rel="noopener">Ver modelos</a>' : ''}
    </div>
    <div id="llmDiagnostics" class="inline-note"></div>
    <details class="field-group">
      <summary>Credenciales y modelos</summary>
      ${['llm.provider', 'llm.ollama.url', 'llm.ollama.model', 'llm.openai.baseUrl', 'llm.openai.model', 'llm.openai.apiKey', 'llm.timeoutMs'].map(secretRow).join('')}
    </details>`;
}

async function testLlm(button) {
  if (!capability('llm')) {
    llmResult = 'módulo del LLM no montado en este servidor';
    toast('Este servidor todavía no expone /api/llm/test. La app funciona sin LLM.', 'warn');
    renderLlm();
    return;
  }
  setBusy(button, true, 'Probando');
  try {
    const result = await api.post('/api/llm/test', {}, { timeoutMs: 30000 });
    llmResult = result?.ok
      ? `ok · ${result.provider || 'proveedor'} · ${result.latencyMs || '?'} ms`
      : `falló: ${result?.error || 'sin detalle'}`;
    toast(result?.ok ? `Modelo OK (${result.provider || ''} ${result.latencyMs || ''} ms)` : `El modelo no respondió: ${result?.error || ''}`, result?.ok ? 'ok' : 'err');
  } catch (error) {
    llmResult = `error: ${error?.message || 'desconocido'}`;
    toast(error?.status === 404 ? 'Este servidor no expone /api/llm/test todavía.' : (error?.message || 'No se pudo probar el modelo'), 'err');
  } finally {
    setBusy(button, false);
    renderLlm();
  }
}

/* ------------------------------ canales ------------------------------ */
function channelPath(id) {
  return `/api/channels/${encodeURIComponent(id).replace(/%3A/gi, ':')}`;
}

function channelResultHTML(key) {
  const result = channelResults[key];
  if (!result) return '';
  return `<div class="inline-note ${result.ok ? '' : 'alert'}">${esc(result.message)}${result.at ? ` · ${esc(result.at)}` : ''}</div>`;
}

function configFieldHTML(channelId, field) {
  const key = field.key;
  const domId = `cfg-${String(channelId).replace(/[^A-Za-z0-9_-]/g, '-')}-${String(key).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const label = esc(field.label || key);
  const help = field.help ? `<small class="hint">${esc(field.help)}</small>` : '';
  const badge = field.configured
    ? `<span class="tag ok">${field.secret ? 'guardado' : 'definido'}</span>`
    : '<span class="tag off">vacío</span>';
  if (field.type === 'boolean') {
    const checked = field.value === true || field.value === 'true';
    return `<label class="field check">
      <input type="checkbox" data-cfg-bool="${esc(key)}" data-cfg-channel="${esc(channelId)}" ${checked ? 'checked' : ''} />
      <span>${label}</span> ${badge}${help}
    </label>`;
  }
  if (field.type === 'enum') {
    const current = String(field.value ?? field.default ?? '');
    const options = (field.options || []).map((option) => `<option value="${esc(option)}" ${current === String(option) ? 'selected' : ''}>${esc(option)}</option>`).join('');
    return `<label class="field" for="${domId}"><span>${label} ${badge}</span>
      <select id="${domId}" data-cfg-field="${esc(key)}">${options}</select>${help}</label>`;
  }
  if (field.type === 'list') {
    const value = Array.isArray(field.value) ? field.value.join('\n') : String(field.value ?? '');
    return `<label class="field" for="${domId}"><span>${label} ${badge}</span>
      <textarea id="${domId}" data-cfg-field="${esc(key)}" data-cfg-list="1" rows="2" placeholder="Una por línea: Nombre: valor">${esc(value)}</textarea>${help}</label>`;
  }
  const type = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
  const value = field.secret ? '' : String(field.value ?? '');
  const placeholder = field.secret ? (field.hint || '') : (field.placeholder || '');
  const lengthAttr = field.maxLength ? `maxlength="${Number(field.maxLength)}"` : '';
  const numberAttrs = field.type === 'number'
    ? `${field.min !== null && field.min !== undefined ? `min="${Number(field.min)}"` : ''} ${field.max !== null && field.max !== undefined ? `max="${Number(field.max)}"` : ''}`
    : '';
  const input = `<input id="${domId}" aria-label="${esc(field.label || key)}" data-cfg-field="${esc(key)}" type="${type}" value="${esc(value)}" placeholder="${esc(String(placeholder || ''))}"
      ${field.secret ? 'autocomplete="new-password"' : ''} ${lengthAttr} ${numberAttrs} />`;
  if (field.secret) {
    return `<div class="field"><span>${label} ${badge}</span>
      <div class="secret-form">${input}
        <button type="button" class="ghost small" data-cfg-clear="${esc(key)}" data-cfg-channel="${esc(channelId)}" ${field.configured ? '' : 'disabled'}>Borrar</button>
      </div>
      ${help}${field.source ? `<small class="hint">origen: ${esc(field.source)}</small>` : ''}</div>`;
  }
  return `<label class="field" for="${domId}"><span>${label} ${badge}</span>${input}${help}</label>`;
}

function serverChannelCard(item) {
  const detail = state.channelDetails?.[item.id] || item;
  const config = Array.isArray(detail.config) ? detail.config : [];
  const capabilities = detail.capabilities || {};
  const capChips = Object.entries(capabilities).filter(([, on]) => on).map(([name]) => `<span class="tag">${esc(name)}</span>`).join('');
  const warnings = (detail.warnings || []).map((warning) => `<div class="alert warn">${esc(warning)}</div>`).join('');
  const instructions = (detail.instructions || []).length
    ? `<details class="field-group"><summary>Cómo conectarlo (${(detail.instructions || []).length} pasos)</summary>
        <ol class="steps-list">${(detail.instructions || []).map((step) => `<li>${esc(step)}</li>`).join('')}</ol>
      </details>`
    : '';
  const stats = detail.stats || {};
  const runtime = detail.runtime || {};
  const statsLine = Object.entries(stats).filter(([, value]) => value !== null && value !== undefined && value !== 0)
    .map(([name, value]) => `${name}: ${value}`).join(' · ');
  const toggle = item.alwaysAvailable
    ? '<span class="tag ok">siempre disponible</span>'
    : `<label class="switch" title="Activar o desactivar">
        <input type="checkbox" data-server-channel-toggle="${esc(item.id)}" ${item.enabled ? 'checked' : ''} aria-label="Activar ${esc(item.label)}" />
        <span></span>
      </label>`;
  const testButton = item.kind === 'local'
    ? '<span class="hint">Prueba con el simulador de abajo: no necesita credenciales.</span>'
    : `<button type="button" class="secondary small" data-server-channel-test="${esc(item.id)}" ${item.configured ? '' : 'disabled title="Configura el canal antes de probar"'}>Probar</button>`;
  const webhookExtra = item.kind === 'webhook'
    ? `<button type="button" class="ghost small" data-webhook-create>Crear webhook propio</button>`
    : '';
  const sendButton = item.kind === 'webhook'
    ? ''
    : `<button type="button" class="primary small" data-server-channel-send="${esc(item.id)}">Enviar mensaje</button>`;
  const gmailButton = item.id === 'email'
    ? '<a class="primary small" href="/api/channels/email/oauth/start">Conectar Gmail (lectura y envío)</a>'
    : '';
  const inboundUrl = runtime.inboundUrl || detail.webhookUrl;
  const lastError = detail.lastError || runtime.lastError;
  const lastErrorHTML = lastError
    ? `<div class="alert">Último error${lastError.at ? ` (${esc(String(lastError.at).slice(0, 16).replace('T', ' '))})` : ''}: ${esc(lastError.message || lastError.code || 'sin detalle')}</div>`
    : '';
  return `<div class="connection" data-server-channel="${esc(item.id)}">
    <div class="connection-head">
      <b>${esc(item.label)}</b>
      <div class="chips">
        <span class="tag ${item.configured ? 'ok' : 'off'}">${item.configured ? 'configurado' : 'sin credenciales'}</span>
        <span class="tag ${item.ready ? 'ok' : 'warn'}">${item.ready ? 'listo' : 'incompleto'}</span>
        ${toggle}
      </div>
    </div>
    <p class="hint">${esc(detail.detail || '')}</p>
    ${capChips ? `<div class="chips">${capChips}</div>` : ''}
    ${warnings}
    ${lastErrorHTML}
    ${inboundUrl ? `<p class="hint">Webhook: <code>${esc(inboundUrl)}</code>${runtime.tokenHint ? ` · token ${esc(runtime.tokenHint)}` : ''}</p>` : ''}
    ${config.length ? `<details class="field-group" ${item.enabled ? '' : 'open'}><summary>Configuración (${config.length} campos)</summary>
      <div class="form-grid">${config.map((field) => configFieldHTML(item.id, field)).join('')}</div>
    </details>` : ''}
    ${instructions}
    <div class="recipe-actions">
      ${sendButton}
      ${testButton}
      ${gmailButton}
      ${config.length ? `<button type="button" class="secondary small" data-server-channel-save="${esc(item.id)}">Guardar cambios</button>` : ''}
      <button type="button" class="ghost small" data-server-channel-diagnose="${esc(item.id)}">Diagnóstico</button>
      ${webhookExtra}
    </div>
    <div data-server-channel-diagnostics="${esc(item.id)}"></div>
    ${statsLine ? `<p class="hint">Actividad: ${esc(statsLine)}</p>` : ''}
    ${channelResultHTML(item.id)}
  </div>`;
}

function legacyChannelCard(channel) {
  const status = state.channels?.[channel.key] || {};
  const configuredFlag = channel.key === 'webhook'
    ? secretInfo('webhooks.generic.secret').configured
    : Boolean(status.configured);
  const enabled = String(secretInfo(channel.enabledSecret).value ?? '').toLowerCase() === 'true';
  const secrets = SECRET_CATALOG.filter((entry) => entry.group === (channel.key === 'webhook' ? 'webhooks' : channel.key));
  const testButton = channel.noTest
    ? '<span class="hint">Se prueba enviando un POST firmado al webhook.</span>'
    : `<button type="button" class="secondary small" data-channel-test="${channel.key}">Probar envío</button>`;
  const toggle = channel.key === 'webhook'
    ? ''
    : `<label class="switch" title="Activar o desactivar">
        <input type="checkbox" data-channel-toggle="${esc(channel.enabledSecret)}" ${enabled ? 'checked' : ''} aria-label="Activar ${esc(channel.label)}" />
        <span></span>
      </label>`;
  return `<div class="connection">
    <div class="connection-head">
      <b><span aria-hidden="true">${channel.icon}</span> ${esc(channel.label)}</b>
      <div class="chips">${statusTag(configuredFlag)}${toggle}</div>
    </div>
    <p class="hint">${esc(channel.help)}</p>
    <details class="field-group"><summary>Configuración y secretos</summary>
      ${secrets.map((entry) => secretRow(entry.name)).join('')}
    </details>
    <div class="recipe-actions">
      ${testButton}
      <button type="button" class="ghost small" data-channel-diagnose="${channel.key}">Diagnóstico</button>
    </div>
    <div data-channel-diagnostics="${channel.key}"></div>
    ${channelResultHTML(channel.key)}
  </div>`;
}

function renderChannels() {
  const body = $('#channelsBody');
  const tag = $('#channelsState');
  if (!body) return;
  const endpoint = endpointState.get('channels');
  const serverItems = state.channelCenter?.items || [];
  const useServer = Boolean(endpoint?.ok && serverItems.length);
  const configured = serverItems.filter((item) => item.configured).length;
  if (tag) {
    tag.textContent = useServer
      ? `${configured}/${serverItems.length} configurados`
      : endpoint?.missing ? 'centro no disponible' : 'modo heredado';
    tag.className = `tag ${configured ? 'ok' : 'off'}`;
  }
  const notice = endpoint?.missing
    ? '<div class="alert warn">El centro de canales (/api/channels) no existe en este servidor: se muestran los secretos heredados. Los envíos se prueban con /api/whatsapp/test y /api/telegram/test.</div>'
    : '';
  body.innerHTML = `${notice}
    <div class="chips">
      <button type="button" class="ghost small" data-channels-refresh>Actualizar estado</button>
      <button type="button" class="ghost small" data-channels-messages>Ver mensajes recientes</button>
    </div>
    ${useServer ? serverItems.map(serverChannelCard).join('') : CHANNELS.map(legacyChannelCard).join('')}
    <div id="channelsInbox" class="inline-note"></div>`;
  if (useServer) renderChannelHealth();
}

async function renderChannelHealth() {
  const box = $('#channelsInbox');
  if (!box) return;
  try {
    const inbox = await api.get('/api/channels/inbox?limit=8');
    const items = inbox?.items || [];
    if (items.length) {
      box.innerHTML = `<b>Últimos mensajes</b>${items.slice(0, 8).map((entry) => `<div class="sim-line ${entry.direction === 'out' ? 'out' : ''}">${esc(String(entry.timestamp || '').slice(11, 16))} ${esc(entry.channel || '')} · ${esc(entry.text || '')}</div>`).join('')}`;
    }
  } catch { /* el historial es opcional */ }
}

function channelConfigFromCard(card) {
  const payload = {};
  for (const input of card.querySelectorAll('[data-cfg-field]')) {
    const key = input.dataset.cfgField;
    if (!key) continue;
    if (input.type === 'password' && !input.value) continue;
    if (input.dataset.cfgList) {
      payload[key] = input.value.split('\n').map((line) => line.trim()).filter(Boolean);
    } else if (input.type === 'number') {
      payload[key] = Number(input.value);
    } else {
      payload[key] = input.value;
    }
  }
  return payload;
}

async function saveServerChannel(id, button) {
  const card = button.closest('[data-server-channel]');
  if (!card) return;
  const payload = channelConfigFromCard(card);
  if (!Object.keys(payload).length) { toast('No hay cambios que guardar en este canal.', 'warn'); return; }
  setBusy(button, true, 'Guardando');
  try {
    const result = await api.post(`${channelPath(id)}/config`, payload, { timeoutMs: 30000 });
    if (result?.generatedToken) {
      channelResults[id] = { ok: true, message: `Token generado (cópialo ahora): ${result.generatedToken}`, at: new Date().toLocaleTimeString('es-CO') };
      toast('Token generado: se muestra una sola vez', 'warn');
    } else {
      channelResults[id] = { ok: true, message: result?.detail || 'Configuración guardada y aplicada.', at: new Date().toLocaleTimeString('es-CO') };
      toast('Canal actualizado', 'ok');
    }
    await loadChannelCenter();
    renderIntegrations();
    refreshAll().catch(() => {});
  } catch (error) {
    channelResults[id] = { ok: false, message: `No se pudo guardar: ${error?.message || 'error'}${error?.field ? ` (campo ${error.field})` : ''}`, at: new Date().toLocaleTimeString('es-CO') };
    toast(channelResults[id].message, 'err');
  } finally {
    setBusy(button, false);
    renderIntegrations();
  }
}

async function toggleServerChannel(id, enabled, input) {
  try {
    await api.post(`${channelPath(id)}/enable`, { enabled });
    toast(enabled ? 'Canal activado' : 'Canal desactivado', 'ok');
    await loadChannelCenter();
    await refreshAll();
  } catch (error) {
    if (input) input.checked = !enabled;
    toast(error?.message || 'No se pudo cambiar el estado del canal', 'err');
  } finally {
    renderIntegrations();
  }
}

/** Borra un secreto de canal enviando null (contrato del centro de canales). */
async function clearChannelField(channelId, key) {
  const ok = await confirmDialog({
    title: 'Borrar credencial',
    text: `Se eliminará «${key}» del canal ${channelId}. La integración dejará de funcionar hasta que vuelvas a guardarla.`,
    okLabel: 'Borrar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.post(`${channelPath(channelId)}/config`, { [key]: null }, { timeoutMs: 20000 });
    toast('Credencial borrada', 'ok');
    await loadChannelCenter();
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo borrar la credencial', 'err');
  } finally {
    renderIntegrations();
  }
}

let channelSendTarget = null;

function openChannelMessage(id) {
  const item = (state.channelCenter?.items || []).find((entry) => entry.id === id);
  channelSendTarget = id;
  const form = $('#channelMsgForm');
  if (!form) return;
  form.reset();
  const alertBox = $('#channelMsgAlert');
  if (alertBox) {
    alertBox.hidden = true;
    alertBox.className = 'alert';
    alertBox.textContent = '';
    alertBox.setAttribute('role', 'alert');
  }
  const meta = $('#channelMsgMeta');
  if (meta) meta.textContent = 'Canal: ' + (item?.label || id) + '. Los envíos a terceros pasan por la Oficina.';
  openDialog('#dlg-channel-msg');
}

function renderApprovalsCard() {
  const input = $('#allowAutonomousOutbound');
  const stateEl = $('#approvalsState');
  const hint = $('#approvalsHint');
  if (!input) return;
  const approvals = state.approvals || {};
  if (!approvals.loadedAt) {
    if (!approvals.loading) {
      state.approvals.loading = true;
      loadApprovals().then(() => { state.approvals.loading = false; renderApprovalsCard(); }).catch(() => { state.approvals.loading = false; renderApprovalsCard(); });
    }
    if (stateEl) { stateEl.textContent = 'comprobando'; stateEl.className = 'tag'; }
    if (hint) hint.textContent = 'Comprobando si este servidor admite el control de autonomía…';
    input.disabled = true;
    return;
  }
  if (approvals.unavailable) {
    input.checked = false;
    input.disabled = true;
    if (stateEl) { stateEl.textContent = 'no disponible'; stateEl.className = 'tag off'; }
    if (hint) hint.textContent = 'Este servidor no expone el control de autonomía. Los envíos a terceros siguen pasando por la Oficina.';
    return;
  }
  const supported = approvals.config && Object.prototype.hasOwnProperty.call(approvals.config, 'allowAutonomousOutbound');
  if (!supported) {
    input.checked = false;
    input.disabled = true;
    if (stateEl) { stateEl.textContent = 'no disponible'; stateEl.className = 'tag off'; }
    if (hint) hint.textContent = 'Este servidor no expone el control de autonomía. Los envíos a terceros siguen pasando por la Oficina.';
    return;
  }
  const enabled = approvals.config.allowAutonomousOutbound === true;
  input.checked = enabled;
  input.disabled = false;
  if (stateEl) { stateEl.textContent = enabled ? 'activada' : 'apagada'; stateEl.className = 'tag ' + (enabled ? 'warn' : 'off'); }
  if (hint) {
    hint.textContent = enabled
      ? 'Autonomía activa: solo en modo total/autónomo, riesgo ≤2, contacto conocido y nunca N3. Puedes desactivarla aquí mismo.'
      : 'Autonomía apagada (recomendado): todo envío a terceros espera tu aprobación en la Oficina.';
  }
}

async function sendChannelMessage() {
  const form = $('#channelMsgForm');
  const alertBox = $('#channelMsgAlert');
  if (!form || !channelSendTarget) return;
  const to = form.elements.to.value.trim();
  const subject = form.elements.subject.value.trim();
  const body = form.elements.body.value.trim();
  const warn = (message) => {
    if (alertBox) {
      alertBox.hidden = false;
      alertBox.className = 'alert warn';
      alertBox.setAttribute('role', 'alert');
      alertBox.textContent = message;
    }
  };
  if (!to) { warn('Escribe el destinatario.'); form.elements.to.focus(); return; }
  if (!body) { warn('El mensaje está vacío.'); form.elements.body.focus(); return; }
  const button = $('#channelMsgSend');
  setBusy(button, true, 'Preparando');
  try {
    const payload = { to, body };
    if (subject) payload.subject = subject;
    const result = await api.post(`${channelPath(channelSendTarget)}/send`, payload, { timeoutMs: 30000 });
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
    toast('Mensaje enviado', 'ok');
    document.querySelector('#dlg-channel-msg')?.close();
  } catch (error) {
    if (error?.code === 'NOT_OWNER' || error?.code === 'OWNER_NOT_CONFIGURED' || error?.code === 'APPROVAL_REQUIRED') {
      const hint = error?.details?.listField ? ' Configura la lista de autorizados en Integraciones.' : '';
      warn('Ese destino no está autorizado.' + hint);
    } else {
      warn(error?.message || 'No se pudo preparar el envío');
    }
    toast(error?.message || 'No se pudo preparar el envío', 'err');
  } finally {
    setBusy(button, false);
  }
}

async function testServerChannel(id, button) {
  setBusy(button, true, 'Probando');
  const attempt = async (extra = {}) => api.post(`${channelPath(id)}/test`, { text: 'Prueba desde Agenda Copilot P95', ...extra }, { timeoutMs: 30000 });
  const promptForTarget = async () => {
    const prompt = id === 'telegram'
      ? { title: 'Probar Telegram', text: 'Chat id de destino. Escribe cualquier cosa al bot y usa el chat.id que aparece en getUpdates.', label: 'Chat id', value: '' }
      : id === 'email'
        ? { title: 'Probar correo', text: 'Correo destino.', label: 'Correo', value: '' }
        : { title: 'Probar WhatsApp', text: 'Número destino E.164 sin + (debe estar autorizado).', label: 'Número', value: '' };
    return promptDialog(prompt);
  };
  const targetField = id === 'telegram' ? 'chatId' : 'to';
  try {
    let result = await attempt();
    /* El módulo responde 200 con sent:false cuando faltan credenciales de destino. */
    if (result?.sent === false || result?.needsTarget === true) {
      const target = await promptForTarget();
      if (!target) throw new Error(result?.detail || 'Falta el destino para completar la prueba');
      result = await attempt({ [targetField]: target });
    }
    const detail = result?.detail || (result?.ok === false ? 'El proveedor rechazó la prueba' : 'Prueba enviada');
    channelResults[id] = { ok: result?.ok !== false && result?.sent !== false, message: detail, at: new Date().toLocaleTimeString('es-CO') };
    toast(detail, result?.ok === false || result?.sent === false ? 'warn' : 'ok');
    await loadChannelCenter();
  } catch (error) {
    channelResults[id] = { ok: false, message: `Falló: ${error?.message || 'error'}${error?.status === 404 ? ' (ruta de prueba no disponible)' : ''}`, at: new Date().toLocaleTimeString('es-CO') };
    toast(channelResults[id].message, 'err');
  } finally {
    setBusy(button, false);
    renderIntegrations();
  }
}

async function createWebhookInstance(button) {
  const name = await promptDialog({
    title: 'Crear webhook propio',
    text: 'Nombre para identificar la integración (por ejemplo n8n, slack o discord). Se generará un token que solo se muestra una vez.',
    label: 'Nombre',
    value: ''
  });
  if (!name) return;
  const slug = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'webhook';
  setBusy(button, true, 'Creando');
  try {
    const result = await api.post(`/api/channels/webhook:${slug}/config`, { label: name.slice(0, 80) }, { timeoutMs: 25000 });
    const token = result?.generatedToken;
    channelResults[`webhook:${slug}`] = {
      ok: true,
      message: token
        ? `Webhook «${name}» creado. Token (se muestra una sola vez): ${token} · URL: /api/channels/inbound/webhook:${slug}`
        : `Webhook «${name}» creado.`,
      at: new Date().toLocaleTimeString('es-CO')
    };
    toast(token ? 'Webhook creado: copia el token ahora' : 'Webhook creado', 'ok');
    await loadChannelCenter();
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo crear el webhook', 'err');
  } finally {
    setBusy(button, false);
    renderIntegrations();
  }
}

function renderServerChannelDiagnostics(id) {
  const container = document.querySelector(`[data-server-channel-diagnostics="${id}"]`);
  if (!container) return;
  if (container.innerHTML.trim()) { container.innerHTML = ''; return; }
  const detail = state.channelDetails?.[id] || {};
  const runtime = detail.runtime || {};
  const stats = detail.stats || {};
  const health = state.health;
  const rows = [
    ['id', id],
    ['configurado', detail.configured ? 'sí' : 'no'],
    ['listo', detail.ready ? 'sí' : 'no'],
    ['activo', detail.enabled ? 'sí' : 'no'],
    ['último error', runtime.lastError?.message || detail.lastError?.message || '—'],
    ['webhooks estrictos', health ? (health.webhooksStrict ? 'sí' : 'no') : '—'],
    ['servidor', health ? `${health.host || ''}:${health.port || ''}` : '—'],
    ['bóveda', health?.vault ? `${health.vault.stored} guardados · ${health.vault.configured} configurados` : '—'],
    ...Object.entries(stats).map(([name, value]) => [`stat ${name}`, String(value)])
  ];
  container.innerHTML = `<dl class="kv">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(String(value))}</dd>`).join('')}</dl>`;
}

async function toggleLegacyChannel(secretName, enabled) {
  try {
    await api.put(`/api/secrets/${encodeURIComponent(secretName)}`, { value: enabled ? 'true' : 'false' });
    toast(enabled ? 'Canal activado' : 'Canal desactivado', 'ok');
    await refreshAll();
    await loadChannelCenter();
    renderIntegrations();
  } catch (error) {
    toast(error?.message || 'No se pudo cambiar el canal', 'err');
  }
}

function renderLegacyChannelDiagnostics(key) {
  const container = document.querySelector(`[data-channel-diagnostics="${key}"]`);
  if (!container) return;
  if (container.innerHTML.trim()) { container.innerHTML = ''; return; }
  const health = state.health;
  const channel = state.channels?.[key] || {};
  const secrets = SECRET_CATALOG.filter((entry) => (key === 'webhook' ? entry.group === 'webhooks' : entry.group === key));
  const rows = secrets.map((entry) => {
    const info = secretInfo(entry.name);
    return `<dt>${esc(entry.label)}</dt><dd>${info.configured ? `configurado (${esc(info.source || '—')})` : 'vacío'}</dd>`;
  }).join('');
  container.innerHTML = `<dl class="kv">
    <dt>Estado del canal</dt><dd>${channel.configured ? 'configurado' : 'incompleto'}</dd>
    <dt>Webhooks estrictos</dt><dd>${health ? (health.webhooksStrict ? 'sí (NODE_ENV=production)' : 'no (modo local)') : '—'}</dd>
    <dt>Servidor</dt><dd>${health ? `${esc(health.host || '')}:${esc(String(health.port || ''))}` : '—'}</dd>
    <dt>Bóveda</dt><dd>${health?.vault ? `${health.vault.stored} guardados · ${health.vault.configured} configurados` : '—'}</dd>
    ${rows}
  </dl>`;
}

async function showChannelMessages() {
  const container = $('#channelsInbox');
  if (!container) return;
  container.textContent = 'Cargando mensajes…';
  try {
    const data = await api.get('/api/channels/inbox?limit=30');
    const items = data?.items || [];
    container.innerHTML = items.length
      ? `<b>Bandeja de canales (${items.length})</b>` + items.map((entry) => `<div class="sim-line ${entry.direction === 'out' ? 'out' : ''}">${esc(String(entry.timestamp || '').slice(0, 16).replace('T', ' '))} ${esc(entry.channel || '')} · ${esc(entry.direction || '')} · ${esc(entry.text || '')}</div>`).join('')
      : '<p class="hint">Sin mensajes registrados todavía. Prueba el simulador.</p>';
  } catch (error) {
    container.innerHTML = `<p class="hint">${esc(error?.status === 404 ? 'La bandeja de canales no está disponible en este servidor.' : (error?.message || 'No se pudo cargar'))}</p>`;
  }
}

/** Compatibilidad: prueba por endpoint heredado cuando no hay centro de canales. */
async function testLegacyChannel(key, button) {
  const prompts = {
    whatsapp: { title: 'Probar WhatsApp', text: 'Número destino en formato E.164 sin + (vacío usa el configurado).', label: 'Número', value: '' },
    telegram: { title: 'Probar Telegram', text: 'Chat id de destino (vacío usa el configurado).', label: 'Chat id', value: '' },
    email: { title: 'Probar correo', text: 'Correo destino (vacío usa el configurado).', label: 'Correo', value: '' }
  };
  const prompt = prompts[key];
  if (!prompt) return;
  const target = await promptDialog(prompt);
  if (target === null) return;
  setBusy(button, true, 'Enviando');
  const attempts = key === 'whatsapp'
    ? [{ path: '/api/whatsapp/test', body: { to: target, text: 'Prueba desde Agenda Copilot P95' } }]
    : key === 'telegram'
      ? [{ path: '/api/telegram/test', body: { chatId: target, text: 'Prueba desde Agenda Copilot P95' } }]
      : [{ path: '/api/gmail/send', body: { to: target, subject: 'Prueba Agenda Copilot P95', body: 'Mensaje de prueba del centro de integraciones.' } }];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await api.post(attempt.path, attempt.body, { timeoutMs: 25000 });
      channelResults[key] = { ok: true, message: `Enviado con ${attempt.path}`, at: new Date().toLocaleTimeString('es-CO') };
      toast('Prueba enviada correctamente', 'ok');
      setBusy(button, false);
      renderChannels();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  channelResults[key] = { ok: false, message: `Falló: ${lastError?.message || 'error'}`, at: new Date().toLocaleTimeString('es-CO') };
  toast(channelResults[key].message, 'err');
  setBusy(button, false);
  renderChannels();
}

/* ------------------------------ Google ------------------------------ */
function renderGoogle() {
  const body = $('#googleBody');
  const tag = $('#googleState');
  if (!body) return;
  const connections = state.googleConnections || [];
  const selected = state.settings?.selectedCalendars || {};
  if (tag) { tag.textContent = connections.length ? `${connections.length} cuenta(s)` : 'sin conectar'; tag.className = `tag ${connections.length ? 'ok' : 'off'}`; }
  body.innerHTML = `
    <div class="chips">
      <a class="primary small" href="/api/auth/google/start?label=Personal">＋ Conectar cuenta Google</a>
      <button type="button" class="ghost small" data-google-sync>${'Sincronizar ahora'}</button>
      <button type="button" class="ghost small" data-google-refresh>Actualizar estado</button>
    </div>
    <p class="hint">Calendar aporta disponibilidad y crea/edita los eventos; Gmail se usa para el correo saliente. Las citas editadas aquí se sincronizan con Google si están vinculadas.</p>
    ${connections.length ? connections.map((connection) => `<div class="connection">
      <div class="connection-head">
        <b>${esc(connection.email || connection.label || connection.id)}</b>
        ${statusTag(true, 'Conectada', 'Sin conexión')}
      </div>
      <div class="chips">
        <button type="button" class="ghost small" data-google-connection-refresh="${esc(connection.id)}">Refrescar calendarios</button>
        <button type="button" class="secondary small" data-google-disconnect="${esc(connection.id)}">Desconectar</button>
      </div>
      ${(connection.calendars || []).map((calendar) => {
        const checked = (selected[connection.id] || []).includes(calendar.id);
        return `<label class="calendar-check"><input type="checkbox" data-calendar data-connection="${esc(connection.id)}" value="${esc(calendar.id)}" ${checked ? 'checked' : ''} />
          <span>${esc(calendar.summary)}${calendar.primary ? ' · principal' : ''}</span></label>`;
      }).join('') || '<p class="hint">Sin calendarios sincronizados.</p>'}
      <p class="hint" data-google-status="${esc(connection.id)}"></p>
    </div>`).join('') : '<p class="muted small">Aún no hay cuentas Google conectadas.</p>'}
    <div id="googleSyncResult" class="inline-note"></div>`;
}

async function disconnectGoogle(id) {
  const ok = await confirmDialog({
    title: 'Desconectar Google',
    text: 'Se revoca el token y se deja de sincronizar esta cuenta. Los eventos ya creados permanecen.',
    okLabel: 'Desconectar',
    danger: true
  });
  if (!ok) return;
  try {
    await api.del(`/api/google/connections/${encodeURIComponent(id)}`);
    toast('Cuenta desconectada', 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo desconectar', 'err');
  }
}

async function syncGoogleNow(button) {
  setBusy(button, true, 'Sincronizando');
  try {
    const result = await api.post('/api/google/sync', {}, { timeoutMs: 40000 });
    const report = result?.report || {};
    const summary = [
      report.created ? `${report.created} creadas` : '',
      report.updated ? `${report.updated} actualizadas` : '',
      report.cancelled ? `${report.cancelled} canceladas` : '',
      report.errors?.length ? `${report.errors.length} errores` : ''
    ].filter(Boolean).join(' · ') || 'sin cambios';
    const box = $('#googleSyncResult');
    if (box) box.textContent = `Sincronización: ${summary}`;
    toast(`Google: ${summary}`, report.errors?.length ? 'warn' : 'ok');
    await loadGoogleEvents();
    await refreshAll();
  } catch (error) {
    toast(error?.status === 404 ? 'La sincronización no está disponible en este servidor.' : (error?.message || 'No se pudo sincronizar'), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function saveCalendars() {
  const selected = {};
  $$('[data-calendar]:checked').forEach((input) => {
    const id = input.dataset.connection;
    (selected[id] ||= []).push(input.value);
  });
  try {
    await api.post('/api/settings', { selectedCalendars: selected });
    toast('Calendarios guardados', 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudieron guardar los calendarios', 'err');
  }
}

/* ------------------------------ preferencias ------------------------------ */
function renderPrefs() {
  const form = $('#prefsForm');
  if (!form) return;
  const settings = state.settings || {};
  const days = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM'];
  const activeDays = Array.isArray(settings.workdays) && settings.workdays.length ? settings.workdays : ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'];
  const holidays = Array.isArray(settings.holidays) ? settings.holidays.join(', ') : '';
  form.innerHTML = `
    <label class="field"><span>Zona horaria (IANA)</span>
      <input name="timezone" value="${esc(settings.timezone || 'America/Bogota')}" placeholder="America/Bogota" />
      <small class="hint">Cambiarla requiere reiniciar el servidor para que el planificador use la nueva zona.</small>
    </label>
    <div class="two">
      <label class="field"><span>Jornada inicia</span><input name="workdayStart" type="time" value="${esc(settings.workdayStart || '07:00')}" /></label>
      <label class="field"><span>Jornada termina</span><input name="workdayEnd" type="time" value="${esc(settings.workdayEnd || '19:00')}" /></label>
    </div>
    <div class="three">
      <label class="field"><span>Duración estándar (min)</span><input name="defaultDurationMin" type="number" min="5" max="480" step="5" value="${Number(settings.defaultDurationMin) || 60}" /></label>
      <label class="field"><span>Recordatorio (min)</span><input name="reminderMin" type="number" min="0" max="1440" step="5" value="${Number(settings.reminderMin) || 10}" /></label>
      <label class="field"><span>Paso de huecos (min)</span><input name="slotStepMin" type="number" min="5" max="120" step="5" value="${Number(settings.slotStepMin) || 30}" /></label>
    </div>
    <div class="chips-field"><span class="chips-label">Días laborables</span>
      <div class="chips">${days.map((day) => `<label class="chip" style="cursor:pointer">
        <input type="checkbox" name="workdays" value="${day}" ${activeDays.includes(day) ? 'checked' : ''} style="accent-color:#37b3ff" /> ${day}
      </label>`).join('')}</div>
    </div>
    <div class="two">
      <label class="field"><span>Festivos (YYYY-MM-DD separados por coma)</span>
        <textarea name="holidays" rows="2" placeholder="2026-12-25, 2027-01-01">${esc(holidays)}</textarea>
      </label>
      <label class="field"><span>Calendario de festivos</span>
        <select name="holidayCalendar">
          <option value="" ${!settings.holidayCalendar ? 'selected' : ''}>Solo los que yo escriba</option>
          <option value="CO" ${settings.holidayCalendar === 'CO' ? 'selected' : ''}>Colombia (Ley Emiliani)</option>
        </select>
        <small class="hint">Los festivos evitan que se generen rutinas.</small>
      </label>
    </div>
    <div class="three">
      <label class="field"><span>Backfill de rutinas (días)</span><input name="routineBackfillDays" type="number" min="1" max="60" value="${Number(settings.routineBackfillDays) || 7}" /></label>
      <label class="field"><span>Sync Google (min)</span><input name="syncIntervalMin" type="number" min="5" max="1440" value="${Number(settings.syncIntervalMin) || 60}" /></label>
      <label class="field check"><input type="checkbox" name="slotIncludeWeekend" ${settings.slotIncludeWeekend ? 'checked' : ''} /><span>Incluir fin de semana en huecos</span></label>
    </div>
    <label class="field check"><input type="checkbox" name="googleSyncEnabled" ${settings.googleSyncEnabled ? 'checked' : ''} /><span>Reconciliación Google activa</span></label>
    <label class="field check"><input type="checkbox" name="autoSyncGoogle" ${settings.autoSyncGoogle ? 'checked' : ''} /><span>Crear automáticamente en Google las citas nuevas</span></label>
    <button type="submit" class="primary">Guardar preferencias</button>
    <p class="hint" id="prefsStatus" role="status"></p>`;
}

async function savePrefs() {
  const form = $('#prefsForm');
  const elements = form.elements;
  const workdays = $$('input[name="workdays"]:checked', form).map((input) => input.value);
  if (!workdays.length) { toast('Marca al menos un día laborable', 'err'); return; }
  if (elements.workdayEnd.value <= elements.workdayStart.value) { toast('La jornada debe terminar después de empezar', 'err'); return; }
  const holidays = elements.holidays.value.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean);
  const invalid = holidays.find((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value));
  if (invalid) { toast(`Fecha de festivo inválida: ${invalid}`, 'err'); return; }
  const payload = {
    timezone: elements.timezone.value.trim(),
    workdayStart: elements.workdayStart.value,
    workdayEnd: elements.workdayEnd.value,
    defaultDurationMin: Number(elements.defaultDurationMin.value),
    reminderMin: Number(elements.reminderMin.value),
    slotStepMin: Number(elements.slotStepMin.value),
    routineBackfillDays: Number(elements.routineBackfillDays.value),
    syncIntervalMin: Number(elements.syncIntervalMin.value),
    slotIncludeWeekend: elements.slotIncludeWeekend.checked,
    googleSyncEnabled: elements.googleSyncEnabled.checked,
    autoSyncGoogle: elements.autoSyncGoogle.checked,
    workdays,
    holidays,
    holidayCalendar: elements.holidayCalendar.value || null
  };
  const status = $('#prefsStatus');
  if (status) status.textContent = 'Guardando…';
  try {
    const result = await api.post('/api/settings', payload);
    if (status) status.textContent = 'Guardado. La zona horaria se aplica al reiniciar el servidor.';
    toast('Preferencias guardadas', 'ok');
    await refreshAll();
    return result;
  } catch (error) {
    if (status) status.textContent = '';
    toast(error?.message || 'No se pudieron guardar las preferencias', 'err');
  }
}

/* ------------------------------ datos ------------------------------ */
function renderData() {
  const body = $('#dataBody');
  const tag = $('#dataState');
  if (!body) return;
  const readOnly = Boolean(state.store?.readOnly);
  if (tag) { tag.textContent = readOnly ? 'solo lectura' : 'normal'; tag.className = `tag ${readOnly ? 'bad' : 'ok'}`; }
  body.innerHTML = `
    ${readOnly ? `<div class="alert">El almacén está en solo lectura: ${esc(state.store?.error || 'datos dañados')}. Restaura una copia para volver a escribir.</div>` : ''}
    <div class="chips">
      <a class="secondary small" href="/api/backup?secrets=none" download>Descargar backup (sin secretos)</a>
      <a class="ghost small" href="/api/backup" download>Backup con secretos cifrados</a>
      <button type="button" class="ghost small" data-journal>Ver journal</button>
    </div>
    <label class="field"><span>Restaurar backup</span>
      <input type="file" accept="application/json,.json" data-restore-input />
      <small class="hint">Se valida el archivo, se guarda una copia previa y se restaura. Funciona incluso en solo lectura.</small>
    </label>
    <div id="journalBox" class="inline-note"></div>
    <div class="recipe-actions">
      <button type="button" class="danger small" data-reset-demo>Reiniciar demo (solo loopback)</button>
    </div>
    <p class="hint">El reset conserva autenticación, secretos, conexiones Google y ajustes.</p>`;
}

async function restoreBackup(file) {
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('El archivo no es JSON válido', 'err');
    return;
  }
  const ok = await confirmDialog({
    title: 'Restaurar backup',
    text: 'Se sobrescribirá la agenda, rutinas y ajustes del servidor. Antes se guarda una copia pre-restore. ¿Continuar?',
    okLabel: 'Restaurar',
    danger: true
  });
  if (!ok) return;
  try {
    const result = await api.post('/api/backup/restore', { confirm: 'RESTORE', data: payload }, { timeoutMs: 60000 });
    toast(`Restaurado: ${JSON.stringify(result?.counts || {})}`, 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.message || 'No se pudo restaurar', 'err');
  }
}

async function showJournal() {
  const box = $('#journalBox');
  if (!box) return;
  box.textContent = 'Cargando journal…';
  try {
    const data = await api.get('/api/backup/journal?limit=12');
    const entries = data?.entries || [];
    box.innerHTML = entries.length
      ? `<b>Journal (${entries.length} entradas)</b>` + entries.map((entry) => `<div class="sim-line">#${esc(String(entry.seq))} · ${esc(entry.label || '')} · ${esc(String(entry.at || '').slice(0, 19))} · ${esc(JSON.stringify(entry.counts || {}))}</div>`).join('')
      : '<p class="hint">Sin entradas en el journal.</p>';
  } catch (error) {
    box.innerHTML = `<p class="hint">${esc(error?.message || 'No se pudo leer el journal')}</p>`;
  }
}

async function resetDemo() {
  const ok = await confirmDialog({
    title: 'Reiniciar datos de demo',
    text: 'Se reinician agenda, inbox, rutinas, reuniones, OKR, métricas y actividad al seed. Se conservan auth, secretos, Google y ajustes. Solo funciona desde 127.0.0.1.',
    okLabel: 'Reiniciar demo',
    danger: true
  });
  if (!ok) return;
  try {
    await api.post('/api/reset-demo', {});
    toast('Datos de demo reiniciados', 'ok');
    await refreshAll();
  } catch (error) {
    toast(error?.code === 'LOCAL_ONLY' ? 'Solo se puede reiniciar desde 127.0.0.1' : (error?.message || 'No se pudo reiniciar'), 'err');
  }
}

/* ------------------------------ seguridad ------------------------------ */
function renderSecurity() {
  const body = $('#securityBody');
  const tag = $('#securityState');
  if (!body) return;
  const auth = state.auth || {};
  if (tag) {
    tag.textContent = auth.required ? (auth.authenticated ? 'sesión activa' : 'sin sesión') : 'modo local';
    tag.className = `tag ${auth.required ? (auth.authenticated ? 'ok' : 'warn') : 'off'}`;
  }
  body.innerHTML = `
    <dl class="kv">
      <dt>Modo</dt><dd>${esc(auth.mode || 'local')}</dd>
      <dt>Usuario</dt><dd>${esc(auth.user || 'local')}</dd>
      <dt>Sesión expira</dt><dd>${esc(auth.sessionExpiresAt ? String(auth.sessionExpiresAt).slice(0, 16).replace('T', ' ') : '—')}</dd>
      <dt>Almacén</dt><dd>v${esc(String(state.store?.version ?? '—'))} · ${state.store?.readOnly ? 'solo lectura' : 'normal'}</dd>
    </dl>
    ${auth.required ? `
      <form id="passwordForm" class="form-grid">
        <label class="field"><span>Contraseña actual</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
        <label class="field"><span>Nueva contraseña (mín. 8)</span><input name="newPassword" type="password" autocomplete="new-password" required minlength="8" /></label>
        <div class="chips">
          <button type="submit" class="primary small">Cambiar contraseña</button>
          <button type="button" class="secondary small" data-logout>Cerrar sesión</button>
        </div>
        <p class="hint">Al cambiarla se invalidan las demás sesiones.</p>
      </form>` : `
      <p class="hint">Estás en modo local (127.0.0.1): no se exige contraseña. Si publicas la app en red, arranca con <code>APP_AUTH=on</code> o <code>HOST≠127.0.0.1</code> y la sesión será obligatoria.</p>
      <div class="chips"><button type="button" class="ghost small" data-logout>Salir de la sesión actual</button></div>`}`;
}

/* ------------------------------ simulador ------------------------------ */
function renderSimulator() {
  const body = $('#simulatorBody');
  if (!body) return;
  const endpoint = endpointState.get('channels');
  const simulator = state.channelDetails?.simulator || {};
  const steps = Array.isArray(simulator.instructions) ? simulator.instructions : [];
  const inbox = Array.isArray(state.channelMessages) ? state.channelMessages.slice(0, 6) : [];
  body.innerHTML = `
    ${endpoint?.missing ? '<div class="alert warn">El simulador necesita el módulo de canales (/api/channels/simulate). Mientras tanto puedes usar el asistente: es el mismo motor sin enviar mensajes.</div>' : ''}
    ${steps.length ? `<details class="field-group"><summary>Qué puedes probar (${steps.length} ideas)</summary><ol class="steps-list">${steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol></details>` : ''}
    <form id="simForm" class="nl-form">
      <label class="sr-only" for="simText">Mensaje simulado</label>
      <textarea id="simText" rows="2" maxlength="1000" placeholder="Escribe como si fueras un usuario por WhatsApp: «agenda reunión mañana 10:00»"></textarea>
      <button type="submit" class="primary">Simular</button>
    </form>
    <p class="hint">No se envía nada real: se ejecuta el mismo pipeline de canales (asistente + acciones) y se muestra la respuesta. El historial queda en la bandeja local.</p>
    <div class="simulator-log" id="simLog">${simLog.map((line) => `<div class="sim-line ${line.out ? 'out' : ''}">${esc(line.text)}</div>`).join('') || '<p class="hint">Sin simulaciones todavía.</p>'}</div>
    ${inbox.length ? `<div class="inline-note"><b>Bandeja local reciente</b>${inbox.map((entry) => `<div class="sim-line ${entry.direction === 'outbound' || entry.direction === 'out' ? 'out' : ''}">${esc(String(entry.timestamp || '').slice(11, 16))} ${esc(entry.channel || '')} · ${esc(entry.direction || '')} · ${esc(String(entry.text || '').slice(0, 120))}</div>`).join('')}</div>` : ''}`;
}

async function simulate() {
  const text = $('#simText')?.value.trim();
  if (!text) return;
  simLog.push({ out: false, text });
  renderSimulator();
  try {
    const result = await api.post('/api/channels/simulate', { text, userId: 'simulador' }, { timeoutMs: 45000 });
    const reply = result?.reply || '(sin respuesta)';
    simLog.push({ out: true, text: `Respuesta: ${reply}` });
    if (Array.isArray(result?.outbound) && result.outbound.length) {
      simLog.push({ out: true, text: `Salidas: ${result.outbound.map((entry) => `${entry.channel || ''} ${entry.ok === false ? '✗' : '✓'}`).join(', ')}` });
    }
    await loadChannelCenter();
    await refreshAll();
  } catch (error) {
    if (error?.status === 404) {
      simLog.push({ out: true, text: 'El simulador no está disponible en este servidor (falta /api/channels/simulate).' });
    } else if (error?.status === 429) {
      simLog.push({ out: true, text: 'Demasiadas simulaciones seguidas: espera unos segundos (límite del servidor).' });
    } else {
      simLog.push({ out: true, text: `Error: ${error?.message || 'desconocido'}` });
    }
  }
  renderSimulator();
}

/* ------------------------------ render + init ------------------------------ */
export function renderIntegrations() {
  renderLlm();
  renderChannels();
  renderGoogle();
  renderPrefs();
  renderData();
  renderSecurity();
  renderSimulator();
  renderApprovalsCard();
}

export function initIntegrations() {
  if (initialized) return;
  initialized = true;

  $('#allowAutonomousOutbound')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    const desired = input.checked;
    if (desired) {
      const ok = await confirmDialog({
        title: 'Activar autonomía de salida',
        text: 'Solo se enviará sin aprobación en modo total/autónomo, con riesgo ≤2, contacto conocido y nunca en N3. Cada envío queda auditado en el ledger. ¿Activar la autonomía?',
        okLabel: 'Activar autonomía'
      });
      if (!ok) { input.checked = false; return; }
    }
    input.disabled = true;
    try {
      const result = await api.post('/api/channels/approvals/config', { allowAutonomousOutbound: desired });
      if (result?.config) state.approvals.config = result.config;
      await loadApprovals({ force: true });
      toast(desired ? 'Autonomía de salida activada' : 'Autonomía de salida desactivada', desired ? 'warn' : 'ok');
    } catch (error) {
      input.checked = !desired;
      if (error?.status === 404 || error?.code === 'UNKNOWN_FIELD' || error?.code === 'NOT_FOUND') state.approvals.unavailable = true;
      toast(error?.message || 'No se pudo cambiar la autonomía', 'err');
    } finally {
      input.disabled = false;
      renderApprovalsCard();
    }
  });

  $('#llmBody')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-llm-test]')) testLlm(event.target.closest('[data-llm-test]'));
    else if (event.target.closest('[data-llm-refresh]')) probeOptionalModules().then(() => refreshAll()).then(() => { renderIntegrations(); toast('Estado actualizado'); });
    else if (event.target.closest('[data-secret-save]')) saveSecret(event.target.closest('[data-secret-save]').dataset.secretSave);
    else if (event.target.closest('[data-secret-clear]')) clearSecret(event.target.closest('[data-secret-clear]').dataset.secretClear);
  });
  $('#llmBody')?.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-llm-provider]');
    if (!select) return;
    try {
      await api.put('/api/secrets/llm.provider', { value: select.value });
      toast(`Proveedor: ${select.value}`, 'ok');
      await refreshAll();
      renderIntegrations();
    } catch (error) {
      toast(error?.message || 'No se pudo cambiar el proveedor', 'err');
    }
  });

  $('#channelsBody')?.addEventListener('click', async (event) => {
    const serverSend = event.target.closest('[data-server-channel-send]');
    if (serverSend) { openChannelMessage(serverSend.dataset.serverChannelSend); return; }
    const serverTest = event.target.closest('[data-server-channel-test]');
    if (serverTest) { await testServerChannel(serverTest.dataset.serverChannelTest, serverTest); return; }
    const serverSave = event.target.closest('[data-server-channel-save]');
    if (serverSave) { await saveServerChannel(serverSave.dataset.serverChannelSave, serverSave); return; }
    const serverDiagnose = event.target.closest('[data-server-channel-diagnose]');
    if (serverDiagnose) { renderServerChannelDiagnostics(serverDiagnose.dataset.serverChannelDiagnose); return; }
    const cfgClear = event.target.closest('[data-cfg-clear]');
    if (cfgClear) { await clearChannelField(cfgClear.dataset.cfgChannel, cfgClear.dataset.cfgClear); return; }
    if (event.target.closest('[data-webhook-create]')) { await createWebhookInstance(event.target.closest('[data-webhook-create]')); return; }
    const test = event.target.closest('[data-channel-test]');
    if (test) { await testLegacyChannel(test.dataset.channelTest, test); return; }
    const diagnose = event.target.closest('[data-channel-diagnose]');
    if (diagnose) { renderLegacyChannelDiagnostics(diagnose.dataset.channelDiagnose); return; }
    if (event.target.closest('[data-telegram-webhook]')) {
      try {
        const result = await api.post('/api/telegram/set-webhook', {});
        toast(result?.ok === false ? 'Telegram rechazó el webhook' : 'Webhook de Telegram registrado', result?.ok === false ? 'err' : 'ok');
      } catch (error) {
        toast(error?.message || 'No se pudo registrar el webhook', 'err');
      }
      return;
    }
    if (event.target.closest('[data-channels-refresh]')) {
      await probeOptionalModules();
      renderIntegrations();
      toast('Estado de canales actualizado');
      return;
    }
    if (event.target.closest('[data-channels-messages]')) { await showChannelMessages(); return; }
    const secretSave = event.target.closest('[data-secret-save]');
    if (secretSave) { await saveSecret(secretSave.dataset.secretSave); return; }
    const secretClear = event.target.closest('[data-secret-clear]');
    if (secretClear) { await clearSecret(secretClear.dataset.secretClear); }
  });
  $('#channelMsgForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await sendChannelMessage();
  });

  $('#channelsBody')?.addEventListener('change', async (event) => {
    const serverToggle = event.target.closest('[data-server-channel-toggle]');
    if (serverToggle) { await toggleServerChannel(serverToggle.dataset.serverChannelToggle, serverToggle.checked, serverToggle); return; }
    const boolField = event.target.closest('[data-cfg-bool]');
    if (boolField) {
      const channelId = boolField.dataset.cfgChannel;
      const key = boolField.dataset.cfgBool;
      try {
        await api.post(`${channelPath(channelId)}/config`, { [key]: boolField.checked }, { timeoutMs: 20000 });
        toast(`${key}: ${boolField.checked ? 'activado' : 'desactivado'}`, 'ok');
        await loadChannelCenter();
        await refreshAll();
      } catch (error) {
        boolField.checked = !boolField.checked;
        toast(error?.message || 'No se pudo cambiar el campo', 'err');
      }
      renderIntegrations();
      return;
    }
    const toggle = event.target.closest('[data-channel-toggle]');
    if (toggle) toggleLegacyChannel(toggle.dataset.channelToggle, toggle.checked);
  });

  $('#googleBody')?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-google-sync]')) { await syncGoogleNow(event.target.closest('[data-google-sync]')); return; }
    if (event.target.closest('[data-google-refresh]')) { await refreshAll(); renderIntegrations(); toast('Google actualizado'); return; }
    const disconnect = event.target.closest('[data-google-disconnect]');
    if (disconnect) { await disconnectGoogle(disconnect.dataset.googleDisconnect); return; }
    const refresh = event.target.closest('[data-google-connection-refresh]');
    if (refresh) {
      try {
        const result = await api.post(`/api/google/connections/${encodeURIComponent(refresh.dataset.googleConnectionRefresh)}/refresh`, {});
        toast(`${(result?.calendars || []).length} calendario(s)`, 'ok');
        await refreshAll();
      } catch (error) {
        toast(error?.message || 'No se pudieron refrescar los calendarios', 'err');
      }
    }
  });
  $('#googleBody')?.addEventListener('change', (event) => {
    if (event.target.closest('[data-calendar]')) saveCalendars();
  });

  $('#prefsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    savePrefs();
  });

  $('#dataBody')?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-journal]')) { await showJournal(); return; }
    if (event.target.closest('[data-reset-demo]')) { await resetDemo(); }
  });
  $('#dataBody')?.addEventListener('change', (event) => {
    const input = event.target.closest('[data-restore-input]');
    if (input?.files?.[0]) restoreBackup(input.files[0]);
  });

  $('#securityBody')?.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-logout]')) return;
    try {
      await api.post('/api/auth/logout', {});
      toast('Sesión cerrada', 'ok');
      window.location.reload();
    } catch (error) {
      toast(error?.message || 'No se pudo cerrar sesión', 'err');
    }
  });
  $('#securityBody')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target.closest('#passwordForm');
    if (!form) return;
    try {
      await api.post('/api/auth/password', {
        currentPassword: form.elements.currentPassword.value,
        newPassword: form.elements.newPassword.value
      });
      toast('Contraseña actualizada', 'ok');
      form.reset();
    } catch (error) {
      toast(error?.message || 'No se pudo cambiar la contraseña', 'err');
    }
  });

  $('#simulatorBody')?.addEventListener('submit', (event) => {
    event.preventDefault();
    simulate();
  });

  $('#integrRefresh')?.addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, 'Actualizando');
    await loadSecrets();
    await refreshAll();
    await loadChannelCenter();
    setBusy(event.currentTarget, false);
    renderIntegrations();
    toast('Integraciones actualizadas');
  });
}

export { renderIntegrations as refreshIntegrationsView };

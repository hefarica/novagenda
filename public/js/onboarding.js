/**
 * Onboarding de 4 pasos: rutinas esenciales, LLM, canales y prueba de chat.
 * Se puede saltar y reabrir desde la barra superior o el menú.
 */
import { api, endpointState } from './api.js';
import { state } from './state.js';
import { capability, refreshAll } from './data.js';
import { loadBaseRoutines } from './routines.js';
import {
  $, closeDialog, esc, openDialog, setBusy, toast
} from './core.js';
import { renderMessage } from './markdown.js';

const DONE_KEY = 'agenda-p95.onboarding.v1';
const STEPS = [
  { id: 'routines', title: 'Rutinas esenciales' },
  { id: 'llm', title: 'Modelo de lenguaje' },
  { id: 'channels', title: 'Canales' },
  { id: 'chat', title: 'Prueba de chat' }
];
const BASE_TITLES = ['Plan diario + Top 3', 'Bloque de foco #1', 'Procesar INBOX', 'Cierre diario', 'Revisión semanal P95', 'Revisión mensual y OKR'];

let current = 0;
let initialized = false;
let chatOutput = '';
let advancing = false;

function done() {
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* modo privado */ }
}

function isDone() {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; }
}

function renderSteps() {
  const list = $('#wizardSteps');
  if (!list) return;
  list.innerHTML = STEPS.map((step, index) => `<li class="${index === current ? 'active' : index < current ? 'done' : ''}">
    ${index < current ? '✓' : index + 1}. ${esc(step.title)}
  </li>`).join('');
}

function routinesStep() {
  const titles = new Set(state.routines.map((routine) => String(routine.title || '').toLowerCase()));
  const loaded = BASE_TITLES.filter((title) => titles.has(title.toLowerCase()));
  return `
    <p class="muted">Cargar la rutina P95 base crea <b>6 rutinas probadas</b> (plan diario, foco, inbox, cierre, revisión semanal y mensual) con horas y resultados esperados. Puedes editarlas o borrarlas después.</p>
    <div class="system-list">
      ${BASE_TITLES.map((title) => {
        const exists = loaded.includes(title);
        return `<div class="system-row">
          <div><b>${esc(title)}</b><small>${exists ? 'Ya está en tu sistema' : 'Se creará con la configuración P95'}</small></div>
          <span class="tag ${exists ? 'ok' : 'off'}">${exists ? 'lista' : 'pendiente'}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="chips">
      <button type="button" class="primary" data-wizard-load-base ${loaded.length === BASE_TITLES.length ? 'disabled' : ''}>
        ${loaded.length ? `Cargar las ${BASE_TITLES.length - loaded.length} que faltan` : '⚡ Cargar rutina P95 base en 1 clic'}
      </button>
      <button type="button" class="ghost" data-nav="routines">Ver mis rutinas</button>
    </div>
    <p class="hint">${state.routines.length ? `Tienes ${state.routines.length} rutina(s): ${loaded.length}/${BASE_TITLES.length} de la base.` : 'Aún no tienes rutinas: este es el paso más importante.'}</p>`;
}

function llmStep() {
  const status = endpointState.get('llm');
  const llm = state.llm;
  return `
    <p class="muted">El agente funciona <b>sin LLM</b> (comandos deterministas). Si conectas un modelo, gana comprensión del lenguaje. Puedes usar Ollama local (gratis) o cualquier API compatible con OpenAI.</p>
    <div class="alert ${status?.missing ? 'warn' : 'info'}">
      ${status?.missing
        ? 'El módulo del LLM aún no está montado en el servidor. Puedes guardar la clave ahora: se usará cuando arranque.'
        : llm?.available
          ? `Modelo disponible: ${esc(llm.provider || '')} · ${esc(llm.model || '')}`
          : 'No hay proveedor respondiendo todavía. Guarda la URL del modelo y prueba de nuevo.'}
    </div>
    <div class="two">
      <label class="field"><span>Proveedor</span>
        <select data-onb-provider>
          <option value="auto">auto (Ollama y luego OpenAI)</option>
          <option value="ollama">Ollama local</option>
          <option value="openai">OpenAI-compatible</option>
        </select>
      </label>
      <label class="field"><span>Modelo Ollama</span><input data-onb-ollama-model placeholder="llama3.2:3b" /></label>
    </div>
    <label class="field"><span>API key (OpenAI-compatible)</span>
      <input data-onb-api-key type="password" autocomplete="new-password" placeholder="sk-… (queda cifrada, nunca vuelve al navegador)" />
    </label>
    <label class="field"><span>URL base (opcional)</span><input data-onb-baseurl placeholder="https://api.openai.com/v1" /></label>
    <div class="chips">
      <button type="button" class="secondary" data-onb-save-llm>Guardar configuración</button>
      <button type="button" class="primary" data-onb-test-llm>Probar el modelo</button>
      <a class="ghost" href="/?view=integrations">Configuración avanzada</a>
    </div>
    <p class="hint" id="onbLlmStatus" role="status">Puedes saltarte este paso: la app seguirá funcionando sin LLM.</p>`;
}

function channelsStep() {
  const channels = state.channels || {};
  return `
    <p class="muted">Conecta al menos un canal para recibir avisos y crear citas desde el móvil. Todos son opcionales: la app funciona sin canales.</p>
    <div class="system-list">
      ${[['whatsapp', 'WhatsApp Cloud API'], ['telegram', 'Telegram'], ['email', 'Correo (Gmail)']].map(([key, label]) => `
        <div class="system-row">
          <div><b>${esc(label)}</b><small>${channels[key]?.configured ? 'Configurado' : 'Sin configurar'}</small></div>
          <span class="tag ${channels[key]?.configured ? 'ok' : 'off'}">${channels[key]?.configured ? 'listo' : 'pendiente'}</span>
        </div>`).join('')}
    </div>
    <div class="two">
      <label class="field"><span>WhatsApp · token de acceso</span><input data-onb-wa type="password" placeholder="EAA… (opcional)" /></label>
      <label class="field"><span>WhatsApp · Phone Number ID</span><input data-onb-wa-phone placeholder="1234567890" /></label>
    </div>
    <div class="two">
      <label class="field"><span>Telegram · token del bot</span><input data-onb-tg type="password" placeholder="123456:ABC…" /></label>
      <label class="field"><span>Correo · destinatario</span><input data-onb-email placeholder="tu@correo.com" /></label>
    </div>
    <div class="chips">
      <button type="button" class="secondary" data-onb-save-channels>Guardar canales</button>
      <button type="button" class="primary" data-onb-test-channel="telegram">Probar Telegram</button>
      <button type="button" class="ghost" data-onb-test-channel="whatsapp">Probar WhatsApp</button>
    </div>
    <p class="hint" id="onbChannelStatus" role="status">Los secretos se guardan cifrados. Los envíos reales dependen de la red y de las credenciales.</p>`;
}

function chatStep() {
  return `
    <p class="muted">Prueba el asistente con una frase real. Se ejecutará de verdad (puede crear o mover citas) y verás la respuesta.</p>
    <div class="chips">
      <button type="button" class="chip" data-onb-example="HOY">HOY</button>
      <button type="button" class="chip" data-onb-example="agenda reunión de prueba mañana a las 10 por 30 minutos">Agendar reunión mañana 10:00</button>
      <button type="button" class="chip" data-onb-example="CAPTURA revisar contrato con Ana">Capturar idea</button>
      <button type="button" class="chip" data-onb-example="balance">balance</button>
    </div>
    <form id="onbChatForm" class="nl-form">
      <label class="sr-only" for="onbChatText">Mensaje de prueba</label>
      <input id="onbChatText" autocomplete="off" maxlength="2000" placeholder="Escribe tu petición…" />
      <button type="submit" class="primary">Enviar prueba</button>
    </form>
    <div class="report-box chat-md" id="onbChatOut">${chatOutput
      ? renderMessage(chatOutput)
      : '<span class="muted">Aquí verás la respuesta del asistente.</span>'}</div>
    <p class="hint">Si no hay LLM, responderá el motor determinista: los comandos HOY, CAPTURA, HECHO, POSPONER, FOCO, CIERRE y SEMANA siempre funcionan.</p>`;
}

function renderBody() {
  const body = $('#wizardBody');
  if (!body) return;
  if (current === 0) body.innerHTML = routinesStep();
  else if (current === 1) body.innerHTML = llmStep();
  else if (current === 2) body.innerHTML = channelsStep();
  else body.innerHTML = chatStep();
  renderSteps();
  const next = $('#wizardNext');
  if (next) next.textContent = current === STEPS.length - 1 ? 'Empezar a usar la app' : 'Continuar';
  const prev = $('#wizardPrev');
  if (prev) prev.disabled = current === 0;
}

export function openOnboarding(step = 0) {
  current = Math.max(0, Math.min(STEPS.length - 1, step));
  chatOutput = '';
  renderBody();
  openDialog('#dlg-onboarding');
}

function stepData() {
  return {
    provider: document.querySelector('[data-onb-provider]')?.value || 'auto',
    apiKey: document.querySelector('[data-onb-api-key]')?.value.trim() || '',
    ollamaModel: document.querySelector('[data-onb-ollama-model]')?.value.trim() || '',
    baseUrl: document.querySelector('[data-onb-baseurl]')?.value.trim() || '',
    waToken: document.querySelector('[data-onb-wa]')?.value.trim() || '',
    waPhone: document.querySelector('[data-onb-wa-phone]')?.value.trim() || '',
    tgToken: document.querySelector('[data-onb-tg]')?.value.trim() || '',
    email: document.querySelector('[data-onb-email]')?.value.trim() || ''
  };
}

async function putSecret(name, value) {
  if (!value) return false;
  await api.put(`/api/secrets/${encodeURIComponent(name)}`, { value });
  return true;
}

async function saveLlmStep() {
  const data = stepData();
  let saved = 0;
  try {
    if (data.apiKey) { if (await putSecret('llm.openai.apiKey', data.apiKey)) saved += 1; }
    if (data.ollamaModel) { if (await putSecret('llm.ollama.model', data.ollamaModel)) saved += 1; }
    if (data.baseUrl) { if (await putSecret('llm.openai.baseUrl', data.baseUrl)) saved += 1; }
    if (data.provider) { if (await putSecret('llm.provider', data.provider)) saved += 1; }
    toast(saved ? `Guardado (${saved} valor/es)` : 'No había nada que guardar', saved ? 'ok' : 'warn');
    if (saved) await refreshAll();
    const status = $('#onbLlmStatus');
    if (status) status.textContent = saved ? 'Configuración guardada. Prueba el modelo para confirmar.' : 'Escribe una clave o un modelo para guardar.';
    return saved;
  } catch (error) {
    const status = $('#onbLlmStatus');
    if (status) status.textContent = error?.message || 'No se pudo guardar';
    toast(error?.message || 'No se pudo guardar', 'err');
    return 0;
  }
}

async function testLlm(button) {
  const status = $('#onbLlmStatus');
  if (!capability('llm')) {
    if (status) status.textContent = 'Este servidor todavía no tiene montado el módulo del LLM. La app funciona igual sin él.';
    toast('Módulo del LLM no disponible', 'warn');
    return;
  }
  setBusy(button, true, 'Probando');
  try {
    const result = await api.post('/api/llm/test', {}, { timeoutMs: 30000 });
    if (status) status.textContent = result?.ok
      ? `✓ El modelo respondió (${result.provider || ''} ${result.latencyMs || ''} ms).`
      : `El modelo no respondió: ${result?.error || 'sin detalle'}. Puedes seguir sin LLM.`;
    toast(result?.ok ? 'Modelo OK' : 'Modelo no disponible', result?.ok ? 'ok' : 'warn');
  } catch (error) {
    if (status) status.textContent = error?.status === 404
      ? 'Este servidor todavía no expone la prueba del LLM. La app funciona sin él.'
      : (error?.message || 'No se pudo probar');
    toast('Prueba del LLM no disponible', 'warn');
  } finally {
    setBusy(button, false);
    renderSteps();
  }
}

async function saveChannelsStep() {
  const data = stepData();
  let saved = 0;
  try {
    if (data.waToken) {
      await putSecret('channels.whatsapp.accessToken', data.waToken);
      await putSecret('channels.whatsapp.enabled', 'true');
      saved += 1;
    }
    if (data.waPhone) { await putSecret('channels.whatsapp.phoneNumberId', data.waPhone); saved += 1; }
    if (data.tgToken) {
      await putSecret('channels.telegram.botToken', data.tgToken);
      await putSecret('channels.telegram.enabled', 'true');
      saved += 1;
    }
    if (data.email) {
      await putSecret('channels.email.to', data.email);
      await putSecret('channels.email.enabled', 'true');
      saved += 1;
    }
    toast(saved ? 'Canales guardados' : 'No había nada que guardar', saved ? 'ok' : 'warn');
    if (saved) await refreshAll();
    renderBody();
    return saved;
  } catch (error) {
    toast(error?.message || 'No se pudieron guardar los canales', 'err');
    return 0;
  }
}

async function testChannel(key, button) {
  const status = $('#onbChannelStatus');
  setBusy(button, true, 'Enviando');
  try {
    const path = key === 'whatsapp' ? '/api/whatsapp/test' : '/api/telegram/test';
    await api.post(path, { text: 'Prueba de configuración de Agenda Copilot P95' }, { timeoutMs: 25000 });
    if (status) status.textContent = '✓ Mensaje de prueba aceptado por el canal.';
    toast('Prueba enviada', 'ok');
  } catch (error) {
    if (status) status.textContent = error?.code === 'CHANNEL_ERROR'
      ? `El canal respondió con error: ${error.message}`
      : (error?.message || 'No se pudo probar el canal');
    toast('La prueba del canal falló', 'err');
  } finally {
    setBusy(button, false);
  }
}

async function sendChatTest(text) {
  const clean = String(text || '').trim();
  const out = $('#onbChatOut');
  if (!clean) return;
  if (out) out.textContent = 'Pensando…';
  try {
    let reply;
    if (!capability('agent')) {
      const result = await api.post('/api/assistant', { text: clean }, { timeoutMs: 30000 });
      reply = result?.reply || '(sin respuesta)';
    } else {
      try {
        const result = await api.post('/api/agent/command', { text: clean, channel: 'web', userId: 'owner' }, { timeoutMs: 45000 });
        reply = result?.reply || '(sin respuesta)';
        if (Array.isArray(result?.actions) && result.actions.length) {
          const labels = result.actions
            .map((action) => `${action.type}${action.agendaId ? ` ${action.agendaId}` : ''}`)
            .join(' · ');
          reply += `\n\n_Acciones: ${labels}_`;
        }
      } catch (error) {
        if (error?.status === 404 || error?.status === 405) {
          const result = await api.post('/api/assistant', { text: clean }, { timeoutMs: 30000 });
          reply = result?.reply || '(sin respuesta)';
        } else {
          throw error;
        }
      }
    }
    chatOutput = reply;
    if (out) out.innerHTML = renderMessage(reply);
    await refreshAll();
  } catch (error) {
    chatOutput = `No pude completar la prueba: ${error?.message || 'error desconocido'}`;
    if (out) out.innerHTML = renderMessage(chatOutput);
  }
}

async function nextStep() {
  if (advancing) return;
  advancing = true;
  const button = $('#wizardNext');
  if (button) button.disabled = true;
  try {
    if (current === 1) await saveLlmStep();
    if (current === 2) await saveChannelsStep();
    if (current < STEPS.length - 1) {
      current += 1;
      renderBody();
      return;
    }
    done();
    closeDialog('#dlg-onboarding');
    toast('Listo. Crea tus rutinas y agenda desde la app.', 'ok');
    await refreshAll();
  } finally {
    advancing = false;
    if (button) button.disabled = false;
  }
}

export function initOnboarding() {
  if (initialized) return;
  initialized = true;

  $('#wizardBtn')?.addEventListener('click', () => openOnboarding(0));
  $('#drawerWizard')?.addEventListener('click', () => openOnboarding(0));
  $('#wizardNext')?.addEventListener('click', () => nextStep());
  $('#wizardPrev')?.addEventListener('click', () => { if (current > 0) { current -= 1; renderBody(); } });
  $('#wizardSkip')?.addEventListener('click', () => { done(); closeDialog('#dlg-onboarding'); toast('Puedes reabrir la guía con el botón ? de la barra superior.'); });

  $('#wizardBody')?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-wizard-load-base]')) {
      const button = event.target.closest('[data-wizard-load-base]');
      setBusy(button, true, 'Cargando');
      await loadBaseRoutines();
      setBusy(button, false);
      renderBody();
      return;
    }
    if (event.target.closest('[data-onb-save-llm]')) { await saveLlmStep(); return; }
    const testLlmButton = event.target.closest('[data-onb-test-llm]');
    if (testLlmButton) { await testLlm(testLlmButton); return; }
    if (event.target.closest('[data-onb-save-channels]')) { await saveChannelsStep(); return; }
    const channelButton = event.target.closest('[data-onb-test-channel]');
    if (channelButton) { await testChannel(channelButton.dataset.onbTestChannel, channelButton); return; }
    const example = event.target.closest('[data-onb-example]');
    if (example) {
      const input = $('#onbChatText');
      if (input) input.value = example.dataset.onbExample;
      await sendChatTest(example.dataset.onbExample);
      return;
    }
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      closeDialog('#dlg-onboarding');
      document.querySelector(`[data-nav="${nav.dataset.nav}"]`)?.click();
    }
  });

  $('#wizardBody')?.addEventListener('submit', (event) => {
    if (event.target.id !== 'onbChatForm') return;
    event.preventDefault();
    sendChatTest($('#onbChatText')?.value);
  });
}

/** Abre la guía automáticamente la primera vez (sin rutinas y sin haberla visto). */
export function maybeAutoOpenOnboarding() {
  if (isDone()) return false;
  if (state.routines.length > 0) return false;
  setTimeout(() => openOnboarding(0), 700);
  return true;
}

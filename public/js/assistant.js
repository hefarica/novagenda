/**
 * Asistente: chat con estado "pensando", traza de acciones ejecutadas,
 * atajos, dictado por voz e historial persistente.
 * Usa /api/agent/command cuando el módulo del agente existe y cae a
 * /api/assistant (determinista) sin romper nada.
 */
import { api, ApiError } from './api.js';
import { state, on } from './state.js';
import { capability, disableCapability, refreshAll } from './data.js';
import {
  $, $$, esc, fmtDateTime, toast
} from './core.js';
import { speak } from './voice.js';
import { renderMessage } from './markdown.js';

const CHAT_KEY = 'agenda-p95.chat.v1';
const ACTIONS_KEY = 'agenda-p95.actions.v1';
const HISTORY_MAX = 80;
const ACTION_LABELS = {
  create: 'creé',
  update: 'actualicé',
  cancel: 'cancelé',
  delete: 'borré',
  complete: 'completé',
  postpone: 'pospuse',
  capture: 'capturé',
  convert: 'convertí',
  focus: 'reservé foco',
  notify: 'notifiqué',
  noop: 'sin cambios',
  other: 'ejecuté'
};

let messages = [];
let actionLog = [];
let initialized = false;
let sending = false;
let recognition = null;

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ }
}

function timeNow() { return new Date().toISOString(); }

function pushMessage(message) {
  messages.push(message);
  if (messages.length > HISTORY_MAX) messages = messages.slice(-HISTORY_MAX);
  writeStorage(CHAT_KEY, messages);
  renderChat();
}

function pushAction(action) {
  actionLog.unshift({ ...action, at: action.at || timeNow() });
  if (actionLog.length > 40) actionLog = actionLog.slice(0, 40);
  writeStorage(ACTIONS_KEY, actionLog);
  renderActions();
}

function bubble(role, text, { meta = '', kind = '' } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = `bubble ${role}${kind ? ` ${kind}` : ''}`;
  if (role === 'bot') {
    // El asistente responde con markdown ligero: se renderiza escapado y legible.
    wrapper.innerHTML = renderMessage(text);
  } else {
    wrapper.textContent = text;
  }
  if (meta) {
    const small = document.createElement('span');
    small.className = 'meta';
    small.textContent = meta;
    wrapper.appendChild(small);
  }
  return wrapper;
}

function renderChat() {
  const chat = $('#chat');
  if (!chat) return;
  chat.innerHTML = '';
  for (const message of messages) {
    if (message.role === 'trace') {
      chat.appendChild(bubble('trace', message.text, { meta: message.meta }));
    } else if (message.role === 'system') {
      chat.appendChild(bubble('system', message.text));
    } else {
      chat.appendChild(bubble(message.role === 'user' ? 'user' : 'bot', message.text, { meta: message.meta }));
    }
  }
  chat.scrollTop = chat.scrollHeight;
}

function thinkingBubble() {
  const chat = $('#chat');
  if (!chat) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'bubble bot';
  wrapper.dataset.thinking = '1';
  wrapper.innerHTML = '<span class="thinking" aria-label="Pensando"><i></i><i></i><i></i></span>';
  chat.appendChild(wrapper);
  chat.scrollTop = chat.scrollHeight;
  return wrapper;
}

function removeThinking() {
  document.querySelectorAll('[data-thinking]').forEach((node) => node.remove());
}

function renderActions() {
  const container = $('#actionsTrace');
  const meta = $('#actionsMeta');
  if (!container) return;
  const serverActions = Array.isArray(state.agentsActions?.items) ? state.agentsActions.items : [];
  const items = actionLog.slice(0, 12).map((action) => {
    const label = ACTION_LABELS[action.type] || ACTION_LABELS.other;
    const suffix = action.agendaId ? ` ${action.agendaId}` : '';
    return `<div class="trace-item">
      <b>${esc(label)}${esc(suffix)}${action.title ? ` · ${esc(action.title)}` : ''}</b>
      <small>${esc(action.detail || (action.fallback ? 'motor determinista' : 'agente'))} · ${esc(fmtDateTime(action.at))}</small>
    </div>`;
  });
  const serverItems = serverActions.slice(0, 6).map((action) => `<div class="trace-item miss">
      <b>${esc(action.type || 'acción')} ${esc(action.status || '')}${action.agendaId ? ` · ${esc(action.agendaId)}` : ''}</b>
      <small>${esc(action.detail || '')} · ${esc(fmtDateTime(action.at))}</small>
    </div>`);
  container.innerHTML = [...items, ...serverItems].join('') || '<p class="muted small">Aún no hay acciones. Pide algo como «agenda reunión mañana a las 10».</p>';
  if (meta) meta.textContent = `${actionLog.length || 0} local(es)${serverActions.length ? ` · ${serverActions.length} servidor` : ''}`;
}

function renderHistory() {
  const container = $('#chatHistory');
  if (!container) return;
  const prompts = messages.filter((message) => message.role === 'user').slice(-12).reverse();
  container.innerHTML = prompts.length
    ? prompts.map((message) => `<button type="button" class="history-item" data-reuse="${esc(message.text)}">
        <b>${esc(message.text)}</b>
        <small>${esc(fmtDateTime(message.at))}</small>
      </button>`).join('')
    : '<p class="muted small">Sin historial todavía.</p>';
}

function renderStatus() {
  const status = $('#assistantStatus');
  const provider = $('#chatProvider');
  const llm = state.llm;
  const agentReady = Boolean(state.endpointAgentOk);
  if (status) {
    if (llm?.available) status.textContent = `LLM ${llm.provider || ''}${llm.model ? ` · ${llm.model}` : ''} · ${agentReady ? 'agente con traza' : 'chat simple'}`;
    else if (llm && llm.lastError) status.textContent = 'Motor determinista (LLM no disponible)';
    else status.textContent = agentReady ? 'Agente listo (traza de acciones)' : 'Motor determinista garantizado';
    status.className = `tag ${llm?.available ? 'ok' : 'off'}`;
  }
  if (provider) provider.textContent = llm?.available ? `${llm.provider || 'LLM'} · ${llm.model || ''}` : 'Sin LLM: comandos deterministas garantizados';
}

function traceText(actions, source) {
  if (!actions.length) return '';
  const parts = actions.map((action) => {
    const label = ACTION_LABELS[action.type] || ACTION_LABELS.other;
    const event = action.agendaId ? state.agenda.find((item) => item.id === action.agendaId) : null;
    const title = action.title || event?.title;
    return `${label}${action.agendaId ? ` ${action.agendaId}` : ''}${title ? ` · «${title}»` : ''}`;
  });
  return `Traza (${source}): ${parts.join(' | ')}`;
}

async function sendCommand(text) {
  if (!capability('agent')) {
    const data = await api.post('/api/assistant', { text }, { timeoutMs: 30000 });
    return { mode: 'assistant', data };
  }
  try {
    return { mode: 'agent', data: await api.post('/api/agent/command', { text, channel: 'web', userId: 'owner' }, { timeoutMs: 45000 }) };
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
      state.endpointAgentOk = false;
      disableCapability('agent');
      const data = await api.post('/api/assistant', { text }, { timeoutMs: 30000 });
      return { mode: 'assistant', data };
    }
    throw error;
  }
}

async function send(text) {
  const clean = String(text || '').trim();
  if (!clean || sending) return;
  sending = true;
  const input = $('#chatText');
  const sendButton = $('#chatForm .send');
  if (input) input.value = '';
  if (sendButton) sendButton.disabled = true;
  pushMessage({ role: 'user', text: clean, at: timeNow() });
  const thinking = thinkingBubble();
  try {
    const { mode, data } = await sendCommand(clean);
    removeThinking();
    const reply = data?.reply || 'Listo.';
    const metaParts = [];
    if (mode === 'agent') {
      metaParts.push(data.provider ? `${data.provider}${data.model ? `/${data.model}` : ''}` : 'agente');
      if (data.fallback) metaParts.push('fallback determinista');
      if (typeof data.latencyMs === 'number') metaParts.push(`${data.latencyMs} ms`);
    } else {
      metaParts.push('motor determinista');
    }
    pushMessage({ role: 'bot', text: reply, meta: metaParts.join(' · '), at: timeNow() });
    speak(reply);
    const actions = Array.isArray(data?.actions) ? data.actions : [];
    const trace = traceText(actions, mode === 'agent' ? 'agente' : 'asistente');
    if (trace) {
      pushMessage({ role: 'trace', text: trace, meta: data.intent?.action ? `intención: ${data.intent.action}` : '', at: timeNow() });
      for (const action of actions) {
        pushAction({ type: action.type, agendaId: action.agendaId || '', detail: action.detail || data.intent?.action || '', title: data.event?.title || '', fallback: Boolean(data.fallback) });
      }
    } else {
      const mentioned = /AG-\d{3,}/.exec(reply);
      if (mentioned) {
        pushMessage({
          role: 'trace',
          text: `Traza (asistente): ejecuté «${clean.slice(0, 70)}» y la agenda quedó con ${mentioned[0]}. Revisa la cita para confirmar el cambio.`,
          meta: 'motor determinista',
          at: timeNow()
        });
        pushAction({ type: 'other', agendaId: mentioned[0], detail: `desde «${clean.slice(0, 60)}»`, title: '' });
      }
    }
    if (mode === 'agent') state.endpointAgentOk = true;
    await refreshAll();
  } catch (error) {
    removeThinking();
    pushMessage({
      role: 'bot',
      text: `No pude ejecutar eso: ${error?.message || 'error desconocido'}${error?.field ? ` (campo: ${error.field})` : ''}`,
      meta: error?.code || '',
      at: timeNow()
    });
  } finally {
    sending = false;
    if (sendButton) sendButton.disabled = false;
    if (input) input.focus();
    renderStatus();
  }
}

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $('#voiceBtn');
  if (!SpeechRecognition) {
    toast('Este navegador no permite dictado. Escribe la petición.', 'warn');
    return;
  }
  if (recognition) { try { recognition.stop(); } catch { /* ignorado */ } recognition = null; }
  recognition = new SpeechRecognition();
  recognition.lang = 'es-CO';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  button?.classList.add('listening');
  button?.setAttribute('aria-pressed', 'true');
  recognition.onresult = (event) => {
    const text = event.results?.[0]?.[0]?.transcript || '';
    const input = $('#chatText');
    if (input) input.value = text;
    if (text) send(text);
  };
  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') toast(`Dictado: ${event.error}`, 'warn');
  };
  recognition.onend = () => {
    button?.classList.remove('listening');
    button?.setAttribute('aria-pressed', 'false');
    recognition = null;
  };
  try { recognition.start(); } catch { toast('No se pudo iniciar el dictado.', 'err'); }
}

export function renderAssistant() {
  renderChat();
  renderActions();
  renderHistory();
  renderStatus();
}

export function initAssistant() {
  if (initialized) return;
  initialized = true;

  /* Comandos de voz globales («hoy», «aprobar»…) llegan por el bus. */
  on('assistant-command', (text) => {
    if (typeof text === 'string' && text.trim()) send(text.trim());
  });
  messages = readStorage(CHAT_KEY, []);
  actionLog = readStorage(ACTIONS_KEY, []);
  if (!messages.length) {
    messages = [{
      role: 'bot',
      text: 'Soy tu Agenda Copilot. Puedo agendar, reprogramar, capturar, darte el balance del día y proteger bloques de foco. Todo lo que ejecute queda en la traza de acciones.',
      meta: 'motor determinista garantizado',
      at: timeNow()
    }];
    writeStorage(CHAT_KEY, messages);
  }

  $('#chatForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    send($('#chatText')?.value);
  });

  $('#quickCommands')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cmd]');
    if (button) send(button.dataset.cmd);
  });

  $('#chatHistory')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reuse]');
    if (button) send(button.dataset.reuse);
  });

  $('#voiceBtn')?.addEventListener('click', startVoice);

  $('#chatClear')?.addEventListener('click', () => {
    messages = [{
      role: 'bot',
      text: 'Conversación borrada. ¿Qué necesitas ahora?',
      meta: '',
      at: timeNow()
    }];
    writeStorage(CHAT_KEY, messages);
    renderChat();
    renderHistory();
    toast('Conversación borrada');
  });

  // El estado del agente se conoce al arrancar: probamos /api/agent/actions.
  state.endpointAgentOk = Boolean(state.agentsActions);
  renderAssistant();
}

export { send as sendAssistantMessage };

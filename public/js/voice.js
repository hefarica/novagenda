/**
 * Voz global: dictado en cualquier campo largo, comandos de voz y lectura en
 * voz alta de las respuestas del asistente.
 *
 * - Botón flotante: dicta en el último campo enfocado (título de cita, rutina,
 *   captura, correo, chat, muestras de estilo…).
 * - Comandos: «nueva cita», «hoy», «captura …», «dictar correo», «aprobar»,
 *   «oficina», «documentos», «estilo», «avisos», etc.
 * - Si el navegador no soporta dictado o se deniega el micrófono, se explica.
 */
import { state, emit } from './state.js';
import { $, toast } from './core.js';
import { openEventDialog } from './agenda.js';
import { captureOrQueue } from './offline.js';
import { openCompose } from './compose.js';
import { approveByVoice } from './office.js';

const STORAGE_SPEAK = 'agenda-p95.voice.speak.v1';
const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

let initialized = false;
let lastField = null;
let recognition = null;
let listening = false;
let finalText = '';
let handled = false;

export function initVoice() {
  if (initialized) return;
  initialized = true;

  state.voice.supported = Boolean(Recognition);
  try { state.voice.speak = localStorage.getItem(STORAGE_SPEAK) === '1'; } catch { state.voice.speak = false; }

  const fab = $('#voiceFab');
  if (fab) {
    /* Evita que el botón se lleve el foco del campo que se está dictando. */
    fab.addEventListener('mousedown', (event) => event.preventDefault());
    fab.addEventListener('click', () => {
      if (listening) stopListening();
      else startListening();
    });
    if (!Recognition) {
      fab.classList.add('off');
      fab.title = 'Este navegador no soporta dictado por voz';
    }
  }

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!target) return;
    if (target.matches?.('input, textarea, [contenteditable="true"]')) {
      if (target.disabled || target.readOnly) return;
      if (target.type && ['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button'].includes(target.type)) return;
      lastField = target;
    }
  });

  const toggle = $('#voiceSpeakToggle');
  if (toggle) {
    toggle.checked = state.voice.speak;
    toggle.addEventListener('change', () => {
      state.voice.speak = toggle.checked;
      try { localStorage.setItem(STORAGE_SPEAK, toggle.checked ? '1' : '0'); } catch { /* privado */ }
      if (toggle.checked) {
        speak('Lectura en voz alta activada.');
        toast('Leeré las respuestas del asistente en voz alta', 'ok');
      } else {
        stopSpeaking();
        toast('Lectura en voz alta desactivada', 'warn');
      }
    });
  }

  window.addEventListener('beforeunload', () => { try { recognition?.abort(); } catch { /* ignorado */ } stopLiveDictation(); });
}

function setStatus(text, kind = '') {
  const status = $('#voiceStatus');
  if (!status) return;
  status.hidden = !text;
  status.textContent = text;
  status.className = `voice-status${kind ? ` ${kind}` : ''}`;
}

function setListening(value) {
  listening = value;
  state.voice.listening = value;
  const fab = $('#voiceFab');
  if (fab) {
    fab.classList.toggle('listening', value);
    fab.setAttribute('aria-pressed', String(value));
    fab.setAttribute('aria-label', value ? 'Detener dictado' : 'Dictado por voz');
  }
}

export function startListening() {
  if (!Recognition) {
    setStatus('Este navegador no soporta dictado por voz. Prueba Chrome o Edge.', 'bad');
    toast('Este navegador no soporta dictado por voz', 'warn');
    return;
  }
  if (listening) return;
  try { recognition?.abort(); } catch { /* ignorado */ }
  finalText = '';
  handled = false;
  recognition = new Recognition();
  recognition.lang = 'es-CO';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    setListening(true);
    const target = lastField?.name || lastField?.placeholder || lastField?.getAttribute?.('aria-label') || '';
    setStatus(target ? `Escuchando… dictaré en «${String(target).slice(0, 40)}»` : 'Escuchando… di un comando o enfoca un campo', 'ok');
  };
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript || '';
      if (result.isFinal) finalText = `${finalText} ${text}`.trim();
      else interim += text;
    }
    if (interim) setStatus(`Escuchando: ${interim.slice(0, 80)}…`, 'ok');
  };
  recognition.onerror = (event) => {
    const code = event.error || 'error';
    const messages = {
      'not-allowed': 'Permiso de micrófono denegado. Actívalo en el candado del sitio. También puedes usar el panel de Camila en Inicio, que graba y transcribe localmente.',
      'service-not-allowed': 'El navegador bloqueó el servicio de dictado. Usa el panel de Camila en Inicio para dictar con Whisper local.',
      'no-speech': 'No te escuché. Pulsa el micrófono y vuelve a hablar cerca del equipo.',
      'audio-capture': 'No encuentro un micrófono conectado. Revisa el dispositivo de entrada.',
      network: 'El reconocimiento de voz necesita conexión a internet en este navegador.',
      aborted: ''
    };
    const message = messages[code] ?? `No pude dictar (${code}). Inténtalo de nuevo.`;
    if (message) { setStatus(message, 'bad'); toast(message, 'warn'); }
    else setStatus('');
  };
  recognition.onend = () => {
    setListening(false);
    if (!handled) {
      handled = true;
      const text = finalText.trim();
      if (text) handleVoiceText(text);
      else if ($('#voiceStatus')?.textContent?.startsWith('Escuchando')) setStatus('');
    }
    recognition = null;
  };
  try {
    recognition.start();
    setStatus('Pidiendo micrófono…');
  } catch (error) {
    setListening(false);
    const message = 'No pude iniciar el micrófono. Revisa los permisos del navegador.';
    setStatus(message, 'bad');
    toast(message, 'warn');
  }
}

export function stopListening() {
  try { recognition?.stop(); } catch { /* ignorado */ }
  setListening(false);
}

let liveRecognition = null;
let liveActive = false;

export function liveDictationSupported() {
  return Boolean(Recognition);
}

export function isLiveDictationActive() {
  return liveActive;
}

/**
 * Dictado continuo para la captura de una reunión. No guarda audio: solo
 * entrega texto final e interino mientras la pestaña siga abierta.
 */
export function startLiveDictation({ onFinal, onInterim, onStatus, lang = 'es-CO' } = {}) {
  if (!Recognition) {
    onStatus?.('Este navegador no soporta captura en vivo. Usa Chrome o Edge.', 'bad');
    return false;
  }
  stopListening();
  stopLiveDictation();
  const rec = new Recognition();
  liveRecognition = rec;
  liveActive = true;
  rec.lang = String(lang || 'es-CO');
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onstart = () => {
    if (!liveActive || liveRecognition !== rec) return;
    onStatus?.('Captura en vivo activa. Habla con claridad; el audio no se guarda.', 'ok');
  };
  rec.onresult = (event) => {
    if (!liveActive || liveRecognition !== rec) return;
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript || '';
      if (result.isFinal) onFinal?.(text.trim());
      else interim += text;
    }
    if (interim) onInterim?.(interim.trim());
  };
  rec.onerror = (event) => {
    const code = event.error || 'error';
    if (code !== 'aborted') liveActive = false;
    const messages = {
      'not-allowed': 'Permiso de micrófono denegado. Actívalo en el candado del sitio.',
      'service-not-allowed': 'El navegador bloqueó el servicio de voz.',
      'audio-capture': 'No encuentro un micrófono conectado.',
      network: 'La captura en vivo necesita conexión a internet.'
    };
    onStatus?.(messages[code] || `Captura detenida (${code}).`, 'bad');
  };
  rec.onend = () => {
    if (liveActive && liveRecognition === rec) {
      setTimeout(() => {
        if (!liveActive || liveRecognition !== rec) return;
        try { rec.start(); } catch { liveActive = false; onStatus?.('Captura detenida.', 'bad'); }
      }, 250);
    } else if (liveRecognition === rec) {
      liveRecognition = null;
      onStatus?.('Captura en vivo detenida.', '');
    }
  };
  try {
    rec.start();
    return true;
  } catch {
    liveActive = false;
    liveRecognition = null;
    onStatus?.('No pude iniciar el micrófono. Revisa los permisos.', 'bad');
    return false;
  }
}

export function stopLiveDictation() {
  const rec = liveRecognition;
  liveActive = false;
  liveRecognition = null;
  try { rec?.stop(); } catch { /* ignorado */ }
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"]';

function focusFieldForDictation() {
  let field = lastField;
  if (!field || !document.contains(field) || field.disabled || field.readOnly) {
    /* Respaldo: si el navegador no emitió focusin (p. ej. ventana sin foco),
       usamos el elemento activo siempre que siga siendo un campo editable. */
    const active = document.activeElement;
    if (!active || !active.matches?.(EDITABLE_SELECTOR) || active.disabled || active.readOnly) return null;
    field = active;
  }
  /* offsetParent es null dentro de un <dialog> modal (position: fixed):
     usamos los rectángulos para saber si está realmente visible. */
  if (!field.getClientRects().length && field.type !== 'hidden') return null;
  return field;
}

function insertText(text) {
  const field = focusFieldForDictation();
  if (!field) return false;
  if (field.isContentEditable) {
    field.textContent = `${field.textContent || ''}${text}`;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } else {
    const start = typeof field.selectionStart === 'number' ? field.selectionStart : field.value.length;
    const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : start;
    const value = field.value || '';
    field.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
    const position = start + text.length;
    try { field.setSelectionRange(position, position); } catch { /* tipos sin selección */ }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  field.focus();
  return true;
}

const COMMANDS = [
  { pattern: /^(nueva|crear|agendar|añadir|anadir)\s+(cita|reunión|reunion|evento|compromiso)/i, label: 'nueva cita', run: () => { openEventDialog({}); toast('Nueva cita por voz', 'ok'); } },
  { pattern: /^(dictar|redactar|escribir|nuevo)\s+(un\s+)?(correo|email|mensaje)/i, label: 'dictar correo', run: () => { openCompose({}); $('#composeForm')?.elements.body.focus(); } },
  { pattern: /^aprobar\b/i, label: 'aprobar', run: (text) => { emit('navigate', 'office'); approveByVoice(text); } },
  { pattern: /^(oficina|documentos|estilo|avisos|agenda|rutinas|asistente|inicio|automatizaciones|integraciones)\b/i, label: 'navegar', run: (text) => {
    const map = { oficina: 'office', documentos: 'docs', estilo: 'style', avisos: 'nudges', agenda: 'agenda', rutinas: 'routines', asistente: 'assistant', inicio: 'home', automatizaciones: 'workflows', integraciones: 'integrations' };
    const word = text.trim().toLowerCase().split(/\s+/)[0];
    emit('navigate', map[word] || 'home');
  } }
];

function handleVoiceText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  const capture = /^(captura|capturar|apunta|apuntar|recuerda|recuérdame)\b[\s:,-]*(.+)$/i.exec(text);
  if (capture && capture[2]) {
    const value = capture[2].trim();
    captureOrQueue(value, { source: 'Voz' }).then((result) => {
      toast(result?.queued ? 'Guardado en la cola (sin conexión)' : 'Captura enviada al inbox', result?.queued ? 'warn' : 'ok');
    }).catch(() => toast('No pude guardar la captura', 'err'));
    return;
  }
  if (/^hoy\b/i.test(text) || /^qué tengo hoy/i.test(text)) {
    emit('navigate', 'assistant');
    emit('assistant-command', 'HOY');
    return;
  }
  for (const command of COMMANDS) {
    if (command.pattern.test(text)) {
      command.run(text);
      return;
    }
  }
  if (insertText(text)) {
    setStatus(`Texto dictado: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`, 'ok');
    setTimeout(() => { if (!listening) setStatus(''); }, 2200);
    return;
  }
  setStatus('Dictado listo: enfoca un campo de texto y vuelve a dictar, o di un comando.', '');
  toast('Enfoca un campo para dictar o di «nueva cita», «hoy» o «captura …»', 'warn');
}

/* ------------------------------ lectura ------------------------------ */

export function speak(text) {
  if (!state.voice.speak) return;
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean.slice(0, 800));
    utterance.lang = 'es-CO';
    utterance.rate = 1.02;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  } catch { /* sin voces instaladas */ }
}

export function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch { /* ignorado */ }
}

export function voiceSupported() {
  return Boolean(Recognition);
}

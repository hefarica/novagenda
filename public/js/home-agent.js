/**
 * Panel de voz del Inicio: habla o escribe con Camila.
 *
 * El micrófono no usa el dictado del navegador: graba con MediaRecorder y manda
 * el audio al transcriptor local de la app (Whisper). Así funciona también
 * cuando Chrome bloquea SpeechRecognition con "not-allowed".
 */
import { api } from './api.js';
import { $, toast } from './core.js';
import { refreshAll } from './data.js';
import { speak } from './voice.js';

let initialized = false;
let sending = false;
let recorder = null;
let chunks = [];
let stream = null;
let recording = false;
let startedAt = 0;
let tick = null;
let maxTimer = null;

function panel() { return $('#homeAgentPanel'); }
function input() { return $('#homeAgentInput'); }
function log() { return $('#homeAgentLog'); }
function status(text, kind = '') {
  const el = $('#homeAgentStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `home-agent-status${kind ? ` ${kind}` : ''}`;
  el.hidden = !text;
}

function addMessage(role, text) {
  const box = log();
  if (!box) return;
  box.querySelector('.ha-empty')?.remove();
  const row = document.createElement('div');
  row.className = `ha-msg ${role}`;
  const bubble = document.createElement('p');
  bubble.textContent = text;
  row.appendChild(bubble);
  box.appendChild(row);
  while (box.querySelectorAll('.ha-msg').length > 8) box.querySelector('.ha-msg')?.remove();
  box.scrollTop = box.scrollHeight;
}

function setBusy(button, value, label) {
  if (!button) return;
  button.disabled = value;
  button.classList.toggle('busy', value);
  if (label) button.setAttribute('aria-label', label);
}

function humanError(error) {
  if (!error) return 'No se pudo completar la petición.';
  if (error.name === 'NotAllowedError' || /not-allowed|Permission denied/i.test(error.message || '')) {
    return 'Micrófono bloqueado. Abre el candado de la barra de direcciones → Micrófono → Permitir, recarga y vuelve a intentar.';
  }
  if (error.name === 'NotFoundError' || /Requested device not found/i.test(error.message || '')) {
    return 'No encuentro un micrófono conectado. Conecta uno y vuelve a intentar.';
  }
  if (error.name === 'NotReadableError') {
    return 'El micrófono está ocupado por otra aplicación. Ciérrala y vuelve a intentar.';
  }
  if (error.code === 'AUDIO_NO_SPEECH') return 'No te escuché. Acércate al micrófono y vuelve a intentar.';
  if (error.code === 'AUDIO_TOO_LONG') return 'La nota es demasiado larga (máximo 60 segundos).';
  return error.message || 'No se pudo procesar el audio.';
}

async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el audio.'));
    reader.readAsDataURL(blob);
  });
  return String(dataUrl).split(',')[1] || '';
}

function stopStream() {
  try { stream?.getTracks().forEach((track) => track.stop()); } catch { /* nada */ }
  stream = null;
}

function clearRecordingUi() {
  recording = false;
  if (tick) clearInterval(tick);
  if (maxTimer) clearTimeout(maxTimer);
  tick = null;
  maxTimer = null;
  const button = $('#homeAgentMic');
  button?.classList.remove('recording');
  button?.setAttribute('aria-pressed', 'false');
  button?.setAttribute('aria-label', 'Hablar con Camila');
}

async function transcribe(blob, durationSec) {
  status('Transcribiendo con Whisper local…', 'busy');
  try {
    const audio = await blobToBase64(blob);
    if (!audio) throw new Error('No se pudo leer el audio grabado.');
    const result = await api.post('/api/voice/transcribe', {
      audio,
      mimeType: blob.type || 'audio/webm',
      durationSec
    }, { timeoutMs: 60000 });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('No se detectó voz en el audio.');
    const field = input();
    if (field) field.value = text;
    addMessage('user', text);
    status('Te escuché. Camila está respondiendo…', 'ok');
    await send(text, { fromVoice: true });
  } catch (error) {
    status(humanError(error), 'bad');
    toast(humanError(error), 'warn');
  }
}

async function stopRecording() {
  if (!recording || !recorder) return;
  const durationSec = Math.max(0.2, (Date.now() - startedAt) / 1000);
  status('Procesando la nota de voz…', 'busy');
  const stopped = new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
  });
  try { recorder.stop(); } catch { /* ya paró */ }
  await stopped;
  const type = recorder.mimeType || chunks[0]?.type || 'audio/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];
  clearRecordingUi();
  stopStream();
  if (blob.size < 700) {
    status('La grabación quedó muy corta. Toca el micrófono y habla un poco más.', 'warn');
    return;
  }
  recorder = null;
  await transcribe(blob, durationSec);
}

async function startRecording() {
  if (recording) return stopRecording();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    status('Este navegador no permite grabar audio. Usa Chrome o Edge actualizado.', 'bad');
    return;
  }
  const button = $('#homeAgentMic');
  setBusy(button, true, 'Preparando micrófono');
  status('Pidiendo permiso al micrófono…', 'busy');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = types.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener('error', (event) => {
      clearRecordingUi();
      stopStream();
      status(`Error al grabar: ${event.error?.message || 'desconocido'}`, 'bad');
    });
    recorder.start(250);
    recording = true;
    startedAt = Date.now();
    button?.classList.add('recording');
    button?.setAttribute('aria-pressed', 'true');
    button?.setAttribute('aria-label', 'Detener y transcribir');
    const paint = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      status(`Grabando ${seconds}s · toca el micrófono para terminar`, 'recording');
    };
    paint();
    tick = setInterval(paint, 500);
    maxTimer = setTimeout(() => { if (recording) stopRecording(); }, 60_000);
  } catch (error) {
    clearRecordingUi();
    stopStream();
    status(humanError(error), 'bad');
    toast(humanError(error), 'warn');
  } finally {
    setBusy(button, false, recording ? 'Detener y transcribir' : 'Hablar con Camila');
  }
}

async function send(text, { fromVoice = false } = {}) {
  const clean = String(text || '').trim();
  if (!clean || sending) return;
  sending = true;
  const field = input();
  const submit = $('#homeAgentForm button[type="submit"]');
  if (field) field.value = '';
  setBusy(submit, true, 'Enviando');
  if (!fromVoice) addMessage('user', clean);
  status('Camila está pensando…', 'busy');
  try {
    const data = await api.post('/api/agent/command', {
      text: clean, channel: 'web', userId: 'owner'
    }, { timeoutMs: 45000 });
    const reply = String(data?.reply || 'Listo.').trim();
    addMessage('bot', reply);
    status('', '');
    speak(reply);
    refreshAll().catch(() => {});
  } catch (error) {
    const message = error?.status === 404
      ? 'El agente no está disponible. Abre la vista Asistente para revisar el motor.'
      : (error?.message || 'No pude comunicarme con Camila.');
    addMessage('bot', message);
    status(message, 'bad');
  } finally {
    sending = false;
    setBusy(submit, false, 'Enviar');
    if (field) field.focus();
  }
}

export function initHomeAgent() {
  if (initialized) return;
  initialized = true;
  const form = $('#homeAgentForm');
  if (!form) return;
  addMessage('bot', 'Hola, Héctor. Puedes hablarme o escribirme: te escucho y sigo el hilo de la oficina.');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input()?.value || '');
  });
  $('#homeAgentMic')?.addEventListener('click', () => {
    startRecording().catch((error) => status(humanError(error), 'bad'));
  });
  for (const chip of document.querySelectorAll('[data-ha-prompt]')) {
    chip.addEventListener('click', () => send(chip.dataset.haPrompt || chip.textContent || ''));
  }
  $('#homeAgentCollapse')?.addEventListener('click', () => {
    const root = panel();
    const collapsed = root?.classList.toggle('collapsed');
    $('#homeAgentCollapse')?.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) status('', '');
  });
  document.addEventListener('agenda:view', (event) => {
    if (event.detail?.view !== 'home' && recording) stopRecording().catch(() => {});
  });
  window.addEventListener('beforeunload', () => { if (recording) stopRecording().catch(() => {}); });
}

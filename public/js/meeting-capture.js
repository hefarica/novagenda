/**
 * Captura de reunión → acta.
 *
 * Extrae acuerdos/asistentes con el LLM y luego crea el DOCX con la plantilla
 * `acta` en `/api/docs`, que convierte los acuerdos en tareas.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy } from './core.js';
import { isLiveDictationActive, startListening, startLiveDictation, stopLiveDictation } from './voice.js';

let initialized = false;
let captured = null;
let recorder = null;
let recordStream = null;
let recordChunks = [];

export function initMeetingCapture() {
  if (initialized) return;
  if (!$('#meetingCaptureForm')) return;
  initialized = true;
  $('#meetingCaptureForm')?.addEventListener('submit', extract);
  $('#captureCreateActa')?.addEventListener('click', createActa);
  $('#captureDictate')?.addEventListener('click', () => {
    const field = $('#meetingCaptureForm')?.elements.transcript;
    field?.focus();
    startListening();
  });
  $('#captureLive')?.addEventListener('click', toggleLiveCapture);
  $('#captureSaveTranscript')?.addEventListener('click', saveTranscript);
  $('#captureRecord')?.addEventListener('click', toggleRecording);
  document.addEventListener('agenda:view', (event) => {
    if (event.detail?.view !== 'docs') stopRecordingForPrivacy('Grabación detenida al salir de Documentos.');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRecordingForPrivacy('Grabación detenida porque ocultaste la pestaña.');
  });
  document.addEventListener('agenda:view', (event) => {
    if (event.detail?.view !== 'docs') stopLiveForPrivacy('Captura detenida al salir de Documentos.');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLiveForPrivacy('Captura detenida porque ocultaste la pestaña.');
  });
}

function stopLiveForPrivacy(message) {
  if (!isLiveDictationActive()) return;
  stopLiveDictation();
  resetLiveButton();
  const status = $('#captureLiveStatus');
  if (status) { status.className = 'hint'; status.textContent = message; }
}

function resetLiveButton() {
  const button = $('#captureLive');
  if (!button) return;
  button.textContent = '● Captura en vivo';
  button.classList.remove('listening');
}

function appendLiveText(text) {
  const field = $('#meetingCaptureForm')?.elements.transcript;
  if (!field || !text) return;
  const clean = String(text).trim();
  if (!clean) return;
  field.value = `${field.value ? `${field.value.trimEnd()} ` : ''}${clean}`;
  field.scrollTop = field.scrollHeight;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleLiveCapture() {
  const button = $('#captureLive');
  const status = $('#captureLiveStatus');
  if (recorder && recorder.state === 'recording') stopRecording('Grabación detenida al iniciar la captura en vivo.');
  if (isLiveDictationActive()) {
    stopLiveDictation();
    resetLiveButton();
    if (status) { status.className = 'hint'; status.textContent = 'Captura en vivo detenida.'; }
    return;
  }
  const started = startLiveDictation({
    lang: $('#captureLiveLang')?.value || 'es-CO',
    onFinal: (text) => {
      appendLiveText(text);
      const field = $('#meetingCaptureForm')?.elements.transcript;
      const words = field ? String(field.value || '').trim().split(/\s+/).filter(Boolean).length : 0;
      if (status) { status.className = 'hint ok'; status.textContent = `Captura en vivo · ${words} palabra(s) transcritas.`; }
    },
    onInterim: (text) => {
      if (status) { status.className = 'hint'; status.textContent = `Escuchando: ${text.slice(0, 100)}…`; }
    },
    onStatus: (message, kind) => {
      if (status) { status.className = `hint${kind ? ` ${kind}` : ''}`; status.textContent = message; }
      if (kind === 'bad') resetLiveButton();
    }
  });
  if (started) {
    if (button) {
      button.textContent = '■ Detener captura';
      button.classList.add('listening');
    }
  } else {
    resetLiveButton();
  }
}

function transcriptParagraphs(text) {
  const chunks = [];
  for (const raw of String(text || '').split(/\n+/)) {
    let line = raw.trim();
    while (line.length > 1200) {
      chunks.push(line.slice(0, 1200));
      line = line.slice(1200);
    }
    if (line) chunks.push(line);
  }
  return chunks.slice(0, 80);
}

async function saveTranscript() {
  const form = $('#meetingCaptureForm');
  const button = $('#captureSaveTranscript');
  const status = $('#captureStatus');
  if (!form) return;
  const title = String(form.elements.title.value || '').trim();
  const transcript = String(form.elements.transcript.value || '').trim();
  const date = String(form.elements.date.value || '').trim();
  const time = String(form.elements.time.value || '').trim();
  const location = String(form.elements.location.value || '').trim();
  if (!title) { toast('Ponle título a la reunión', 'err'); return; }
  if (transcript.length < 30) { toast('La transcripción es demasiado corta', 'err'); return; }
  if (isLiveDictationActive()) { stopLiveDictation(); resetLiveButton(); }
  const details = [];
  if (date) details.push(`Fecha: ${date}`);
  if (time) details.push(`Hora: ${time}`);
  if (location) details.push(`Lugar: ${location}`);
  setBusy(button, true);
  if (status) { status.className = 'hint'; status.textContent = 'Guardando la transcripción…'; }
  try {
    const result = await api.post('/api/docs', {
      type: 'docx',
      title: `Transcripción — ${title}`.slice(0, 200),
      sections: [
        ...(details.length ? [{ heading: 'Datos de la reunión', paragraphs: details }] : []),
        { heading: 'Transcripción', paragraphs: transcriptParagraphs(transcript) }
      ]
    });
    const item = result?.item || result;
    if (status) {
      const url = item?.downloadUrl || (item?.id ? `/api/docs/${encodeURIComponent(item.id)}/download` : '');
      status.className = 'hint ok';
      status.innerHTML = url
        ? `Transcripción guardada. <a href="${esc(url)}" rel="noopener">Descargar DOCX</a>`
        : 'Transcripción guardada como documento.';
    }
    toast('Transcripción guardada', 'ok');
  } catch (error) {
    if (status) { status.className = 'hint bad'; status.textContent = formatError(error); }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function extract(event) {
  event.preventDefault();
  if (isLiveDictationActive()) {
    stopLiveDictation();
    resetLiveButton();
    const live = $('#captureLiveStatus');
    if (live) { live.className = 'hint'; live.textContent = 'Captura en vivo detenida al extraer acuerdos.'; }
  }
  const form = event.currentTarget;
  const button = $('#captureExtract');
  const status = $('#captureStatus');
  const preview = $('#capturePreview');
  const title = String(form.elements.title.value || '').trim();
  const transcript = String(form.elements.transcript.value || '').trim();
  const date = String(form.elements.date.value || '').trim();
  const time = String(form.elements.time.value || '').trim();
  const location = String(form.elements.location.value || '').trim();
  if (!title) { toast('Ponle título a la reunión', 'err'); return; }
  if (transcript.length < 30) { toast('La transcripción es demasiado corta', 'err'); return; }
  setBusy(button, true);
  if (status) { status.className = 'hint'; status.textContent = 'Leyendo la reunión…'; }
  if (preview) preview.hidden = true;
  try {
    const result = await api.post('/api/meetings/capture', { title, transcript, ...(date ? { date } : {}), ...(time ? { time } : {}), ...(location ? { location } : {}) });
    captured = result;
    renderPreview(result);
    const create = $('#captureCreateActa');
    if (create) create.hidden = false;
    if (status) {
      status.className = result.empty ? 'hint bad' : 'hint ok';
      status.textContent = result.empty
        ? 'El modelo no encontró asistentes ni acuerdos claros. Revisa la transcripción antes de crear el acta.'
        : 'Extracción lista. Revisa y crea el acta.';
    }
  } catch (error) {
    if (status) { status.className = 'hint bad'; status.textContent = formatError(error); }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function renderPreview(result) {
  const box = $('#capturePreview');
  if (!box) return;
  const extraction = result.extraction || {};
  const attendees = (extraction.attendees || []).map((person) => person.role ? `${person.name} (${person.role})` : person.name);
  const agreements = extraction.agreements || [];
  box.hidden = false;
  box.innerHTML = `
    <div class="capture-block">
      <h4>Resumen</h4>
      ${(extraction.summary || []).length
        ? `<ul class="capture-summary">${extraction.summary.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
        : '<p class="muted small">Sin resumen.</p>'}
    </div>
    <div class="capture-block">
      <h4>Asistentes</h4>
      <p class="small">${attendees.length ? attendees.map(esc).join(' · ') : 'No se detectaron asistentes.'}</p>
      <h4>Orden del día</h4>
      ${(extraction.agenda || []).length
        ? `<ol class="capture-summary">${extraction.agenda.map((item) => `<li>${esc(item)}</li>`).join('')}</ol>`
        : '<p class="muted small">Sin orden del día.</p>'}
    </div>
    <div class="capture-block">
      <h4>Acuerdos y compromisos</h4>
      ${agreements.length
        ? `<ul class="capture-summary">${agreements.map((item) => `<li>${esc(item.text)}${item.owner ? ` · ${esc(item.owner)}` : ''}${item.due ? ` · ${esc(item.due)}` : ''}</li>`).join('')}</ul>`
        : '<p class="muted small">No se detectaron acuerdos.</p>'}
    </div>
    ${extraction.risks?.length ? `<div class="capture-block"><h4>Riesgos / pendientes</h4><ul class="capture-summary">${extraction.risks.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}`;
}

async function createActa() {
  if (!captured) return;
  const form = $('#meetingCaptureForm');
  const button = $('#captureCreateActa');
  const status = $('#captureStatus');
  const extraction = captured.extraction || {};
  const privateNotes = String(form?.elements.privateNotes.value || '').trim();
  const payload = {
    type: 'docx',
    title: captured.title,
    template: 'acta',
    topic: captured.title,
    attendees: extraction.attendees || [],
    agenda: extraction.agenda || [],
    body: extraction.development || '',
    agreements: extraction.agreements || [],
    summary: extraction.summary || [],
    ...(captured.metadata?.date ? { date: captured.metadata.date } : {}),
    ...(captured.metadata?.time ? { time: captured.metadata.time } : {}),
    ...(captured.metadata?.location ? { location: captured.metadata.location } : {}),
    ...(privateNotes ? { annexNotes: privateNotes } : {}),
    register: true
  };
  setBusy(button, true);
  try {
    const result = await api.post('/api/docs', payload);
    const tasks = Array.isArray(result?.tasks) ? result.tasks.length : 0;
    if (status) {
      status.className = 'hint ok';
      status.innerHTML = `Acta creada: ${esc(result?.title || captured.title)}${tasks ? ` · ${tasks} tarea(s) desde los acuerdos` : ''}.`;
    }
    toast(tasks ? `Acta creada con ${tasks} tarea(s)` : 'Acta creada', 'ok');
    $('#docsRefresh')?.click();
  } catch (error) {
    if (status) { status.className = 'hint bad'; status.textContent = formatError(error); }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}



function recordButton() { return $('#captureRecord'); }
function recordStatus() { return $('#captureRecordStatus'); }

function resetRecordButton() {
  const button = recordButton();
  if (!button) return;
  button.textContent = '⏺ Grabar audio';
  button.classList.remove('recording');
  button.setAttribute('aria-pressed', 'false');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function toggleRecording() {
  if (recorder && recorder.state === 'recording') {
    stopRecording();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Este navegador no permite grabar audio', 'err');
    return;
  }
  const button = recordButton();
  const status = recordStatus();
  if (button) button.disabled = true;
  try {
    if (isLiveDictationActive()) {
      stopLiveDictation();
      resetLiveButton();
      const liveStatus = $('#captureLiveStatus');
      if (liveStatus) { liveStatus.className = 'hint'; liveStatus.textContent = 'Captura en vivo detenida al iniciar la grabación.'; }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mimeType = preferred.find((type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)) || '';
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordStream = stream;
    recordChunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) recordChunks.push(event.data);
    });
    recorder.addEventListener('stop', finishRecording, { once: true });
    recorder.start(1000);
    if (button) { button.disabled = false; button.textContent = '■ Detener y descargar'; button.classList.add('recording'); button.setAttribute('aria-pressed', 'true'); }
    if (status) { status.className = 'hint'; status.textContent = 'Grabando audio en este equipo. No se envía al servidor; al detener se descarga.'; }
  } catch (error) {
    if (button) button.disabled = false;
    if (recordStream) { try { recordStream.getTracks().forEach((track) => track.stop()); } catch { /* nada */ } }
    recordStream = null;
    recorder = null;
    recordChunks = [];
    resetRecordButton();
    const message = error?.name === 'NotAllowedError' ? 'Permiso de micrófono denegado.' : (error?.message || 'No se pudo grabar audio.');
    if (status) { status.className = 'hint bad'; status.textContent = message; }
    toast(message, 'err');
  }
}

function stopRecording(message = '') {
  if (recorder && recorder.state === 'recording') {
    try { recorder.stop(); } catch { finishRecording(); }
  }
  if (message) {
    const status = recordStatus();
    if (status) { status.className = 'hint'; status.textContent = message; }
  }
}

function stopRecordingForPrivacy(message) {
  if (!recorder || recorder.state !== 'recording') return;
  stopRecording(message);
}

function finishRecording() {
  const type = recorder?.mimeType || 'audio/webm';
  const chunks = recordChunks.slice();
  recordChunks = [];
  if (recordStream) {
    try { recordStream.getTracks().forEach((track) => track.stop()); } catch { /* nada */ }
  }
  recordStream = null;
  recorder = null;
  resetRecordButton();
  const status = recordStatus();
  const blob = new Blob(chunks, { type });
  if (!blob.size) {
    if (status) { status.className = 'hint bad'; status.textContent = 'No se capturó audio.'; }
    return;
  }
  const extension = type.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `reunion-${stamp}.${extension}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (status) {
    status.className = 'hint ok';
    status.textContent = `Audio descargado: ${filename} (${formatBytes(blob.size)}). No se almacena en el servidor.`;
  }
  toast('Audio de la reunión descargado', 'ok');
}

/**
 * Transcripción local de notas de voz y audios.
 *
 * Usa `ffmpeg` para normalizar a WAV 16 kHz mono y `faster-whisper` en CPU
 * (modelo `base` en español por defecto). El audio se escribe en un
 * directorio temporal, se transcribe y se borra; no se envía a ninguna API.
 *
 * Variables opcionales:
 *   PYTHON_BIN   ejecutable de Python (por defecto `python`)
 *   FFMPEG_BIN   ejecutable de ffmpeg (por defecto `ffmpeg`)
 *   STT_MODEL    tiny|base|small|medium (por defecto `base`; `small` = más preciso y lento)
 *   STT_LANGUAGE idioma (por defecto `es`)
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'transcribe-audio.py');
const WORKER_SCRIPT = path.join(ROOT, 'scripts', 'transcribe-server.py');
const DEFAULT_PROMPT = process.env.STT_PROMPT
  || 'Agenda, reunión, correo, WhatsApp, Telegram, Héctor Fabio Riascos, Andrés, recordatorio, tarea, mañana, viernes.';
const WORKER_IDLE_MS = 10 * 60 * 1000;

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 300;

const EXT_BY_MIME = {
  'audio/ogg': '.ogg',
  'audio/oga': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac'
};

function audioError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function extensionFor(mimeType = '') {
  return EXT_BY_MIME[String(mimeType).toLowerCase().split(';')[0].trim()] || '.bin';
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const line = text.split(/\r?\n/).filter(Boolean).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker persistente: carga el modelo una sola vez y atiende peticiones por
// líneas JSON. Reduce la latencia de ~5-6 s a ~1-3 s en notas cortas.
// ---------------------------------------------------------------------------
let worker = null;
let workerLines = null;
let workerStderr = '';
let nextRequestId = 0;
let workerQueue = Promise.resolve();
let idleTimer = null;
const pendingRequests = new Map();

function stopWorker(reason = 'reinicio') {
  const current = worker;
  worker = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try { workerLines?.close(); } catch { /* nada */ }
  workerLines = null;
  try { current?.kill(); } catch { /* nada */ }
  for (const [id, item] of pendingRequests) {
    clearTimeout(item.timer);
    item.reject(audioError('STT_WORKER_STOPPED', `El transcriptor local se detuvo (${reason}).`, { detail: workerStderr.slice(-600) }));
    pendingRequests.delete(id);
  }
}

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  workerStderr = '';
  worker = spawn(process.env.PYTHON_BIN || 'python', [WORKER_SCRIPT], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      STT_MODEL: String(process.env.STT_MODEL || 'base'),
      STT_LANGUAGE: String(process.env.STT_LANGUAGE || 'es')
    }
  });
  worker.stderr?.on('data', (chunk) => {
    workerStderr = (workerStderr + chunk.toString()).slice(-2000);
  });
  worker.once('error', (error) => {
    stopWorker(`error: ${error.message}`);
  });
  worker.once('exit', (code, signal) => {
    stopWorker(`exit ${code ?? signal ?? '?'}`);
  });
  workerLines = readline.createInterface({ input: worker.stdout });
  workerLines.on('line', (line) => {
    const parsed = parseJson(line);
    if (!parsed) return;
    if (parsed.type === 'ready') return;
    if (parsed.type === 'fatal') {
      workerStderr = String(parsed.error || 'error fatal del transcriptor');
      stopWorker('fatal');
      return;
    }
    const item = pendingRequests.get(parsed.id);
    if (!item) return;
    clearTimeout(item.timer);
    pendingRequests.delete(parsed.id);
    item.resolve(parsed);
    touchIdle();
  });
  touchIdle();
  return worker;
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stopWorker('inactivo'), WORKER_IDLE_MS);
  idleTimer.unref?.();
}

function workerRequest(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let current;
    try { current = ensureWorker(); } catch (error) { reject(error); return; }
    const id = ++nextRequestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      stopWorker('timeout');
      reject(audioError('STT_WORKER_TIMEOUT', 'La transcripción tardó demasiado.'));
    }, timeoutMs);
    timer.unref?.();
    pendingRequests.set(id, { resolve, reject, timer });
    try {
      current.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      touchIdle();
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    }
  });
}

/** Arranca el worker y carga el modelo en segundo plano. */
export async function warmTranscription() {
  if (process.env.STT_WORKER === '0') return false;
  ensureWorker();
  return true;
}

/** Cierra el worker (pruebas, apagado ordenado o cambio de modelo). */
export function stopTranscriptionWorker() {
  stopWorker('manual');
}

function transcribeInWorker(wav, options) {
  const task = workerQueue.then(() => workerRequest({
    path: wav,
    language: String(options.language || process.env.STT_LANGUAGE || 'es'),
    model: String(options.model || process.env.STT_MODEL || 'base'),
    initial_prompt: String(options.initialPrompt || DEFAULT_PROMPT),
    beam_size: Number(options.beamSize || 5)
  }, Number(options.timeoutMs || 180_000)));
  workerQueue = task.catch(() => {});
  return task;
}

process.once('exit', () => {
  try { worker?.kill(); } catch { /* nada */ }
});

/** Fallback de una sola ejecución si el worker no está disponible. */
async function transcribeOneShot(wav, options) {
  const args = [
    SCRIPT,
    '--input', wav,
    '--model', String(options.model || process.env.STT_MODEL || 'base'),
    '--language', String(options.language || process.env.STT_LANGUAGE || 'es'),
    '--prompt', String(options.initialPrompt || DEFAULT_PROMPT)
  ];
  let stdout = '';
  try {
    const result = await execFileAsync(process.env.PYTHON_BIN || 'python', args, {
      timeout: Number(options.timeoutMs || 180_000),
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = error?.stdout || '';
    const parsed = parseJson(stdout);
    if (parsed && parsed.ok === false) {
      throw audioError('AUDIO_TRANSCRIBE_FAILED', parsed.error || 'No se pudo transcribir el audio.', parsed);
    }
    if (parsed && parsed.ok === true && !String(parsed.text || '').trim()) {
      throw audioError('AUDIO_NO_SPEECH', 'No se detectó voz en el audio.', parsed);
    }
    if (error?.killed || error?.signal) {
      throw audioError('AUDIO_TIMEOUT', 'La transcripción tardó demasiado.');
    }
    throw audioError('AUDIO_TRANSCRIBE_FAILED', 'No se pudo ejecutar el transcriptor local.', {
      detail: String(error?.stderr || error?.message || '').slice(0, 600)
    });
  }
  const parsed = parseJson(stdout);
  if (!parsed) {
    throw audioError('AUDIO_BAD_OUTPUT', 'El transcriptor no devolvió un resultado válido.');
  }
  return parsed;
}

/**
 * Convierte y transcribe un buffer de audio.
 * @param {Buffer} buffer
 * @param {{mimeType?: string, durationSec?: number, language?: string, model?: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: true, text: string, language: string, duration: number, model: string, elapsedMs: number}>}
 */
export async function transcribeAudioBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw audioError('AUDIO_EMPTY', 'El audio está vacío.');
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw audioError('AUDIO_TOO_LARGE', 'El audio supera los 20 MB.');
  }
  const duration = Number(options.durationSec || 0);
  if (duration > MAX_AUDIO_SECONDS) {
    throw audioError('AUDIO_TOO_LONG', 'El audio dura más de 5 minutos.');
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'agenda-stt-'));
  const input = path.join(directory, `entrada${extensionFor(options.mimeType)}`);
  const wav = path.join(directory, 'entrada.wav');
  try {
    await writeFile(input, buffer);
    // Normaliza volumen y quita ruido de baja frecuencia antes de Whisper.
    // -vn y map 0:a:0? permiten que un video_note/video entregue solo su audio.
    await execFileAsync(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', input,
      '-vn', '-map', '0:a:0?',
      '-ar', '16000', '-ac', '1',
      '-af', 'highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-f', 'wav', wav
    ], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });

    const request = {
      language: String(options.language || process.env.STT_LANGUAGE || 'es'),
      model: String(options.model || process.env.STT_MODEL || 'base'),
      initialPrompt: String(options.initialPrompt || DEFAULT_PROMPT),
      beamSize: Number(options.beamSize || 5),
      timeoutMs: Number(options.timeoutMs || 180_000)
    };

    let parsed = null;
    let workerFailure = null;
    if (process.env.STT_WORKER !== '0') {
      try {
        parsed = await transcribeInWorker(wav, request);
      } catch (error) {
        workerFailure = error;
      }
    }
    if (!parsed) {
      parsed = await transcribeOneShot(wav, request);
    }
    if (!parsed.ok) {
      throw audioError('AUDIO_TRANSCRIBE_FAILED', parsed.error || 'No se pudo transcribir el audio.', parsed);
    }
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      throw audioError('AUDIO_NO_SPEECH', 'No se detectó voz en el audio.', parsed);
    }
    return {
      ok: true,
      text,
      language: String(parsed.language || options.language || 'es'),
      duration: Number(parsed.duration || duration || 0),
      model: String(parsed.model || options.model || 'base'),
      elapsedMs: Number(parsed.elapsed_ms || 0),
      worker: !workerFailure && process.env.STT_WORKER !== '0'
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribe un archivo local (útil para pruebas y otras vías).
 */
export async function transcribeAudioFile(filePath, options = {}) {
  const buffer = await readFile(filePath);
  return transcribeAudioBuffer(buffer, options);
}

export function isTelegramAudioMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.voice) return { ...message.voice, kind: 'voice' };
  if (message.audio) return { ...message.audio, kind: 'audio' };
  if (message.video_note) return { ...message.video_note, kind: 'video_note' };
  if (message.video) return { ...message.video, kind: 'video' };
  const mime = String(message.document?.mime_type || '').toLowerCase();
  if (message.document && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
    return { ...message.document, kind: 'document', mime_type: message.document.mime_type };
  }
  return null;
}



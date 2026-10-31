/**
 * Prueba real de la transcripción de notas de voz:
 * genera una frase en español, la convierte a OGG/Opus (formato de Telegram),
 * la transcribe con faster-whisper y valida el texto.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isTelegramAudioMessage, stopTranscriptionWorker, transcribeAudioBuffer } from '../lib/channel/transcribe.mjs';

const checks = [];
function check(name, ok, evidence = '') {
  checks.push({ name, ok: !!ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? ` · ${evidence}` : ''}`);
}

const directory = await mkdtemp(path.join(tmpdir(), 'agenda-voice-check-'));
const wav = path.join(directory, 'voz.wav');
const ogg = path.join(directory, 'voz.ogg');
try {
  const script = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voice = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1
    if ($voice) { $s.SelectVoice($voice.VoiceInfo.Name) }
    $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')
    $s.Speak('Hola, recuerdame llamar a Andres manana a las nueve de la manana.')
    $s.Dispose()
  `;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 30_000 });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', ogg], {
    windowsHide: true, timeout: 30_000
  });
  const buffer = await readFile(ogg);
  check('el audio OGG/Opus se generó', buffer.length > 1000, `${buffer.length} bytes`);
  check('detecta voice de Telegram', isTelegramAudioMessage({ voice: { file_id: 'abc', duration: 3 } })?.kind === 'voice');
  check('detecta audio de Telegram', isTelegramAudioMessage({ audio: { file_id: 'abc', duration: 3 } })?.kind === 'audio');
  check('detecta video de Telegram', isTelegramAudioMessage({ video: { file_id: 'abc', duration: 3 } })?.kind === 'video');
  check('detecta documento de audio', isTelegramAudioMessage({ document: { file_id: 'abc', mime_type: 'audio/mpeg' } })?.kind === 'document');
  const result = await transcribeAudioBuffer(buffer, { mimeType: 'audio/ogg', durationSec: 5 });
  check('la transcripción devuelve texto', result.ok && result.text.length > 3, result.text);
  check('entiende “llamar”', /llamar/i.test(result.text), result.text);
  check('conserva el nombre Andrés', /andr[eé]s/i.test(result.text), result.text);
  check('devuelve idioma español', result.language === 'es', result.language);
  check('devuelve duración', Number(result.duration) > 0, String(result.duration));
} finally {
  stopTranscriptionWorker();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`);
process.exit(failed.length ? 1 : 0);

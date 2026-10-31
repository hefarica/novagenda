/**
 * Dictado desde la app: recibe audio corto del micrófono y lo transcribe con
 * el mismo motor local que usa Telegram. No guarda el audio.
 *
 *   POST /api/voice/transcribe { audio: base64, mimeType, durationSec }
 */
import { bodyOf, respond, route } from '../agenda/http.mjs';
import { transcribeAudioBuffer } from '../channel/transcribe.mjs';
import { HttpError } from '../http/errors.mjs';

export const name = 'voice';
export const priority = 118;

const MAX_BASE64 = 9_000_000;

async function transcribeRoute(ctx) {
  const body = await bodyOf(ctx);
  const audio = typeof body?.audio === 'string' ? body.audio.trim() : '';
  if (!audio) {
    throw new HttpError(400, 'VOICE_AUDIO_REQUIRED', 'Falta el audio para transcribir.');
  }
  if (audio.length > MAX_BASE64) {
    throw new HttpError(413, 'VOICE_AUDIO_TOO_LARGE', 'El audio supera el límite de 6 MB.');
  }
  let buffer;
  try {
    buffer = Buffer.from(audio, 'base64');
  } catch {
    throw new HttpError(400, 'VOICE_AUDIO_INVALID', 'El audio no está en base64 válido.');
  }
  if (!buffer.length) {
    throw new HttpError(400, 'VOICE_AUDIO_EMPTY', 'El audio está vacío.');
  }
  try {
    const result = await transcribeAudioBuffer(buffer, {
      mimeType: String(body?.mimeType || 'audio/webm'),
      durationSec: Number(body?.durationSec || 0)
    });
    return respond(ctx, 200, { ok: true, ...result });
  } catch (error) {
    return respond(ctx, 422, {
      error: error?.message || 'No se pudo transcribir el audio.',
      code: error?.code || 'VOICE_TRANSCRIPTION_FAILED'
    });
  }
}

export const routes = [
  {
    method: 'POST',
    path: '/api/voice/transcribe',
    name: 'voice.transcribe',
    maxBodyBytes: 10_000_000,
    handler: route(transcribeRoute)
  }
];

export default { name, priority, routes };

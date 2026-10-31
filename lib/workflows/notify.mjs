/**
 * Puente de notificaciones del scheduler hacia los canales (t4).
 *
 * - `deliverNotification()` nunca lanza: devuelve el resultado por canal.
 * - En dry-run NO envía nada ni toca el store: solo describe el envío previsto.
 * - Si no hay canales configurados, `notifyChannels` devuelve [] y el scheduler
 *   lo audita como "sin canales", sin tratarlo como fallo.
 */
import { notifyChannels, notifyChannel } from '../channels.mjs';

/**
 * @param {string} text
 * @param {{subject?:string, channels?:string[], dryRun?:boolean}} [options]
 * @returns {Promise<{results:Array<{channel:string, ok:boolean, id:string|null, error:string|null}>,
 *                    planned?:object|null, error?:string|null}>}
 */
export async function deliverNotification(text, options = {}) {
  const clean = String(text || '').trim();
  const subject = options.subject || 'Agenda Copilot — aviso';
  const channels = Array.isArray(options.channels)
    ? options.channels.map((item) => String(item)).filter(Boolean)
    : [];

  if (options.dryRun) {
    return {
      results: [],
      planned: {
        dryRun: true,
        channels: channels.length ? channels : ['whatsapp', 'telegram', 'email'],
        subject,
        chars: clean.length,
        preview: clean.slice(0, 280)
      }
    };
  }

  if (!clean) return { results: [], error: null, skipped: true, reason: 'empty-text' };

  try {
    if (channels.length === 1) {
      const result = await notifyChannel(channels[0], { text: clean, subject });
      return {
        results: [{
          channel: result.channel || channels[0],
          ok: result.ok === true,
          id: result.id || null,
          error: result.error || null,
          skipped: result.skipped === true
        }]
      };
    }
    const results = await notifyChannels(clean, { subject, channels: channels.length ? channels : undefined });
    return {
      results: (Array.isArray(results) ? results : []).map((item) => ({
        channel: item.channel,
        ok: item.ok === true,
        id: item.id || null,
        error: item.error || null
      }))
    };
  } catch (error) {
    return { results: [], error: error?.message || 'Error desconocido al notificar.' };
  }
}

/** ¿Hubo al menos un envío correcto? */
export function anyDelivered(results) {
  return Array.isArray(results) && results.some((item) => item && item.ok === true);
}

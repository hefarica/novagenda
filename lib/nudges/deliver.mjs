/**
 * Entrega de avisos por los canales de t4 (t16).
 *
 * Reglas:
 * - Nunca se envía si el canal no está configurado (`channelStatus()`).
 * - `dryRun` no toca la red ni el store.
 * - `notifyChannels` ya nunca lanza y devuelve un resultado por canal.
 * - `deliver` permite inyectar un emisor de prueba en el selfcheck (sin red).
 */
import { channelStatus, notifyChannels } from '../channels.mjs';
import { CHANNEL_IDS } from './config.mjs';

function normalizeResults(results) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    channel: item?.channel || 'desconocido',
    ok: item?.ok === true,
    id: item?.id || null,
    error: item?.error || null
  }));
}

/** Canales realmente configurados en este proceso (sin secretos). */
export function configuredChannels() {
  try {
    const status = channelStatus() || {};
    return CHANNEL_IDS.filter((id) => status[id]?.configured === true);
  } catch {
    return [];
  }
}

/**
 * Resuelve a qué canales se entregaría, intersección entre lo pedido y lo
 * configurado.
 * @param {object} config
 */
export function resolveTargets(config = {}) {
  const configured = configuredChannels();
  const requested = (Array.isArray(config.channels) ? config.channels : [])
    .filter((id) => CHANNEL_IDS.includes(id));
  const targets = requested.length
    ? requested.filter((id) => configured.includes(id))
    : configured.slice();
  let reason = null;
  if (!targets.length) reason = requested.length ? 'requested-not-configured' : 'no-channels';
  return { configured, requested, targets, reason };
}

/**
 * Entrega un aviso.
 * @param {string} text
 * @param {{config?:object, subject?:string, dryRun?:boolean,
 *          deliver?:(input:{text:string,subject:string,targets:string[]})=>any}} [options]
 * @returns {Promise<{attempted:boolean, reason:string|null, targets:string[],
 *                    results:Array<{channel:string,ok:boolean,id:string|null,error:string|null}>,
 *                    error?:string}>}
 */
export async function deliverNudge(text, options = {}) {
  const clean = String(text || '').trim();
  const targetsInfo = resolveTargets(options.config || {});
  if (!clean) return { attempted: false, reason: 'empty-message', targets: [], results: [] };
  if (options.dryRun === true) {
    return { attempted: false, reason: 'dry-run', targets: targetsInfo.targets, results: [] };
  }
  if (!targetsInfo.targets.length) {
    return { attempted: false, reason: targetsInfo.reason, targets: [], results: [] };
  }
  const subject = options.subject || 'Agenda Copilot — aviso';
  try {
    if (typeof options.deliver === 'function') {
      const custom = await options.deliver({ text: clean, subject, targets: targetsInfo.targets });
      return { attempted: true, reason: null, targets: targetsInfo.targets, results: normalizeResults(custom) };
    }
    const results = await notifyChannels(clean, { subject, channels: targetsInfo.targets });
    return { attempted: true, reason: null, targets: targetsInfo.targets, results: normalizeResults(results) };
  } catch (error) {
    return {
      attempted: true,
      reason: null,
      targets: targetsInfo.targets,
      results: [],
      error: String(error?.message || error).slice(0, 300)
    };
  }
}

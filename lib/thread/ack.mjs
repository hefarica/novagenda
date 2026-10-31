/**
 * Acuses de "gestión en curso" para canales.
 *
 * Reglas:
 *   - 1 o 2 frases, sin detalle del asunto ni datos internos.
 *   - Plazo creíble de actualización (hoy, en el día, en el próximo rato).
 *   - Nunca repite la misma fórmula con el mismo contacto en 7 días.
 *   - Nunca promete fechas de entrega no confirmadas: no copia fechas, horas,
 *     días ni plazos que aparezcan en la intención del usuario.
 *
 * Reutiliza la ventana anti-repetición de `lib/style/variation.mjs` (tipo
 * `acuse`), que persiste en `data.style.variations`. Si el módulo no estuviera
 * disponible, el llamador puede seguir usando el texto devuelto (la ventana es
 * una mejora, no un requisito para responder).
 */
import { store } from '../store.mjs';
import {
  contactKey, pickVariant, recordVariationEntries, VARIATION_WINDOW_DAYS
} from '../style/variation.mjs';

export const ACK_URGENCIES = Object.freeze(['baja', 'normal', 'alta', 'urgente']);
export const ACK_WINDOW_DAYS = VARIATION_WINDOW_DAYS;

export const ACK_FORMULAS = Object.freeze({
  normal: Object.freeze([
    'Recibí tu mensaje; lo estoy gestionando y te confirmo el estado hoy mismo.',
    'Quedo con esto. En el transcurso del día te paso una actualización.',
    'Lo tengo en cuenta; te aviso en cuanto tenga novedades, hoy si es posible.',
    'Ya lo puse en marcha. Antes de cerrar el día te digo cómo va.',
    'Me ocupo y te confirmo hoy mismo, sin demoras.',
    'Está en curso; te comparto el estado en el próximo rato.',
    'Lo reviso y te respondo con una actualización hoy.',
    'Gracias por el aviso; me encargo y te confirmo esta misma jornada.',
    'Tomo nota y te aviso en cuanto lo tenga resuelto.',
    'Lo gestiono ahora; te doy una respuesta antes de que termine el día.',
    'Recibido. Lo estoy viendo y te confirmo hoy.',
    'Queda en mis manos; te aviso con una actualización en el día.'
  ]),
  alta: Object.freeze([
    'Lo veo ahora mismo; en cuanto lo tenga te confirmo.',
    'Me pongo con esto ya y te aviso en el próximo rato.',
    'Lo estoy atendiendo; te confirmo hoy sin falta.',
    'Voy con esto de inmediato; te doy señal en cuanto avance.',
    'Lo priorizo ahora; te confirmo esta misma hora.'
  ]),
  baja: Object.freeze([
    'Recibí tu mensaje; lo gestiono y te aviso con tiempo.',
    'Quedo pendiente; te paso una actualización en cuanto pueda.',
    'Lo tengo presente; te aviso cuando tenga el detalle.',
    'Sin apuro: lo reviso y te comparto el estado en el día.'
  ]),
  neutral: Object.freeze([
    'Gracias por escribir; lo estoy gestionando y te confirmo hoy mismo.',
    'Recibí tu mensaje; me encargo y te aviso en el transcurso del día.'
  ])
});

const URGENCY_ALIASES = Object.freeze({
  baja: 'baja', low: 'baja', tranquila: 'baja', tranquilo: 'baja',
  normal: 'normal', media: 'normal', medium: 'normal',
  alta: 'alta', high: 'alta', importante: 'alta',
  urgente: 'urgente', urgent: 'urgente', critica: 'urgente', crítica: 'urgente'
});

const FORBIDDEN_DATE_RE = /\b(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b|\b20\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/20\d{2})?\b/i;
const INTERNAL_DATA_RE = /\b(?:AG|TK|IN|MT|MSG|R)-\d{1,6}\b/;

/** Normaliza la urgencia a baja|normal|alta|urgente. */
export function normalizeUrgency(value, fallback = 'normal') {
  const key = String(value ?? '').trim().toLowerCase();
  return URGENCY_ALIASES[key] || fallback;
}

function ackCandidates(urgency, neutral) {
  const high = urgency === 'alta' || urgency === 'urgente';
  const low = urgency === 'baja';
  const ordered = high
    ? [...ACK_FORMULAS.alta, ...ACK_FORMULAS.normal, ...ACK_FORMULAS.baja]
    : low
      ? [...ACK_FORMULAS.baja, ...ACK_FORMULAS.neutral, ...ACK_FORMULAS.normal]
      : [...ACK_FORMULAS.normal, ...ACK_FORMULAS.neutral, ...ACK_FORMULAS.alta, ...ACK_FORMULAS.baja];
  return neutral ? [...ACK_FORMULAS.neutral, ...ordered] : ordered;
}

/** Comprueba que el acuse no filtre datos internos ni fechas. */
export function isSafeAck(text) {
  const value = String(text || '');
  return value.length > 0
    && value.length <= 400
    && !INTERNAL_DATA_RE.test(value)
    && !FORBIDDEN_DATE_RE.test(value)
    && !/https?:\/\//i.test(value);
}

function persistVariation(data, { contact, channel, text, now }) {
  const entry = [{ type: 'acuse', text }];
  if (data && data !== store.get()) {
    // Datos inyectados (pruebas/autocheck): se registran en memoria, sin tocar
    // el store real.
    recordVariationEntries(data, entry, { contact, register: channel, now });
    return;
  }
  return store.mutate((current) => {
    recordVariationEntries(current, entry, { contact, register: channel, now });
  }, { label: 'thread-ack-variation' });
}

/**
 * Redacta un acuse variado para un contacto.
 *
 * @param {{channel?:string, userId:string, intent?:string, urgency?:string, context?:object, data?:object, persist?:boolean, now?:number}} input
 * @returns {Promise<{text:string, contact:string, channel:string, urgency:string, neutral:boolean, replaced:boolean, synthesized:boolean, exhausted:boolean, windowDays:number, sources:object[]}>}
 */
export async function composeAck({
  channel = 'generic', userId = '', intent = '', urgency = 'normal', context = null,
  data = null, persist = true, now = Date.now()
} = {}) {
  const sourceData = data || store.get();
  const channelValue = String(channel || 'generic').trim().slice(0, 40);
  const userValue = String(userId || '').trim().slice(0, 200);
  if (!userValue) throw new Error('userId es obligatorio para componer un acuse.');
  const urgencyValue = normalizeUrgency(urgency);
  const neutral = !context || context.hasHistory !== true;
  const candidates = ackCandidates(urgencyValue, neutral);
  const choice = pickVariant(sourceData, userValue, 'acuse', candidates, { now });
  let text = choice.text;
  if (!text || !isSafeAck(text)) {
    // Fallback neutro: nunca una fecha ni un id.
    text = ACK_FORMULAS.neutral[0];
  }

  let recorded = false;
  if (persist === true) {
    try {
      await persistVariation(sourceData, { contact: userValue, channel: channelValue, text, now });
      recorded = true;
    } catch {
      // Si el store está en solo lectura, el acuse sigue siendo válido.
      recorded = false;
    }
  }

  return {
    text,
    contact: contactKey(userValue),
    channel: channelValue,
    urgency: urgencyValue,
    neutral,
    replaced: choice.replaced === true,
    synthesized: choice.synthesized === true,
    exhausted: choice.exhausted === true,
    windowDays: ACK_WINDOW_DAYS,
    recorded,
    intentLength: String(intent || '').length,
    sources: [
      { type: 'variacion', windowDays: ACK_WINDOW_DAYS, contacto: contactKey(userValue), registrada: recorded },
      { type: 'regla', detail: 'sin datos internos, sin fechas no confirmadas' }
    ]
  };
}

export const __test__ = Object.freeze({ ackCandidates, isSafeAck, persistVariation });

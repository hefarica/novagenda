/**
 * Parseo determinista de respuestas humanas a una decisión de la Oficina.
 *
 *   "ok", "dale", "sí", "adelante"       → approve
 *   "no", "rechaza", "cancela"           → reject
 *   "corrige: pon 10:00", "cambia ..."   → correct (+ correction)
 *   cualquier otra cosa                  → unknown
 */

const APPROVE_EXACT = new Set(['ok', 'okay', 'okey', 'dale', 'si', 'sí', 'yes', 'yep', 'aprueba', 'apruebo', 'aprobado', 'adelante', 'hazlo', 'confirmo', 'confirmado', 'perfecto', 'de acuerdo', 'vale', 'go']);
const REJECT_EXACT = new Set(['no', 'nop', 'nope', 'rechaza', 'rechazo', 'rechazado', 'cancela', 'cancelar', 'cancelado', 'para', 'stop', 'mejor no', 'no lo hagas', 'descarta']);

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * @param {unknown} value
 * @returns {{decision:'approve'|'reject'|'correct'|'unknown', text:string, correction:string|null, matched:string|null, confidence:number}}
 */
export function parseDecision(value) {
  const text = String(value ?? '').trim();
  const normalized = normalize(text);
  if (!normalized) {
    return { decision: 'unknown', text, correction: null, matched: null, confidence: 0 };
  }

  const correctionMatch = /^(?:corrige|corregir|correccion|corrije|cambia|ajusta|modifica)\s*(?:[:\-–]\s*)?(.+)$/i.exec(text);
  if (correctionMatch && correctionMatch[1] && correctionMatch[1].trim()) {
    return {
      decision: 'correct',
      text,
      correction: correctionMatch[1].trim(),
      matched: correctionMatch[0].slice(0, correctionMatch[0].length - correctionMatch[1].length).trim(),
      confidence: 0.9
    };
  }

  const words = normalized.split(/[\s,.;:!¡¿?]+/).filter(Boolean);
  const first = words[0] || '';
  if (APPROVE_EXACT.has(normalized) || APPROVE_EXACT.has(first)) {
    return { decision: 'approve', text, correction: null, matched: APPROVE_EXACT.has(normalized) ? normalized : first, confidence: APPROVE_EXACT.has(normalized) ? 0.95 : 0.8 };
  }
  if (REJECT_EXACT.has(normalized) || REJECT_EXACT.has(first)) {
    return { decision: 'reject', text, correction: null, matched: REJECT_EXACT.has(normalized) ? normalized : first, confidence: REJECT_EXACT.has(normalized) ? 0.95 : 0.8 };
  }
  if (normalized.startsWith('ok ') || normalized.startsWith('dale ')) {
    return { decision: 'approve', text, correction: null, matched: first, confidence: 0.75 };
  }
  if (normalized.startsWith('no ') || normalized.startsWith('mejor no')) {
    return { decision: 'reject', text, correction: null, matched: first, confidence: 0.75 };
  }
  return { decision: 'unknown', text, correction: null, matched: null, confidence: 0.2 };
}

/**
 * Política de niveles y modos de la Oficina.
 *
 * Niveles:
 *   N0  lectura automática (sin efectos externos)
 *   N1  borrador automático con ventana de deshacer
 *   N2  requiere aprobación humana (o autonomía si el modo lo permite)
 *   N3  doble confirmación: aprobación + código de 6 caracteres
 *
 * Modos:
 *   sombra   nada sale: todo queda retenido hasta cambiar de modo
 *   asistido N2 siempre manual (N0/N1 automáticos)
 *   autonomo N2 automático solo si riesgo ≤3, contacto conocido y voz ≥0.75
 *   total    N0/N1/N2 automáticos con bitácora; N3 sigue exigiendo código
 */

export const LEVELS = Object.freeze([
  {
    id: 'N0',
    label: 'Lectura automática',
    description: 'Consultas y resúmenes sin efectos externos: se ejecutan sin aprobación.',
    auto: true,
    requiresApproval: false,
    requiresCode: false,
    undoWindow: false
  },
  {
    id: 'N1',
    label: 'Borrador automático',
    description: 'Borradores internos (documento/nota) automáticos con ventana de deshacer.',
    auto: true,
    requiresApproval: false,
    requiresCode: false,
    undoWindow: true
  },
  {
    id: 'N2',
    label: 'Aprobación requerida',
    description: 'Envíos externos o con adjuntos: requieren aprobación del jefe (salvo autonomía).',
    auto: false,
    requiresApproval: true,
    requiresCode: false,
    undoWindow: false
  },
  {
    id: 'N3',
    label: 'Doble confirmación',
    description: 'Dinero, términos legales o riesgo alto: aprobación + código de 6 caracteres.',
    auto: false,
    requiresApproval: true,
    requiresCode: true,
    undoWindow: false
  }
]);

export const MODES = Object.freeze([
  {
    id: 'sombra',
    label: 'Sombra',
    description: 'Nada sale: todas las propuestas quedan retenidas y la ejecución se bloquea.'
  },
  {
    id: 'asistido',
    label: 'Asistido',
    description: 'N0/N1 automáticos; N2 requiere aprobación; N3 requiere aprobación + código.'
  },
  {
    id: 'autonomo',
    label: 'Autónomo',
    description: 'N2 se ejecuta solo si riesgo ≤3, contacto conocido y voz ≥0.75; el resto, aprobación.'
  },
  {
    id: 'total',
    label: 'Total',
    description: 'N0/N1/N2 automáticos con bitácora; N3 mantiene aprobación + código como puerta dura.'
  }
]);

export const DEFAULT_MODE = 'asistido';
export const DEFAULT_VOICE_THRESHOLD = 0.75;

const ALIASES = Object.freeze({
  sombra: 'sombra',
  shadow: 'sombra',
  sombra_total: 'sombra',
  asistido: 'asistido',
  assisted: 'asistido',
  manual: 'asistido',
  autonomo: 'autonomo',
  autónomo: 'autonomo',
  autonomous: 'autonomo',
  auto: 'autonomo',
  total: 'total',
  full: 'total',
  automatico: 'total',
  automático: 'total'
});

/** @param {unknown} value @returns {string|null} */
export function normalizeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  return ALIASES[raw] || null;
}

/** @param {unknown} value */
export function isMode(value) {
  return MODES.some((mode) => mode.id === value);
}

/** @param {string} mode */
export function modeInfo(mode) {
  return MODES.find((item) => item.id === mode) || MODES.find((item) => item.id === DEFAULT_MODE);
}

/** @param {string} levelId */
export function levelInfo(levelId) {
  return LEVELS.find((item) => item.id === levelId) || LEVELS[0];
}

/**
 * Deriva el nivel desde el riesgo determinista y el tipo/canal.
 * @param {{kind?:string, channel?:string, risk:{score:number, flags:{code:string}[]}, meta?:object}} input
 * @returns {'N0'|'N1'|'N2'|'N3'}
 */
export function deriveLevel({ kind, channel, risk, meta = {} }) {
  const flags = new Set((risk?.flags || []).map((flag) => flag.code));
  const readOnly = risk?.readOnly === true
    || String(kind || '').toLowerCase() === 'read'
    || String(channel || '').toLowerCase() === 'read'
    || meta?.readOnly === true;
  if (readOnly) return 'N0';
  if (flags.has('MONEY') || flags.has('LEGAL') || Number(risk?.score) >= 7) return 'N3';
  if (flags.has('EXTERNAL_CHANNEL') || flags.has('EXTERNAL_RECIPIENT') || flags.has('NEW_CONTACT') || flags.has('ATTACHMENTS') || Number(risk?.score) >= 4) return 'N2';
  return 'N1';
}

/**
 * Decide el comportamiento para una propuesta.
 * @param {{level:string, mode:string, riskScore:number, knownContact:boolean, voice:number, voiceThreshold?:number}} input
 * @returns {{mode:string, level:string, action:'auto'|'approve'|'hold', autoExecute:boolean, requiresApproval:boolean, requiresCode:boolean, reason:string}}
 */
export function decidePolicy({ level, mode, riskScore, knownContact, voice, voiceThreshold = DEFAULT_VOICE_THRESHOLD }) {
  const normalizedMode = normalizeMode(mode) || DEFAULT_MODE;
  const base = { mode: normalizedMode, level, action: 'approve', autoExecute: false, requiresApproval: true, requiresCode: false, reason: '' };

  if (normalizedMode === 'sombra') {
    return { ...base, action: 'hold', autoExecute: false, requiresApproval: true, requiresCode: level === 'N3', reason: 'Modo sombra: la propuesta queda retenida y no se ejecutará hasta cambiar de modo.' };
  }
  if (level === 'N0') {
    return { ...base, action: 'auto', autoExecute: true, requiresApproval: false, requiresCode: false, reason: 'N0: lectura sin efectos externos.' };
  }
  if (level === 'N1') {
    return { ...base, action: 'auto', autoExecute: true, requiresApproval: false, requiresCode: false, reason: 'N1: borrador interno automático con ventana de deshacer.' };
  }
  if (level === 'N3') {
    return { ...base, action: 'approve', autoExecute: false, requiresApproval: true, requiresCode: true, reason: 'N3: puerta dura, siempre aprobación + código de 6 caracteres (también en modo total).' };
  }

  // N2
  if (normalizedMode === 'total') {
    return { ...base, action: 'auto', autoExecute: true, requiresApproval: false, requiresCode: false, reason: 'Modo total: N2 automático con bitácora.' };
  }
  if (normalizedMode === 'autonomo') {
    const riskOk = riskScore <= 3;
    const voiceOk = Number(voice) >= Number(voiceThreshold);
    if (riskOk && knownContact && voiceOk) {
      return { ...base, action: 'auto', autoExecute: true, requiresApproval: false, requiresCode: false, reason: `Modo autónomo: riesgo ${riskScore} ≤ 3, contacto conocido y voz ${Number(voice).toFixed(2)} ≥ ${voiceThreshold}.` };
    }
    const missing = [];
    if (!riskOk) missing.push(`riesgo ${riskScore} > 3`);
    if (!knownContact) missing.push('contacto nuevo');
    if (!voiceOk) missing.push(`voz ${Number(voice).toFixed(2)} < ${voiceThreshold}`);
    return { ...base, reason: `Modo autónomo: requiere aprobación (${missing.join(', ')}).` };
  }
  return { ...base, reason: `Modo asistido: N2 requiere aprobación (riesgo ${riskScore}).` };
}

/** Catálogo público de niveles/modos para la UI y el contrato. */
export function policyCatalog() {
  return {
    levels: LEVELS.map((level) => ({ ...level })),
    modes: MODES.map((mode) => ({ ...mode })),
    defaultMode: DEFAULT_MODE,
    voiceThreshold: DEFAULT_VOICE_THRESHOLD
  };
}

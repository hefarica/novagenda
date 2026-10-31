/**
 * Perfiles LLM por workflow.
 *
 * Cada tarea de la app declara su perfil: modelo (opcional), temperatura,
 * máximo de tokens y si está encendida. Los perfiles se pueden sobreescribir
 * desde `POST /api/llm/config` (`profiles.<id>`) sin tocar código.
 *
 * Perfiles mínimos (contrato de producto):
 *   chat · brief · midday · close · weekly · channel · conflict · signals ·
 *   schedule_summary · autocomplete
 * `intent` es el perfil interno del agente (protocolo JSON de intención).
 */

export const PROFILE_IDS = Object.freeze([
  'chat',
  'brief',
  'midday',
  'close',
  'weekly',
  'channel',
  'conflict',
  'signals',
  'schedule_summary',
  'autocomplete',
  'intent'
]);

/** Alias en español aceptados en la API/CLI. */
export const PROFILE_ALIASES = Object.freeze({
  asistente: 'chat',
  asistente_chat: 'chat',
  chat: 'chat',
  brief: 'brief',
  briefing: 'brief',
  brief_diario: 'brief',
  mediodia: 'midday',
  mediodía: 'midday',
  midday: 'midday',
  chequeo_mediodia: 'midday',
  cierre: 'close',
  cierre_diario: 'close',
  close: 'close',
  semanal: 'weekly',
  reporte_semanal: 'weekly',
  weekly: 'weekly',
  canales: 'channel',
  respuesta_canales: 'channel',
  channel: 'channel',
  conflictos: 'conflict',
  conflict: 'conflict',
  alternativas: 'conflict',
  senales: 'signals',
  señales: 'signals',
  signals: 'signals',
  resumen_horario: 'schedule_summary',
  schedule_summary: 'schedule_summary',
  autocompletado: 'autocomplete',
  autocomplete: 'autocomplete',
  intencion: 'intent',
  intención: 'intent',
  intent: 'intent',
  agente: 'intent',
  agent: 'intent'
});

/**
 * Catálogo de perfiles. `maxTokens` es un tope de salida; el proveedor puede
 * ignorarlo, por eso el cliente también recorta por longitud cuando hace falta.
 */
export const DEFAULT_PROFILES = Object.freeze({
  chat: {
    id: 'chat', label: 'Chat / asistente', description: 'Conversación libre con el agente y respuestas del asistente.',
    temperature: 0.3, maxTokens: 800, enabled: true, cacheable: false, json: false
  },
  brief: {
    id: 'brief', label: 'Brief diario', description: 'Resumen matinal con Top 3, conflictos y foco.',
    temperature: 0.4, maxTokens: 500, enabled: true, cacheable: true, cacheTtlSec: 180, json: false
  },
  midday: {
    id: 'midday', label: 'Chequeo de mediodía', description: 'Revisión de avance y reencuadre del resto del día.',
    temperature: 0.4, maxTokens: 400, enabled: true, cacheable: true, cacheTtlSec: 120, json: false
  },
  close: {
    id: 'close', label: 'Cierre diario', description: 'Cierre con hechas, abiertas, foco e índice P95.',
    temperature: 0.3, maxTokens: 450, enabled: true, cacheable: true, cacheTtlSec: 120, json: false
  },
  weekly: {
    id: 'weekly', label: 'Reporte semanal', description: 'Reporte semanal con métricas y recomendaciones.',
    temperature: 0.4, maxTokens: 900, enabled: true, cacheable: true, cacheTtlSec: 600, json: false
  },
  channel: {
    id: 'channel', label: 'Respuesta de canales', description: 'Redacción breve de respuestas para WhatsApp, Telegram y correo.',
    temperature: 0.2, maxTokens: 350, enabled: true, cacheable: false, json: false
  },
  conflict: {
    id: 'conflict', label: 'Explicación de conflictos', description: 'Explica choques de agenda y recomienda alternativas.',
    temperature: 0.2, maxTokens: 400, enabled: true, cacheable: true, cacheTtlSec: 60, json: false
  },
  signals: {
    id: 'signals', label: 'Señales', description: 'Convierte señales del sistema en acciones sugeridas.',
    temperature: 0.3, maxTokens: 450, enabled: true, cacheable: false, json: false
  },
  schedule_summary: {
    id: 'schedule_summary', label: 'Resumen horario', description: 'Resumen en lenguaje natural del día o de la semana.',
    temperature: 0.3, maxTokens: 400, enabled: true, cacheable: true, cacheTtlSec: 60, json: false
  },
  autocomplete: {
    id: 'autocomplete', label: 'Autocompletado de campos', description: 'Propone los campos de una cita desde una frase libre.',
    temperature: 0.1, maxTokens: 600, enabled: true, cacheable: true, cacheTtlSec: 60, json: true
  },
  intent: {
    id: 'intent', label: 'Intención del agente', description: 'Protocolo JSON de intención del agente de agenda.',
    temperature: 0.1, maxTokens: 700, enabled: true, cacheable: false, json: true
  }
});

/** @param {unknown} name @returns {string|null} */
export function normalizeProfileName(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (PROFILE_IDS.includes(raw)) return raw;
  return PROFILE_ALIASES[raw] || null;
}

/**
 * Perfil resuelto = catálogo + override del store (sólo campos válidos).
 * @param {string} name
 * @param {Record<string, object>} [overrides]
 */
export function resolveProfile(name, overrides = {}) {
  const id = normalizeProfileName(name) || 'chat';
  const base = DEFAULT_PROFILES[id];
  const override = overrides && typeof overrides === 'object' && overrides[id] && typeof overrides[id] === 'object' ? overrides[id] : {};
  const out = {
    ...base,
    enabled: override.enabled === undefined ? base.enabled : override.enabled !== false,
    model: typeof override.model === 'string' && override.model.trim() ? override.model.trim() : null
  };
  if (Number.isFinite(Number(override.temperature))) out.temperature = Math.min(2, Math.max(0, Number(override.temperature)));
  if (Number.isFinite(Number(override.maxTokens))) out.maxTokens = Math.min(4096, Math.max(16, Math.round(Number(override.maxTokens))));
  if (Number.isFinite(Number(override.cacheTtlSec))) out.cacheTtlSec = Math.min(86_400, Math.max(0, Math.round(Number(override.cacheTtlSec))));
  if (typeof override.cacheable === 'boolean') out.cacheable = override.cacheable;
  if (typeof override.json === 'boolean') out.json = override.json;
  return out;
}

/** Todos los perfiles resueltos (para estado y UI). */
export function resolveAllProfiles(overrides = {}) {
  const out = {};
  for (const id of PROFILE_IDS) out[id] = resolveProfile(id, overrides);
  return out;
}

/** ¿Está encendido el perfil? (kill-switch global se evalúa aparte). */
export function profileIsEnabled(name, overrides = {}) {
  return resolveProfile(name, overrides).enabled === true;
}

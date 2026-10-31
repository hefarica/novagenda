/**
 * Registro y estado de features (Wave 0).
 *
 * Reglas:
 *   - Todo nace `off`; nada nuevo entra en `on` sin pasar por `shadow` y set
 *     dorado de pruebas.
 *   - `settings.features` se completa al leer; no se migra ni se escribe por el
 *     solo hecho de consultar.
 *   - `FEATURE_<ID>=off|shadow|on` (env) gana a settings.
 *   - `FEATURES_KILLSWITCH=all` apaga todas las features no-core sin persistir.
 *   - Cada cambio real de modo/pausa se audita en el ledger de la Oficina ANTES
 *     de persistir. Si el ledger no está disponible no hay cambio.
 */
import { store } from '../store.mjs';
import { HttpError } from '../http/errors.mjs';
import { log } from '../http/logger.mjs';

export const MODES = Object.freeze(['off', 'shadow', 'on']);
const MODE_SET = new Set(MODES);

/**
 * Catálogo inicial. `status` es el valor de catálogo (off por defecto); el
 * estado efectivo se calcula en `getFeature`.
 */
export const FEATURES = Object.freeze([
  {
    id: 'lingo', name: 'Lingo',
    description: 'Capa de lenguaje natural y sinónimos para comandos de agenda.',
    defaultMode: 'off', status: 'off', consumers: ['asistente'], owner: 'backend-core'
  },
  {
    id: 'acl', name: 'ACL',
    description: 'Control de acceso por propietario y listas blancas de canales.',
    defaultMode: 'off', status: 'off', consumers: ['channels', 'office'], owner: 'backend-core'
  },
  {
    id: 'theme_light', name: 'Tema claro',
    description: 'Tema visual claro y tokens de accesibilidad.',
    defaultMode: 'off', status: 'off', consumers: ['frontend'], owner: 'frontend'
  },
  {
    id: 'approvals_center', name: 'Centro de aprobaciones',
    description: 'Bandeja unificada de propuestas y aprobaciones de la Oficina.',
    defaultMode: 'off', status: 'off', consumers: ['office', 'frontend'], owner: 'backend-core'
  },
  {
    id: 'meeting_capture', name: 'Captura de reuniones',
    description: 'Transcripción y extracción de acuerdos de reuniones.',
    defaultMode: 'off', status: 'off', consumers: ['assistant', 'docs'], owner: 'backend-core'
  },
  {
    id: 'mail_rules', name: 'Reglas de correo',
    description: 'Reglas declarativas para clasificar y responder correo.',
    defaultMode: 'off', status: 'off', consumers: ['channels'], owner: 'backend-core'
  },
  {
    id: 'base', name: 'Base de conocimiento',
    description: 'Base local de conocimiento y recuperación de contexto.',
    defaultMode: 'off', status: 'off', consumers: ['assistant', 'research'], owner: 'backend-core'
  },
  {
    id: 'wiki', name: 'Wiki',
    description: 'Páginas internas enlazadas a la agenda y a documentos.',
    defaultMode: 'off', status: 'off', consumers: ['docs', 'frontend'], owner: 'frontend'
  },
  {
    id: 'translate', name: 'Traducción',
    description: 'Traducción de mensajes y documentos bajo demanda.',
    defaultMode: 'off', status: 'off', consumers: ['assistant', 'channels'], owner: 'backend-core'
  },
  {
    id: 'loop_guard', name: 'Loop guard',
    description: 'Detección de bucles de mensajes y respuestas automáticas.',
    defaultMode: 'off', status: 'off', consumers: ['channels'], owner: 'backend-core'
  },
  {
    id: 'audit', name: 'Auditoría extendida',
    description: 'Vista y exportación de eventos de auditoría de features/office.',
    defaultMode: 'off', status: 'off', consumers: ['office', 'frontend'], owner: 'backend-core'
  },
  {
    id: 'connectors', name: 'Conectores',
    description: 'Conectores externos adicionales con gate de Oficina.',
    defaultMode: 'off', status: 'off', consumers: ['channels', 'mcp'], owner: 'backend-core'
  }
]);

const BY_ID = new Map(FEATURES.map((feature) => [feature.id, feature]));
const SHADOW_LOG = [];
const MAX_SHADOW_LOG = 100;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function featureOf(id) {
  const normalized = String(id || '').trim();
  const feature = BY_ID.get(normalized);
  if (!feature) {
    throw new HttpError(404, 'FEATURE_UNKNOWN', `Feature desconocida: ${normalized || '(vacía)'}.`, { field: 'id' });
  }
  return feature;
}

function stateOf(data = store.get()) {
  const raw = data?.settings?.features;
  const features = isObject(raw) ? raw : {};
  const modes = isObject(features.modes) ? features.modes : {};
  const paused = new Set(
    (Array.isArray(features.paused) ? features.paused : [])
      .map((id) => String(id || '').trim())
      .filter((id) => BY_ID.has(id))
  );
  return {
    modes,
    paused,
    globalPaused: features.globalPaused === true
  };
}

function ensureState(current) {
  if (!isObject(current.settings)) current.settings = {};
  if (!isObject(current.settings.features)) current.settings.features = {};
  const features = current.settings.features;
  if (!isObject(features.modes)) features.modes = {};
  if (!Array.isArray(features.paused)) features.paused = [];
  if (typeof features.globalPaused !== 'boolean') features.globalPaused = false;
  return features;
}

function envKey(id) {
  return `FEATURE_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Override de entorno; `null` si no está definido o es inválido. */
function envOverride(id) {
  const raw = process.env[envKey(id)];
  if (raw === undefined || String(raw).trim() === '') return null;
  const mode = String(raw).trim().toLowerCase();
  return MODE_SET.has(mode) ? mode : null;
}

function killSwitchEnv() {
  return String(process.env.FEATURES_KILLSWITCH || '').trim().toLowerCase() === 'all';
}

function storedMode(state, id) {
  const mode = state.modes[id];
  return MODE_SET.has(mode) ? mode : 'off';
}

function pausedBy(state, id) {
  if (killSwitchEnv()) return 'killswitch';
  if (state.globalPaused) return 'global';
  if (state.paused.has(id)) return 'feature';
  return null;
}

/** Vista pública de una feature con estado efectivo. */
export function getFeature(id, data = store.get()) {
  const feature = featureOf(id);
  const state = stateOf(data);
  const override = envOverride(feature.id);
  const configuredMode = override || storedMode(state, feature.id);
  const pausedByValue = pausedBy(state, feature.id);
  const effectiveMode = pausedByValue ? 'off' : configuredMode;
  return {
    ...feature,
    defaultMode: 'off',
    status: effectiveMode,
    mode: configuredMode,
    configuredMode,
    effectiveMode,
    override,
    paused: pausedByValue !== null,
    pausedBy: pausedByValue
  };
}

/** @param {string} id @param {any} [data] */
export function getMode(id, data = store.get()) {
  return getFeature(id, data).effectiveMode;
}

export function isOn(id, data = store.get()) {
  return getMode(id, data) === 'on';
}

export function isShadow(id, data = store.get()) {
  return getMode(id, data) === 'shadow';
}

/**
 * Falla si la feature no está efectivamente `on`.
 * - Pausada/global/killswitch → FEATURE_PAUSED.
 * - off/shadow → FEATURE_OFF.
 */
export function assertOn(id, data = store.get()) {
  const feature = getFeature(id, data);
  if (feature.paused) {
    throw new HttpError(409, 'FEATURE_PAUSED', `Feature ${feature.id} pausada (${feature.pausedBy}).`, {
      details: { feature: feature.id, pausedBy: feature.pausedBy }
    });
  }
  if (feature.effectiveMode !== 'on') {
    throw new HttpError(409, 'FEATURE_OFF', `Feature ${feature.id} no está activa (modo ${feature.effectiveMode}).`, {
      details: { feature: feature.id, mode: feature.effectiveMode }
    });
  }
  return feature;
}

export function listFeatures(data = store.get()) {
  return FEATURES.map((feature) => getFeature(feature.id, data));
}

export function featureSummary(data = store.get()) {
  const items = listFeatures(data);
  const summary = { count: items.length, on: 0, shadow: 0, off: 0, paused: 0, globalPaused: killSwitchEnv() || stateOf(data).globalPaused };
  for (const item of items) {
    if (item.status === 'on') summary.on += 1;
    else if (item.status === 'shadow') summary.shadow += 1;
    else summary.off += 1;
    if (item.paused) summary.paused += 1;
  }
  return summary;
}

export function shadowLog() {
  return SHADOW_LOG.map((entry) => ({ ...entry }));
}

async function loadLedger() {
  try {
    const ledger = await import('../office/ledger.mjs');
    if (typeof ledger.appendLedger !== 'function') throw new Error('sin appendLedger');
    return ledger;
  } catch {
    throw new HttpError(503, 'FEATURES_UNAVAILABLE', 'El ledger de la Oficina no está disponible; no se cambió ninguna feature.');
  }
}

function normalizeMode(mode) {
  if (typeof mode !== 'string' || !MODE_SET.has(mode)) {
    throw new HttpError(400, 'FEATURE_INVALID_MODE', 'mode debe ser off, shadow u on.', { field: 'mode' });
  }
  return mode;
}

function markUpdated(features) {
  features.updatedAt = new Date().toISOString();
}

/** Cambia el modo configurado. La env sigue ganando. */
export async function setMode(id, mode, { by = 'user' } = {}) {
  const feature = featureOf(id);
  const next = normalizeMode(mode);
  const before = storedMode(stateOf(store.get()), feature.id);
  if (before === next) return getFeature(feature.id);
  const ledger = await loadLedger();
  await store.mutate((current) => {
    const currentMode = storedMode(stateOf(current), feature.id);
    if (currentMode === next) return;
    // Auditoría ANTES de tocar settings.features.
    ledger.appendLedger(current, {
      actor: String(by || 'user').slice(0, 80),
      action: 'feature.change',
      payload: { id: feature.id, from: currentMode, to: next, by: String(by || 'user').slice(0, 80) }
    });
    const features = ensureState(current);
    features.modes[feature.id] = next;
    markUpdated(features);
  }, { label: `feature-change-${feature.id}` });
  return getFeature(feature.id);
}

export async function pause(id, { by = 'user' } = {}) {
  const feature = featureOf(id);
  const state = stateOf(store.get());
  if (state.globalPaused || state.paused.has(feature.id)) return getFeature(feature.id);
  const ledger = await loadLedger();
  await store.mutate((current) => {
    const currentState = stateOf(current);
    if (currentState.globalPaused || currentState.paused.has(feature.id)) return;
    ledger.appendLedger(current, {
      actor: String(by || 'user').slice(0, 80),
      action: 'feature.paused',
      payload: { id: feature.id, paused: true, scope: 'feature', by: String(by || 'user').slice(0, 80) }
    });
    const features = ensureState(current);
    if (!features.paused.includes(feature.id)) features.paused.push(feature.id);
    markUpdated(features);
  }, { label: `feature-pause-${feature.id}` });
  return getFeature(feature.id);
}

export async function resume(id, { by = 'user' } = {}) {
  const feature = featureOf(id);
  const state = stateOf(store.get());
  if (!state.paused.has(feature.id)) return getFeature(feature.id);
  const ledger = await loadLedger();
  await store.mutate((current) => {
    const currentState = stateOf(current);
    if (!currentState.paused.has(feature.id)) return;
    ledger.appendLedger(current, {
      actor: String(by || 'user').slice(0, 80),
      action: 'feature.paused',
      payload: { id: feature.id, paused: false, scope: 'feature', by: String(by || 'user').slice(0, 80) }
    });
    const features = ensureState(current);
    features.paused = features.paused.filter((item) => item !== feature.id);
    markUpdated(features);
  }, { label: `feature-resume-${feature.id}` });
  return getFeature(feature.id);
}

export async function pauseAll({ by = 'user' } = {}) {
  if (stateOf(store.get()).globalPaused) return featureSummary();
  const ledger = await loadLedger();
  await store.mutate((current) => {
    if (stateOf(current).globalPaused) return;
    ledger.appendLedger(current, {
      actor: String(by || 'user').slice(0, 80),
      action: 'feature.paused',
      payload: { scope: 'all', paused: true, by: String(by || 'user').slice(0, 80) }
    });
    const features = ensureState(current);
    features.globalPaused = true;
    // Reflejar la pausa global también en paused[] (estado observable).
    features.paused = FEATURES.map((item) => item.id);
    markUpdated(features);
  }, { label: 'feature-pause-all' });
  return featureSummary();
}

export async function resumeAll({ by = 'user' } = {}) {
  const state = stateOf(store.get());
  if (!state.globalPaused && state.paused.size === 0) return featureSummary();
  const ledger = await loadLedger();
  await store.mutate((current) => {
    const currentState = stateOf(current);
    if (!currentState.globalPaused && currentState.paused.size === 0) return;
    ledger.appendLedger(current, {
      actor: String(by || 'user').slice(0, 80),
      action: 'feature.paused',
      payload: { scope: 'all', paused: false, by: String(by || 'user').slice(0, 80) }
    });
    const features = ensureState(current);
    features.globalPaused = false;
    features.paused = [];
    markUpdated(features);
  }, { label: 'feature-resume-all' });
  return featureSummary();
}

/**
 * Ejecuta `fn` en shadow sin permitir los efectos habituales:
 *   - `ctx.send` es no-op;
 *   - `ctx.store` solo expone una copia de lectura.
 * El `compare` opcional devuelve la diferencia; se registra en memoria/log,
 * nunca en el store (shadow no escribe).
 *
 * @param {string} id
 * @param {(shadow:{feature:string,shadow:true,dryRun:true,send:Function,store:object})=>any} fn
 * @param {(result:any)=>any} [compare]
 */
export async function runShadow(id, fn, compare) {
  const feature = getFeature(id);
  if (feature.paused) {
    throw new HttpError(409, 'FEATURE_PAUSED', `Feature ${feature.id} pausada (${feature.pausedBy}).`, {
      details: { feature: feature.id, pausedBy: feature.pausedBy }
    });
  }
  if (feature.effectiveMode !== 'shadow') {
    throw new HttpError(409, 'FEATURE_NOT_SHADOW', `Feature ${feature.id} no está en shadow (modo ${feature.effectiveMode}).`, {
      details: { feature: feature.id, mode: feature.effectiveMode }
    });
  }
  if (typeof fn !== 'function') {
    throw new HttpError(400, 'FEATURE_SHADOW_FN', 'runShadow requiere una función.', { field: 'fn' });
  }
  const snapshot = structuredClone(store.get());
  const shadowContext = Object.freeze({
    feature: feature.id,
    shadow: true,
    dryRun: true,
    send: async () => ({ ok: true, skipped: true, shadow: true }),
    store: Object.freeze({
      get: () => structuredClone(snapshot),
      status: () => ({ readOnly: true, shadow: true })
    })
  });
  const result = await fn(shadowContext);
  let diff = null;
  if (typeof compare === 'function') {
    const compared = await compare(result);
    if (compared !== undefined && compared !== null) diff = compared;
  }
  if (diff !== null) {
    const entry = { at: new Date().toISOString(), feature: feature.id, diff };
    SHADOW_LOG.push(entry);
    if (SHADOW_LOG.length > MAX_SHADOW_LOG) SHADOW_LOG.splice(0, SHADOW_LOG.length - MAX_SHADOW_LOG);
    log('warn', `feature.shadow diferencia en ${feature.id}`, { feature: feature.id, diff });
  }
  return { feature: feature.id, mode: 'shadow', result, diff, effects: false };
}

export default {
  MODES,
  FEATURES,
  getFeature,
  getMode,
  isOn,
  isShadow,
  assertOn,
  listFeatures,
  featureSummary,
  shadowLog,
  runShadow,
  setMode,
  pause,
  resume,
  pauseAll,
  resumeAll
};

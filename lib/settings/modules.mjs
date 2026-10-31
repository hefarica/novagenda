/**
 * Visibilidad de módulos opcionales.
 *
 * No borra datos ni desactiva APIs: decide si el módulo aparece en el menú y
 * si se puede abrir desde la interfaz. El servidor sigue sirviendo sus rutas.
 */
import { HttpError } from '../http/errors.mjs';
import { appendLedger } from '../office/ledger.mjs';

export const MODULE_KEYS = Object.freeze([
  'approvals', 'okr', 'rooms', 'attendance', 'moments', 'base', 'docs', 'wiki'
]);

const DEFAULT_MODULES = Object.freeze(Object.fromEntries(MODULE_KEYS.map((key) => [key, true])));

function ensureSettings(data) {
  if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) data.settings = {};
  if (!data.settings.modules || typeof data.settings.modules !== 'object' || Array.isArray(data.settings.modules)) {
    data.settings.modules = { ...DEFAULT_MODULES };
  }
  for (const key of MODULE_KEYS) {
    if (typeof data.settings.modules[key] !== 'boolean') data.settings.modules[key] = true;
  }
  return data.settings.modules;
}

export function listModules(data) {
  const modules = ensureSettings(data);
  return { items: MODULE_KEYS.map((key) => ({ key, enabled: modules[key] !== false })), modules: { ...modules } };
}

export function setModule(data, key, enabled) {
  if (!MODULE_KEYS.includes(String(key || ''))) {
    throw new HttpError(400, 'INVALID_MODULE', `Módulo no válido. Usa: ${MODULE_KEYS.join(', ')}.`, { field: 'key' });
  }
  if (typeof enabled !== 'boolean') {
    throw new HttpError(400, 'INVALID_VALUE', 'enabled debe ser booleano.', { field: 'enabled' });
  }
  const modules = ensureSettings(data);
  const before = modules[key] !== false;
  modules[key] = enabled;
  data.settings.updatedAt = new Date().toISOString();
  appendLedger(data, { actor: 'settings', action: 'settings.change', payload: { change: 'module_visibility', key, before, after: enabled } });
  return { key, enabled, modules: { ...modules } };
}

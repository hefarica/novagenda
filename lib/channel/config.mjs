/**
 * Metadatos y validación de configuración de canales.
 *
 * Cada adaptador declara `configFields` (sin valores) y esta capa:
 *   - construye la vista enmascarada para la UI (`hint` en secretos),
 *   - valida los valores con los validadores estrictos de `lib/validate.mjs`,
 *   - escribe los secretos en la bóveda cifrada (`setSecret`) y los ajustes no
 *     sensibles en `store.channelState.config`.
 *
 * Regla: un campo con `vault` NUNCA se guarda en `channelState`; su valor va a
 * `store.secrets` cifrado con AES-256-GCM y en la vista solo aparece `hint`.
 */
import {
  boolean, enumValue, integer, isPlainObject, text
} from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import { deleteSecret, getSecret, secretStatus, setSecret } from '../security/vault.mjs';

/**
 * @typedef {object} FieldSpec
 * @property {string} key
 * @property {string} label
 * @property {'string'|'secret'|'boolean'|'number'|'enum'|'list'|'url'} type
 * @property {string} [vault]      nombre en la bóveda de secretos
 * @property {boolean} [required]
 * @property {any} [default]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [maxLength]
 * @property {string[]} [options]
 * @property {string} [help]
 * @property {string} [placeholder]
 * @property {string[]} [items]    valores permitidos para tipo list (opcional)
 */

const DEFAULT_MAX_LENGTH = 300;

/**
 * Valida y normaliza un valor según el campo.
 * @param {FieldSpec} field
 * @param {unknown} raw
 * @returns {unknown} valor normalizado (null = borrar)
 */
export function normalizeFieldValue(field, raw) {
  if (raw === null) return null;
  if (raw === '' && (field.type === 'url' || field.type === 'string')) return null;
  switch (field.type) {
    case 'boolean':
      return boolean(raw, { field: field.key });
    case 'number':
      return integer(raw, { field: field.key, min: field.min, max: field.max });
    case 'enum':
      return enumValue(raw, field.options || [], { field: field.key });
    case 'list': {
      let items;
      if (Array.isArray(raw)) items = raw;
      else if (typeof raw === 'string') items = raw.split(',').map((item) => item.trim()).filter(Boolean);
      else throw new ValidationError(field.key, 'INVALID_TYPE', `${field.label} debe ser una lista de textos.`);
      if (items.length > 20) throw new ValidationError(field.key, 'TOO_LONG', `${field.label} admite como máximo 20 elementos.`);
      const clean = items.map((item, index) => {
        if (typeof item !== 'string' && typeof item !== 'number') {
          throw new ValidationError(`${field.key}[${index}]`, 'INVALID_TYPE', 'Cada elemento debe ser texto.');
        }
        const value = text(String(item), { field: `${field.key}[${index}]`, max: 120, allowEmpty: false });
        if (field.items && !field.items.includes(value)) {
          throw new ValidationError(`${field.key}[${index}]`, 'INVALID_VALUE', `Valor no permitido: ${value}.`);
        }
        return value;
      });
      return clean;
    }
    case 'url': {
      const value = text(raw, { field: field.key, max: field.maxLength || 500, required: true, allowEmpty: false });
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new ValidationError(field.key, 'INVALID_URL', `${field.label} debe ser una URL válida (https://…).`);
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new ValidationError(field.key, 'INVALID_URL', `${field.label} debe usar http o https.`);
      }
      return parsed.toString().replace(/\/$/, '');
    }
    case 'secret':
      return text(raw, {
        field: field.key,
        max: field.maxLength || 512,
        required: true,
        allowEmpty: false
      });
    case 'string':
    default:
      return text(raw, {
        field: field.key,
        max: field.maxLength || DEFAULT_MAX_LENGTH,
        required: !!field.required,
        allowEmpty: false
      });
  }
}

/**
 * Vista pública de la configuración: nunca devuelve valores secretos.
 * @param {FieldSpec[]} fields
 * @param {Record<string, any>} settings
 * @returns {object[]}
 */
export function buildConfigView(fields, settings = {}) {
  return (fields || []).map((field) => {
    const base = {
      key: field.key,
      label: field.label,
      type: field.type,
      secret: field.type === 'secret' || field.secret === true,
      required: !!field.required,
      help: field.help || null,
      placeholder: field.placeholder || null,
      options: field.options || null,
      min: field.min ?? null,
      max: field.max ?? null,
      maxLength: field.maxLength ?? null,
      default: field.default ?? null,
      vault: !!field.vault
    };
    if (field.vault) {
      const status = secretStatus(field.vault);
      return {
        ...base,
        configured: status.configured,
        hint: base.secret ? status.hint : null,
        value: base.secret ? null : status.value,
        source: status.source,
        updatedAt: status.updatedAt,
        error: status.error || null
      };
    }
    const value = settings[field.key] !== undefined ? settings[field.key] : field.default ?? null;
    return {
      ...base,
      configured: value !== null && value !== undefined,
      hint: null,
      value,
      source: value !== null && value !== undefined ? 'store' : null,
      updatedAt: null
    };
  });
}

/**
 * Aplica una configuración parcial.
 *
 * Acepta `{enabled, fields:{…}}` o el objeto plano `{botToken:…, mode:…}`.
 *
 * @param {{
 *   channel:string,
 *   fields:FieldSpec[],
 *   body:unknown,
 *   settings:Record<string, any>,
 *   requiredEnabled?:boolean
 * }} input
 * @returns {Promise<{changed:string[], settingsPatch:Record<string, unknown>, cleared:string[], enabled:boolean|null}>}
 */
export async function applyConfigFields({ channel, fields, body, settings }) {
  if (!isPlainObject(body)) throw new ValidationError('body', 'INVALID_BODY', 'Se espera un objeto JSON de configuración.');
  const flat = { ...body };
  const nested = flat.fields;
  delete flat.fields;
  if (nested !== undefined) {
    if (!isPlainObject(nested)) throw new ValidationError('fields', 'INVALID_BODY', 'fields debe ser un objeto.');
    for (const [key, value] of Object.entries(nested)) {
      if (flat[key] !== undefined) throw new ValidationError(key, 'DUPLICATE_FIELD', `El campo ${key} llegó dos veces.`);
      flat[key] = value;
    }
  }
  if (Object.keys(flat).length === 0) {
    throw new ValidationError('body', 'EMPTY_PATCH', 'No se envió ningún campo de configuración.');
  }

  const byKey = new Map((fields || []).map((field) => [field.key, field]));
  for (const key of Object.keys(flat)) {
    if (!byKey.has(key)) {
      throw new ValidationError(key, 'UNKNOWN_FIELD', `Campo de configuración no permitido: ${key}.`);
    }
  }

  const changed = [];
  const cleared = [];
  const settingsPatch = {};
  let enabled = null;

  // Los secretos se escriben al final: si una validación posterior falla, no se
  // habrá tocado la bóveda (todo se valida antes de persistir).
  /** @type {{field:FieldSpec, value:any}[]} */
  const vaultWrites = [];
  for (const [key, raw] of Object.entries(flat)) {
    const field = byKey.get(key);
    if (raw === '' && field.type !== 'string' && field.type !== 'url' && field.type !== 'list') {
      // Cadena vacía en un campo ya configurado = «no cambiar».
      continue;
    }
    const value = normalizeFieldValue(field, raw);
    if (field.vault) {
      vaultWrites.push({ field, value });
    } else {
      settingsPatch[field.key] = value;
    }
    if (field.key === 'enabled') enabled = value === true;
    changed.push(key);
  }

  for (const { field, value } of vaultWrites) {
    if (value === null) {
      await deleteSecret(field.vault);
      cleared.push(field.key);
      continue;
    }
    const serialized = typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.join(',') : String(value);
    await setSecret(field.vault, serialized);
  }

  return { changed, cleared, settingsPatch, enabled };
}

/**
 * Comprueba si un campo de bóveda está configurado.
 * @param {string} name
 */
export function vaultConfigured(name) {
  return secretStatus(name).configured;
}

/**
 * Lee un campo del cuerpo aceptando `{campo:…}` o `{fields:{campo:…}}`.
 * @param {unknown} body
 * @param {string} key
 */
export function readRawField(body, key) {
  if (!body || typeof body !== 'object') return undefined;
  if (body[key] !== undefined) return body[key];
  if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) return body.fields[key];
  return undefined;
}

/** Valor real de un secreto (solo uso interno del adaptador). */
export function vaultValue(name) {
  return getSecret(name);
}

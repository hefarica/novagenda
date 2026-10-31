/**
 * Persistencia y cálculo de perfiles de voz por registro.
 *
 * Los datos viven en el store (JSON atómico de t1) bajo `data.style`:
 *
 *   data.style.samples    = { cliente: [{text, at}], proveedor: [...], ... }
 *   data.style.profiles   = { global: {...}, cliente: {...}, ... }  // caché
 *   data.style.variations = [{at, contact, type, text, register}]   // anti-repetición
 *
 * Mínimo 10 muestras por registro; si no llega, se usa el perfil global; si no
 * hay ninguna muestra, un perfil neutro por defecto. Nada de esto llama a un LLM.
 */
import { store } from '../store.mjs';
import { isPlainObject } from '../validate.mjs';
import { ValidationError } from '../http/errors.mjs';
import {
  aggregateProfile, analyzeSample, defaultProfile, normalizeText
} from './features.mjs';

export const STYLE_REGISTERS = Object.freeze(['cliente', 'proveedor', 'entidad', 'colega', 'familiar']);
export const MIN_REGISTER_SAMPLES = 10;
export const MAX_REGISTER_SAMPLES = 200;
export const MAX_SAMPLE_CHARS = 8_000;

/** Asegura la forma de `data.style` (idempotente). */
export function ensureStyleData(data) {
  if (!isPlainObject(data.style)) data.style = {};
  const style = data.style;
  if (!isPlainObject(style.samples)) style.samples = {};
  if (!isPlainObject(style.profiles)) style.profiles = {};
  if (!Array.isArray(style.variations)) style.variations = [];
  for (const register of STYLE_REGISTERS) {
    if (!Array.isArray(style.samples[register])) style.samples[register] = [];
  }
  return style;
}

/** Registro válido o error 400. */
export function assertRegister(value, { required = true, field = 'register' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(field, 'REQUIRED', 'register es obligatorio.');
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(field, 'INVALID_TYPE', 'register debe ser texto.');
  const clean = value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!STYLE_REGISTERS.includes(clean)) {
    throw new ValidationError(field, 'INVALID_VALUE', `register debe ser uno de: ${STYLE_REGISTERS.join(', ')}.`);
  }
  return clean;
}

/** Normaliza y valida una muestra de texto. */
export function normalizeSample(value, index = 0) {
  const raw = isPlainObject(value) ? value.text ?? value.body : value;
  if (typeof raw !== 'string') {
    throw new ValidationError(`samples[${index}]`, 'INVALID_TYPE', 'Cada muestra debe ser texto (o {text}).');
  }
  const clean = normalizeText(raw);
  if (clean.length < 20) throw new ValidationError(`samples[${index}]`, 'TOO_SHORT', 'Cada muestra debe tener al menos 20 caracteres.');
  if (clean.length > MAX_SAMPLE_CHARS) throw new ValidationError(`samples[${index}]`, 'TOO_LONG', `Cada muestra admite como máximo ${MAX_SAMPLE_CHARS} caracteres.`);
  return clean;
}

function allSamples(style) {
  const rows = [];
  for (const register of STYLE_REGISTERS) {
    for (const sample of style.samples[register] || []) rows.push({ register, ...sample });
  }
  return rows;
}

/** Análisis por registro (sin persistir). */
export function computeProfiles(data, { now = new Date().toISOString() } = {}) {
  const style = ensureStyleData(data);
  const registers = {};
  for (const register of STYLE_REGISTERS) {
    const samples = style.samples[register] || [];
    const analyses = samples.map((sample) => analyzeSample(sample.text || sample)).filter((row) => row.text);
    registers[register] = {
      register,
      sampleCount: samples.length,
      profile: analyses.length >= MIN_REGISTER_SAMPLES
        ? { ...aggregateProfile(analyses, { register, updatedAt: now }), source: 'register' }
        : null
    };
  }
  const globalAnalyses = allSamples(style).map((sample) => analyzeSample(sample.text)).filter((row) => row.text);
  const globalProfile = globalAnalyses.length
    ? { ...aggregateProfile(globalAnalyses, { register: null, updatedAt: now }), source: 'global' }
    : null;
  return {
    registers,
    global: globalProfile,
    totalSamples: globalAnalyses.length,
    counts: Object.fromEntries(STYLE_REGISTERS.map((register) => [register, (style.samples[register] || []).length]))
  };
}

/**
 * Perfil efectivo para un registro (registro → global → default).
 * @returns {{profile:object, source:'register'|'global'|'default', requestedRegister:string|null, samples:Array<string>}}
 */
export function profileForRegister(data, register, { minSamples = MIN_REGISTER_SAMPLES } = {}) {
  const style = ensureStyleData(data);
  const effectiveRegister = register ? assertRegister(register) : null;
  const requested = effectiveRegister;
  if (effectiveRegister) {
    const samples = (style.samples[effectiveRegister] || []).map((sample) => sample.text).filter(Boolean);
    if (samples.length >= minSamples) {
      const analyses = samples.map((sample) => analyzeSample(sample)).filter((row) => row.text);
      return {
        profile: { ...aggregateProfile(analyses, { register: effectiveRegister }), source: 'register' },
        source: 'register',
        requestedRegister: requested,
        samples
      };
    }
  }
  const globalSamples = allSamples(style).map((sample) => sample.text).filter(Boolean);
  if (globalSamples.length) {
    const analyses = globalSamples.map((sample) => analyzeSample(sample)).filter((row) => row.text);
    return {
      profile: { ...aggregateProfile(analyses, { register: null }), source: 'global' },
      source: 'global',
      requestedRegister: requested,
      samples: globalSamples
    };
  }
  return { profile: defaultProfile(), source: 'default', requestedRegister: requested, samples: [] };
}

/** Resumen público de un perfil (para GET /api/style/profiles). */
export function profileSummary(profile, { source, sampleCount, requestedRegister = null } = {}) {
  if (!profile) return null;
  return {
    register: requestedRegister ?? profile.register ?? null,
    source: source || profile.source || 'default',
    sampleCount: sampleCount ?? profile.sampleCount ?? 0,
    minSamples: MIN_REGISTER_SAMPLES,
    greeting: profile.greeting,
    greetingTemplate: profile.greetingTemplate,
    closing: profile.closing,
    signature: profile.signature,
    sentenceMean: profile.sentenceMean,
    sentenceStd: profile.sentenceStd,
    paragraphs: profile.paragraphs,
    meanWords: profile.meanWords,
    formality: profile.formality,
    emojiRate: profile.emojiRate,
    questionRate: profile.questionRate,
    bulletRate: profile.bulletRate,
    hedges: profile.hedges,
    blacklistHits: profile.blacklistHits,
    updatedAt: profile.updatedAt || null,
    isDefault: profile.isDefault === true
  };
}

/** Estado completo de perfiles (registro, global y default). */
export function styleProfilesSnapshot(data) {
  const computed = computeProfiles(data);
  const items = STYLE_REGISTERS.map((register) => {
    const effective = profileForRegister(data, register);
    return {
      register,
      samples: computed.counts[register] || 0,
      source: effective.source,
      profile: profileSummary(effective.profile, {
        source: effective.source,
        sampleCount: effective.source === 'register' ? computed.counts[register] : computed.totalSamples,
        requestedRegister: register
      })
    };
  });
  return {
    items,
    global: computed.global
      ? profileSummary(computed.global, { source: 'global', sampleCount: computed.totalSamples })
      : profileSummary(defaultProfile(), { source: 'default', sampleCount: 0 }),
    default: profileSummary(defaultProfile(), { source: 'default', sampleCount: 0 }),
    registers: [...STYLE_REGISTERS],
    minSamples: MIN_REGISTER_SAMPLES,
    totalSamples: computed.totalSamples,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Añade muestras a un registro y recalcula perfiles.
 * @param {{register:string, samples:Array<string|{text:string}>}} input
 */
export async function addStyleSamples({ register, samples }) {
  const effectiveRegister = assertRegister(register);
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new ValidationError('samples', 'REQUIRED', 'samples debe ser un array con al menos una muestra.');
  }
  if (samples.length > 50) throw new ValidationError('samples', 'TOO_LONG', 'Máximo 50 muestras por petición.');
  const normalized = samples.map((sample, index) => normalizeSample(sample, index));
  let added = 0;
  let skipped = 0;
  let samplesCount = 0;
  let totalSamples = 0;
  await store.mutate((data) => {
    const style = ensureStyleData(data);
    const rows = style.samples[effectiveRegister];
    const existing = new Set(rows.map((row) => row.text));
    for (const sample of normalized) {
      if (existing.has(sample)) {
        skipped += 1;
        continue;
      }
      if (rows.length >= MAX_REGISTER_SAMPLES) {
        rows.shift();
      }
      rows.push({ text: sample, at: new Date().toISOString() });
      existing.add(sample);
      added += 1;
    }
    const computed = computeProfiles(data);
    style.profiles = {
      global: computed.global || null,
      ...Object.fromEntries(STYLE_REGISTERS.map((name) => [name, computed.registers[name]?.profile || null]))
    };
    style.updatedAt = new Date().toISOString();
    samplesCount = rows.length;
    totalSamples = computed.totalSamples;
  }, { label: `style-samples:${effectiveRegister}` });
  const effective = profileForRegister(store.get(), effectiveRegister);
  return {
    ok: true,
    register: effectiveRegister,
    added,
    skipped,
    samples: samplesCount,
    totalSamples,
    source: effective.source,
    profile: profileSummary(effective.profile, {
      source: effective.source,
      sampleCount: effective.source === 'register' ? samplesCount : totalSamples,
      requestedRegister: effectiveRegister
    })
  };
}

/** Borra las muestras de un registro (y recalcula el global). */
export async function deleteStyleRegister(register) {
  const effectiveRegister = assertRegister(register);
  let deleted = 0;
  let totalSamples = 0;
  await store.mutate((data) => {
    const style = ensureStyleData(data);
    deleted = (style.samples[effectiveRegister] || []).length;
    style.samples[effectiveRegister] = [];
    const computed = computeProfiles(data);
    style.profiles = {
      global: computed.global || null,
      ...Object.fromEntries(STYLE_REGISTERS.map((name) => [name, computed.registers[name]?.profile || null]))
    };
    style.updatedAt = new Date().toISOString();
    totalSamples = computed.totalSamples;
  }, { label: `style-delete:${effectiveRegister}` });
  return { ok: true, register: effectiveRegister, deleted, totalSamples };
}

/** 3 muestras reales del registro (o globales) para el prompt de compose. */
export function samplesForPrompt(data, register, { count = 3, minSamples = MIN_REGISTER_SAMPLES } = {}) {
  const style = ensureStyleData(data);
  const effectiveRegister = register ? assertRegister(register) : null;
  const registerSamples = effectiveRegister ? (style.samples[effectiveRegister] || []).map((sample) => sample.text).filter(Boolean) : [];
  const source = registerSamples.length >= minSamples ? 'register' : 'global';
  const pool = source === 'register' ? registerSamples : allSamples(style).map((sample) => sample.text).filter(Boolean);
  // Determinista: las últimas muestras añadidas (más recientes) primero.
  return { samples: pool.slice(-Math.max(1, count)), source, register: effectiveRegister };
}

/** Variaciones persistidas (para variation.mjs). */
export function ensureVariations(data) {
  const style = ensureStyleData(data);
  if (!Array.isArray(style.variations)) style.variations = [];
  return style.variations;
}

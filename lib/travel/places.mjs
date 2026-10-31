/**
 * Catálogo de lugares para la agenda física.
 *
 * Persistencia: `store.places` (array). Si el store aún no tiene catálogo se
 * usa un catálogo semilla en memoria (Cali, Palmira, Yumbo, aeropuerto…), de
 * modo que el planificador funciona en una instalación nueva sin configurar
 * nada. La primera mutación (POST/PATCH/DELETE) materializa la semilla en el
 * store.
 */

import { nextId } from '../store.mjs';

export class TravelError extends Error {
  constructor(status, code, message, { field, details } = {}) {
    super(message);
    this.name = 'TravelError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

export const PLACE_CATEGORIES = ['ciudad', 'oficina', 'cliente', 'aeropuerto', 'hotel', 'planta', 'bodega', 'otro'];

export const DEFAULT_PLACES = Object.freeze([
  { id: 'PL-0001', name: 'Cali', city: 'Cali', lat: 3.4516, lon: -76.5320, category: 'ciudad', aliases: ['santiago de cali', 'cali valle'], address: 'Cali, Valle del Cauca', notes: 'Sede principal' },
  { id: 'PL-0002', name: 'Palmira', city: 'Palmira', lat: 3.5394, lon: -76.3036, category: 'ciudad', aliases: ['palmira valle'], address: 'Palmira, Valle del Cauca', notes: '' },
  { id: 'PL-0003', name: 'Yumbo', city: 'Yumbo', lat: 3.5847, lon: -76.4967, category: 'ciudad', aliases: ['yumbo industrial'], address: 'Yumbo, Valle del Cauca', notes: 'Zona industrial' },
  { id: 'PL-0004', name: 'Aeropuerto Alfonso Bonilla Aragón', city: 'Palmira', lat: 3.5432, lon: -76.3815, category: 'aeropuerto', aliases: ['aeropuerto cali', 'cll', 'skcl'], address: 'Palmira, Valle del Cauca', notes: 'Aeropuerto internacional' },
  { id: 'PL-0005', name: 'Bogotá', city: 'Bogotá', lat: 4.7110, lon: -74.0721, category: 'ciudad', aliases: ['bogota d.c.', 'santa fe de bogota'], address: 'Bogotá D.C.', notes: '' },
  { id: 'PL-0006', name: 'Medellín', city: 'Medellín', lat: 6.2442, lon: -75.5812, category: 'ciudad', aliases: ['medellin'], address: 'Medellín, Antioquia', notes: '' },
  { id: 'PL-0007', name: 'Buenaventura', city: 'Buenaventura', lat: 3.8801, lon: -77.0319, category: 'ciudad', aliases: ['buenaventura valle'], address: 'Buenaventura, Valle del Cauca', notes: 'Puerto' },
  { id: 'PL-0008', name: 'Candelaria', city: 'Candelaria', lat: 3.4067, lon: -76.3486, category: 'ciudad', aliases: [], address: 'Candelaria, Valle del Cauca', notes: '' },
  { id: 'PL-0009', name: 'Oficina Cali', city: 'Cali', lat: 3.4516, lon: -76.5320, category: 'oficina', aliases: ['oficina', 'sede cali', 'oficina principal'], address: 'Cali, Valle del Cauca', notes: 'Oficina' }
]);

export function cloneDefaultPlaces() {
  return DEFAULT_PLACES.map((place) => ({ ...place, aliases: [...place.aliases] }));
}

/** Devuelve el catálogo sin mutar el store (fallback a la semilla). */
export function placesOf(data) {
  if (Array.isArray(data?.places)) return data.places;
  return cloneDefaultPlaces();
}

/** Materializa `places`/`tasks` en el store. Llamar solo dentro de store.mutate. */
export function ensureTravelState(data) {
  if (!Array.isArray(data.places)) data.places = cloneDefaultPlaces();
  if (!Array.isArray(data.tasks)) data.tasks = [];
  if (!data.travel || typeof data.travel !== 'object') data.travel = {};
  return data;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter(Boolean));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(query, candidate) {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q) || q.startsWith(c)) return 0.92;
  if (c.includes(q) || q.includes(c)) return 0.84;
  const qTokens = tokenSet(q);
  const cTokens = tokenSet(c);
  let shared = 0;
  for (const token of qTokens) if (cTokens.has(token)) shared += 1;
  const overlap = shared / Math.max(1, Math.min(qTokens.size, cTokens.size));
  const distance = levenshtein(q, c);
  const editRatio = 1 - distance / Math.max(q.length, c.length);
  return Math.max(overlap * 0.78, editRatio * 0.9);
}

export function isOnlineLocation(value) {
  if (!value) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  return /(meet\.google\.com|zoom\.(us|com)|teams\.microsoft\.com|webex\.com|whereby\.com|jitsi|google meet|videollamada|virtual|remoto|online)/i.test(text);
}

export function parseCoordinatePair(value) {
  const match = String(value ?? '').match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Resuelve una entrada libre/objeto a un lugar del catálogo o efímero. */
export function resolvePlace(data, input, { threshold = 0.55 } = {}) {
  if (input === undefined || input === null || input === '') return null;
  const places = placesOf(data);
  if (typeof input === 'object') {
    if (input.id) {
      const byId = places.find((place) => String(place.id).toLowerCase() === String(input.id).toLowerCase());
      if (byId) return { place: byId, score: 1, method: 'id' };
    }
    const lat = Number(input.lat ?? input.latitude);
    const lon = Number(input.lon ?? input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return {
        place: {
          id: input.id || null,
          name: input.name || input.place || `${lat.toFixed(4)},${lon.toFixed(4)}`,
          city: input.city || '',
          lat,
          lon,
          category: input.category || 'otro',
          aliases: [],
          ephemeral: true
        },
        score: 1,
        method: 'coordinates'
      };
    }
    const text = input.name || input.place || input.query || input.text;
    if (text) return resolvePlace(data, text, { threshold });
    return null;
  }

  const text = String(input).trim();
  const coords = parseCoordinatePair(text);
  if (coords) return resolvePlace(data, { ...coords, name: text }, { threshold });
  if (isOnlineLocation(text)) return null;

  let best = null;
  for (const place of places) {
    const candidates = [place.name, place.city, ...(Array.isArray(place.aliases) ? place.aliases : [])].filter(Boolean);
    for (const candidate of candidates) {
      const score = similarity(text, candidate);
      if (!best || score > best.score) best = { place, score, matched: candidate, method: 'fuzzy' };
    }
  }
  if (best && best.score >= threshold) return best;
  return null;
}

export function resolvePlaceOrThrow(data, input, { field = 'place' } = {}) {
  const resolved = resolvePlace(data, input);
  if (!resolved) {
    throw new TravelError(404, 'PLACE_NOT_FOUND', `No encontré el lugar «${typeof input === 'string' ? input : JSON.stringify(input)}» en el catálogo`, { field });
  }
  return resolved.place;
}

function numberField(value, field, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TravelError(400, 'VALIDATION', `${field} es requerido`, { field });
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new TravelError(400, 'VALIDATION', `${field} debe estar entre ${min} y ${max}`, { field });
  }
  return number;
}

function textField(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TravelError(400, 'VALIDATION', `${field} es requerido`, { field });
    return undefined;
  }
  if (typeof value !== 'string') throw new TravelError(400, 'VALIDATION', `${field} debe ser texto`, { field });
  const trimmed = value.trim();
  if (required && !trimmed) throw new TravelError(400, 'VALIDATION', `${field} no puede estar vacío`, { field });
  if (trimmed.length > max) throw new TravelError(400, 'VALIDATION', `${field} excede ${max} caracteres`, { field });
  return trimmed;
}

export function validatePlaceInput(input, { partial = false, current = null } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const allowed = new Set(['name', 'city', 'lat', 'lon', 'latitude', 'longitude', 'lng', 'category', 'aliases', 'address', 'notes']);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new TravelError(400, 'UNKNOWN_FIELD', `Campo no permitido: ${key}`, { field: key });
  }
  const out = {};
  if (source.name !== undefined || !partial) out.name = textField(source.name, 'name', { max: 160, required: !partial && !current });
  if (source.city !== undefined) out.city = textField(source.city, 'city', { max: 100 }) || '';
  if (source.category !== undefined) {
    const category = String(source.category).trim().toLowerCase();
    if (!PLACE_CATEGORIES.includes(category)) {
      throw new TravelError(400, 'VALIDATION', `category debe ser ${PLACE_CATEGORIES.join('/')}`, { field: 'category' });
    }
    out.category = category;
  }
  if (source.aliases !== undefined) {
    const aliases = Array.isArray(source.aliases) ? source.aliases : String(source.aliases).split(',');
    out.aliases = aliases.map((alias) => String(alias).trim()).filter(Boolean).slice(0, 20);
  }
  for (const field of ['address', 'notes']) {
    if (source[field] !== undefined) out[field] = textField(source[field], field, { max: field === 'notes' ? 500 : 300 }) || '';
  }
  const lat = numberField(source.lat ?? source.latitude, 'lat', { min: -90, max: 90, required: !partial && !current });
  const lon = numberField(source.lon ?? source.longitude ?? source.lng, 'lon', { min: -180, max: 180, required: !partial && !current });
  if (lat !== undefined) out.lat = lat;
  if (lon !== undefined) out.lon = lon;
  if (partial && !Object.keys(out).length) throw new TravelError(400, 'EMPTY_PATCH', 'No hay campos para actualizar');
  return out;
}

function duplicateName(data, name, city, ignoreId = null) {
  const target = `${normalizeText(name)}|${normalizeText(city || '')}`;
  return placesOf(data).find((place) => String(place.id) !== String(ignoreId)
    && `${normalizeText(place.name)}|${normalizeText(place.city || '')}` === target);
}

export function createPlace(data, input) {
  const fields = validatePlaceInput(input);
  if (duplicateName(data, fields.name, fields.city)) {
    throw new TravelError(409, 'PLACE_EXISTS', `Ya existe «${fields.name}» en ${fields.city || 'el catálogo'}`, { field: 'name' });
  }
  const place = {
    id: nextId('PL', placesOf(data)),
    name: fields.name,
    city: fields.city || '',
    lat: fields.lat,
    lon: fields.lon,
    category: fields.category || 'otro',
    aliases: fields.aliases || [],
    address: fields.address || '',
    notes: fields.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  ensureTravelState(data);
  data.places.push(place);
  return place;
}

export function updatePlace(data, id, input) {
  const place = placesOf(data).find((item) => String(item.id).toLowerCase() === String(id).toLowerCase());
  if (!place) throw new TravelError(404, 'NOT_FOUND', `No encontré el lugar ${id}`, { field: 'id' });
  const fields = validatePlaceInput(input, { partial: true, current: place });
  if ((fields.name !== undefined || fields.city !== undefined)
    && duplicateName(data, fields.name ?? place.name, fields.city ?? place.city, place.id)) {
    throw new TravelError(409, 'PLACE_EXISTS', 'Ya existe un lugar con ese nombre y ciudad', { field: 'name' });
  }
  ensureTravelState(data);
  const stored = data.places.find((item) => String(item.id).toLowerCase() === String(id).toLowerCase()) || place;
  Object.assign(stored, fields, { updatedAt: new Date().toISOString() });
  return stored;
}

export function deletePlace(data, id) {
  ensureTravelState(data);
  const index = data.places.findIndex((item) => String(item.id).toLowerCase() === String(id).toLowerCase());
  if (index < 0) throw new TravelError(404, 'NOT_FOUND', `No encontré el lugar ${id}`, { field: 'id' });
  const [removed] = data.places.splice(index, 1);
  return removed;
}

export function getPlace(data, id) {
  return placesOf(data).find((item) => String(item.id).toLowerCase() === String(id).toLowerCase()) || null;
}

export function listPlaces(data, { q, city, category } = {}) {
  let items = placesOf(data);
  if (q) {
    const query = normalizeText(q);
    items = items.filter((place) => normalizeText([place.name, place.city, ...(place.aliases || []), place.address].join(' ')).includes(query)
      || resolvePlace({ places: items }, q)?.place?.id === place.id);
  }
  if (city) items = items.filter((place) => normalizeText(place.city) === normalizeText(city));
  if (category) items = items.filter((place) => normalizeText(place.category) === normalizeText(category));
  return [...items].sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
}

export function placeLabel(place) {
  if (!place) return '';
  return place.city && normalizeText(place.city) !== normalizeText(place.name) ? `${place.name} (${place.city})` : place.name;
}

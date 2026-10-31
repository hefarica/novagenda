/**
 * Cálculo de tiempo de desplazamiento offline (haversine) con perfiles de
 * velocidad, franja de punta y márgenes configurables. El proveedor externo
 * (Google Distance Matrix) es opcional: si no hay clave, todo funciona local.
 */

import {
  dateKeyOf, minutesOfDayOf, timezoneOf, weekdayCodeOfKey, partsOf
} from '../agenda/time.mjs';

export const TRAVEL_MODES = ['auto', 'urbano', 'mixto', 'carretera'];
export const DEFAULT_TRAVEL_SETTINGS = Object.freeze({
  speeds: { urbano: 22, mixto: 45, carretera: 70 },
  margins: { urbano: 20, mixto: 20, carretera: 35 },
  rushFactor: 1.35,
  rushWindows: [[6.5, 8.5], [11.5, 13.0], [16.5, 18.5]],
  rushWeekdays: ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'],
  autoModes: { urbanoMaxKm: 8, mixtoMaxKm: 35 },
  google: { enabled: true, cacheMinutes: 10, timeoutMs: 8000 }
});

let transport = (url, options) => fetch(url, options);

/** Inyecta un transporte HTTP falso para pruebas de Distance Matrix. */
export function setEtaTransport(fn) {
  transport = typeof fn === 'function' ? fn : ((url, options) => fetch(url, options));
}

export function resetEtaTransport() {
  transport = (url, options) => fetch(url, options);
}

const matrixCache = new Map();

export function clearEtaCache() {
  matrixCache.clear();
}

export function travelSettings(settings = {}) {
  const source = settings?.travel && typeof settings.travel === 'object' ? settings.travel : {};
  const speeds = { ...DEFAULT_TRAVEL_SETTINGS.speeds, ...(source.speeds || {}) };
  const margins = { ...DEFAULT_TRAVEL_SETTINGS.margins, ...(source.margins || {}) };
  return {
    ...DEFAULT_TRAVEL_SETTINGS,
    ...source,
    speeds,
    margins,
    rushWindows: Array.isArray(source.rushWindows) ? source.rushWindows : DEFAULT_TRAVEL_SETTINGS.rushWindows,
    rushWeekdays: Array.isArray(source.rushWeekdays) ? source.rushWeekdays : DEFAULT_TRAVEL_SETTINGS.rushWeekdays,
    autoModes: { ...DEFAULT_TRAVEL_SETTINGS.autoModes, ...(source.autoModes || {}) },
    google: { ...DEFAULT_TRAVEL_SETTINGS.google, ...(source.google || {}) }
  };
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

/** Distancia en kilómetros entre dos coordenadas. */
export function haversineKm(from, to) {
  if (!from || !to) return null;
  const lat1 = Number(from.lat), lon1 = Number(from.lon);
  const lat2 = Number(to.lat), lon2 = Number(to.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const earthKm = 6371.0088;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * earthKm * Math.asin(Math.min(1, Math.sqrt(a))) * 10) / 10;
}

function normalizeCity(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

export function inferTravelMode(fromPlace, toPlace, km, requested = 'auto', config = DEFAULT_TRAVEL_SETTINGS) {
  const requestedMode = String(requested || 'auto').toLowerCase();
  if (['urbano', 'mixto', 'carretera'].includes(requestedMode)) return requestedMode;
  if (Number.isFinite(km) && km <= 0.3) return 'local';
  const fromCity = normalizeCity(fromPlace?.city || fromPlace?.name);
  const toCity = normalizeCity(toPlace?.city || toPlace?.name);
  if (fromCity && toCity && fromCity === toCity) return 'urbano';
  if (!Number.isFinite(km)) return 'mixto';
  const auto = config.autoModes || DEFAULT_TRAVEL_SETTINGS.autoModes;
  if (km <= Number(auto.urbanoMaxKm || 8)) return 'urbano';
  if (km <= Number(auto.mixtoMaxKm || 35)) return 'mixto';
  return 'carretera';
}

function hourValueToMinutes(value) {
  if (typeof value === 'string' && value.includes(':')) {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + (minute || 0);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number * 60 : NaN;
}

/** Factor de punta para un instante local según settings.travel. */
export function rushInfoAt(date, settings = {}) {
  const config = travelSettings(settings);
  const tz = timezoneOf(settings);
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return { rush: false, factor: 1, window: null };
  const key = dateKeyOf(parsed, tz);
  const weekday = weekdayCodeOfKey(key);
  if (!config.rushWeekdays.map((day) => String(day).toUpperCase()).includes(weekday)) {
    return { rush: false, factor: 1, window: null, weekday };
  }
  const minutes = minutesOfDayOf(parsed, tz);
  for (const window of config.rushWindows) {
    const start = hourValueToMinutes(window?.[0]);
    const end = hourValueToMinutes(window?.[1]);
    if (Number.isFinite(start) && Number.isFinite(end) && minutes >= start && minutes < end) {
      return {
        rush: true,
        factor: Math.max(1, Number(config.rushFactor) || 1.35),
        window: [window[0], window[1]],
        weekday
      };
    }
  }
  return { rush: false, factor: 1, window: null, weekday };
}

/** Zona horaria local de un instante (para respuestas). */
export function localTimeOf(date, settings = {}) {
  return partsOf(date, timezoneOf(settings));
}

function googleKey(settings = {}) {
  const config = travelSettings(settings);
  return process.env.GOOGLE_DISTANCE_MATRIX_KEY
    || process.env.GOOGLE_MAPS_API_KEY
    || config.google?.apiKey
    || null;
}

async function distanceMatrixEstimate({ from, to, departAt, settings, config }) {
  if (config.google?.enabled === false) return null;
  const key = googleKey(settings);
  if (!key) return null;
  if (!from || !to || !Number.isFinite(Number(from.lat)) || !Number.isFinite(Number(to.lat))) return null;
  const origin = `${from.lat},${from.lon}`;
  const destination = `${to.lat},${to.lon}`;
  const when = new Date(departAt);
  const cacheKey = `${origin}|${destination}|${Number.isFinite(when.getTime()) ? Math.floor(when.getTime() / 600000) : 0}|${config.google?.traffic === false ? 'notraffic' : 'traffic'}`;
  const cached = matrixCache.get(cacheKey);
  if (cached && Date.now() - cached.at < (Number(config.google?.cacheMinutes) || 10) * 60000) return cached.value;
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', origin);
  url.searchParams.set('destinations', destination);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('language', 'es');
  url.searchParams.set('key', key);
  if (Number.isFinite(when.getTime()) && when.getTime() > Date.now()) {
    url.searchParams.set('departure_time', String(Math.floor(when.getTime() / 1000)));
    if (config.google?.traffic !== false) url.searchParams.set('traffic_model', 'best_guess');
  }
  try {
    const response = await transport(url.toString(), { signal: AbortSignal.timeout(Number(config.google?.timeoutMs) || 8000) });
    const json = await response.json();
    if (!response.ok || json.status !== 'OK') return null;
    const element = json.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') return null;
    const seconds = element.duration_in_traffic?.value || element.duration?.value;
    const meters = element.distance?.value;
    if (!Number.isFinite(seconds)) return null;
    const value = {
      km: Number.isFinite(meters) ? Math.round(meters / 100) / 10 : haversineKm(from, to),
      etaMin: Math.max(1, Math.ceil(seconds / 60)),
      source: 'google'
    };
    matrixCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/**
 * Estima el desplazamiento.
 * @param {{from:object,to:object,departAt?:string|Date,mode?:string,gapMin?:number,settings?:object,marginMin?:number,speedKmh?:number,useGoogle?:boolean}} options
 */
export async function estimateTravel({
  from, to, departAt, mode = 'auto', gapMin, settings = {}, marginMin, speedKmh, useGoogle = true
} = {}) {
  const config = travelSettings(settings);
  const km = from && to ? haversineKm(from, to) : null;
  if (!Number.isFinite(km) || km <= 0.3) {
    return {
      km: Number.isFinite(km) ? km : 0,
      etaMin: 0,
      marginMin: 0,
      totalMin: 0,
      feasible: gapMin === undefined ? true : Number(gapMin) >= 0,
      mode: 'local',
      speedKmh: 0,
      rush: false,
      rushFactor: 1,
      source: 'local',
      departAt: departAt ? new Date(departAt).toISOString() : null
    };
  }

  const resolvedMode = inferTravelMode(from, to, km, mode, config);
  const effectiveMode = resolvedMode === 'local' ? 'urbano' : resolvedMode;
  const rush = departAt ? rushInfoAt(departAt, settings) : { rush: false, factor: 1 };
  let baseKm = km;
  let baseEta = Math.ceil((baseKm / Math.max(1, Number(config.speeds[effectiveMode]) || 45)) * 60);
  let source = 'offline';
  let googleMinutes = null;
  if (useGoogle) {
    const google = await distanceMatrixEstimate({ from, to, departAt: departAt || new Date(), settings, config });
    if (google && Number.isFinite(google.etaMin)) {
      baseKm = google.km ?? baseKm;
      googleMinutes = google.etaMin;
      source = 'google';
    }
  }
  const etaMin = googleMinutes !== null
    ? Math.max(1, Math.ceil(googleMinutes * rush.factor))
    : Math.max(1, Math.ceil(baseEta * rush.factor));
  const margin = marginMin !== undefined
    ? Math.max(0, Math.round(Number(marginMin) || 0))
    : Math.max(0, Math.round(Number(config.margins[effectiveMode] ?? 20)));
  const totalMin = etaMin + margin;
  const gap = gapMin === undefined ? undefined : Number(gapMin);
  return {
    km: Math.round(baseKm * 10) / 10,
    etaMin,
    marginMin: margin,
    totalMin,
    feasible: gap === undefined ? true : Number.isFinite(gap) ? gap >= totalMin : null,
    gapMin: Number.isFinite(gap) ? Math.round(gap) : null,
    mode: effectiveMode,
    speedKmh: speedKmh !== undefined ? Number(speedKmh) : Number(config.speeds[effectiveMode]) || 45,
    rush: rush.rush,
    rushFactor: rush.factor,
    rushWindow: rush.window || null,
    source,
    departAt: departAt ? new Date(departAt).toISOString() : null,
    formula: source === 'google'
      ? 'eta = duration_in_traffic (Distance Matrix) × factorPunta; total = eta + margen'
      : 'km = haversine; eta = ceil(km / velocidad × 60 × factorPunta); total = eta + margen'
  };
}

export function formatTravelSummary(estimate, { fromLabel, toLabel } = {}) {
  if (!estimate) return '';
  const parts = [];
  if (fromLabel || toLabel) parts.push(`${fromLabel || 'origen'} → ${toLabel || 'destino'}`);
  parts.push(`${estimate.km} km`);
  parts.push(`${estimate.etaMin} min de viaje${estimate.rush ? ' (punta)' : ''}`);
  parts.push(`margen ${estimate.marginMin} min`);
  parts.push(`${estimate.totalMin} min total`);
  return parts.join(' · ');
}

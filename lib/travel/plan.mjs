/**
 * Planificador de agenda física.
 *
 * Regla dura: si no se llega, el plan devuelve `feasible:false` y alternativas
 * reales (hora mínima, hora con holgura y primer hueco libre de la semana).
 * Nunca muta la agenda; la integración con eventos solo advierte.
 */

import {
  addDaysKey, dateKeyOfIso, formatDateLong, formatTime, isWorkingDay, isoAtLocal, isoLocalOf,
  isValidDateKey, isValidIso, minutesBetween, parseHHMM, timezoneOf
} from '../agenda/time.mjs';
import { placesOf, resolvePlace, placeLabel, isOnlineLocation, TravelError } from './places.mjs';
import { estimateTravel, travelSettings } from './eta.mjs';

function parseInstant(value, field = 'fecha', tz = undefined) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TravelError(400, 'INVALID_DATE', `${field} no es una fecha válida`, { field });
    return value.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new TravelError(400, 'INVALID_DATE', `${field} es requerido (ISO o YYYY-MM-DD HH:MM)`, { field });
  }
  const raw = value.trim();
  if (isValidIso(raw)) return new Date(raw).toISOString();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (local && isValidDateKey(local[1])) {
    const hhmm = `${String(local[2]).padStart(2, '0')}:${local[3]}`;
    return isoAtLocal(local[1], hhmm, tz);
  }
  if (isValidDateKey(raw)) return isoAtLocal(raw, '09:00', tz);
  throw new TravelError(400, 'INVALID_DATE', `${field} no es una fecha válida`, { field });
}

function ceilToStep(date, stepMin) {
  const step = Math.max(1, Number(stepMin) || 5) * 60000;
  return new Date(Math.ceil(new Date(date).getTime() / step) * step);
}

function overlapping(events, startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  return events.some((event) => {
    if (!event || event.status === 'Cancelada') return false;
    const eventStart = new Date(event.start).getTime();
    const eventEnd = new Date(event.end).getTime();
    if (![eventStart, eventEnd].every(Number.isFinite)) return false;
    return eventStart < end && eventEnd > start;
  });
}

function eventsOnDate(data, dateKey, tz) {
  return (data?.agenda || []).filter((event) => event
    && event.status !== 'Cancelada'
    && dateKeyOfIso(event.start, tz) === dateKey
    && isValidIso(event.start) && isValidIso(event.end));
}

function nextFreeSameDay(data, at, { durationMin, fromAt, totalMin, tz, settings, maxIterations = 40 }) {
  let cursor = new Date(at);
  const dayKey = dateKeyOfIso(cursor.toISOString(), tz);
  const dayEnd = isoAtLocal(dayKey, '23:00', tz);
  const events = eventsOnDate(data, dayKey, tz);
  for (let i = 0; i < maxIterations; i++) {
    const end = new Date(cursor.getTime() + durationMin * 60000);
    const gap = minutesBetween(fromAt, cursor.toISOString());
    if (cursor.getTime() + durationMin * 60000 <= new Date(dayEnd).getTime()
      && gap >= totalMin
      && !overlapping(events, cursor.toISOString(), end.toISOString())) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 30 * 60000);
  }
  return null;
}

/**
 * Busca el primer hueco libre en los próximos días hábiles.
 * @returns {Promise<{at:string, why:string, date:string}|null>}
 */
async function firstGapOfWeek(data, { fromAt, totalMin, durationMin = 60, settings = {}, horizonDays = 7 } = {}) {
  const tz = timezoneOf(settings);
  const fromKey = dateKeyOfIso(fromAt, tz);
  const now = new Date(fromAt).getTime();
  for (let offset = 1; offset <= Math.max(1, horizonDays); offset++) {
    const key = addDaysKey(fromKey, offset);
    if (!isWorkingDay(key, settings)) continue;
    const events = eventsOnDate(data, key, tz);
    for (let minutes = 9 * 60; minutes <= 17 * 60; minutes += 30) {
      const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const at = isoAtLocal(key, hhmm);
      if (new Date(at).getTime() <= now) continue;
      if (minutesBetween(fromAt, at) < totalMin) continue;
      const end = new Date(new Date(at).getTime() + durationMin * 60000).toISOString();
      if (!overlapping(events, at, end)) {
        return { at, why: `Primer hueco libre: ${formatDateLong(key, tz)} a las ${hhmm}`, date: key };
      }
    }
  }
  return null;
}

/**
 * Construye alternativas válidas para una llegada imposible.
 * La primera es la hora mínima; la segunda añade 30 min de holgura; la tercera
 * es el primer hueco libre de la semana.
 */
async function buildAlternatives(data, {
  from, to, fromAt, toAt, totalMin, durationMin = 60, settings = {}, mode = 'auto', horizonDays = 7
}) {
  const tz = timezoneOf(settings);
  const earliest = new Date(new Date(fromAt).getTime() + totalMin * 60000);
  const candidates = [];
  const seen = new Set();
  const push = (candidate) => {
    const epoch = new Date(candidate.at).getTime();
    if (seen.has(epoch)) return;
    seen.add(epoch);
    candidates.push(candidate);
  };

  const minimum = ceilToStep(earliest, 5);
  const freeMinimum = nextFreeSameDay(data, minimum, { durationMin, fromAt, totalMin, tz, settings })
    || (minimum.getTime() > new Date(toAt).getTime() ? minimum : null);
  if (freeMinimum) {
    push({
      at: isoLocalOf(freeMinimum, tz),
      date: dateKeyOfIso(freeMinimum.toISOString(), tz),
      why: `Hora mínima viable: ${formatTime(fromAt, tz)} + ${totalMin} min de viaje y margen`,
      kind: 'minimum',
      departureAt: isoLocalOf(new Date(freeMinimum.getTime() - totalMin * 60000), tz),
      gapMin: minutesBetween(fromAt, freeMinimum.toISOString())
    });
  }

  const comfortableBase = freeMinimum || minimum;
  const comfortable = ceilToStep(new Date(comfortableBase.getTime() + 30 * 60000), 30);
  const freeComfortable = nextFreeSameDay(data, comfortable, { durationMin, fromAt, totalMin, tz, settings })
    || (comfortable.getTime() > new Date(toAt).getTime() ? comfortable : null);
  if (freeComfortable) {
    push({
      at: isoLocalOf(freeComfortable, tz),
      date: dateKeyOfIso(freeComfortable.toISOString(), tz),
      why: 'Opción con 30 min de holgura sobre la hora mínima',
      kind: 'comfortable',
      departureAt: isoLocalOf(new Date(freeComfortable.getTime() - totalMin * 60000), tz),
      gapMin: minutesBetween(fromAt, freeComfortable.toISOString())
    });
  }

  const nextGap = await firstGapOfWeek(data, { fromAt, totalMin, durationMin, settings, horizonDays });
  if (nextGap) {
    push({
      at: nextGap.at,
      date: nextGap.date,
      why: `${nextGap.why} (sin choques de agenda)`,
      kind: 'next-gap',
      departureAt: isoLocalOf(new Date(new Date(nextGap.at).getTime() - totalMin * 60000), tz),
      gapMin: minutesBetween(fromAt, nextGap.at)
    });
  }

  // Garantía: si por datos corruptos no hubo huecos, al menos una fecha nueva
  // del siguiente día hábil (nunca dejamos al usuario sin salida).
  if (candidates.length < 2) {
    let key = addDaysKey(dateKeyOfIso(fromAt, tz), 1);
    for (let i = 0; i < 7 && !isWorkingDay(key, settings); i++) key = addDaysKey(key, 1);
    const at = isoAtLocal(key, '09:00', tz);
    push({
      at,
      date: key,
      why: `Siguiente día hábil a las 09:00 (${formatDateLong(key, tz)})`,
      kind: 'next-day',
      departureAt: isoLocalOf(new Date(new Date(at).getTime() - totalMin * 60000), tz),
      gapMin: minutesBetween(fromAt, at)
    });
  }
  // Valida que ninguna alternativa sea en el pasado ni incumpla el viaje.
  return candidates.filter((item) => {
    const gap = minutesBetween(fromAt, item.at);
    return Number.isFinite(gap) && gap >= totalMin && gap > 0;
  }).slice(0, 3);
}

/**
 * POST /api/travel/plan.
 * @param {{data:object, settings?:object, fromPlace:*, fromAt:*, toPlace:*, toAt:*, mode?:string, durationMin?:number, horizonDays?:number, now?:string}} options
 */
export async function planTravel({
  data, settings = data?.settings || {}, fromPlace, fromAt, toPlace, toAt,
  mode = 'auto', durationMin = 60, horizonDays = 7
} = {}) {
  const from = resolvePlace(data, fromPlace);
  const to = resolvePlace(data, toPlace);
  if (!from) {
    throw new TravelError(404, 'PLACE_NOT_FOUND', `No encontré el lugar de origen «${typeof fromPlace === 'string' ? fromPlace : JSON.stringify(fromPlace)}»`, { field: 'fromPlace' });
  }
  if (!to) {
    throw new TravelError(404, 'PLACE_NOT_FOUND', `No encontré el lugar de destino «${typeof toPlace === 'string' ? toPlace : JSON.stringify(toPlace)}»`, { field: 'toPlace' });
  }
  const departureAt = parseInstant(fromAt, 'fromAt', timezoneOf(settings));
  const arrivalAt = parseInstant(toAt, 'toAt', timezoneOf(settings));
  const gapMin = minutesBetween(departureAt, arrivalAt);
  if (!Number.isFinite(gapMin)) throw new TravelError(400, 'INVALID_DATE', 'No pude calcular la diferencia entre fromAt y toAt', { field: 'toAt' });
  const config = travelSettings(settings);
  const estimate = await estimateTravel({
    from: from.place, to: to.place, departAt: departureAt, mode, gapMin, settings,
    useGoogle: config.google?.enabled !== false
  });
  const feasible = estimate.feasible !== false;
  const alternatives = feasible ? [] : await buildAlternatives(data, {
    from: from.place, to: to.place, fromAt: departureAt, toAt: arrivalAt,
    totalMin: estimate.totalMin, durationMin, settings, mode, horizonDays
  });
  const warning = feasible ? null
    : `No llegas: ${placeLabel(from.place)} → ${placeLabel(to.place)} requiere ${estimate.totalMin} min (${estimate.etaMin} de viaje + ${estimate.marginMin} de margen) y solo hay ${Math.max(0, gapMin)} min.`;
  return {
    feasible,
    km: estimate.km,
    etaMin: estimate.etaMin,
    marginMin: estimate.marginMin,
    totalMin: estimate.totalMin,
    gapMin: Math.max(0, gapMin),
    from: { ...from.place, label: placeLabel(from.place) },
    to: { ...to.place, label: placeLabel(to.place) },
    mode: estimate.mode,
    rush: estimate.rush,
    rushFactor: estimate.rushFactor,
    departureAt,
    arrivalAt,
    requestedArrivalAt: arrivalAt,
    source: estimate.source,
    formula: estimate.formula,
    warning,
    alternatives,
    durationMin,
    horizonDays
  };
}

function previousEventBefore(data, event, tz) {
  const eventStart = new Date(event.start).getTime();
  const candidates = (data?.agenda || [])
    .filter((candidate) => candidate
      && candidate.id !== event.id
      && candidate.status !== 'Cancelada'
      && candidate.location
      && !isOnlineLocation(candidate.location)
      && isValidIso(candidate.end)
      && new Date(candidate.end).getTime() <= eventStart
      && eventStart - new Date(candidate.end).getTime() <= 36 * 3600000)
    .sort((a, b) => new Date(b.end) - new Date(a.end));
  for (const candidate of candidates) {
    const resolved = resolvePlace(data, candidate.location);
    if (resolved) return { event: candidate, place: resolved.place };
  }
  return null;
}

/**
 * Factibilidad de viaje de un evento respecto al evento anterior con lugar.
 * No lanza por datos incompletos: devuelve `{resolved:false, feasible:null}`.
 */
export async function computeEventTravel({ data, settings = data?.settings || {}, event } = {}) {
  if (!event) return null;
  const location = String(event.location || '').trim();
  if (!location) return { resolved: false, online: false, feasible: true, warning: null, reason: 'sin ubicación' };
  if (isOnlineLocation(location)) {
    return { resolved: false, online: true, feasible: true, warning: null, reason: 'reunión en línea', location };
  }
  const destination = resolvePlace(data, location);
  if (!destination) {
    return { resolved: false, online: false, feasible: null, warning: null, reason: 'lugar no encontrado en el catálogo', location };
  }
  const tz = timezoneOf(settings);
  const previous = previousEventBefore(data, event, tz);
  const configuredOrigin = settings?.travel?.defaultOriginPlace
    ? resolvePlace(data, settings.travel.defaultOriginPlace)
    : null;
  const origin = previous?.place || configuredOrigin?.place || null;
  if (!origin) {
    return {
      resolved: true,
      online: false,
      feasible: true,
      warning: null,
      reason: 'sin evento previo con lugar',
      location,
      toPlace: { ...destination.place, label: placeLabel(destination.place) },
      fromPlace: null
    };
  }
  const config = travelSettings(settings);
  const gapMin = minutesBetween(previous?.event?.end || event.start, event.start);
  const estimate = await estimateTravel({
    from: origin, to: destination.place,
    departAt: previous?.event?.end || event.start,
    mode: event.travelMode || 'auto',
    gapMin,
    settings,
    useGoogle: config.google?.enabled !== false
  });
  let alternatives = [];
  if (estimate.feasible === false) {
    alternatives = await buildAlternatives(data, {
      from: origin, to: destination.place,
      fromAt: previous?.event?.end || event.start,
      toAt: event.start,
      totalMin: estimate.totalMin,
      durationMin: Math.max(5, Number(event.plannedMin) || 60),
      settings,
      mode: event.travelMode || 'auto'
    });
  }
  const warning = estimate.feasible === false
    ? `No llegas a ${placeLabel(destination.place)}: salida ${origin.name} a las ${formatTime(previous?.event?.end || event.start, tz)}, viaje ${estimate.etaMin} + margen ${estimate.marginMin} = ${estimate.totalMin} min y solo hay ${Math.max(0, gapMin)} min.`
    : null;
  return {
    resolved: true,
    online: false,
    feasible: estimate.feasible !== false,
    warning,
    location,
    fromPlace: { ...origin, label: placeLabel(origin) },
    toPlace: { ...destination.place, label: placeLabel(destination.place) },
    previousEventId: previous?.event?.id || null,
    previousEventTitle: previous?.event?.title || null,
    km: estimate.km,
    etaMin: estimate.etaMin,
    marginMin: estimate.marginMin,
    totalMin: estimate.totalMin,
    gapMin: Math.max(0, gapMin),
    mode: estimate.mode,
    rush: estimate.rush,
    rushFactor: estimate.rushFactor,
    source: estimate.source,
    alternatives,
    durationMin: Math.max(5, Number(event.plannedMin) || 60)
  };
}

export { parseInstant, buildAlternatives, placesOf };

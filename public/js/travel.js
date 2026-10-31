/**
 * Agenda física: lugares, planificador con tráfico y alternativas, viaje de una
 * cita y generación de Meet.
 */
import { api, formatError } from './api.js';
import { state } from './state.js';
import { loadTravel as fetchTravel, capability } from './data.js';
import { $, $$, esc, toast, setBusy, emptyState, unavailableState, promptDialog, confirmDialog, fmtDateTime, toZonedInput, openDialog } from './core.js';

let initialized = false;
const MODES = { auto: 'Automático', urbano: 'Urbano', mixto: 'Mixto', carretera: 'Carretera' };

export function initTravel() {
  if (initialized) return;
  initialized = true;

  $('#travelPlanForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await planRequest();
  });

  $('#travelPlaceNew')?.addEventListener('click', addPlace);

  $('#travelPlaces')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-place-act]');
    if (!button) return;
    if (button.dataset.placeAct === 'delete') await deletePlace(button.dataset.id);
    else if (button.dataset.placeAct === 'use') {
      const place = state.travel.places.find((item) => item.id === button.dataset.id);
      if (place) {
        const form = $('#travelPlanForm');
        if (form) form.elements.to.value = place.name;
        toast(`Destino: ${place.name}`, 'ok');
      }
    }
  });
}

export async function refreshTravel() {
  const result = await fetchTravel({ force: true }).catch(() => ({ ok: false }));
  renderTravel();
  return result;
}

export function renderTravel() {
  const box = $('#travelPlaces');
  if (!box) return;
  if (!capability('travel')) {
    box.innerHTML = unavailableState({ title: 'Viajes no disponible en este servidor', detail: 'El módulo de viajes no está montado.' });
    return;
  }
  fillPlaceDatalist();
  const places = state.travel.places || [];
  if (!places.length) {
    box.innerHTML = emptyState('No hay lugares guardados. Añade tu oficina, casa o clientes frecuentes.', '⌖');
    return;
  }
  box.innerHTML = places.map((place) => `
    <div class="place-row">
      <div>
        <b>${esc(place.name)}</b>
        <small>${esc([place.city, place.address].filter(Boolean).join(' · ') || 'sin dirección')}${place.category ? ` · ${esc(place.category)}` : ''}</small>
      </div>
      <div class="doc-actions">
        <button type="button" data-place-act="use" data-id="${esc(place.id)}">Usar</button>
        <button type="button" data-place-act="delete" data-id="${esc(place.id)}">Quitar</button>
      </div>
    </div>`).join('');
}

export function fillPlaceDatalist() {
  const list = $('#eventPlaceList');
  if (!list) return;
  list.innerHTML = (state.travel.places || []).map((place) => `<option value="${esc(place.name)}">${esc(place.city || '')}</option>`).join('');
}

async function addPlace() {
  const name = await promptDialog({ title: 'Nuevo lugar', text: 'Nombre del lugar (oficina, cliente, aeropuerto…).', label: 'Nombre', value: '' });
  if (!name || !String(name).trim()) return;
  const city = await promptDialog({ title: 'Ciudad', text: 'Ciudad del lugar (opcional).', label: 'Ciudad', value: '' });
  if (city === null) return;
  const address = await promptDialog({ title: 'Dirección', text: 'Dirección (opcional).', label: 'Dirección', value: '' });
  if (address === null) return;
  const coords = await promptDialog({
    title: 'Coordenadas',
    text: 'Escribe latitud,longitud (por ejemplo 3.4516,-76.5320). Se usan para calcular distancias sin Google.',
    label: 'lat,lon',
    value: '3.4516,-76.5320'
  });
  if (coords === null) return;
  const [latRaw, lonRaw] = String(coords).split(/[,;]+/);
  const lat = Number(String(latRaw || '').trim());
  const lon = Number(String(lonRaw || '').trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    toast('Coordenadas inválidas: usa latitud,longitud.', 'err');
    return;
  }
  try {
    await api.post('/api/travel/places', {
      name: String(name).trim(), city: String(city).trim() || '', address: String(address).trim() || '', lat, lon
    });
    toast('Lugar guardado', 'ok');
    await refreshTravel();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

async function deletePlace(id) {
  const ok = await confirmDialog({ title: 'Quitar lugar', text: 'El lugar dejará de estar disponible para planificar viajes.', okLabel: 'Quitar', danger: true });
  if (!ok) return;
  try {
    await api.del(`/api/travel/places/${encodeURIComponent(id)}`);
    toast('Lugar eliminado', 'ok');
    await refreshTravel();
  } catch (error) {
    toast(formatError(error), 'err');
  }
}

function localToIso(value) {
  if (!value) return undefined;
  const date = new Date(`${value}:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function planRequest() {
  const form = $('#travelPlanForm');
  const box = $('#travelPlanResult');
  if (!form || !box) return;
  const from = form.elements.from.value.trim();
  const to = form.elements.to.value.trim();
  if (!from || !to) { box.innerHTML = '<p class="hint bad">Indica origen y destino.</p>'; return; }
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Calculando');
  box.innerHTML = '<div class="loading"><span class="spin" aria-hidden="true"></span> Calculando ruta…</div>';
  try {
    const body = {
      fromPlace: from,
      toPlace: to,
      durationMin: Number(form.elements.durationMin.value) || 60
    };
    const fromAt = localToIso(form.elements.fromAt.value);
    const toAt = localToIso(form.elements.toAt.value);
    if (fromAt) body.fromAt = fromAt;
    if (toAt) body.toAt = toAt;
    const plan = await api.post('/api/travel/plan', body);
    state.travel.plan = plan;
    box.innerHTML = planHTML(plan);
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
  } finally {
    setBusy(button, false);
  }
}

export function planHTML(plan, { compact = false } = {}) {
  if (!plan) return '<p class="hint">Sin datos del viaje.</p>';
  const feasible = plan.feasible !== false;
  const facts = [
    plan.km != null ? `${Number(plan.km).toFixed(1)} km` : '',
    plan.etaMin != null ? `${plan.etaMin} min de viaje` : '',
    plan.marginMin != null ? `+${plan.marginMin} min de margen` : '',
    plan.totalMin != null ? `${plan.totalMin} min en total` : '',
    plan.gapMin != null ? `hueco ${plan.gapMin} min` : '',
    plan.mode ? `modo ${MODES[plan.mode] || plan.mode}` : '',
    plan.rush ? 'hora punta' : ''
  ].filter(Boolean);
  const alternatives = Array.isArray(plan.alternatives) ? plan.alternatives : [];
  return `
    <div class="travel-verdict ${feasible ? 'ok' : 'bad'}">
      <span aria-hidden="true">${feasible ? '✅' : '⚠️'}</span>
      <span>${feasible ? 'Llegas a tiempo' : 'No llegas a tiempo'}</span>
    </div>
    ${plan.warning ? `<p class="hint warn">${esc(plan.warning)}</p>` : ''}
    <div class="travel-facts">${facts.map((fact) => `<span>${esc(fact)}</span>`).join('')}</div>
    ${plan.departureAt ? `<p class="muted small">Salida ${esc(fmtDateTime(plan.departureAt))}${plan.arrivalAt ? ` · llegada ${esc(fmtDateTime(plan.arrivalAt))}` : ''}${plan.to?.label ? ` · destino ${esc(plan.to.label)}` : ''}</p>` : ''}
    ${alternatives.length && !feasible ? `<div class="travel-alternatives">
      <b>Alternativas reales</b>
      ${alternatives.slice(0, compact ? 2 : 4).map((alt) => `<div class="travel-alt"><span>${esc(alt.label || fmtDateTime(alt.at))}</span><span>${esc(alt.reason || 'hueco libre')}</span></div>`).join('')}
    </div>` : ''}`;
}

export async function checkEventTravel(eventId) {
  const box = $('#eventTravelInfo');
  if (!box || !eventId) return null;
  box.innerHTML = '<div class="loading"><span class="spin" aria-hidden="true"></span> Comprobando viaje…</div>';
  try {
    const result = await api.get(`/api/agenda/${encodeURIComponent(eventId)}/travel`);
    box.innerHTML = result?.travel ? planHTML(result.travel) : '<p class="hint">Esta cita no tiene lugar o no hay datos de viaje.</p>';
    if (result?.warning) toast(result.warning, 'warn');
    return result;
  } catch (error) {
    box.innerHTML = `<p class="hint bad">${esc(formatError(error))}</p>`;
    return null;
  }
}

export async function generateMeet(eventId) {
  const info = $('#eventMeetInfo');
  if (!eventId) {
    if (info) info.textContent = 'Guarda la cita primero para generar el Meet.';
    return null;
  }
  if (info) info.textContent = 'Generando sala…';
  try {
    const result = await api.post(`/api/agenda/${encodeURIComponent(eventId)}/meet`, {});
    const link = result?.meetLink || result?.meet?.meetLink || '';
    const jitsi = result?.provider === 'jitsi' || result?.fallback === true;
    const label = jitsi ? 'Sala Jitsi (Google Meet no conectado)' : 'Meet en Google';
    if (info) {
      info.innerHTML = link
        ? `${label}: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>${result.note ? ` · ${esc(result.note)}` : ''}`
        : 'No se pudo crear la sala.';
    }
    toast(jitsi ? 'Sala Jitsi creada · conecta Google para un Meet real' : 'Meet creado en Google', 'ok');
    return result;
  } catch (error) {
    if (info) info.textContent = formatError(error);
    toast(formatError(error), 'err');
    return null;
  }
}

/** Rellena el diálogo de cita con el viaje guardado del evento. */
export function fillEventTravel(event) {
  const box = $('#eventTravelBox');
  const info = $('#eventTravelInfo');
  const meet = $('#eventMeetInfo');
  if (!box) return;
  const hasLocation = Boolean(event?.location) || Boolean(event?.placeId);
  box.hidden = !event || (!hasLocation && !event?.meet?.meetLink);
  if (info) {
    if (event?.travel?.feasible === false) info.innerHTML = planHTML(event.travel, { compact: true });
    else if (event?.travel?.feasible === true) info.innerHTML = planHTML(event.travel, { compact: true });
    else info.innerHTML = '';
  }
  if (meet) {
    meet.innerHTML = event?.meet?.meetLink
      ? `Meet: <a href="${esc(event.meet.meetLink)}" target="_blank" rel="noopener">${esc(event.meet.meetLink)}</a>`
      : '';
  }
}

/** Datos de lugares para el diálogo de cita. */
export function placeOptions() {
  return (state.travel.places || []).map((place) => ({ id: place.id, name: place.name, city: place.city || '' }));
}

export function travelModeOptions() {
  return Object.entries(MODES).map(([value, label]) => ({ value, label }));
}


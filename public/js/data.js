/**
 * Carga de datos: bootstrap + endpoints del contrato, con degradación explícita
 * cuando un módulo (LLM, canales, workflows, señales) todavía no existe.
 */
import { api, probeEndpoint, endpointState } from './api.js';
import { state, setBoot, emit } from './state.js';
import { setDisplayTimezone, todayKey, addDaysKey } from './core.js';

export const ENDPOINTS = {
  p95: '/api/p95',
  routines: '/api/routines',
  occurrences: '/api/routines/occurrences',
  agentActions: '/api/agent/actions?limit=30',
  signals: '/api/signals?limit=50',
  workflows: '/api/workflows',
  llm: '/api/llm/status',
  channels: '/api/channels',
  health: '/api/health',
  metrics: '/api/metrics?days=30',
  officeRoster: '/api/office/roster',
  officeStatus: '/api/office/status',
  officeProposals: '/api/office/proposals?limit=50',
  officeMode: '/api/office/mode',
  officeLedger: '/api/office/ledger?limit=60',
  docs: '/api/docs?limit=60',
  docsTemplates: '/api/docs/templates',
  styleProfiles: '/api/style/profiles',
  nudgesConfig: '/api/nudges/config',
  nudgesFeed: '/api/nudges/feed?limit=25',
  nudgesStatus: '/api/nudges/status',
  travelPlaces: '/api/travel/places',
  approvalsStatus: '/api/channels/approvals/status',
  identityPeople: '/api/identity/people?limit=50'
};

export async function loadBootstrap() {
  const boot = await api.get('/api/bootstrap');
  setBoot(boot);
  setDisplayTimezone(state.timezone);
  state.authRequired = Boolean(boot?.auth?.required);
  emit('bootstrap', boot);
  return boot;
}

export async function loadHealth() {
  const result = await probeEndpoint('health', ENDPOINTS.health);
  if (result.ok) {
    state.health = result.data;
    state.capabilities = deriveCapabilities(result.data);
  }
  return result;
}

/**
 * Deduce qué módulos opcionales están montados a partir de /api/health.
 * Evita sondear endpoints inexistentes (y los 404 en consola que conllevan).
 * `null` significa "no se pudo saber": en ese caso se prueba de verdad.
 */
export function deriveCapabilities(health) {
  const modules = Array.isArray(health?.modules) ? health.modules : null;
  if (!modules) return null;
  const has = (pattern) => modules.some((module) => module && module.ok !== false && pattern.test(`${module.name || ''} ${module.file || ''}`));
  return {
    llm: has(/(^|\s)llm(\s|\.|$)/i),
    agent: has(/(^|\s)llm(\s|\.|$)/i),
    channels: has(/channels/i),
    workflows: has(/workflow|automat|scheduler|automation/i),
    signals: has(/signal|webhook|workflow|automat|scheduler/i),
    office: has(/office/i),
    docs: has(/docs|document/i),
    style: has(/style|identit/i),
    identity: has(/identity|style/i),
    nudges: has(/nudge|aviso/i),
    travel: has(/travel|agenda|core|routines/i),
    p95: true,
    routines: has(/routines|agenda|core/i),
    inbox: has(/inbox|core|agenda/i)
  };
}

export function capability(key) {
  const caps = state.capabilities;
  if (!caps) return true; // desconocido: se prueba
  return caps[key] !== false;
}

/** Marca una capacidad como ausente (por ejemplo, si el endpoint devolvió 404). */
export function disableCapability(key) {
  if (!state.capabilities) state.capabilities = {};
  state.capabilities[key] = false;
}

function markMissing(key, reason = 'module-missing') {
  endpointState.set(key, { ok: false, missing: true, status: 0, reason, checkedAt: Date.now() });
}

export async function loadP95() {
  const result = await probeEndpoint('p95', ENDPOINTS.p95);
  state.p95 = result.ok ? result.data : null;
  return result;
}

export async function loadRoutines() {
  if (!capability('routines')) { markMissing('routines'); state.routines = []; return { ok: false, missing: true }; }
  const result = await probeEndpoint('routines', ENDPOINTS.routines);
  state.routines = result.ok && Array.isArray(result.data?.items) ? result.data.items : [];
  await loadOccurrences();
  return result;
}

export async function loadOccurrences(fromKey = todayKey(), days = 7) {
  const to = addDaysKey(fromKey, Math.max(1, days) - 1);
  const path = `${ENDPOINTS.occurrences}?from=${fromKey}&to=${to}`;
  const result = await probeEndpoint('occurrences', path);
  state.occurrences = result.ok && Array.isArray(result.data?.items) ? result.data.items : [];
  return result;
}

export async function loadAgentActions({ force = false } = {}) {
  if (!force && !capability('agent')) { markMissing('agentActions'); state.agentsActions = null; return { ok: false, missing: true }; }
  const result = await probeEndpoint('agentActions', ENDPOINTS.agentActions);
  state.agentsActions = result.ok ? result.data : null;
  return result;
}

export async function loadSignals({ force = false } = {}) {
  if (!force && !capability('signals')) { markMissing('signals'); state.signals = null; return { ok: false, missing: true }; }
  const result = await probeEndpoint('signals', ENDPOINTS.signals);
  state.signals = result.ok ? result.data : null;
  if (result.ok) await loadSignalRules();
  return result;
}

/** Reglas de señales con umbrales y ventanas. Opcional. */
export async function loadSignalRules() {
  try {
    const data = await api.get('/api/signals/rules');
    state.signalRules = data;
    return { ok: true, data };
  } catch (error) {
    state.signalRules = null;
    return { ok: false, error };
  }
}

export async function loadWorkflows({ force = false } = {}) {
  if (!force && !capability('workflows')) { markMissing('workflows'); state.workflows = null; return { ok: false, missing: true }; }
  const result = await probeEndpoint('workflows', ENDPOINTS.workflows);
  state.workflows = result.ok ? result.data : null;
  if (result.ok) {
    await Promise.allSettled([loadWorkflowStatus(), loadWorkflowRuns()]);
  }
  return result;
}

/** Estado del planificador (tick, workflows activos, señales). Opcional. */
export async function loadWorkflowStatus() {
  try {
    const data = await api.get('/api/workflows/status');
    state.workflowStatus = data;
    return { ok: true, data };
  } catch (error) {
    state.workflowStatus = null;
    return { ok: false, error };
  }
}

/** Últimas ejecuciones de workflows (incluye simulaciones). Opcional. */
export async function loadWorkflowRuns(limit = 25) {
  try {
    const data = await api.get(`/api/workflows/runs?limit=${limit}`);
    state.workflowRuns = Array.isArray(data?.items) ? data.items : [];
    return { ok: true, data };
  } catch (error) {
    state.workflowRuns = null;
    return { ok: false, error };
  }
}

export async function loadLlmStatus({ force = false } = {}) {
  if (!force && !capability('llm')) { markMissing('llm'); state.llm = null; return { ok: false, missing: true }; }
  const result = await probeEndpoint('llm', ENDPOINTS.llm);
  state.llm = result.ok ? result.data : null;
  return result;
}

export async function loadChannelCenter({ force = false } = {}) {
  if (!force && !capability('channels')) { markMissing('channels'); state.channelCenter = null; return { ok: false, missing: true }; }
  const result = await probeEndpoint('channels', ENDPOINTS.channels);
  state.channelCenter = result.ok ? result.data : null;
  state.channelDetails = {};
  if (result.ok) {
    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    await Promise.all(items.map(async (item) => {
      try {
        const detail = await api.get(`/api/channels/${encodeURIComponent(item.id).replace(/%3A/gi, ':')}`);
        state.channelDetails[item.id] = detail?.item || item;
      } catch {
        state.channelDetails[item.id] = item;
      }
    }));
    try {
      const inbox = await api.get('/api/channels/inbox?limit=30');
      state.channelMessages = inbox?.items || [];
    } catch {
      state.channelMessages = null;
    }
  }
  return result;
}

export async function loadMetrics(days = 30) {
  const result = await probeEndpoint('metrics', `/api/metrics?days=${days}`);
  state.metrics = result.ok ? result.data : null;
  return result;
}

export async function loadGoogleEvents(days = 21) {
  if (!state.googleConnections.length) {
    state.googleEvents = [];
    return { ok: true, data: { events: [] } };
  }
  try {
    const data = await api.get(`/api/google/events?days=${days}`);
    state.googleEvents = Array.isArray(data?.events) ? data.events : [];
    return { ok: true, data };
  } catch (error) {
    state.googleEvents = [];
    return { ok: false, error };
  }
}

export async function loadSecrets() {
  try {
    const data = await api.get('/api/secrets');
    state.secrets = data;
    return { ok: true, data };
  } catch (error) {
    state.secrets = null;
    return { ok: false, error };
  }
}

/* ------------------------- Oficina, documentos, estilo, avisos, viajes ------------------------- */

export async function loadOffice({ force = false } = {}) {
  if (capability('office') === false) {
    markMissing('office');
    state.office.roster = null;
    return { ok: false, missing: true };
  }
  const [roster, mode, status, proposals, ledger] = await Promise.allSettled([
    probeEndpoint('officeRoster', ENDPOINTS.officeRoster),
    probeEndpoint('officeMode', ENDPOINTS.officeMode),
    probeEndpoint('officeStatus', ENDPOINTS.officeStatus),
    probeEndpoint('officeProposals', ENDPOINTS.officeProposals),
    probeEndpoint('officeLedger', ENDPOINTS.officeLedger)
  ]);
  const value = (settled) => (settled.status === 'fulfilled' && settled.value.ok ? settled.value.data : null);
  const rosterData = value(roster);
  state.office.roster = rosterData;
  state.office.mode = value(mode) || (rosterData ? { mode: rosterData.mode, modes: rosterData.modes, levels: rosterData.levels } : null);
  state.office.status = value(status);
  const proposalsData = value(proposals);
  state.office.proposals = Array.isArray(proposalsData?.items) ? proposalsData.items : [];
  const ledgerData = value(ledger);
  state.office.ledger = Array.isArray(ledgerData?.items) ? ledgerData.items : [];
  return { ok: Boolean(rosterData || proposalsData), data: proposalsData };
}

export async function loadDocs({ force = false } = {}) {
  if (capability('docs') === false) { markMissing('docs'); state.docs.items = []; return { ok: false, missing: true }; }
  const query = new URLSearchParams({ limit: '60' });
  if (state.docs.query) query.set('q', state.docs.query);
  if (state.docs.filterType) query.set('type', state.docs.filterType);
  const [list, templates] = await Promise.allSettled([
    probeEndpoint('docs', `/api/docs?${query.toString()}`),
    probeEndpoint('docsTemplates', ENDPOINTS.docsTemplates)
  ]);
  const value = (settled) => (settled.status === 'fulfilled' && settled.value.ok ? settled.value.data : null);
  const listData = value(list);
  state.docs.items = Array.isArray(listData?.items) ? listData.items : [];
  state.docs.stats = listData?.stats || null;
  const templatesData = value(templates);
  state.docs.templates = Array.isArray(templatesData?.items) ? templatesData.items : [];
  return { ok: Boolean(listData), data: listData };
}

export async function loadStyle({ force = false } = {}) {
  if (capability('style') === false) { markMissing('style'); state.style.profiles = null; return { ok: false, missing: true }; }
  const result = await probeEndpoint('styleProfiles', ENDPOINTS.styleProfiles);
  state.style.profiles = result.ok ? result.data : null;
  return result;
}

export async function loadNudges({ force = false } = {}) {
  if (capability('nudges') === false) { markMissing('nudges'); state.nudges.config = null; return { ok: false, missing: true }; }
  const [config, feed, status] = await Promise.allSettled([
    probeEndpoint('nudgesConfig', ENDPOINTS.nudgesConfig),
    probeEndpoint('nudgesFeed', `${ENDPOINTS.nudgesFeed}${state.nudges.includeDismissed ? '&includeDismissed=1' : ''}`),
    probeEndpoint('nudgesStatus', ENDPOINTS.nudgesStatus)
  ]);
  const value = (settled) => (settled.status === 'fulfilled' && settled.value.ok ? settled.value.data : null);
  const configData = value(config);
  if (configData) {
    state.nudges.config = configData.config || null;
    state.nudges.state = configData.state || null;
    state.nudges.types = configData.types || null;
  }
  const feedData = value(feed);
  state.nudges.feed = Array.isArray(feedData?.items) ? feedData.items : [];
  state.nudges.status = value(status);
  return { ok: Boolean(configData), data: configData };
}

export async function loadTravel({ force = false } = {}) {
  if (capability('travel') === false) { markMissing('travel'); state.travel.places = []; return { ok: false, missing: true }; }
  const [places, config] = await Promise.allSettled([
    probeEndpoint('travelPlaces', ENDPOINTS.travelPlaces),
    probeEndpoint('travelConfig', '/api/travel/config')
  ]);
  const value = (settled) => (settled.status === 'fulfilled' && settled.value.ok ? settled.value.data : null);
  const placesData = value(places);
  state.travel.places = Array.isArray(placesData?.items) ? placesData.items : [];
  state.travel.config = value(config)?.item || null;
  return { ok: Boolean(placesData), data: placesData };
}

export async function loadApprovals({ force = false } = {}) {
  if (!force && state.approvals.loadedAt && Date.now() - state.approvals.loadedAt < 30000) {
    return { ok: !state.approvals.unavailable, data: state.approvals };
  }
  if (capability('channels') === false) {
    state.approvals.unavailable = true;
    state.approvals.loadedAt = Date.now();
    return { ok: false, missing: true };
  }
  try {
    const data = await api.get(ENDPOINTS.approvalsStatus, { timeoutMs: 15000 });
    state.approvals.status = data;
    state.approvals.config = data?.config || null;
    state.approvals.unavailable = false;
    state.approvals.error = null;
    state.approvals.loadedAt = Date.now();
    return { ok: true, data };
  } catch (error) {
    state.approvals.unavailable = true;
    state.approvals.error = error;
    state.approvals.loadedAt = Date.now();
    return { ok: false, error };
  }
}

export async function loadIdentityPeople(q = '') {
  const result = await probeEndpoint('identityPeople', `/api/identity/people?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return result.ok ? result.data : null;
}

/**
 * Refresco completo. `silent` evita mensajes de error repetidos.
 */
export async function refreshAll({ silent = true, google = true } = {}) {
  if (state.busy) return;
  state.busy = true;
  try {
    await loadBootstrap();
    /* La salud se lee primero: sus módulos deciden qué endpoints opcionales se piden. */
    await loadHealth();
    await Promise.allSettled([
      loadP95(),
      loadRoutines(),
      loadWorkflows(),
      loadSignals(),
      loadLlmStatus(),
      loadChannelCenter()
      /* Oficina, documentos, estilo, avisos y viajes se cargan al entrar en su
         vista (navigate → refreshX) para no castigar cada refresco global. */
    ]);
    if (google) await loadGoogleEvents();
    state.lastRefresh = Date.now();
    emit('state', { silent });
    return true;
  } finally {
    state.busy = false;
  }
}

/**
 * Sondeo explícito de módulos opcionales (botones "comprobar de nuevo").
 * Ignora la caché de capacidades: aquí sí se pregunta al servidor.
 */
export async function probeOptionalModules() {
  /* Releer salud: si el módulo se montó después, la capacidad pasa a true;
     si sigue ausente, no lo sondeamos (cero 404 en consola). */
  await loadHealth();
  await Promise.allSettled([
    loadWorkflows({ force: true }),
    loadSignals({ force: true }),
    loadLlmStatus({ force: true }),
    loadChannelCenter({ force: true }),
    loadAgentActions({ force: true }),
    loadOffice({ force: true }),
    loadDocs({ force: true }),
    loadStyle({ force: true }),
    loadNudges({ force: true }),
    loadTravel({ force: true })
  ]);
  emit('endpoints');
}

export function moduleStatus(key) {
  return endpointState.get(key) || { ok: false, missing: true, status: 0 };
}

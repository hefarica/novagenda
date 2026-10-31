/**
 * Estado compartido del frontend + emisor de eventos sencillo.
 * Ningún módulo escribe otro módulo: todos leen de aquí y re-renderizan.
 */
const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) || []) {
    try { handler(payload); } catch (error) { console.error(`[bus:${event}]`, error); }
  }
}

export const state = {
  /** Payload de /api/bootstrap */
  boot: null,
  settings: {},
  timezone: 'America/Bogota',
  agenda: [],
  inbox: [],
  okrs: [],
  activity: [],
  dashboard: null,
  googleConnections: [],
  googleEvents: [],
  channels: {},
  vault: [],
  auth: { required: false, mode: 'local', configured: false, authenticated: true },
  store: { readOnly: false, version: null, error: null },
  serverTime: null,
  version: '',

  /** Datos de endpoints propios del motor */
  p95: null,
  routines: [],
  occurrences: [],
  agentsActions: null,
  signals: null,
  workflows: null,
  workflowStatus: null,
  workflowRuns: null,
  signalRules: null,
  runs: [],
  llm: null,
  channelCenter: null,
  channelDetails: {},
  channelMessages: null,
  health: null,
  /** Capacidades derivadas de health.modules (null = desconocido). */
  capabilities: null,
  metrics: null,
  backupJournal: null,
  secrets: null,

  /** Oficina (t13/t18): organigrama, propuestas, ledger. */
  office: { roster: null, mode: null, status: null, proposals: [], ledger: [], ledgerVerify: null, filter: 'pending', codes: {}, busy: false },
  /** Documentos ofimáticos (t17). */
  docs: { items: [], templates: [], stats: null, query: '', type: 'docx', filterType: '' },
  /** Estilo propio e identidad (t14). */
  style: { profiles: null, lastScore: null, lastCompose: null },
  /** Avisos inteligentes (t16). */
  nudges: { config: null, feed: [], status: null, includeDismissed: false },
  /** Agenda física (t15): lugares y planificador. */
  travel: { places: [], config: null, plan: null },
  /** Aprobaciones y autonomía de salida (t35). */
  approvals: { status: null, config: null, unavailable: false, error: null, loadedAt: 0 },
  /** Voz: dictado y lectura en voz alta. */
  voice: { speak: false, supported: null, listening: false },

  /** UI */
  ui: {
    view: 'home',
    agendaFilter: 'all',
    agendaQuery: '',
    agendaMode: 'list',
    routineFilter: 'all',
    routineQuery: '',
    weekStart: null,
    signalFilter: '',
    recipes: null
  },

  /** Cola offline (se hidrata desde offline.js) */
  queued: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  lastRefresh: 0,
  busy: false,
  authRequired: false,
  setupRequired: false,
  authPolicyReason: ''
};

export function setBoot(payload) {
  state.boot = payload;
  state.settings = payload?.settings || {};
  state.timezone = payload?.timezone || payload?.settings?.timezone || 'America/Bogota';
  state.agenda = Array.isArray(payload?.agenda) ? payload.agenda : [];
  state.inbox = Array.isArray(payload?.inbox) ? payload.inbox : [];
  state.okrs = Array.isArray(payload?.okrs) ? payload.okrs : [];
  state.activity = Array.isArray(payload?.activity) ? payload.activity : [];
  state.dashboard = payload?.dashboard || null;
  state.googleConnections = Array.isArray(payload?.googleConnections) ? payload.googleConnections : [];
  state.channels = payload?.channels || {};
  state.vault = Array.isArray(payload?.vault) ? payload.vault : [];
  state.auth = payload?.auth || state.auth;
  state.store = payload?.store || state.store;
  state.serverTime = payload?.serverTime || null;
  state.version = payload?.version || '';
}

export function findEvent(id) {
  return state.agenda.find((event) => event.id === id) || null;
}

export function findRoutine(id) {
  return state.routines.find((routine) => routine.id === id) || null;
}

export function findGoogleEvent(id) {
  return state.googleEvents.find((event) => event.eventId === id || event.id === id) || null;
}

/** Todos los compromisos externos (Google) como eventos de solo lectura. */
export function externalEvents() {
  return state.googleEvents.filter((event) => event.source === 'google');
}

export function settingsP95() {
  return state.settings?.p95 || {};
}

export function workdays() {
  const list = state.settings?.workdays;
  return Array.isArray(list) && list.length ? list : ['LUN', 'MAR', 'MIE', 'JUE', 'VIE'];
}

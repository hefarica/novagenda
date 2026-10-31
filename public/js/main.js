/**
 * Arranque de la aplicación: autenticación, navegación, carga de datos,
 * banners de estado, PWA (service worker + cola offline) y atajos de teclado.
 */
import { api, ApiError, onUnauthorized } from './api.js';
import { state, on } from './state.js';
import {
  loadAgentActions, loadApprovals, loadBootstrap, loadChannelCenter, loadDocs, loadGoogleEvents, loadHealth,
  loadLlmStatus, loadNudges, loadOffice, loadP95, loadRoutines, loadSecrets, loadSignals, loadStyle, loadTravel, loadWorkflows, refreshAll
} from './data.js';
import {
  $, $$, addDaysKey, closeDialog, esc, openDialog, setBusy, startOfWeekKey, toast, todayKey,
  wireDialogCloseButtons
} from './core.js';
import { flushQueue, getQueue, removeFromQueue, subscribeQueue } from './offline.js';
import { focusSearch, initAgenda, renderAgenda } from './agenda.js';
import { initHome, renderHome, updateQueueChip } from './home.js';
import { initRoutines, renderRoutines } from './routines.js';
import { initTasks, renderTasks } from './tasks.js';
import { initAssistant, renderAssistant } from './assistant.js';
import { initOrganization, renderOrganization } from './organization.js';
import { initStudio, renderStudio } from './studio.js';
import { initIntegrations, renderIntegrations } from './integrations.js';
import { initModules, renderModules } from './modules.js';
import { initBackup } from './backup.js';
import { initFeaturesLab, renderFeaturesLab } from './features.js';
import { initMcpLab, renderMcpLab } from './mcp.js';
import { initEmailAccounts, renderEmailAccounts } from './email-accounts.js';
import { initImapAccounts, renderImapAccounts } from './imap-accounts.js';
import { initWorkflows, renderWorkflows } from './workflows.js';
import { initSystem, renderSystem } from './system.js';
import { initOnboarding, maybeAutoOpenOnboarding, openOnboarding } from './onboarding.js';
import { initSetup, renderSetup } from './setup.js';
import { initOffice, refreshOffice, renderOffice } from './office.js';
import { initDocs, refreshDocs, renderDocs } from './docs.js';
import { initWiki, renderWiki } from './wiki.js';
import { initGlobalSearch } from './global-search.js';
import { initMailGuard, renderMailGuard } from './mail-guard.js';
import { initBase, renderBase } from './base.js';
import { initLingo, renderLingo } from './lingo.js';
import { initAudit, renderAudit } from './audit.js';
import { initMeetingCapture } from './meeting-capture.js';
import { initTranslate } from './translate.js';
import { initIdentity, renderIdentity } from './identity.js';
import { initApprovals, renderApprovals } from './approvals.js';
import { initApprovalTypes, renderApprovalTypes } from './approval-types.js';
import { initOkr, renderOkr } from './okr.js';
import { initRooms, renderRooms } from './rooms.js';
import { initMoments, renderMoments } from './moments.js';
import { initAttendance, renderAttendance } from './attendance.js';
import { initStyle, refreshStyle, renderStyle } from './style.js';
import { initNudges, refreshNudges, renderNudges, startNudgeWatcher } from './nudges.js';
import { initTravel, refreshTravel, renderTravel } from './travel.js';
import { initVoice } from './voice.js';
import { initHomeAgent } from './home-agent.js';
import { initAmbient } from './ambient.js';
import { initCompose } from './compose.js';

const VIEWS = ['home', 'agenda', 'routines', 'tasks', 'rooms', 'attendance', 'okr', 'office', 'approvals', 'moments', 'docs', 'wiki', 'base', 'lingo', 'identity', 'style', 'audit', 'nudges', 'assistant', 'organization', 'studio', 'workflows', 'setup', 'integrations', 'system'];
const VIEW_TITLES = {
  home: 'Inicio', agenda: 'Agenda', routines: 'Rutinas', tasks: 'Tareas', rooms: 'Salas', attendance: 'Jornada', okr: 'Objetivos', office: 'Oficina', approvals: 'Aprobaciones', moments: 'Momentos', docs: 'Documentos', wiki: 'Wiki', base: 'Base', lingo: 'Léxico',
  style: 'Estilo', nudges: 'Avisos', assistant: 'Asistente', organization: 'Organización', studio: 'Estudio',
  workflows: 'Automatizaciones y señales', setup: 'Puesta en marcha', integrations: 'Integraciones y ajustes', system: 'Sistema P95'
};
let swRegistration = null;
let updateReady = false;
let deferredPrompt = null;
let authGateVisible = false;
let booting = false;
let moduleVisibility = {};
const TOGGLEABLE_MODULES = ['approvals', 'okr', 'rooms', 'attendance', 'moments', 'base', 'docs', 'wiki'];

/* ------------------------------ navegación ------------------------------ */
export function navigate(name, { updateHash = true } = {}) {
  if (TOGGLEABLE_MODULES.includes(name) && moduleVisibility[name] === false) {
    toast('Ese módulo está oculto. Actívalo en Ajustes.', 'warn');
    name = 'home';
  }
  const view = VIEWS.includes(name) ? name : 'home';
  state.ui.view = view;
  document.dispatchEvent(new CustomEvent('agenda:view', { detail: { view } }));
  for (const section of $$('.view')) section.classList.toggle('active', section.id === `view-${view}`);
  for (const button of $$('.bottom-nav [data-nav]')) button.classList.toggle('active', button.dataset.nav === view);
  for (const button of $$('.drawer-nav [data-nav]')) {
    if (button.dataset.nav === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  closeDrawer();
  if (updateHash && location.hash !== `#${view}`) {
    try { history.replaceState(null, '', `#${view}`); } catch { /* file:// */ }
  }
  if (view === 'system') renderSystem();
  if (view === 'workflows') renderWorkflows();
  if (view === 'setup') renderSetup().catch(() => {});
  if (view === 'integrations') { renderIntegrations(); renderModules(); renderFeaturesLab(); renderMcpLab(); renderEmailAccounts(); renderImapAccounts(); renderMailGuard(); loadApprovals().then(() => renderIntegrations()).catch(() => {}); }
  if (view === 'tasks') renderTasks();
  if (view === 'office') { renderOffice(); refreshOffice().catch(() => {}); }
  if (view === 'docs') { renderDocs(); refreshDocs().catch(() => {}); }
  if (view === 'wiki') { renderWiki(); }
  if (view === 'base') { renderBase(); }
  if (view === 'lingo') { renderLingo(); }
  if (view === 'identity') { renderIdentity(); }
  if (view === 'approvals') { renderApprovals(); renderApprovalTypes(); }
  if (view === 'okr') { renderOkr(); }
  if (view === 'rooms') { renderRooms(); }
  if (view === 'moments') { renderMoments(); }
  if (view === 'attendance') { renderAttendance(); }
  if (view === 'audit') { renderAudit(); }
  if (view === 'style') { renderStyle(); refreshStyle().catch(() => {}); }
  if (view === 'nudges') { renderNudges(); refreshNudges().catch(() => {}); }
  if (view === 'organization') { renderOrganization(); }
  if (view === 'studio') { renderStudio().catch(() => {}); }
  if (view === 'agenda') { renderAgenda(); refreshTravel().catch(() => {}); }
  /* Datos frescos al entrar: pueden haber cambiado por WhatsApp, Telegram o el LLM. */
  if (Date.now() - state.lastRefresh > 20000) {
    refreshAll().catch(() => { /* el banner de error ya informa */ });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openDrawer() {
  const drawer = $('#drawer');
  const shade = $('#drawerShade');
  drawer?.classList.add('open');
  drawer?.setAttribute('aria-hidden', 'false');
  shade?.classList.add('open');
  $('#menuBtn')?.setAttribute('aria-expanded', 'true');
  drawer?.querySelector('button')?.focus();
}

function closeDrawer() {
  const drawer = $('#drawer');
  const shade = $('#drawerShade');
  if (!drawer?.classList.contains('open')) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  shade?.classList.remove('open');
  $('#menuBtn')?.setAttribute('aria-expanded', 'false');
  $('#menuBtn')?.focus();
}

/* ------------------------------ banners ------------------------------ */
function bannerHTML(kind, text, actions = []) {
  return `<div class="banner ${kind}">
    <span>${esc(text)}</span>
    <div class="actions">${actions.map((action) => `<button type="button" class="secondary small" data-banner-action="${esc(action.action)}">${esc(action.label)}</button>`).join('')}</div>
  </div>`;
}

function renderBanners() {
  const stack = $('#bannerStack');
  if (!stack) return;
  const parts = [];
  if (!state.online) {
    parts.push(bannerHTML('warn', 'Sin conexión: las capturas se guardan en la cola del dispositivo y se envían al volver.', [
      { label: 'Ver cola', action: 'queue' }
    ]));
  }
  if (state.store?.readOnly) {
    parts.push(bannerHTML('bad', `Datos en solo lectura: ${state.store.error || 'el almacén no se pudo leer'}. Puedes restaurar una copia desde Integraciones.`, [
      { label: 'Ir a Datos', action: 'data' }
    ]));
  }
  if (updateReady) {
    parts.push(bannerHTML('', 'Hay una nueva versión lista. Actualiza para ver los últimos cambios.', [
      { label: 'Actualizar', action: 'sw-update' }
    ]));
  }
  if (deferredPrompt) {
    parts.push(bannerHTML('', 'Puedes instalar Agenda Copilot en tu pantalla de inicio.', [
      { label: 'Instalar app', action: 'install' }
    ]));
  }
  stack.innerHTML = parts.join('');
}

/* ------------------------------ cola offline ------------------------------ */
function renderQueueDialog() {
  const list = $('#queueList');
  if (!list) return;
  const items = getQueue();
  list.innerHTML = items.length
    ? items.map((item) => `<div class="system-row">
        <div><b>${esc(item.text)}</b><small>${esc(item.source || 'Captura')} · ${esc(String(item.at || '').slice(0, 16).replace('T', ' '))}</small></div>
        <button type="button" data-queue-remove="${esc(item.id)}">Quitar</button>
      </div>`).join('')
    : '<p class="muted small">No hay capturas pendientes. Todo sincronizado.</p>';
}

async function syncQueue({ silent = false } = {}) {
  const pending = getQueue().length;
  if (!pending) { if (!silent) toast('No hay nada pendiente', 'warn'); return; }
  if (!navigator.onLine) { if (!silent) toast('Seguimos sin conexión: la cola se conserva.', 'warn'); return; }
  const button = $('#queueFlush');
  setBusy(button, true, 'Sincronizando');
  const result = await flushQueue();
  setBusy(button, false);
  renderQueueDialog();
  updateQueueChip();
  if (result.sent) {
    toast(`${result.sent} captura(s) enviadas al inbox`, 'ok');
    await refreshAll();
  } else if (!silent) {
    toast('No se pudo sincronizar todavía; se reintentará al recuperar la conexión.', 'warn');
  }
}

/* ------------------------------ autenticación ------------------------------ */
async function showAuthGate() {
  if (authGateVisible) return;
  authGateVisible = true;
  const gate = $('#authGate');
  if (!gate) return;
  gate.hidden = false;
  gate.setAttribute('aria-hidden', 'false');
  let status = null;
  try { status = await api.get('/api/auth/status'); } catch { /* sin estado */ }
  const setup = Boolean(status?.setupRequired);
  const loginForm = $('#loginForm');
  const setupForm = $('#setupForm');
  if (loginForm) loginForm.hidden = setup;
  if (setupForm) setupForm.hidden = !setup;
  const help = $('#authHelp');
  if (help) {
    help.textContent = setup
      ? 'Crea la cuenta de propietario. La contraseña se guarda cifrada con scrypt y nunca sale del servidor.'
      : 'Este servidor exige una sesión para proteger tus datos.';
  }
  const username = status?.username || 'owner';
  if (loginForm) loginForm.elements.username.value = username;
  if (setupForm) setupForm.elements.username.value = username;
  const error = $('#authError');
  if (error) error.hidden = true;
}

function hideAuthGate() {
  authGateVisible = false;
  const gate = $('#authGate');
  if (gate) { gate.hidden = true; gate.setAttribute('aria-hidden', 'true'); }
}

function showAuthError(message) {
  const box = $('#authError');
  if (!box) { toast(message, 'err'); return; }
  box.hidden = false;
  box.textContent = message;
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Entrando');
  try {
    await api.post('/api/auth/login', {
      username: form.elements.username.value.trim() || 'owner',
      password: form.elements.password.value
    });
    hideAuthGate();
    await startData();
  } catch (error) {
    showAuthError(error?.message || 'No se pudo iniciar sesión');
  } finally {
    setBusy(button, false);
  }
}

async function submitSetup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Creando');
  try {
    await api.post('/api/auth/setup', {
      username: form.elements.username.value.trim() || 'owner',
      password: form.elements.password.value,
      setupToken: form.elements.setupToken.value.trim() || undefined
    });
    hideAuthGate();
    await startData();
  } catch (error) {
    showAuthError(error?.details?.requiresToken ? 'Este servidor pide token de instalación para crear la cuenta desde la red.' : (error?.message || 'No se pudo crear la cuenta'));
  } finally {
    setBusy(button, false);
  }
}

/* ------------------------------ datos y render ------------------------------ */
function safeRender(name, fn) {
  try { fn(); } catch (error) { console.error(`[render:${name}]`, error); }
}

export function renderAll() {
  safeRender('home', renderHome);
  safeRender('agenda', renderAgenda);
  safeRender('routines', renderRoutines);
safeRender('tasks', renderTasks);
  safeRender('assistant', renderAssistant);
  safeRender('workflows', renderWorkflows);
  safeRender('integrations', renderIntegrations);
safeRender('mcp', renderMcpLab);
  safeRender('office', renderOffice);
  safeRender('docs', renderDocs);
  safeRender('wiki', renderWiki);
  safeRender('base', renderBase);
  safeRender('lingo', renderLingo);
  safeRender('identity', renderIdentity);
  safeRender('approvals', renderApprovals);
  safeRender('approval-types', renderApprovalTypes);
  safeRender('okr', renderOkr);
  safeRender('rooms', renderRooms);
  safeRender('moments', renderMoments);
  safeRender('attendance', renderAttendance);
  safeRender('audit', renderAudit);
  safeRender('style', renderStyle);
  safeRender('nudges', renderNudges);
  safeRender('travel', renderTravel);
  if (state.ui.view === 'system') safeRender('system', renderSystem);
  safeRender('queue', updateQueueChip);
  safeRender('banners', renderBanners);
}

async function loadModuleVisibility() {
  try {
    const result = await api.get('/api/settings/modules');
    moduleVisibility = Object.fromEntries((result?.items || []).map((item) => [item.key, item.enabled !== false]));
    applyModuleVisibility();
  } catch { /* la app sigue con todo visible */ }
}

function applyModuleVisibility() {
  for (const key of TOGGLEABLE_MODULES) {
    for (const element of $$('[data-nav="' + key + '"]')) element.hidden = moduleVisibility[key] === false;
  }
}

async function startData() {
  await loadBootstrap();
  await loadModuleVisibility();
  /* Primero la salud: de sus módulos sale qué endpoints opcionales existen. */
  await loadHealth();
  await Promise.allSettled([
    loadP95(),
    loadRoutines(),
    loadWorkflows(),
    loadSignals(),
    loadLlmStatus(),
    loadChannelCenter(),
    loadSecrets(),
    loadAgentActions(),
    loadOffice(),
    loadDocs(),
    loadStyle(),
    loadNudges(),
    loadTravel()
  ]);
  await loadGoogleEvents();
  state.lastRefresh = Date.now();
  renderAll();
  await maybeFlushQueue();
  maybeAutoOpenOnboarding();
  handleInitialRoute();
}

async function maybeFlushQueue() {
  if (!navigator.onLine) return;
  if (!getQueue().length) return;
  const result = await flushQueue();
  updateQueueChip();
  renderQueueDialog();
  if (result.sent) {
    toast(`Se sincronizaron ${result.sent} captura(s) pendientes`, 'ok');
    await refreshAll();
  }
}

function handleInitialRoute() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('view') || (location.hash || '').replace('#', '');
  if (VIEWS.includes(requested)) navigate(requested, { updateHash: false });
  if (params.get('action') === 'new') setTimeout(() => $('#agendaNewBtn')?.click(), 220);
  if (params.get('focus') === 'captura') setTimeout(() => $('#captureInput')?.focus(), 220);
  if (params.get('connected') === 'google') toast('Cuenta Google conectada', 'ok');
  if (params.get('google') === 'error') toast('No se pudo conectar Google. Revisa clientId/clientSecret y el redirect.', 'err');
}

/* ------------------------------ PWA ------------------------------ */
async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    if (swRegistration.waiting && navigator.serviceWorker.controller) {
      updateReady = true;
      renderBanners();
    }
    swRegistration.addEventListener('updatefound', () => {
      const worker = swRegistration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          updateReady = true;
          renderBanners();
          toast('Hay una nueva versión disponible. Usa el aviso para actualizar.', 'warn');
        }
      });
    });
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SW_UPDATED') {
        updateReady = true;
        renderBanners();
      }
    });
    const check = () => swRegistration?.update?.().catch(() => {});
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  } catch (error) {
    console.warn('[sw] no se pudo registrar:', error?.message || error);
  }
}

function applyUpdate() {
  if (!swRegistration) {
    window.location.reload();
    return;
  }
  const waiting = swRegistration.waiting;
  if (waiting) {
    waiting.postMessage({ type: 'SKIP_WAITING' });
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    toast('Actualizando…', 'ok');
  } else {
    window.location.reload();
  }
}

/* ------------------------------ eventos globales ------------------------------ */
function wireGlobal() {
  wireDialogCloseButtons();

  /* Los avisos 202 envían a la Oficina: cierra el diálogo abierto y resalta
     la propuesta recién creada. */
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go-approval]');
    if (!go) return;
    event.preventDefault();
    const proposalId = go.dataset.goApproval || '';
    for (const dialog of $$('dialog[open]')) {
      try { dialog.close(); } catch { /* ignorado */ }
    }
    navigate('office');
    if (!proposalId) return;
    state.office.highlight = proposalId;
    setTimeout(() => {
      const card = document.querySelector('[data-proposal="' + CSS.escape(proposalId) + '"]');
      if (!card) return;
      card.classList.add('pulse');
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 900);
  });

  $('#menuBtn')?.addEventListener('click', openDrawer);
  $('#drawerClose')?.addEventListener('click', closeDrawer);
  $('#drawerShade')?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  for (const button of $$('[data-nav]')) {
    button.addEventListener('click', () => navigate(button.dataset.nav));
  }
  for (const button of $$('[data-action="new"]')) {
    button.addEventListener('click', () => $('#agendaNewBtn')?.click());
  }

  $('#queueBtn')?.addEventListener('click', () => { renderQueueDialog(); openDialog('#dlg-queue'); });
  $('#queueFlush')?.addEventListener('click', () => syncQueue());
  $('#queueList')?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-queue-remove]');
    if (remove) { removeFromQueue(remove.dataset.queueRemove); renderQueueDialog(); updateQueueChip(); }
  });

  $('#bannerStack')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-banner-action]');
    if (!action) return;
    if (action.dataset.bannerAction === 'queue') { renderQueueDialog(); openDialog('#dlg-queue'); }
    else if (action.dataset.bannerAction === 'data') navigate('integrations');
    else if (action.dataset.bannerAction === 'sw-update') applyUpdate();
    else if (action.dataset.bannerAction === 'install') {
      deferredPrompt?.prompt?.();
      deferredPrompt = null;
      renderBanners();
    }
  });

  window.addEventListener('online', async () => {
    state.online = true;
    renderBanners();
    /* Si hay un aviso con acción (p. ej. "Reintentar" un borrado), no lo pisamos:
       el usuario necesita ese botón para terminar la acción. */
    if (!$('#toast')?.querySelector('.toast-action')) toast('Conexión recuperada', 'ok');
    await syncQueue({ silent: true });
    await refreshAll();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    renderBanners();
    toast('Sin conexión: puedes seguir capturando, se sincronizará después.', 'warn');
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    renderBanners();
  });

  document.addEventListener('keydown', (event) => {
    const tag = String(event.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable;
    if (typing) return;
    if (event.key === '/') { event.preventDefault(); navigate('agenda'); setTimeout(focusSearch, 100); }
    else if (event.key === '?') { event.preventDefault(); openOnboarding(0); }
    else if (event.key.toLowerCase() === 'n') { event.preventDefault(); $('#agendaNewBtn')?.click(); }
    else if (event.key === 'g') {
      const next = (event2) => {
        const map = { h: 'home', a: 'agenda', r: 'routines', s: 'assistant', w: 'workflows', i: 'integrations', p: 'system' };
        if (map[event2.key]) { event2.preventDefault(); navigate(map[event2.key]); }
        document.removeEventListener('keydown', next);
      };
      document.addEventListener('keydown', next, { once: true });
    }
  });

  on('state', () => renderAll());
  on('bootstrap', () => {
    if (state.store?.readOnly) renderBanners();
  });
  on('queue', (count) => { state.queued = count; updateQueueChip(); renderQueueDialog(); });

  subscribeQueue((count) => { state.queued = count; updateQueueChip(); });

  onUnauthorized(() => { showAuthGate(); });

  $('#loginForm')?.addEventListener('submit', submitLogin);
  $('#setupForm')?.addEventListener('submit', submitSetup);
}

/* ------------------------------ arranque ------------------------------ */
async function boot() {
  if (booting) return;
  booting = true;
  wireGlobal();
  initHome();
  initAgenda();
  initGlobalSearch();
  initRoutines();
  initAssistant();
  initOrganization();
  initStudio();
  initWorkflows();
  initIntegrations();
  initSetup();
  initModules();
  initBackup();
  document.addEventListener('modules:visibility', (event) => {
    moduleVisibility = { ...moduleVisibility, ...(event.detail || {}) };
    applyModuleVisibility();
  });
  initSystem();
  initOnboarding();
  initOffice();
  initDocs();
  initWiki();
  initMailGuard();
  initBase();
  initLingo();
  initAudit();
  initMeetingCapture();
  initTranslate();
  initIdentity();
  initApprovals();
  initApprovalTypes();
  initOkr();
  initRooms();
  initMoments();
  initAttendance();
  initStyle();
  initNudges();
  initTravel();
  initCompose();
  initVoice();
  initHomeAgent();
  initAmbient();
  initTasks();
  startNudgeWatcher();
  initFeaturesLab();
  initMcpLab();
  initEmailAccounts();
  initImapAccounts();
  on('navigate', (name) => navigate(name));
  state.ui.weekStart = state.ui.weekStart || startOfWeekKey(todayKey());
  await initServiceWorker();
  renderBanners();
  try {
    await startData();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await showAuthGate();
    } else {
      const stack = $('#bannerStack');
      if (stack) {
        stack.innerHTML = bannerHTML('bad', `No pude cargar el estado inicial: ${error?.message || 'error'}. ¿Sigue encendido el servidor?`, [
          { label: 'Reintentar', action: 'retry-boot' }
        ]);
        stack.querySelector('[data-banner-action="retry-boot"]')?.addEventListener('click', () => window.location.reload());
      }
      if (error?.name === 'NetworkError') console.warn('[boot]', error.message);
      else console.error('[boot]', error);
    }
  } finally {
    booting = false;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { boot, openDialog, closeDialog, addDaysKey };





















/**
 * Avisos inteligentes: configuración (cadencia, silencio, canales, umbrales),
 * feed con descarte y evaluación en seco.
 */
import { api, formatError } from './api.js';
import { state } from './state.js';
import { loadNudges as fetchNudges, capability } from './data.js';
import { $, $$, esc, toast, setBusy, emptyState, unavailableState, fmtDateTime } from './core.js';

let initialized = false;
const CHANNELS = ['whatsapp', 'telegram', 'email'];

export function initNudges() {
  if (initialized) return;
  initialized = true;

  $('#nudgeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveConfig(event.currentTarget);
  });

  $('#nudgeChannels')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-nudge-channel]');
    if (!chip) return;
    const active = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(active));
    chip.classList.toggle('active', active);
  });

  $('#nudgeFeed')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-nudge-dismiss]');
    if (!button) return;
    await dismissNudge(button.dataset.nudgeDismiss, button);
  });

  $('#nudgeShowDismissed')?.addEventListener('change', async (event) => {
    state.nudges.includeDismissed = event.target.checked;
    await refreshNudges();
  });

  $('#nudgeEvaluateBtn')?.addEventListener('click', evaluateNudges);
  $('#nudgeNotifyToggle')?.addEventListener('change', async (event) => {
    if (event.target.checked) await enableBrowserNotifications();
    else disableBrowserNotifications();
  });
  syncNotifyToggle();
  $('#nudgeRefresh')?.addEventListener('click', async () => { await refreshNudges(); toast('Avisos actualizados', 'ok'); });
}

export async function refreshNudges() {
  const result = await fetchNudges({ force: true }).catch(() => ({ ok: false }));
  renderNudges();
  return result;
}

export function renderNudges() {
  const feed = $('#nudgeFeed');
  if (!feed) return;
  if (!capability('nudges')) {
    feed.innerHTML = unavailableState({ title: 'Avisos no disponible en este servidor', detail: 'El módulo de avisos no está montado.' });
    return;
  }
  fillConfig();
  renderFeed();
  renderStatus();
}

function fillConfig() {
  const form = $('#nudgeForm');
  const config = state.nudges.config;
  if (!form || !config) return;
  const set = (name, value) => { if (form.elements[name]) form.elements[name].value = value ?? ''; };
  form.elements.enabled.checked = config.enabled !== false;
  set('cadenceMin', config.cadenceMin);
  set('maxPerHour', config.maxPerHour);
  set('maxPerDay', config.maxPerDay);
  set('cooldownMin', config.cooldownMin);
  set('maxItems', config.maxItems);
  form.elements.silenceEnabled.checked = config.silence?.enabled !== false;
  set('silenceFrom', config.silence?.from || '21:30');
  set('silenceTo', config.silence?.to || '07:00');
  set('freeGapMin', config.freeGapMin);
  set('unansweredMin', config.unansweredMin);
  set('meetingLookaheadMin', config.meetingLookaheadMin);
  set('closeCheckAt', config.closeCheckAt);
  set('reportAt', config.reportAt);
  form.elements.llmEnabled.checked = config.llmEnabled !== false;
  const active = new Set(Array.isArray(config.channels) ? config.channels : []);
  $$('#nudgeChannels [data-nudge-channel]').forEach((chip) => {
    const on = active.has(chip.dataset.nudgeChannel);
    chip.setAttribute('aria-pressed', String(on));
    chip.classList.toggle('active', on);
  });
  const targets = $('#nudgeTargets');
  const resolved = state.nudges.state?.targets;
  if (targets) {
    const list = Array.isArray(resolved) ? resolved : [];
    targets.textContent = list.length ? `Destinos: ${list.map((target) => target.channel || target).join(', ')}` : 'Sin destinos: activa un canal.';
  }
}

async function saveConfig(form) {
  const status = $('#nudgeConfigStatus');
  const button = form.querySelector('button[type="submit"]');
  const channels = $$('#nudgeChannels [data-nudge-channel]')
    .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
    .map((chip) => chip.dataset.nudgeChannel)
    .filter((channel) => CHANNELS.includes(channel));
  const patch = {
    enabled: form.elements.enabled.checked,
    cadenceMin: Number(form.elements.cadenceMin.value),
    maxPerHour: Number(form.elements.maxPerHour.value),
    maxPerDay: Number(form.elements.maxPerDay.value),
    cooldownMin: Number(form.elements.cooldownMin.value),
    maxItems: Number(form.elements.maxItems.value),
    silence: {
      enabled: form.elements.silenceEnabled.checked,
      from: form.elements.silenceFrom.value || '21:30',
      to: form.elements.silenceTo.value || '07:00'
    },
    channels,
    freeGapMin: Number(form.elements.freeGapMin.value),
    unansweredMin: Number(form.elements.unansweredMin.value),
    meetingLookaheadMin: Number(form.elements.meetingLookaheadMin.value),
    closeCheckAt: form.elements.closeCheckAt.value || '17:30',
    reportAt: form.elements.reportAt.value || '18:00',
    llmEnabled: form.elements.llmEnabled.checked
  };
  setBusy(button, true, 'Guardando');
  try {
    await api.post('/api/nudges/config', patch);
    if (status) { status.textContent = 'Configuración guardada.'; status.className = 'hint ok'; }
    toast('Avisos configurados', 'ok');
    await refreshNudges();
  } catch (error) {
    if (status) { status.textContent = formatError(error); status.className = 'hint bad'; }
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function renderFeed() {
  const box = $('#nudgeFeed');
  if (!box) return;
  const items = state.nudges.feed || [];
  if (!items.length) {
    box.innerHTML = emptyState('No hay avisos todavía. Cambia algo en tu agenda y vuelve a mirar.', '◔');
    return;
  }
  box.innerHTML = items.map((entry) => {
    const at = entry.at || entry.createdAt || entry.sentAt || '';
    const subjects = Array.isArray(entry.items) ? entry.items : [];
    const text = entry.text || entry.message || entry.summary || '';
    return `
      <article class="nudge-item ${entry.dismissed ? 'dismissed' : ''}">
        <div class="n-top">
          <span>${entry.dismissed ? 'Descartado' : esc(entry.channel || 'interno')} · ${esc(at ? fmtDateTime(at) : '')}</span>
          <span>${subjects.length ? `${subjects.length} asunto(s)` : ''}</span>
        </div>
        ${text ? `<div>${esc(text)}</div>` : ''}
        ${subjects.length ? `<ul>${subjects.map((subject) => `<li>${esc(subject.title || subject.text || subject.type || 'Asunto')}${subject.priority ? ` · <small>${esc(subject.priority)}</small>` : ''}</li>`).join('')}</ul>` : ''}
        ${entry.dismissed ? '' : `<div class="n-actions"><button type="button" class="ghost small" data-nudge-dismiss="${esc(entry.id)}">Descartar</button></div>`}
      </article>`;
  }).join('');
}

function renderStatus() {
  const box = $('#nudgeStatus');
  if (!box) return;
  const status = state.nudges.status;
  const config = state.nudges.config;
  if (!status && !config) { box.innerHTML = '<span class="muted small">Sin estado todavía.</span>'; return; }
  const counters = status?.state?.counters || {};
  box.innerHTML = `
    <span class="status-pill ${config?.enabled === false ? 'warn' : 'ok'}"><b>${config?.enabled === false ? 'Apagados' : 'Activos'}</b> avisos</span>
    <span class="status-pill"><b>${counters.sent ?? 0}</b> enviados hoy</span>
    <span class="status-pill"><b>${counters.dismissed ?? 0}</b> descartados</span>
    <span class="status-pill"><b>${status?.state?.history ?? 0}</b> en historial</span>
    <span class="status-pill"><b>${config?.cadenceMin ?? '—'}</b> min de cadencia</span>
    <span class="status-pill"><b>${config?.silence?.enabled === false ? 'off' : `${config?.silence?.from || '21:30'}–${config?.silence?.to || '07:00'}`}</b> silencio</span>`;
}

async function dismissNudge(id, button) {
  if (!id) return;
  setBusy(button, true, 'Descartando');
  try {
    await api.post(`/api/nudges/${encodeURIComponent(id)}/dismiss`, {});
    toast('Aviso descartado', 'ok');
    await refreshNudges();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

async function evaluateNudges() {
  const button = $('#nudgeEvaluateBtn');
  setBusy(button, true, 'Evaluando');
  try {
    const result = await api.post('/api/nudges/evaluate', { dryRun: true });
    const count = Array.isArray(result?.items) ? result.items.length : (result?.wouldSend ?? result?.candidates ?? 0);
    const reason = result?.skippedReason || result?.reason || '';
    toast(`Simulación: ${count} aviso(s)${reason ? ` · ${reason}` : ''}. No se envió nada.`, 'ok');
    await refreshNudges();
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

/* ---------------- Notificaciones proactivas del navegador ---------------- */
const NOTIFY_KEY = 'agenda-p95.notify.v1';
const SEEN_KEY = 'agenda-p95.nudge.seen.v1';
let watcher = null;
let checking = false;

function notifyEnabled() {
  try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch { return false; }
}
function seenSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.slice(-300) : []);
  } catch { return new Set(); }
}
function saveSeen(set) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-300))); } catch { /* ignorado */ }
}
function inSilence(config) {
  if (!config?.silenceEnabled) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const parse = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = parse(config.silenceFrom);
  const to = parse(config.silenceTo);
  if (from === null || to === null) return false;
  return from <= to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to);
}
function syncNotifyToggle() {
  const box = $('#nudgeNotifyToggle');
  const status = $('#nudgeNotifyStatus');
  if (!box) return;
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  box.disabled = !supported;
  box.checked = supported && notifyEnabled();
  if (!status) return;
  if (!supported) status.textContent = 'Este navegador no permite notificaciones.';
  else if (Notification.permission === 'denied') { status.textContent = 'Notificaciones bloqueadas en el navegador; actívalas en el candado del sitio.'; status.className = 'hint bad'; }
  else if (notifyEnabled()) { status.textContent = 'Notificaciones activas: avisaré aquí mientras la app esté abierta.'; status.className = 'hint ok'; }
  else { status.textContent = 'Sin notificaciones del navegador.'; status.className = 'hint'; }
}
async function enableBrowserNotifications() {
  if (typeof window === 'undefined' || !('Notification' in window)) { toast('Este navegador no permite notificaciones', 'err'); syncNotifyToggle(); return; }
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission().catch(() => 'denied');
  if (permission !== 'granted') { toast('Permiso de notificaciones denegado', 'err'); syncNotifyToggle(); return; }
  try { localStorage.setItem(NOTIFY_KEY, '1'); } catch { /* ignorado */ }
  const seen = seenSet();
  for (const entry of state.nudges.feed || []) seen.add(entry.id);
  saveSeen(seen);
  toast('Avisos del navegador activados', 'ok');
  syncNotifyToggle();
  startNudgeWatcher();
  await checkNudgesNotify({ force: true });
}
function disableBrowserNotifications() {
  try { localStorage.removeItem(NOTIFY_KEY); } catch { /* ignorado */ }
  if (watcher) { clearInterval(watcher); watcher = null; }
  toast('Avisos del navegador desactivados', 'ok');
  syncNotifyToggle();
}
async function checkNudgesNotify({ force = false } = {}) {
  if (!notifyEnabled() || checking) return;
  if (!force && document.hidden === false && document.hasFocus?.() === true) { /* también se revisa: el aviso es local */ }
  checking = true;
  try {
    const result = await fetchNudges({ force: true }).catch(() => null);
    const feed = Array.isArray(result?.feed) ? result.feed : (state.nudges.feed || []);
    const config = state.nudges.config || result?.config || null;
    const seen = seenSet();
    const fresh = feed.filter((entry) => entry && !entry.dismissed && entry.id && !seen.has(entry.id));
    if (!fresh.length) return;
    for (const entry of fresh) seen.add(entry.id);
    saveSeen(seen);
    if (inSilence(config)) return;
    for (const entry of fresh.slice(0, 3)) {
      const subjects = Array.isArray(entry.items) ? entry.items.map((item) => item.title || item.text).filter(Boolean) : [];
      const body = String(entry.text || entry.message || subjects.slice(0, 3).join(' · ') || 'Tienes un aviso nuevo').slice(0, 180);
      const title = 'Agenda P95 · aviso';
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(title, { body, tag: String(entry.id), icon: '/icons/icon-192.png' }); } catch { toast(body, 'warn'); }
      } else {
        toast(body, 'warn');
      }
    }
  } finally {
    checking = false;
  }
}
export function startNudgeWatcher() {
  if (!notifyEnabled()) return;
  if (watcher) return;
  watcher = setInterval(() => { checkNudgesNotify().catch(() => {}); }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNudgesNotify().catch(() => {}); });
  checkNudgesNotify().catch(() => {});
}

/**
 * Núcleo del frontend: utilidades de DOM, formato de fechas en la zona horaria
 * de la app, avisos, diálogos y pequeños ayudantes reutilizables.
 */
const WEEKDAYS = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
const WEEKDAY_LABELS = { LUN: 'Lunes', MAR: 'Martes', MIE: 'Miércoles', JUE: 'Jueves', VIE: 'Viernes', SAB: 'Sábado', DOM: 'Domingo' };

let displayTz = 'America/Bogota';

export function setDisplayTimezone(tz) {
  if (typeof tz === 'string' && tz.trim()) {
    try {
      new Intl.DateTimeFormat('es-CO', { timeZone: tz }).format(new Date());
      displayTz = tz;
    } catch {
      displayTz = 'America/Bogota';
    }
  }
}

export function getDisplayTimezone() {
  return displayTz;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Escapa texto para insertarlo en HTML (contenido o atributos entre comillas). */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00Z`);
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export const isDateOnly = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

function partsInTz(date, tz = displayTz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const out = {};
  for (const part of fmt.formatToParts(date)) if (part.type !== 'literal') out[part.type] = part.value;
  return out;
}

/** Clave YYYY-MM-DD en la zona horaria de la app. */
export function dateKeyOf(value, tz = displayTz) {
  if (isDateOnly(value)) return value.trim();
  const date = asDate(value);
  if (!date) return '';
  const p = partsInTz(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function timeLabel(value, tz = displayTz) {
  if (isDateOnly(value)) return 'Todo el día';
  const date = asDate(value);
  if (!date) return '';
  const p = partsInTz(date, tz);
  return `${p.hour}:${p.minute}`;
}

export function todayKey(tz = displayTz) {
  return dateKeyOf(new Date().toISOString(), tz);
}

export function parseKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDaysKey(key, days) {
  const date = parseKey(key);
  if (!date) return key;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

export function weekdayCode(key) {
  const date = parseKey(key);
  if (!date) return '';
  return WEEKDAYS[date.getUTCDay()];
}

export function weekdayLong(key) {
  return WEEKDAY_LABELS[weekdayCode(key)] || '';
}

/** Lunes de la semana de `key`. */
export function startOfWeekKey(key = todayKey()) {
  const date = parseKey(key);
  if (!date) return key;
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

export function weekKeys(startKey) {
  return Array.from({ length: 7 }, (_, index) => addDaysKey(startKey, index));
}

export function labelForKey(key) {
  const date = parseKey(key);
  if (!date) return key;
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short'
  }).format(date);
}

export function longLabelForKey(key) {
  const date = parseKey(key);
  if (!date) return key;
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
  }).format(date);
}

export function relativeDayLabel(key) {
  const today = todayKey();
  if (key === today) return 'Hoy';
  if (key === addDaysKey(today, 1)) return 'Mañana';
  if (key === addDaysKey(today, -1)) return 'Ayer';
  return labelForKey(key);
}

export function fmtDateTime(value, tz = displayTz) {
  if (!value) return '';
  if (isDateOnly(value)) return labelForKey(value);
  const date = asDate(value);
  if (!date) return String(value);
  return `${labelForKey(dateKeyOf(value, tz))} · ${timeLabel(value, tz)}`;
}

/** Valor para <input type="datetime-local"> en la zona de la app. */
export function toZonedInput(value, tz = displayTz) {
  if (!value) return '';
  if (isDateOnly(value)) return `${value.trim()}T09:00`;
  const date = asDate(value);
  if (!date) return '';
  const p = partsInTz(date, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function minutesBetween(start, end) {
  const a = asDate(start);
  const b = asDate(end);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
}

/**
 * Suma minutos a una hora de pared (`YYYY-MM-DDTHH:MM`), sin conversiones de
 * zona: es aritmética de calendario, justo lo que necesita un <input datetime-local>.
 */
export function addMinutesToInput(value, minutes) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])));
  date.setUTCMinutes(date.getUTCMinutes() + Math.round(Number(minutes) || 0));
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function nowLocalInput(offsetMin = 30) {
  const date = new Date(Date.now() + Number(offsetMin) * 60000);
  const p = partsInTz(date, displayTz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function roundToNextStep(stepMin = 30) {
  const date = new Date(Date.now() + 5 * 60000);
  const minutes = date.getMinutes();
  date.setMinutes(Math.ceil(minutes / stepMin) * stepMin, 0, 0);
  const p = partsInTz(date, displayTz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function humanDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!rest) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------ Avisos ------------------------------ */
let toastTimer = null;

function clearToast() {
  const box = $('#toast');
  if (!box) return;
  box.className = 'toast';
  box.innerHTML = '';
}

/**
 * Aviso efímero. Admite una acción opcional (botón) para reintentar.
 * @param {string} message
 * @param {''|'ok'|'err'|'warn'} type
 * @param {{actionLabel?:string, onAction?:Function, duration?:number}} [options]
 */
export function toast(message, type = '', options = {}) {
  const box = $('#toast');
  if (!box) return;
  const { actionLabel = '', onAction = null, duration } = options || {};
  box.innerHTML = '';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = String(message ?? '');
  box.appendChild(text);
  if (actionLabel && typeof onAction === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = actionLabel;
    button.addEventListener('click', () => {
      clearTimeout(toastTimer);
      clearToast();
      try { onAction(); } catch (error) { console.warn('[toast] la acción falló', error?.message || error); }
    }, { once: true });
    box.appendChild(button);
  }
  box.setAttribute('role', type === 'err' ? 'alert' : 'status');
  box.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  const ms = Number(duration) > 0 ? Number(duration) : (type === 'err' ? 6500 : 3200);
  toastTimer = setTimeout(clearToast, ms);
}

/** Datos de propuesta presentes en respuestas 202/executed. */
export function proposalDetails(payload) {
  const proposal = (payload && payload.proposal) || {};
  const id = proposal.id || payload?.proposalId || '';
  const level = proposal.level || payload?.level || '';
  const rawRisk = proposal.risk ?? proposal.card?.riskScore ?? payload?.risk;
  const risk = rawRisk && typeof rawRisk === 'object' ? rawRisk.score : rawRisk;
  const flags = Array.isArray(proposal.flags)
    ? proposal.flags
    : (Array.isArray(proposal.card?.flags) ? proposal.card.flags : (Array.isArray(payload?.flags) ? payload.flags : []));
  const parts = [
    id ? 'Propuesta ' + id : '',
    level ? 'nivel ' + level : '',
    risk !== undefined && risk !== null ? 'riesgo ' + risk + '/10' : '',
    flags.length ? flags.slice(0, 4).join(', ') : ''
  ].filter(Boolean);
  return { id, level, risk, flags, text: parts.join(' · ') };
}

/**
 * ¿Sigue pendiente de aprobación? Solo si hay propuesta y los campos lo dicen:
 * - status 'pending_approval', o
 * - approvalRequired === true y no está ejecutada.
 * Una respuesta 'executed' NUNCA es pendiente (aunque traiga proposal.id).
 */
export function isPendingApproval(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.proposal || !payload.proposal.id) return false;
  if (payload.executed === true || payload.status === 'executed') return false;
  if (payload.status === 'pending_approval') return true;
  return payload.approvalRequired === true && payload.executed !== true;
}

/** ¿Ya se envió por autonomía (status executed / executed:true)? */
export function isAutonomousSend(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.proposal || !payload.proposal.id) return false;
  return payload.executed === true || payload.status === 'executed';
}

/**
 * Aviso accesible de "enviado a la Oficina" con enlace a la propuesta.
 * No afirma que el envío se haya producido: solo que quedó preparado.
 */
export function approvalNoticeHTML(payload, fallback = 'Preparado y enviado a la Oficina para tu aprobación.') {
  const details = proposalDetails(payload);
  const message = payload?.message || '';
  const extra = message && message !== fallback ? '<p class="muted small">' + esc(message) + '</p>' : '';
  return '<div class="approval-notice">'
    + '<p><b>' + esc(fallback) + '</b></p>'
    + extra
    + '<p class="muted small">' + esc(details.text) + '</p>'
    + '<button type="button" class="primary small" data-go-approval="' + esc(details.id) + '">Ir a la Oficina</button>'
    + '</div>';
}

/**
 * Aviso accesible de "enviado automáticamente por autonomía": sin botón de
 * aprobar (ya salió) y con el detalle de la propuesta y del ledger.
 */
export function autonomousNoticeHTML(payload, fallback = 'Enviado automáticamente por autonomía.') {
  const details = proposalDetails(payload);
  const message = payload?.message || '';
  const extra = message && message !== fallback ? '<p class="muted small">' + esc(message) + '</p>' : '';
  return '<div class="approval-notice autonomous">'
    + '<p><b>' + esc(fallback) + '</b></p>'
    + extra
    + '<p class="muted small">' + esc(details.text) + '</p>'
    + '<p class="muted small">Quedó registrado en el ledger de la Oficina; no necesitas aprobarlo.</p>'
    + '</div>';
}

/* ------------------------------ Diálogos ------------------------------ */
export function openDialog(dialog) {
  const el = typeof dialog === 'string' ? $(dialog) : dialog;
  if (!el) return null;
  if (!el.open) {
    try { el.showModal(); } catch { el.setAttribute('open', ''); }
  }
  const focusable = el.querySelector('input:not([type="hidden"]),textarea,select,button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 40);
  return el;
}

export function closeDialog(dialog) {
  const el = typeof dialog === 'string' ? $(dialog) : dialog;
  if (el && el.open) el.close();
}

export function confirmDialog({ title = 'Confirmar', text = '', okLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  const dialog = $('#dlg-confirm');
  if (!dialog) return Promise.resolve(false);
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  const ok = $('#confirmOk');
  const cancel = $('#confirmCancel');
  ok.textContent = okLabel;
  ok.className = danger ? 'danger' : 'primary';
  cancel.textContent = cancelLabel;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    openDialog(dialog);
  });
}

export function promptDialog({ title = 'Escribe un valor', text = '', label = 'Valor', value = '', type = 'text', min, max, step } = {}) {
  const dialog = $('#dlg-prompt');
  if (!dialog) return Promise.resolve(null);
  $('#promptTitle').textContent = title;
  $('#promptText').textContent = text;
  $('#promptLabel').textContent = label;
  const form = $('#promptForm');
  const input = form.elements.value;
  input.type = type;
  input.value = value;
  for (const [prop, val] of Object.entries({ min, max, step })) {
    if (val === undefined || val === null) input.removeAttribute(prop);
    else input.setAttribute(prop, String(val));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      // Espera a que el evento close del diálogo anterior se drene antes de
      // resolver: permite abrir otro prompt inmediatamente sin que lo cierre.
      setTimeout(() => resolve(result), 0);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const raw = input.value.trim();
      if (!raw) { input.focus(); return; }
      finish(type === 'number' ? Number(raw) : raw);
    };
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
    openDialog(dialog);
    setTimeout(() => input.select(), 60);
  });
}

export function wireDialogCloseButtons() {
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close]');
    if (!closer) return;
    const dialog = closer.closest('dialog');
    if (dialog) dialog.close();
  });
}

/* ------------------------------ Varios ------------------------------ */
export function setBusy(button, busy, busyLabel = '') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spin" aria-hidden="true"></span>${busyLabel ? ` ${esc(busyLabel)}` : ''}`;
  } else {
    button.disabled = false;
    if (button.dataset.idleHtml) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
    }
  }
}

export function emptyState(text, icon = '✦') {
  return `<p class="empty"><span aria-hidden="true">${icon}</span> ${esc(text)}</p>`;
}

export function unavailableState({ title = 'No disponible en este servidor', detail = '', retry = null } = {}) {
  return `<div class="unavailable"><b>${esc(title)}</b><span>${esc(detail)}</span>${
    retry ? `<div class="actions"><button type="button" class="secondary small" data-retry="${esc(retry)}">Reintentar</button></div>` : ''
  }</div>`;
}

export function priorityBadge(priority) {
  const value = String(priority || 'P2').toUpperCase();
  const label = ['P1', 'P2', 'P3'].includes(value) ? value : 'P3';
  return `<span class="badge ${label}" aria-label="Prioridad ${label}">${label}</span>`;
}

export function scorePill(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '';
  return `<span class="score-pill" title="Score de prioridad 0–100">${Math.round(value)}</span>`;
}

export function humanFrequency(routine) {
  const frequency = String(routine?.frequency || 'DIARIA').toUpperCase();
  const rule = String(routine?.rule || '').toUpperCase();
  if (frequency === 'DIARIA') return 'Todos los días';
  if (frequency === 'LABORABLES') return 'Días laborables';
  if (frequency === 'SEMANAL') {
    const days = (rule.match(/(LUN|MAR|MIE|JUE|VIE|SAB|DOM)/g) || []).map((d) => WEEKDAY_LABELS[d]?.slice(0, 3) || d);
    return days.length ? `Cada ${days.join(', ')}` : 'Semanal';
  }
  if (frequency === 'MENSUAL') return `Día ${rule || '1'} de cada mes`;
  if (frequency === 'TRIMESTRAL') return `Día ${rule || '1'} cada trimestre`;
  return frequency;
}

export function normalizeRuleFromDays(days) {
  return [...new Set(days)].filter((day) => WEEKDAYS.includes(day)).join('-');
}

export function daysFromRule(rule) {
  const found = String(rule || '').toUpperCase().match(/(LUN|MAR|MIE|JUE|VIE|SAB|DOM)/g) || [];
  return [...new Set(found)];
}

export { WEEKDAYS, WEEKDAY_LABELS };

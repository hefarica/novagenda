/**
 * Módulos de oficina: catálogo con estado real, acceso directo y visibilidad
 * en el menú. Ocultar un módulo no borra datos ni apaga su API.
 */
import { api, formatError } from './api.js';
import { $, esc, toast } from './core.js';

let initialized = false;
const enabled = {};

const MODULES = [
  { key: 'approvals', title: 'Aprobaciones', desc: 'Lo que espera tu visto bueno', target: 'approvals' },
  { key: 'okr', title: 'Objetivos', desc: 'Metas y resultados clave', target: 'okr' },
  { key: 'rooms', title: 'Salas', desc: 'Reservas físicas sin cruces', target: 'rooms' },
  { key: 'attendance', title: 'Jornada', desc: 'Entrada, salida y horas', target: 'attendance' },
  { key: 'moments', title: 'Momentos', desc: 'Resumen semanal de la oficina', target: 'moments' },
  { key: 'base', title: 'Base', desc: 'Tablas y consultas naturales', target: 'base' },
  { key: 'docs', title: 'Documentos', desc: 'Word, Excel y PowerPoint reales', target: 'docs' },
  { key: 'wiki', title: 'Wiki', desc: 'Conocimiento en árbol', target: 'wiki' }
];

export function initModules() {
  if (initialized) return;
  initialized = true;
  $('#modulesGrid')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-module-target]');
    if (!button) return;
    if (enabled[button.dataset.moduleTarget] === false) {
      toast('Ese módulo está oculto. Actívalo en Ajustes.', 'err');
      return;
    }
    document.querySelector(`[data-nav="${button.dataset.moduleTarget}"]`)?.click();
  });
  $('#modulesGrid')?.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-module-toggle]');
    if (!input) return;
    const key = input.dataset.moduleToggle;
    input.disabled = true;
    try {
      const result = await api.patch(`/api/settings/modules/${encodeURIComponent(key)}`, { enabled: input.checked });
      enabled[key] = input.checked;
      const card = input.closest('.module-card');
      if (card) {
        card.classList.toggle('module-hidden', !input.checked);
        const open = card.querySelector('[data-module-target]');
        if (open) open.disabled = !input.checked;
        const label = input.closest('.module-visible')?.querySelector('span');
        if (label) label.textContent = input.checked ? 'Visible' : 'Oculto';
      }
      document.dispatchEvent(new CustomEvent('modules:visibility', { detail: { ...enabled } }));
      toast(input.checked ? 'Módulo visible en el menú' : 'Módulo oculto del menú', 'ok');
      if (!input.checked) {
        const current = document.querySelector('.view.active')?.id || '';
        if (current === `view-${key}`) document.querySelector('[data-nav="home"]')?.click();
      }
    } catch (error) {
      input.checked = !input.checked;
      toast(formatError(error), 'err');
    } finally {
      input.disabled = false;
    }
  });
}

export async function renderModules() {
  if (!initialized) initModules();
  const box = $('#modulesGrid');
  if (!box) return;
  const [approvals, okr, rooms, attendance, moments, base, docs, wiki, settings] = await Promise.all([
    api.get('/api/office/proposals?status=pending&limit=1').catch(() => null),
    api.get('/api/okr/stats').catch(() => null),
    api.get('/api/rooms/stats').catch(() => null),
    api.get('/api/attendance/summary').catch(() => null),
    api.get('/api/moments/weekly').catch(() => null),
    api.get('/api/base/tables').catch(() => null),
    api.get('/api/docs?limit=1').catch(() => null),
    api.get('/api/wiki/stats').catch(() => null),
    api.get('/api/settings/modules').catch(() => null)
  ]);
  const status = {
    approvals: `${approvals?.total ?? approvals?.count ?? 0} pendiente(s)`,
    okr: `${okr?.total ?? 0} objetivo(s)`,
    rooms: `${rooms?.rooms ?? 0} sala(s)`,
    attendance: `${attendance?.hours ?? 0} h esta semana`,
    moments: moments?.today ? `hoy ${moments.today}` : 'sin resumen',
    base: `${base?.count ?? (base?.items || []).length} tabla(s)`,
    docs: `${docs?.total ?? docs?.count ?? 0} documento(s)`,
    wiki: `${wiki?.pages ?? wiki?.count ?? 0} página(s)`
  };
  for (const item of settings?.items || []) enabled[item.key] = item.enabled !== false;
  box.innerHTML = MODULES.map((mod) => {
    const visible = enabled[mod.key] !== false;
    return `
    <div class="module-card${visible ? '' : ' module-hidden'}">
      <b>${esc(mod.title)}</b>
      <small>${esc(mod.desc)} · ${esc(status[mod.key] || '—')}</small>
      <label class="module-visible"><input type="checkbox" data-module-toggle="${esc(mod.key)}" ${visible ? 'checked' : ''} /><span>${visible ? 'Visible' : 'Oculto'}</span></label>
      <button type="button" class="ghost small" data-module-target="${esc(mod.target)}" ${visible ? '' : 'disabled'}>Abrir</button>
    </div>`;
  }).join('');
}


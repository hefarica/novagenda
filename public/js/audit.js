/**
 * Auditoría: consulta filtrable del ledger y verificación de la cadena.
 */
import { api, formatError } from './api.js';
import { $, esc, toast, setBusy, emptyState } from './core.js';

let initialized = false;
let current = { items: [], total: 0, ledgerTotal: 0, stats: null, filters: {} };

export function initAudit() {
  if (initialized) return;
  initialized = true;

  $('#auditFilters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    load().catch(() => {});
  });
  $('#auditReset')?.addEventListener('click', () => {
    $('#auditFilters')?.reset();
    load().catch(() => {});
  });
  $('#auditRefresh')?.addEventListener('click', () => load().catch(() => {}));
  $('#auditVerify')?.addEventListener('click', verifyChain);
  $('#auditExportJson')?.addEventListener('click', () => exportFile('json'));
  $('#auditExportCsv')?.addEventListener('click', () => exportFile('csv'));
}

export function renderAudit() {
  if (!initialized) initAudit();
  load().catch(() => {});
}

function filtersOf() {
  const form = $('#auditFilters');
  const data = new FormData(form);
  const out = {};
  for (const key of ['actor', 'action', 'q', 'from', 'to']) {
    const value = String(data.get(key) || '').trim();
    if (value) out[key] = value;
  }
  return out;
}

function queryStringOf(extra = {}) {
  const params = new URLSearchParams({ ...filtersOf(), ...extra });
  return params.toString();
}

async function load() {
  const params = queryStringOf({ limit: '200' });
  const [events, stats] = await Promise.all([
    api.get(`/api/audit/events?${params}`),
    api.get('/api/audit/stats')
  ]);
  current = {
    items: Array.isArray(events?.items) ? events.items : [],
    total: Number(events?.total) || 0,
    ledgerTotal: Number(events?.ledgerTotal) || 0,
    stats: stats || null,
    filters: events?.filters || filtersOf()
  };
  renderStats();
  renderTable();
}

function renderStats() {
  const box = $('#auditStats');
  const verifyBox = $('#auditVerifyResult');
  const stats = current.stats;
  if (box && stats) {
    const last = stats.lastTs ? new Date(stats.lastTs).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    box.textContent = `${stats.total ?? 0} evento(s) · ${(stats.actors || []).length} actor(es) · último: ${last}`;
  }
  if (verifyBox && stats?.verification) {
    const v = stats.verification;
    verifyBox.className = v.ok ? 'hint ok' : 'hint bad';
    verifyBox.textContent = v.ok
      ? `Cadena íntegra · cabeza ${String(v.head || '').slice(0, 12)}…`
      : `Cadena rota en ${v.broken || 0} punto(s). Revisa el ledger antes de confiar en estos datos.`;
  }
}

function renderTable() {
  const box = $('#auditTable');
  const count = $('#auditCount');
  if (count) count.textContent = `${current.total} de ${current.ledgerTotal} evento(s)`;
  if (!box) return;
  if (!current.items.length) {
    box.innerHTML = emptyState('No hay eventos que coincidan con el filtro.', '◎');
    return;
  }
  box.innerHTML = `
    <div class="base-table-wrap">
      <table class="base-table">
        <thead><tr><th>#</th><th>Fecha</th><th>Actor</th><th>Acción</th><th>Huella</th><th>Detalle</th></tr></thead>
        <tbody>
          ${current.items.map((entry) => `
            <tr>
              <td>${Number(entry.seq) || ''}</td>
              <td>${esc(formatDate(entry.ts))}</td>
              <td>${esc(entry.actor || '')}</td>
              <td>${esc(entry.action || '')}</td>
              <td class="audit-hash">${esc(String(entry.hash || '').slice(0, 10))}…</td>
              <td>
                <details>
                  <summary class="muted small">Payload</summary>
                  <pre class="audit-payload">${esc(JSON.stringify(entry.payload || {}, null, 2))}</pre>
                  <small class="audit-hash">prev ${esc(String(entry.prevHash || '').slice(0, 10))}… · ${esc(entry.payloadHash || '')}</small>
                </details>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'medium' });
}

async function verifyChain() {
  const button = $('#auditVerify');
  setBusy(button, true);
  try {
    const stats = await api.get('/api/audit/stats');
    current.stats = stats;
    renderStats();
    toast(stats?.verification?.ok ? 'Cadena íntegra' : 'La cadena tiene rupturas', stats?.verification?.ok ? 'ok' : 'err');
  } catch (error) {
    toast(formatError(error), 'err');
  } finally {
    setBusy(button, false);
  }
}

function exportFile(format) {
  const url = `/api/audit/export?${queryStringOf({ format })}`;
  window.open(url, '_blank', 'noopener');
}

/**
 * Consultas de auditoría sobre el ledger de la Oficina.
 *
 * El ledger es append-only: aquí solo se lee, filtra y exporta. La verificación
 * de la cadena la sigue haciendo `verifyLedger`.
 */
import { verifyLedger } from '../office/ledger.mjs';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

function normalize(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function matches(entry, filters) {
  const actor = normalize(filters.actor).toLowerCase();
  const action = normalize(filters.action).toLowerCase();
  const query = normalize(filters.q).toLowerCase();
  if (actor && String(entry.actor || '').toLowerCase() !== actor) return false;
  if (action && !String(entry.action || '').toLowerCase().includes(action)) return false;
  if (filters.from && String(entry.ts || '').slice(0, 10) < filters.from) return false;
  if (filters.to && String(entry.ts || '').slice(0, 10) > filters.to) return false;
  if (query) {
    const haystack = `${entry.actor || ''} ${entry.action || ''} ${JSON.stringify(entry.payload || {})}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function auditFilters(input = {}) {
  const from = normalize(input.from, 10);
  const to = normalize(input.to, 10);
  if (from && !isValidDateKey(from)) {
    throw Object.assign(new Error('from debe ser una fecha real AAAA-MM-DD.'), { status: 400, code: 'INVALID_DATE', field: 'from' });
  }
  if (to && !isValidDateKey(to)) {
    throw Object.assign(new Error('to debe ser una fecha real AAAA-MM-DD.'), { status: 400, code: 'INVALID_DATE', field: 'to' });
  }
  if (from && to && from > to) {
    throw Object.assign(new Error('from no puede ser posterior a to.'), { status: 400, code: 'INVALID_RANGE', field: 'from' });
  }
  return {
    actor: normalize(input.actor),
    action: normalize(input.action),
    q: normalize(input.q),
    from: from || null,
    to: to || null
  };
}

export function auditQuery(data, input = {}) {
  const filters = auditFilters(input);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(Number(input.limit) || DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.round(Number(input.offset) || 0));
  const ledger = Array.isArray(data?.office?.ledger) ? data.office.ledger : [];
  const matched = [...ledger].reverse().filter((entry) => matches(entry, filters));
  const items = matched.slice(offset, offset + limit).map((entry) => ({
    seq: entry.seq,
    ts: entry.ts,
    actor: entry.actor,
    action: entry.action,
    payload: entry.payload,
    payloadHash: entry.payloadHash,
    prevHash: entry.prevHash,
    hash: entry.hash
  }));
  return {
    items,
    count: items.length,
    total: matched.length,
    ledgerTotal: ledger.length,
    limit,
    offset,
    filters
  };
}

export function auditStats(data) {
  const ledger = Array.isArray(data?.office?.ledger) ? data.office.ledger : [];
  const actors = new Map();
  const actions = new Map();
  for (const entry of ledger) {
    const actor = String(entry.actor || 'sistema');
    const action = String(entry.action || 'evento');
    actors.set(actor, (actors.get(actor) || 0) + 1);
    actions.set(action, (actions.get(action) || 0) + 1);
  }
  const top = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }));
  const verification = verifyLedger(data);
  return {
    total: ledger.length,
    firstTs: ledger[0]?.ts || null,
    lastTs: ledger[ledger.length - 1]?.ts || null,
    actors: top(actors),
    actions: top(actions),
    verification: {
      ok: verification.ok !== false && !(verification.broken || []).length,
      broken: (verification.broken || []).length,
      head: verification.head || null
    }
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  // Evita que una hoja de cálculo interprete el valor como fórmula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditCsv(data, input = {}) {
  const result = auditQuery(data, { ...input, limit: MAX_LIMIT, offset: 0 });
  const header = ['seq', 'ts', 'actor', 'action', 'payload', 'payloadHash', 'prevHash', 'hash'];
  const lines = [header.join(',')];
  for (const entry of result.items) {
    lines.push([
      entry.seq,
      entry.ts,
      entry.actor,
      entry.action,
      JSON.stringify(entry.payload ?? {}),
      entry.payloadHash,
      entry.prevHash,
      entry.hash
    ].map(csvCell).join(','));
  }
  return { csv: `${lines.join('\r\n')}\r\n`, total: result.total };
}

export function auditExport(data, input = {}) {
  const result = auditQuery(data, { ...input, limit: MAX_LIMIT, offset: 0 });
  return {
    app: 'Agenda Copilot P95',
    document: 'auditoria',
    exportedAt: new Date().toISOString(),
    filters: result.filters,
    verification: auditStats(data).verification,
    total: result.total,
    entries: result.items
  };
}


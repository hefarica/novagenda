/* Prueba: las propuestas pendientes generan un aviso consolidado y ordenado por antigüedad. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-nudge-approvals-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';

const { collectCandidates } = await import('../lib/nudges/detect.mjs');
const { DEFAULT_CONFIG } = await import('../lib/nudges/config.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const now = new Date('2026-10-28T15:00:00.000Z');
const settings = { timezone: 'America/Bogota' };
const isoAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const base = {
  settings, agenda: [], inbox: [], recurrences: [], meetings: [], metrics: [], tasks: [], imapAccounts: []
};

const data = {
  ...base,
  office: {
    proposals: [
      { id: 'OF-0001', status: 'pending', subject: 'Acta de liberación del predio', createdAt: isoAgo(5), level: 'N2' },
      { id: 'OF-0002', status: 'pending', subject: 'Carta a Catastro', createdAt: isoAgo(2), level: 'N2' },
      { id: 'OF-0003', status: 'held', subject: 'Solicitud de aplazamiento', createdAt: isoAgo(0.5), level: 'N1' },
      { id: 'OF-0004', status: 'approved', subject: 'Ya aprobada', createdAt: isoAgo(9), level: 'N2' },
      { id: 'OF-0005', status: 'executed', subject: 'Ya ejecutada', createdAt: isoAgo(9), level: 'N2' }
    ]
  }
};

const { items } = await collectCandidates({ data, settings, now, config: DEFAULT_CONFIG });
const approvals = items.filter((item) => item.type === 'approvals');
check('Consolida las pendientes en un solo aviso', approvals.length === 1, JSON.stringify(approvals).slice(0, 160));
const item = approvals[0] || {};
check('Cuenta las pendientes y retenidas', item.count === 3, `count=${item.count}`);
check('Nombra la más antigua primero', /Acta de liberación/.test(item.title || '') && item.oldestId === 'OF-0001', `${item.title} · ${item.oldestId}`);
check('Calcula la antigüedad de la más vieja', Math.abs(Number(item.ageHours) - 5) < 0.05, `ageHours=${item.ageHours}`);
check('Conserva un resumen de las tres', Array.isArray(item.proposals) && item.proposals.length === 3 && item.proposals[0].id === 'OF-0001');

const onlyApproved = await collectCandidates({
  data: { ...base, office: { proposals: [{ id: 'OF-9', status: 'approved', subject: 'Lista', createdAt: isoAgo(4) }] } },
  settings, now, config: DEFAULT_CONFIG
});
check('Sin pendientes no hay aviso', !onlyApproved.items.some((entry) => entry.type === 'approvals'));

const recent = await collectCandidates({
  data: { ...base, office: { proposals: [{ id: 'OF-7', status: 'pending', subject: 'Recién creada', createdAt: isoAgo(0.1) }] } },
  settings, now, config: DEFAULT_CONFIG
});
const recentItem = recent.items.find((entry) => entry.type === 'approvals');
check('Una sola pendiente también se avisa', !!recentItem && recentItem.count === 1 && /Recién creada/.test(recentItem.title));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

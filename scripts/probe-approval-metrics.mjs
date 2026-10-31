/* Prueba determinista de métricas de aprobación. */
import { approvalMetrics } from '../lib/office/metrics.mjs';

const now = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
const data = {
  office: {
    proposals: [
      { id: 'OF-1', status: 'pending', level: 'N2', createdAt: iso(26) },
      { id: 'OF-2', status: 'held', level: 'N3', createdAt: iso(2) },
      { id: 'OF-3', status: 'approved', level: 'N2', createdAt: iso(4), approvedAt: iso(1) },
      { id: 'OF-4', status: 'executed', level: 'N2', createdAt: iso(10), approvedAt: iso(8), executedAt: iso(6) },
      { id: 'OF-5', status: 'rejected', level: 'N2', createdAt: iso(3), rejectedAt: iso(1) }
    ]
  },
  quarantine: {
    items: [
      { id: 'Q1', status: 'held' },
      { id: 'Q2', status: 'released' }
    ]
  }
};
const m = approvalMetrics(data, { now, slaHours: 24, windowDays: 7 });

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
check('Cuenta estados', m.pending === 1 && m.held === 1 && m.approved === 1 && m.executed === 1 && m.rejected === 1, JSON.stringify({ pending: m.pending, held: m.held, approved: m.approved }));
check('Detecta la más antigua y el SLA', m.oldestPendingHours === 26 && m.slaBreaches === 1, `${m.oldestPendingHours} h · ${m.slaBreaches} fuera`);
check('Calcula tiempos de aprobación', m.averageApprovalHours === 2.5 && m.medianApprovalHours === 2.5, `${m.averageApprovalHours} h`);
check('Calcula tiempo de ejecución', m.averageExecutionHours === 2, `${m.averageExecutionHours} h`);
check('Actividad de la ventana', m.recent.approved === 2 && m.recent.rejected === 1 && m.recent.executed === 1, JSON.stringify(m.recent));
check('Niveles y cuarentena', m.byLevel.N2 === 1 && m.byLevel.N3 === 1 && m.quarantine === 1, JSON.stringify(m.byLevel));

const empty = approvalMetrics({}, { now });
check('Sin datos no inventa promedios', empty.total === 0 && empty.averageApprovalHours === null && empty.oldestPendingHours === null);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


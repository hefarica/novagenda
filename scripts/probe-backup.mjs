/* Prueba determinista de la copia de seguridad. */
import { buildOfficeExport } from '../lib/admin/export.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const data = {
  agenda: [{ id: 'EV-1', title: 'Cita' }],
  tasks: [{ id: 'TK-1', title: 'Tarea' }],
  recurrences: [{ id: 'RC-1' }],
  office: { proposals: [{ id: 'OF-1' }], ledger: [{ seq: 1 }] },
  okr: { objectives: [{ id: 'OK-1' }] },
  rooms: { items: [{ id: 'RM-1' }], reservations: [{ id: 'RS-1' }] },
  attendance: { entries: [{ id: 'AT-1' }] },
  base: { tables: [{ id: 'TB-1' }] },
  wiki: { pages: [{ id: 'WP-1' }] },
  approvals: { types: [{ id: 'APT-1' }], requests: [{ id: 'APR-1' }] },
  vault: { password: 'NO_DEBE_SALIR' },
  channels: { token: 'NO_DEBE_SALIR' },
  llm: { apiKey: 'NO_DEBE_SALIR' }
};
const bundle = buildOfficeExport(data, { now: new Date('2026-10-28T12:00:00Z') });
check('Formato y fecha', bundle.format === 'agenda-copilot-export' && bundle.generatedAt.startsWith('2026-10-28'));
check('Cuenta datos', bundle.counts.agenda === 1 && bundle.counts.tasks === 1 && bundle.counts.okr === 1 && bundle.counts.rooms === 1 && bundle.counts.attendance === 1 && bundle.counts.baseTables === 1);
check('Incluye oficina y aprobaciones', bundle.data.office.proposals.length === 1 && bundle.data.approvals.types.length === 1);
const raw = JSON.stringify(bundle);
check('No exporta secretos', !/NO_DEBE_SALIR|"apiKey"|"password"/i.test(raw), raw.match(/NO_DEBE_SALIR/) ? 'fuga' : 'limpio');
check('Aviso de alcance', /No incluye contraseñas/i.test(bundle.notice));
check('Documentos como metadatos', Array.isArray(bundle.data.documents) && !('buffer' in (bundle.data.documents[0] || {})));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

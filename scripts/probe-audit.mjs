/* Prueba determinista de las consultas de auditoría (sin servidor). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-audit-probe-'));
process.env.APP_SECRET = 'audit-probe-secret-0123456789';

const { appendLedger } = await import('../lib/office/ledger.mjs');
const { auditCsv, auditQuery, auditStats } = await import('../lib/audit/index.mjs');

const data = {};
appendLedger(data, { actor: 'lingo', action: 'lingo.change', payload: { term: 'Palmira', status: 'shadow' } });
appendLedger(data, { actor: 'oficina', action: 'propuesta.creada', payload: { proposalId: 'PR-0001' } });
appendLedger(data, { actor: 'lingo', action: 'lingo.change', payload: { term: '=Catastro', status: 'approved' } });

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const all = auditQuery(data, {});
check('Lista el ledger más reciente primero', all.total === 3 && all.items[0].payload.term === '=Catastro', `total ${all.total}`);
check('Filtra por actor', auditQuery(data, { actor: 'lingo' }).total === 2);
check('Filtra por acción y texto', auditQuery(data, { action: 'propuesta', q: 'PR-0001' }).total === 1);

let bad = null;
try { auditQuery(data, { from: '2026-02-31' }); } catch (error) { bad = error; }
check('Rechaza fecha inexistente', bad?.status === 400 && bad?.code === 'INVALID_DATE', bad?.message);
let range = null;
try { auditQuery(data, { from: '2026-12-31', to: '2026-01-01' }); } catch (error) { range = error; }
check('Rechaza rango invertido', range?.status === 400 && range?.code === 'INVALID_RANGE', range?.message);

const stats = auditStats(data);
check('Estadísticas y cadena íntegra', stats.total === 3 && stats.verification.ok === true && stats.actors[0].name === 'lingo', JSON.stringify(stats.actors));

appendLedger(data, { actor: '=HYPERLINK("http://x")', action: 'prueba', payload: {} });
const csv = auditCsv(data, {}).csv;
check('CSV con cabecera y fórmula neutralizada', csv.startsWith('seq,ts,actor,action') && csv.includes('"lingo.change"') && csv.includes(`"'=HYPERLINK(""http://x"")"`), csv.slice(0, 80).replace(/\r?\n/g, ' | '));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


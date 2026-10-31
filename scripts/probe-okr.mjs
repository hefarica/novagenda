/* Prueba determinista de OKR (sin servidor). */
import {
  addKeyResult, createObjective, deleteObjective, listObjectives, okrStats, updateKeyResult, updateObjective
} from '../lib/okr/store.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const data = {};
const okr = createObjective(data, { title: 'Cerrar actas 2026', owner: 'Héctor', quarter: '2026-Q4' });
check('Crea objetivo', okr.id === 'OK-0001' && okr.status === 'active' && okr.progress === 0);
const withKr = addKeyResult(data, okr.id, { title: 'Actas firmadas', target: 3, current: 1, unit: 'actas' });
check('Añade resultado y calcula 33 %', withKr.progress === 33 && withKr.keyResults[0].progress === 33);
const two = addKeyResult(data, okr.id, { title: 'Predios liberados', target: 2, current: 2 });
check('Promedia dos resultados', two.progress === 67, `${two.progress}%`);
const advanced = updateKeyResult(data, okr.id, 'KR-0001', { current: 2 });
check('Actualiza avance', advanced.progress === 83, `${advanced.progress}%`);
const done = updateObjective(data, okr.id, { status: 'done' });
check('Cambia estado a cumplido', done.status === 'done');
const stats = okrStats(data);
check('Estadísticas', stats.total === 1 && stats.done === 1 && stats.active === 0, JSON.stringify(stats));
const listed = listObjectives(data, { status: 'done', q: 'actas' });
check('Lista y filtra', listed.items.length === 1 && listed.items[0].id === 'OK-0001');
let invalid = null;
try { addKeyResult(data, okr.id, { title: 'Malo', target: 0 }); } catch (error) { invalid = error; }
check('Rechaza meta inválida', invalid?.status === 400 && invalid?.code === 'INVALID_VALUE', invalid?.message);
const deleted = deleteObjective(data, okr.id);
check('Borra objetivo', deleted.id === 'OK-0001' && okrStats(data).total === 0);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

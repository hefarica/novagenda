import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-basecoldel-'));
process.env.DATA_DIR = dir;
const { addColumn, addRow, createTable, createView, deleteColumn, getTable } = await import('../lib/base/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const table = await createTable({ name: 'Predios', columns: 'Nombre:texto, Área:número' });
await addRow(table.id, { c1: 'El Roble', c2: 10 });
await addColumn(table.id, { name: 'Estado', type: 'texto' });
await addRow(table.id, { c1: 'La Esperanza', c3: 'Activo' });
await createView(table.id, { name: 'Solo activos', filters: [{ columnId: 'c3', op: 'contains', value: 'Activo' }], sort: { columnId: 'c3', direction: 'asc' } });
await createView(table.id, { name: 'Por nombre', filters: [{ columnId: 'c1', op: 'contains', value: 'El' }] });
const result = await deleteColumn(table.id, 'c3');
check('Elimina la columna', result.column.id === 'c3' && !getTable(table.id).columns.some((column) => column.id === 'c3'));
check('Elimina sus valores en las filas', getTable(table.id).rows.every((row) => !Object.prototype.hasOwnProperty.call(row.values, 'c3')));
check('Conserva las demás columnas y filas', getTable(table.id).columns.length === 2 && getTable(table.id).rows.length === 2);
check('Elimina la vista dependiente', result.removedViews.includes('Solo activos') && getTable(table.id).views.length === 1, JSON.stringify(result.removedViews));
check('Conserva la vista independiente', getTable(table.id).views[0].name === 'Por nombre');
const single = await createTable({ name: 'Una', columns: 'Solo:texto' });
let last = null;
try { await deleteColumn(single.id, 'c1'); } catch (error) { last = error; }
check('Rechaza eliminar la última columna', last?.status === 409 && last?.code === 'LAST_COLUMN');
let missing = null;
try { await deleteColumn(table.id, 'c99'); } catch (error) { missing = error; }
check('Rechaza columna inexistente', missing?.status === 404);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

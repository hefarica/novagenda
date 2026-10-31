import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-duplicaterow-'));
process.env.DATA_DIR = dir;
const { addRow, createTable, duplicateRow, getTable } = await import('../lib/base/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const table = await createTable({ name: 'Predios', columns: 'Nombre:texto, Área:número' });
const first = await addRow(table.id, { c1: 'El Roble', c2: 10 });
const copy = await duplicateRow(table.id, first.id);
const rows = getTable(table.id).rows;
check('Duplica la fila', rows.length === 2 && copy.id === 'ROW-0002', copy.id);
check('Copia los valores', copy.values.c1 === 'El Roble' && copy.values.c2 === 10, JSON.stringify(copy.values));
check('La inserta después del original', rows[0].id === first.id && rows[1].id === copy.id);
check('El original queda intacto', rows[0].values.c1 === 'El Roble');
let missing = null;
try { await duplicateRow(table.id, 'ROW-9999'); } catch (error) { missing = error; }
check('Rechaza fila inexistente', missing?.status === 404);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-basecolumn-'));
process.env.DATA_DIR = dir;
const { addColumn, addRow, createTable, getTable, renameColumn } = await import('../lib/base/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const table = await createTable({ name: 'Predios', columns: 'Nombre:texto, Área:número' });
await addRow(table.id, { c1: 'El Roble', c2: 10 });
const result = await addColumn(table.id, { name: 'Estado', type: 'texto' });
check('Agrega columna al final', result.column.id === 'c3' && result.column.name === 'Estado' && result.column.type === 'text', JSON.stringify(result.column));
check('Conserva filas existentes', getTable(table.id).rows.length === 1 && getTable(table.id).rows[0].values.c1 === 'El Roble');
check('La tabla expone la columna', getTable(table.id).columns.length === 3 && getTable(table.id).columns[2].id === 'c3');
const second = await addColumn(table.id, { name: 'Pagado', type: 'casilla' });
check('Segunda columna usa c4', second.column.id === 'c4' && second.column.type === 'checkbox');
let duplicate = null;
try { await addColumn(table.id, { name: 'estado', type: 'texto' }); } catch (error) { duplicate = error; }
check('Rechaza nombre duplicado', duplicate?.status === 409 && duplicate?.code === 'DUPLICATE');
let badType = null;
try { await addColumn(table.id, { name: 'Raro', type: 'binario' }); } catch (error) { badType = error; }
check('Rechaza tipo inválido', badType?.status === 400);
const wide = await createTable({ name: 'Ancha', columns: Array.from({ length: 12 }, (_, index) => `C${index + 1}:texto`).join(', ') });
let limit = null;
try { await addColumn(wide.id, { name: 'Extra', type: 'texto' }); } catch (error) { limit = error; }
check('Respeta el máximo de columnas', limit?.status === 409 && limit?.code === 'COLUMN_LIMIT');
const renamed = await renameColumn(table.id, 'c3', 'Situación');
check('Renombra columna sin cambiar id', renamed.column.id === 'c3' && renamed.column.name === 'Situación' && getTable(table.id).rows[0].values.c1 === 'El Roble');
let duplicateColumn = null;
try { await renameColumn(table.id, 'c4', 'situación'); } catch (error) { duplicateColumn = error; }
check('Rechaza nombre de columna duplicado', duplicateColumn?.status === 409 && duplicateColumn?.code === 'DUPLICATE');
let missingColumn = null;
try { await renameColumn(table.id, 'c99', 'Nada'); } catch (error) { missingColumn = error; }
check('Rechaza columna inexistente', missingColumn?.status === 404);
rmSync(dir, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-baserename-'));
process.env.DATA_DIR = dir;
const { addRow, createTable, getTable, listTables, renameTable } = await import('../lib/base/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const table = await createTable({ name: 'Predios', columns: 'Nombre:texto, Área:número' });
const second = await createTable({ name: 'Contactos', columns: 'Nombre:texto' });
await addRow(table.id, { c1: 'El Roble', c2: 10 });
const renamed = await renameTable(table.id, 'Predios y linderos');
check('Renombra la tabla', renamed.id === table.id && renamed.name === 'Predios y linderos');
check('Conserva columnas y filas', getTable(table.id).rows.length === 1 && getTable(table.id).columns.length === 2);
check('Aparece en el listado', listTables().some((item) => item.id === table.id && item.name === 'Predios y linderos'));
let duplicate = null;
try { await renameTable(table.id, 'Contactos'); } catch (error) { duplicate = error; }
check('Rechaza nombre duplicado', duplicate?.status === 409 && duplicate?.code === 'DUPLICATE');
let empty = null;
try { await renameTable(table.id, '   '); } catch (error) { empty = error; }
check('Rechaza nombre vacío', empty?.status === 400);
let notFound = null;
try { await renameTable('TB-9999', 'Fantasma'); } catch (error) { notFound = error; }
check('Rechaza tabla inexistente', notFound?.status === 404);
check('No altera la otra tabla', getTable(second.id).name === 'Contactos');
rmSync(dir, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

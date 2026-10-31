/* Prueba determinista de vistas guardadas de Base. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-baseviews-'));
process.env.DATA_DIR = dir;
const { createTable, createView, deleteView, getTable } = await import('../lib/base/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const table = await createTable({ name: 'Vistas E2E', columns: 'Predio:texto, Área:número, Pagado:casilla' });
const view = await createView(table.id, { name: 'Pagados', filters: [{ columnId: 'c3', op: 'eq', value: 'Sí' }] });
check('Crea vista', view.id === 'BV-0001' && view.name === 'Pagados' && view.filters.length === 1);
check('La tabla incluye la vista', getTable(table.id).views.length === 1 && getTable(table.id).views[0].name === 'Pagados');
let duplicate = null;
try { await createView(table.id, { name: 'Pagados', filters: [{ columnId: 'c1', op: 'contains', value: 'x' }] }); } catch (error) { duplicate = error; }
check('Rechaza nombre duplicado', duplicate?.status === 409);
let invalid = null;
try { await createView(table.id, { name: 'Mala', filters: [{ columnId: 'c99', op: 'eq', value: 'x' }] }); } catch (error) { invalid = error; }
check('Rechaza columna inexistente', invalid?.status === 400);
let empty = null;
try { await createView(table.id, { name: 'Vacía', filters: [] }); } catch (error) { empty = error; }
check('Exige al menos un filtro', empty?.status === 400);
const second = await createView(table.id, { name: 'Área alta', filters: [{ columnId: 'c2', op: 'gte', value: '100' }], sort: { columnId: 'c2', direction: 'desc' } });
check('Segunda vista con filtro y orden', second.id === 'BV-0002' && getTable(table.id).views.length === 2 && second.sort?.columnId === 'c2' && second.sort?.direction === 'desc');
let badSort = null;
try { await createView(table.id, { name: 'Orden mala', filters: [{ columnId: 'c2', op: 'gte', value: '1' }], sort: { columnId: 'c99', direction: 'asc' } }); } catch (error) { badSort = error; }
check('Rechaza orden por columna inexistente', badSort?.status === 400);
const removed = await deleteView(table.id, view.id);
check('Borra vista sin tocar filas', removed.id === view.id && getTable(table.id).views.length === 1);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


/* Prueba determinista de importación CSV a Base. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-baseimport-'));
process.env.DATA_DIR = dir;
const { parseCsv, rowsFromCsv } = await import('../lib/base/csv.mjs');
const { createTable, getTable, importRows } = await import('../lib/base/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const parsed = parseCsv('\uFEFFPredio,Área\r\n"El Roble, lote 2",1250.5\r\n"Dice ""hola""",0\r\n');
check('Parser respeta BOM, comas y comillas', parsed.length === 3 && parsed[1][0] === 'El Roble, lote 2' && parsed[2][0] === 'Dice "hola"');
const table = await createTable({ name: 'Importación E2E', columns: 'Predio:texto, Área:número, Pagado:casilla, Entrega:fecha' });
const rows = rowsFromCsv('Predio,Área,Pagado,Entrega\nEl Roble,10,Sí,2026-10-30\nLa Palma,20,No,2026-11-01\n', table.columns);
check('Mapea cabeceras y tipos', rows.length === 2 && rows[0].c3 === true && rows[1].c3 === false);
const created = await importRows(table.id, rows);
check('Importa filas', created.length === 2 && created[0].id === 'ROW-0001' && created[1].id === 'ROW-0002');
const stored = getTable(table.id);
check('Guarda valores convertidos', stored.rows.length === 2 && stored.rows[0].values.c2 === 10 && stored.rows[0].values.c4 === '2026-10-30');
const formula = rowsFromCsv('Predio,Área,Pagado,Entrega\n\'=SUM(A1:A2),1,No,2026-10-30\n', table.columns);
check('Quita apóstrofo de fórmula exportada', formula[0].c1 === '=SUM(A1:A2)');
let unknown = null;
try { rowsFromCsv('Predio,Nombre\nA,B\n', table.columns); } catch (error) { unknown = error; }
check('Rechaza columna desconocida', /Columna desconocida/.test(unknown?.message || ''));
let invalid = null;
try { await importRows(table.id, [{ c1: 'Mala', c2: 'no-numero', c3: false, c4: '2026-10-30' }]); } catch (error) { invalid = error; }
check('Rechaza número inválido', Boolean(invalid));
check('No deja fila a medias', getTable(table.id).rows.length === 2);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

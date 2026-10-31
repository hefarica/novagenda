/* Prueba determinista de Preguntar a la Base. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-ask-base-'));
process.env.DATA_DIR = dir;
const { createTable, addRow } = await import('../lib/base/store.mjs');
const { askBase } = await import('../lib/base/ask.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const predios = await createTable({ name: 'Predios', columns: 'Nombre:texto, Estado:texto, Valor:número' });
const contactos = await createTable({ name: 'Contactos', columns: 'Nombre:texto, Ciudad:texto' });
const c = Object.fromEntries(predios.columns.map((column) => [column.name, column.id]));
await addRow(predios.id, { [c.Nombre]: 'Predio Norte', [c.Estado]: 'pagado', [c.Valor]: 150 });
await addRow(predios.id, { [c.Nombre]: 'Predio Sur', [c.Estado]: 'pagado', [c.Valor]: 80 });
await addRow(predios.id, { [c.Nombre]: 'Predio Centro', [c.Estado]: 'pendiente', [c.Valor]: 200 });
const cc = Object.fromEntries(contactos.columns.map((column) => [column.name, column.id]));
await addRow(contactos.id, { [cc.Nombre]: 'Andrés', [cc.Ciudad]: 'Cali' });

const count = askBase('¿cuántos predios con estado = pagado?');
check('Cuenta con filtro de texto', count.matched === 2 && /Predios/.test(count.answer), count.answer);
const number = askBase('predios con valor mayor que 100');
check('Filtra por número', number.matched === 2, `${number.matched}`);
const contains = askBase('predios donde nombre contiene Norte');
check('Filtra por contiene', contains.matched === 1 && contains.rows[0].values.Nombre === 'Predio Norte', JSON.stringify(contains.rows[0]));
const total = askBase('¿cuántos predios hay?');
check('Conteo sin filtro', total.matched === 3 && total.note, total.answer);
const ambiguous = askBase('¿cuántos registros hay?');
check('Avisa ambigüedad de tabla', ambiguous.ambiguous === true && /Predios/.test(ambiguous.answer), ambiguous.answer);
const other = askBase('contactos con ciudad = Cali');
check('Elige otra tabla por nombre', other.table?.name === 'Contactos' && other.matched === 1, other.answer);
let invalid = null;
try { askBase(''); } catch (error) { invalid = error; }
check('Rechaza pregunta vacía', invalid?.status === 400);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


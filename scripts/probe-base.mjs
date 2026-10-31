/* Prueba: Base de tablas con columnas tipadas y filas editables. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-base-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';

const {
  addRow, createTable, deleteRow, deleteTable, getTable, listTables, updateRow
} = await import('../lib/base/store.mjs');
const { store } = await import('../lib/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const table = await createTable({
  name: 'Predios',
  columns: 'Predio:texto, Área:número, Fecha:fecha, Pagado:casilla'
});
check('Crea tabla con columnas tipadas', table.id === 'TB-0001' && table.columns.length === 4 && table.columns[1].type === 'number' && table.columns[3].type === 'checkbox', JSON.stringify(table.columns));
check('La lista no carga filas', listTables().length === 1 && !('rows' in listTables()[0]));
const cols = Object.fromEntries(table.columns.map((column) => [column.name, column.id]));

const row = await addRow('TB-0001', {
  [cols.Predio]: 'La Esperanza',
  [cols['Área']]: '1200.5',
  [cols.Fecha]: '2026-11-05',
  [cols.Pagado]: true,
  c99: 'ignorada'
});
check('Añade fila con tipos convertidos', row.id === 'ROW-0001' && row.values[cols['Área']] === 1200.5 && row.values[cols.Pagado] === true, JSON.stringify(row.values));
check('Ignora columnas desconocidas', !('c99' in row.values));

const loaded = getTable('TB-0001');
check('La tabla trae la fila', loaded.rows.length === 1 && loaded.rows[0].values[cols.Predio] === 'La Esperanza');

let badNumber = null;
try { await addRow('TB-0001', { [cols['Área']]: 'mucho' }); } catch (error) { badNumber = error; }
check('Rechaza número inválido', badNumber?.code === 'INVALID_NUMBER' || badNumber?.status === 400, badNumber?.message);

let badDate = null;
try { await addRow('TB-0001', { [cols.Fecha]: '05/11/2026' }); } catch (error) { badDate = error; }
check('Rechaza fecha inválida', badDate?.code === 'INVALID_DATE' || badDate?.status === 400, badDate?.message);

const updated = await updateRow('TB-0001', 'ROW-0001', { [cols.Pagado]: false, [cols['Área']]: 1300 });
check('Actualiza solo los campos enviados', updated.values[cols.Pagado] === false && updated.values[cols['Área']] === 1300 && updated.values[cols.Predio] === 'La Esperanza', JSON.stringify(updated.values));

let duplicate = null;
try { await createTable({ name: 'Predios', columns: 'X:texto' }); } catch (error) { duplicate = error; }
check('Rechaza tabla duplicada', duplicate?.code === 'DUPLICATE' || duplicate?.status === 409, duplicate?.message);

let badType = null;
try { await createTable({ name: 'Rara', columns: 'X:moneda' }); } catch (error) { badType = error; }
check('Rechaza tipo no soportado', badType?.code === 'INVALID_VALUE' || badType?.status === 400, badType?.message);

const second = await createTable({ name: 'Contactos', columns: [{ name: 'Nombre', type: 'text' }, { name: 'Correo', type: 'text' }] });
check('Crea tabla desde array de columnas', second.id === 'TB-0002' && second.columns.length === 2);

await deleteRow('TB-0001', 'ROW-0001');
check('Borra una fila', getTable('TB-0001').rows.length === 0);

await deleteTable('TB-0002');
check('Borra una tabla', getTable('TB-0002') === null && listTables().length === 1);
check('Persiste en el store', (store.get().base?.tables || []).length === 1 && store.get().base.tables[0].name === 'Predios');

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

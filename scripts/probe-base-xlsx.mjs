/* Prueba determinista de exportación XLSX de Base. */
import { readZip } from '../lib/docs/zip.mjs';
import { tableToXlsx, xlsxFilename } from '../lib/base/xlsx.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const table = {
  id: 'TB-0001',
  name: 'Predios y linderos',
  columns: [
    { id: 'c1', name: 'Predio', type: 'text' },
    { id: 'c2', name: 'Área', type: 'number' },
    { id: 'c3', name: 'Entrega', type: 'date' },
    { id: 'c4', name: 'Pagado', type: 'checkbox' }
  ],
  rows: [
    { id: 'R1', values: { c1: 'El Roble', c2: 1250.5, c3: '2026-10-30', c4: true } },
    { id: 'R2', values: { c1: 'La Palma', c2: 20, c3: '2026-11-01', c4: false } }
  ]
};
const buffer = tableToXlsx(table, { now: new Date('2026-10-28T12:00:00Z') });
check('Genera un ZIP XLSX', buffer.length > 1000 && buffer.slice(0, 2).toString('latin1') === 'PK', `${buffer.length} bytes`);
const archive = readZip(buffer);
const names = Object.keys(archive.map);
check('Contiene partes OOXML', names.includes('xl/workbook.xml') && names.includes('xl/worksheets/sheet1.xml'));
const sheet = archive.map['xl/worksheets/sheet1.xml'].toString('utf8');
const strings = archive.map['xl/sharedStrings.xml']?.toString('utf8') || '';
check('Incluye cabeceras y textos', strings.includes('Predio') && strings.includes('El Roble') && strings.includes('La Palma'));
check('Incluye números y fechas', sheet.includes('1250.5') && /46\d{3}/.test(sheet));
const workbook = archive.map['xl/workbook.xml'].toString('utf8');
check('Nombre de hoja', workbook.includes('Predios y linderos'));
check('Nombre de archivo', xlsxFilename(table) === `base-predios-y-linderos-${new Date().toISOString().slice(0, 10)}.xlsx`, xlsxFilename(table));
const empty = tableToXlsx({ name: 'Vacía', columns: [{ id: 'c1', name: 'Solo', type: 'text' }], rows: [] });
check('Exporta tabla vacía', (readZip(empty).map['xl/sharedStrings.xml']?.toString('utf8') || '').includes('Solo'));
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;



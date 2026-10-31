/* Prueba determinista de exportación CSV de Base. */
import { csvFilename, tableToCsv } from '../lib/base/csv.mjs';

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
    { id: 'R1', values: { c1: 'El Roble, lote 2', c2: 1250.5, c3: '2026-10-30', c4: true } },
    { id: 'R2', values: { c1: '=SUM(A1:A2)', c2: 0, c3: '2026-11-01', c4: false } },
    { id: 'R3', values: { c1: 'Dice "hola"', c2: '', c3: '', c4: false } },
    { id: 'R4', values: { c1: 'Línea\nnueva', c2: 2, c3: '', c4: true } }
  ]
};
const csv = tableToCsv(table);
check('Incluye BOM UTF-8', csv.startsWith('\uFEFF'));
check('Cabeceras y filas', (csv.match(/\r\n/g) || []).length === 5, `${(csv.match(/\r\n/g) || []).length} saltos`);
check('Escapa coma y comillas', csv.includes('"El Roble, lote 2"') && csv.includes('"Dice ""hola"""'));
check('Casilla como Sí/No', csv.includes(',Sí\r\n') || csv.includes(',Sí') && csv.includes(',No'));
check('Neutraliza fórmula', csv.includes("'=SUM(A1:A2)") && !csv.includes(',=SUM'));
check('Respeta salto de línea entre comillas', csv.includes('"Línea\nnueva"'));
const filename = csvFilename(table);
check('Nombre de archivo seguro', filename === `base-predios-y-linderos-${new Date().toISOString().slice(0, 10)}.csv`, filename);
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

/**
 * Exportación CSV de una tabla de Base, compatible con Excel.
 *
 * - UTF-8 con BOM para que Excel respete acentos.
 * - Comillas RFC 4180 cuando el valor contiene coma, comilla o salto de línea.
 * - Neutraliza fórmulas (=, +, -, @, tab y CR) anteponiendo un apóstrofo.
 */
const BOM = '\uFEFF';

function quote(value) {
  let text = value === null || value === undefined ? '' : String(value);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  if (/[",\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

function cellValue(column, value) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'checkbox') return value === true || value === 'true' || value === 1 ? 'Sí' : 'No';
  if (column.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(value);
  }
  return String(value);
}

export function tableToCsv(table) {
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const lines = [columns.map((column) => quote(column.name)).join(',')];
  for (const row of rows) {
    const values = row?.values && typeof row.values === 'object' ? row.values : {};
    lines.push(columns.map((column) => quote(cellValue(column, values[column.id]))).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

export function csvFilename(table) {
  const base = String(table?.name || 'tabla')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'tabla';
  return `base-${base}-${new Date().toISOString().slice(0, 10)}.csv`;
}

/**
 * Parser CSV RFC 4180 suficiente para archivos de Excel/LibreOffice.
 * Devuelve una matriz de celdas de texto. No ejecuta fórmulas.
 */
export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((cell) => cell === '')) rows.pop();
  return rows;
}

/** Convierte una matriz CSV en valores por columna de una tabla de Base. */
export function rowsFromCsv(text, columns) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('El CSV está vacío.');
  const header = rows[0].map((cell) => String(cell || '').trim());
  const byName = new Map(columns.map((column) => [column.name.trim().toLowerCase(), column]));
  const indexes = header.map((name) => {
    const column = byName.get(name.toLowerCase());
    if (!column) throw new Error(`Columna desconocida en el CSV: «${name}».`);
    return column;
  });
  if (!indexes.length) throw new Error('El CSV no tiene cabeceras.');
  const data = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    if (!cells.some((cell) => String(cell).trim() !== '')) continue;
    const values = {};
    for (const column of columns) values[column.id] = '';
    indexes.forEach((column, index) => {
      let cell = cells[index] === undefined ? '' : String(cells[index]);
      if (column.type === 'checkbox') cell = ['sí', 'si', 'true', '1', 'x', 'on'].includes(cell.trim().toLowerCase());
      else if (/^'[=+\-@]/.test(cell)) cell = cell.slice(1);
      values[column.id] = cell;
    });
    data.push(values);
  }
  if (!data.length) throw new Error('El CSV no tiene filas de datos.');
  return data;
}

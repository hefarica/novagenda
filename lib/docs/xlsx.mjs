/**
 * Generador de XLSX (SpreadsheetML) sin dependencias.
 *
 * Modelo de entrada (`sheets`):
 *   {
 *     name: 'Resumen',
 *     columns: [
 *       { header: 'Concepto', type: 'text', width: 30 },
 *       { header: 'Monto', type: 'currency' },
 *       { header: 'Avance', type: 'percent' },
 *       { header: 'Fecha', type: 'date' }
 *     ],
 *     rows: [
 *       ['Consultoría', 1500000, 0.35, '2026-10-01'],
 *       ['Soporte', 800000, 0.42, '2026-10-05'],
 *       ['Total', { formula: 'SUM(B2:B3)' }, { formula: 'AVERAGE(C2:C3)' }, null]
 *     ],
 *     widths: [30, 16, 12, 14],   // alternativa a column.width
 *     totals: true,               // da formato a la última fila
 *     autoFilter: true,
 *     freeze: true
 *   }
 *
 * Tipos de celda admitidos: texto, número, fecha, moneda, porcentaje, booleano
 * y fórmula (`{ formula: 'SUM(B2:B9)' }`). Las fórmulas SUM/AVERAGE/IF se
 * evalúan para guardar un valor en caché; el libro se marca con
 * `fullCalcOnLoad` para que Excel/LibreOffice recalculen siempre al abrir.
 */
import { createZip } from './zip.mjs';
import {
  XML_DECL, NS, REL, CT, escapeXml, escapeAttr, cleanText, normalizeBrand,
  hexColor, lighten, contrastText, parseDateInput, excelSerial, isoUtc,
  contentTypesXml, relsXml, corePropsXml, appPropsXml
} from './ooxml.mjs';
import { ValidationError } from '../http/errors.mjs';

const MAX_SHEETS = 12;
const MAX_ROWS = 2000;
const MAX_COLUMNS = 30;
const MAX_CELL_TEXT = 2000;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/* ------------------------------------------------------------------ */
/* Referencias y utilidades                                            */
/* ------------------------------------------------------------------ */

/** Índice de columna (0) a letra Excel (A, B, …, AA). */
export function columnName(index) {
  let value = Number(index) + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** Convierte letra de columna a índice 0. */
export function columnIndex(letters) {
  let index = 0;
  for (const char of String(letters).toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function cellReference(rowIndex, colIndex) {
  return `${columnName(colIndex)}${Number(rowIndex) + 1}`;
}

export function parseCellReference(reference) {
  const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(reference || '').trim());
  if (!match) return null;
  return { column: columnIndex(match[1]), row: Number(match[2]) - 1 };
}

function sanitizeSheetName(value, fallback, used) {
  let name = String(value ?? '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  if (!name) name = fallback;
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const tail = ` (${suffix})`;
    candidate = `${name.slice(0, Math.max(1, 31 - tail.length))}${tail}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function currencyCode(symbol) {
  const clean = String(symbol ?? '$').replace(/["\\\r\n]/g, '').trim().slice(0, 4) || '$';
  return clean;
}

function numberText(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1e10) / 1e10;
  return String(rounded);
}

/* ------------------------------------------------------------------ */
/* Ancho automático: texto que Excel pinta en cada celda               */
/* ------------------------------------------------------------------ */

function groupThousands(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function longestLine(value) {
  return String(value ?? '').split('\n').reduce((longest, line) => Math.max(longest, line.length), 0);
}

/** Moneda tal como la pinta el formato `"$"#,##0.00`. */
export function currencyDisplayText(value, symbol = '$') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const sign = numeric < 0 ? '-' : '';
  const fixed = Math.abs(numeric).toFixed(2);
  const [integerPart, decimalPart] = fixed.split('.');
  return `${sign}${symbol}${groupThousands(integerPart)}.${decimalPart}`;
}

/** Número con separador de miles y 0 decimales (`#,##0`). */
export function numberDisplayText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const rounded = Math.round(numeric);
  return `${rounded < 0 ? '-' : ''}${groupThousands(Math.abs(rounded))}`;
}

/** Porcentaje con dos decimales (`0.00%`). */
export function percentDisplayText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return `${(numeric * 100).toFixed(2)}%`;
}

/** Fecha `dd/mm/yyyy` (10 caracteres) tal como la pinta el formato 164. */
export function dateDisplayText() {
  return '31/12/2026';
}

/**
 * Texto aproximado que Excel mostrará en una celda, usado solo para calcular
 * el ancho de columna. Para fórmulas se usa el valor en caché; si no hay caché
 * se devuelve cadena vacía y decide el mínimo por tipo.
 *
 * @param {any} cell
 * @param {any} column
 * @param {string} currency símbolo monetario
 * @returns {string}
 */
export function cellDisplayText(cell, column = {}, currency = '$') {
  if (!cell || cell.type === 'blank') return '';
  const columnType = String(column?.type || '').toLowerCase();
  if (cell.type === 'text') return String(cell.value ?? '');
  if (cell.type === 'currency') return currencyDisplayText(cell.value, currency);
  if (cell.type === 'percent') return percentDisplayText(cell.value);
  if (cell.type === 'date') return dateDisplayText();
  if (cell.type === 'number') return numberDisplayText(cell.value);
  if (cell.type === 'boolean') return cell.value ? 'VERDADERO' : 'FALSO';
  if (cell.type === 'formula') {
    const cached = cell.cached;
    if (!cached) return '';
    if (cached.type === 'text') return String(cached.value ?? '');
    if (cached.type === 'boolean') return cached.value ? 'VERDADERO' : 'FALSO';
    if (cached.type === 'number') {
      if (columnType === 'currency') return currencyDisplayText(cached.value, currency);
      if (columnType === 'percent') return percentDisplayText(cached.value);
      if (columnType === 'date') return dateDisplayText();
      return numberDisplayText(cached.value);
    }
    return '';
  }
  return '';
}

const TYPE_MINIMUM_WIDTH = Object.freeze({
  currency: 16,
  date: 12,
  percent: 10,
  number: 10,
  text: 12
});

function minimumWidthForColumn(column, rows, columnPosition) {
  let minimum = TYPE_MINIMUM_WIDTH[String(column?.type || '').toLowerCase()] || 8;
  for (const row of rows) {
    const cell = row[columnPosition];
    if (!cell || cell.type === 'blank') continue;
    if (cell.type === 'formula') {
      const cached = cell.cached;
      if (cached?.type === 'text') minimum = Math.max(minimum, TYPE_MINIMUM_WIDTH.text);
      else if (cached?.type === 'boolean') minimum = Math.max(minimum, 10);
      else if (cached?.type === 'number') {
        const columnType = String(column?.type || '').toLowerCase();
        minimum = Math.max(minimum, TYPE_MINIMUM_WIDTH[columnType] || TYPE_MINIMUM_WIDTH.number);
      } else {
        minimum = Math.max(minimum, TYPE_MINIMUM_WIDTH[String(column?.type || '').toLowerCase()] || 10);
      }
      continue;
    }
    minimum = Math.max(minimum, TYPE_MINIMUM_WIDTH[cell.type] || (cell.type === 'boolean' ? 10 : 0));
  }
  return minimum;
}

/**
 * Ancho de columna: máximo entre el texto renderizado (encabezado, valores y
 * caché de fórmulas) y el mínimo del tipo, con 10 % de margen y clamps 8–60.
 * @param {any} column
 * @param {any[]} rows
 * @param {number} columnPosition
 * @param {string} currency
 */
export function autoColumnWidth(column, rows, columnPosition, currency = '$') {
  let maxLength = longestLine(column?.header ?? '');
  for (const row of rows) {
    maxLength = Math.max(maxLength, longestLine(cellDisplayText(row[columnPosition], column, currency)));
  }
  const required = Math.ceil((maxLength * 11) / 10 + 2);
  const minimum = minimumWidthForColumn(column, rows, columnPosition);
  return Math.min(60, Math.max(8, required, minimum));
}

/* ------------------------------------------------------------------ */
/* Evaluador mínimo de fórmulas (solo para el valor en caché)          */
/* ------------------------------------------------------------------ */

function splitTopLevel(input, separator = ',') {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of String(input)) {
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === separator && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function literalValue(token) {
  const text = String(token).trim();
  if (/^"(.*)"$/.test(text)) return { type: 'text', value: text.slice(1, -1) };
  if (/^(VERDADERO|FALSO|TRUE|FALSE)$/i.test(text)) return { type: 'boolean', value: /^(VERDADERO|TRUE)$/i.test(text) };
  const numeric = Number(text);
  if (text !== '' && Number.isFinite(numeric)) return { type: 'number', value: numeric };
  return null;
}

function resolveToken(token, values) {
  const text = String(token).trim();
  const literal = literalValue(text);
  if (literal) return literal;
  const ref = parseCellReference(text);
  if (ref) {
    const entry = values.get(text.toUpperCase());
    if (!entry) return { type: 'blank', value: null };
    return entry;
  }
  return { type: 'unknown', value: null };
}

function expandRange(startRef, endRef, values) {
  const start = parseCellReference(startRef);
  const end = parseCellReference(endRef);
  if (!start || !end) return [];
  const results = [];
  for (let row = Math.min(start.row, end.row); row <= Math.max(start.row, end.row); row += 1) {
    for (let column = Math.min(start.column, end.column); column <= Math.max(start.column, end.column); column += 1) {
      const entry = values.get(cellReference(row, column));
      if (entry && entry.type === 'number') results.push(entry.value);
    }
  }
  return results;
}

/**
 * Calcula un valor en caché para fórmulas sencillas. Si no se reconoce la
 * fórmula devuelve null (la celda queda sin `<v>` y Excel recalcula).
 * @param {string} formula
 * @param {Map<string,{type:string,value:any}>} values
 * @returns {{type:'number'|'text'|'boolean', value:any}|null}
 */
export function evaluateFormula(formula, values) {
  try {
    const expression = String(formula ?? '').trim().replace(/^=/, '').trim();
    const fnMatch = /^(SUM|AVERAGE|SUMA|PROMEDIO)\((.+)\)$/i.exec(expression);
    if (fnMatch) {
      const fn = fnMatch[1].toUpperCase();
      const args = splitTopLevel(fnMatch[2]);
      const numbers = [];
      for (const arg of args) {
        const range = /^([A-Za-z]{1,3}\d{1,7}):([A-Za-z]{1,3}\d{1,7})$/.exec(arg.trim());
        if (range) {
          numbers.push(...expandRange(range[1], range[2], values));
          continue;
        }
        const resolved = resolveToken(arg, values);
        if (resolved.type === 'number') numbers.push(resolved.value);
      }
      if (!numbers.length) return null;
      const total = numbers.reduce((sum, value) => sum + value, 0);
      const result = fn.startsWith('SUM') || fn === 'SUMA' ? total : total / numbers.length;
      return { type: 'number', value: Math.round(result * 1e10) / 1e10 };
    }

    const ifMatch = /^IF\((.+)\)$/i.exec(expression);
    if (ifMatch) {
      const parts = splitTopLevel(ifMatch[1]);
      if (parts.length !== 3) return null;
      const condition = /^(.+?)(>=|<=|<>|=|>|<)(.+)$/.exec(parts[0]);
      if (!condition) return null;
      const left = resolveToken(condition[1], values);
      const right = resolveToken(condition[3], values);
      if (left.type === 'unknown' || right.type === 'unknown') return null;
      const leftValue = left.value;
      const rightValue = right.value;
      let outcome = false;
      switch (condition[2]) {
        case '>': outcome = leftValue > rightValue; break;
        case '<': outcome = leftValue < rightValue; break;
        case '>=': outcome = leftValue >= rightValue; break;
        case '<=': outcome = leftValue <= rightValue; break;
        case '=': outcome = String(leftValue) === String(rightValue); break;
        case '<>': outcome = String(leftValue) !== String(rightValue); break;
        default: return null;
      }
      const branch = outcome ? parts[1] : parts[2];
      const resolved = resolveToken(branch, values);
      if (resolved.type === 'unknown') return null;
      if (resolved.type === 'blank') return { type: 'text', value: '' };
      return { type: resolved.type, value: resolved.value };
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Modelo de celdas                                                    */
/* ------------------------------------------------------------------ */

const STYLE = Object.freeze({
  default: 0,
  header: 1,
  date: 2,
  currency: 3,
  percent: 4,
  number: 5,
  bold: 6,
  wrap: 7,
  datetime: 8,
  boldCurrency: 9,
  boldPercent: 10,
  boldNumber: 11,
  totalText: 12,
  totalCurrency: 13,
  totalPercent: 14,
  totalNumber: 15
});

function styleFor(type, { bold = false, total = false, wrap = false } = {}) {
  if (total) {
    if (type === 'currency') return STYLE.totalCurrency;
    if (type === 'percent') return STYLE.totalPercent;
    if (type === 'number' || type === 'formulaNumber') return STYLE.totalNumber;
    return STYLE.totalText;
  }
  if (type === 'date') return bold ? STYLE.date : STYLE.date;
  if (type === 'datetime') return STYLE.datetime;
  if (type === 'currency') return bold ? STYLE.boldCurrency : STYLE.currency;
  if (type === 'percent') return bold ? STYLE.boldPercent : STYLE.percent;
  if (type === 'number' || type === 'formulaNumber') return bold ? STYLE.boldNumber : STYLE.number;
  if (bold) return STYLE.bold;
  if (wrap) return STYLE.wrap;
  return STYLE.default;
}

function textValue(value) {
  const text = cleanText(value);
  return text.length > MAX_CELL_TEXT ? text.slice(0, MAX_CELL_TEXT) : text;
}

/**
 * Convierte el valor de una celda en un modelo intermedio.
 * @returns {{type:string, value:any, formula?:string, style:number}}
 */
function resolveCell(raw, column, rowIndex, colIndex) {
  const columnType = String(column?.type || '').toLowerCase();
  const wrap = column?.wrap === true;
  const options = { wrap };
  const typeFor = (type) => styleFor(type, options);

  if (raw === undefined || raw === null) return { type: 'blank', style: 0 };

  if (raw instanceof Date) {
    return { type: 'date', value: excelSerial(raw), style: typeFor('date') };
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.formula !== undefined) {
      const formula = String(raw.formula || '').replace(/^=/, '').trim();
      if (!formula) return { type: 'blank', style: 0 };
      const formulaType = ['currency', 'percent', 'date'].includes(columnType) ? columnType : 'formulaNumber';
      return { type: 'formula', formula, style: styleFor(formulaType, { bold: raw.bold === true, total: raw.total === true, wrap }) };
    }
    if (raw.date !== undefined) {
      const date = parseDateInput(raw.date);
      return { type: 'date', value: excelSerial(date), style: typeFor('date') };
    }
    const value = raw.value !== undefined ? raw.value : raw.text !== undefined ? raw.text : raw.number;
    if (raw.percent !== undefined) return { type: 'percent', value: Number(raw.percent), style: typeFor('percent') };
    if (raw.currency !== undefined) return { type: 'currency', value: Number(raw.currency), style: typeFor('currency') };
    const explicitType = String(raw.type || '').toLowerCase();
    if (explicitType === 'date') {
      const date = parseDateInput(value);
      return { type: 'date', value: excelSerial(date), style: typeFor('date') };
    }
    if (explicitType === 'currency') return { type: 'currency', value: Number(value), style: typeFor('currency') };
    if (explicitType === 'percent') return { type: 'percent', value: Number(value), style: typeFor('percent') };
    if (explicitType === 'number') return { type: 'number', value: Number(value), style: styleFor('number', { bold: raw.bold === true, total: raw.total === true, wrap }) };
    if (explicitType === 'text') return { type: 'text', value: textValue(value), style: styleFor('text', { bold: raw.bold === true, total: raw.total === true, wrap }) };
    if (typeof value === 'number') return { type: 'number', value, style: styleFor('number', { bold: raw.bold === true, total: raw.total === true, wrap }) };
    if (typeof value === 'boolean') return { type: 'boolean', value, style: 0 };
    return { type: 'text', value: textValue(value), style: styleFor('text', { bold: raw.bold === true, total: raw.total === true, wrap }) };
  }

  if (typeof raw === 'boolean') return { type: 'boolean', value: raw, style: 0 };
  if (typeof raw === 'number') {
    if (columnType === 'currency') return { type: 'currency', value: raw, style: typeFor('currency') };
    if (columnType === 'percent') return { type: 'percent', value: raw, style: typeFor('percent') };
    if (columnType === 'number') return { type: 'number', value: raw, style: typeFor('number') };
    if (columnType === 'date') {
      return { type: 'date', value: excelSerial(parseDateInput(raw)), style: typeFor('date') };
    }
    return { type: 'number', value: raw, style: typeFor('number') };
  }

  const text = String(raw);
  const trimmed = text.trim();
  if (trimmed.startsWith('=')) {
    const formula = trimmed.slice(1).trim();
    if (!formula) return { type: 'blank', style: 0 };
    const formulaType = ['currency', 'percent', 'date'].includes(columnType) ? columnType : 'formulaNumber';
    return { type: 'formula', formula, style: styleFor(formulaType, { wrap }) };
  }
  if (columnType === 'date') {
    return { type: 'date', value: excelSerial(parseDateInput(trimmed)), style: typeFor('date') };
  }
  if (columnType === 'currency') {
    const numeric = Number(trimmed.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(numeric)) return { type: 'currency', value: numeric, style: typeFor('currency') };
  }
  if (columnType === 'percent') {
    const percent = /^([-+]?\d+(?:[.,]\d+)?)\s*%$/.exec(trimmed);
    if (percent) return { type: 'percent', value: Number(percent[1].replace(',', '.')) / 100, style: typeFor('percent') };
    const numeric = Number(trimmed.replace(',', '.'));
    if (Number.isFinite(numeric)) return { type: 'percent', value: numeric, style: typeFor('percent') };
  }
  if (columnType === 'number') {
    const numeric = Number(trimmed.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(numeric)) return { type: 'number', value: numeric, style: typeFor('number') };
  }
  if (columnType === 'boolean') {
    if (/^(sí|si|true|verdadero|1)$/i.test(trimmed)) return { type: 'boolean', value: true, style: 0 };
    if (/^(no|false|falso|0)$/i.test(trimmed)) return { type: 'boolean', value: false, style: 0 };
  }
  return { type: 'text', value: textValue(text), style: typeFor('text') };
}

/**
 * Construye el modelo de una hoja: cabeceras, celdas resueltas y valores.
 */
function buildSheetModel(sheet, index, usedNames, spec) {
  if (!sheet || typeof sheet !== 'object') sheet = {};
  const name = sanitizeSheetName(sheet.name, `Hoja${index + 1}`, usedNames);
  let columns = Array.isArray(sheet.columns) ? sheet.columns.slice(0, MAX_COLUMNS) : [];
  columns = columns.map((column) => (typeof column === 'string' ? { header: column } : (column && typeof column === 'object' ? { ...column } : {})));
  let rows = Array.isArray(sheet.rows) ? sheet.rows.slice(0, MAX_ROWS) : [];
  if (!columns.length && rows.length && Array.isArray(rows[0])) {
    columns = rows[0].map((value, columnPosition) => ({ header: String(value ?? `Columna ${columnPosition + 1}`) }));
    rows = rows.slice(1);
  }
  if (columns.length > MAX_COLUMNS) {
    throw new ValidationError('sheets.columns', 'VALIDATION', `La hoja "${name}" supera ${MAX_COLUMNS} columnas.`);
  }
  for (const row of rows) {
    const length = Array.isArray(row) ? row.length : (row && typeof row === 'object' ? Object.keys(row).length : 1);
    if (length > MAX_COLUMNS) throw new ValidationError('sheets.rows', 'VALIDATION', `La hoja "${name}" tiene una fila con más de ${MAX_COLUMNS} celdas.`);
  }

  const rowCount = rows.length;
  const explicitWidths = Array.isArray(sheet.widths) ? sheet.widths : null;
  const columnCount = Math.max(columns.length, ...rows.map((row) => (Array.isArray(row) ? row.length : columns.length)), 1);

  const resolvedRows = rows.map((row, rowIndex) => {
    const isLast = rowIndex === rowCount - 1;
    const totalRow = sheet.totals === true && isLast;
    return Array.from({ length: columnCount }, (_, columnPosition) => {
      let raw;
      if (Array.isArray(row)) {
        raw = row[columnPosition];
      } else if (row && typeof row === 'object') {
        const column = columns[columnPosition] || {};
        const key = column.key || column.header;
        raw = key !== undefined && Object.prototype.hasOwnProperty.call(row, key) ? row[key] : row[columnPosition];
      } else {
        raw = columnPosition === 0 ? row : undefined;
      }
      const cell = resolveCell(raw, columns[columnPosition] || {}, rowIndex, columnPosition);
      if (totalRow && cell.type !== 'blank' && cell.type !== 'formula') {
        cell.style = styleFor(cell.type, { total: true, wrap: columns[columnPosition]?.wrap === true });
      }
      if (totalRow && cell.type === 'formula') {
        const columnType = String(columns[columnPosition]?.type || '').toLowerCase();
        const formulaType = columnType === 'currency' || columnType === 'percent' ? columnType : 'formulaNumber';
        cell.style = styleFor(formulaType, { total: true, wrap: columns[columnPosition]?.wrap === true });
      }
      if (typeof raw === 'object' && raw && raw.bold === true && cell.type !== 'blank') {
        cell.style = styleFor(cell.type, { bold: true, total: raw.total === true, wrap: columns[columnPosition]?.wrap === true });
      }
      return cell;
    });
  });

  // Valores para el evaluador de fórmulas (primero valores directos).
  // Las filas de datos empiezan en la fila 2 de Excel si hay cabecera.
  const rowOffset = columns.length ? 1 : 0;
  const values = new Map();
  for (let rowIndex = 0; rowIndex < resolvedRows.length; rowIndex += 1) {
    for (let columnPosition = 0; columnPosition < columnCount; columnPosition += 1) {
      const cell = resolvedRows[rowIndex][columnPosition];
      if (!cell || cell.type === 'formula' || cell.type === 'blank') continue;
      const ref = cellReference(rowIndex + rowOffset, columnPosition);
      if (cell.type === 'text') values.set(ref, { type: 'text', value: cell.value });
      else if (cell.type === 'boolean') values.set(ref, { type: 'boolean', value: cell.value });
      else values.set(ref, { type: 'number', value: cell.value });
    }
  }
  const formulas = [];
  for (let rowIndex = 0; rowIndex < resolvedRows.length; rowIndex += 1) {
    for (let columnPosition = 0; columnPosition < columnCount; columnPosition += 1) {
      const cell = resolvedRows[rowIndex][columnPosition];
      if (!cell || cell.type !== 'formula') continue;
      const ref = cellReference(rowIndex + rowOffset, columnPosition);
      const cached = evaluateFormula(cell.formula, values);
      cell.cached = cached;
      if (cached && cached.type === 'number') {
        values.set(ref, { type: 'number', value: cached.value });
      }
      formulas.push({ ref, formula: cell.formula, cached });
    }
  }

  const currency = currencyCode(spec.currency);
  const widths = Array.from({ length: columnCount }, (_, columnPosition) => {
    const explicit = Number(explicitWidths?.[columnPosition] ?? columns[columnPosition]?.width);
    if (Number.isFinite(explicit) && explicit > 0) return Math.min(80, Math.max(6, explicit));
    return autoColumnWidth(columns[columnPosition] || {}, resolvedRows, columnPosition, currency);
  });

  return {
    name,
    columns,
    rows: resolvedRows,
    rowCount,
    columnCount,
    widths,
    freeze: sheet.freeze !== false,
    autoFilter: sheet.autoFilter !== false && resolvedRows.length > 0,
    formulas,
    watermark: String(spec.watermark || '').trim().slice(0, 40),
    tabColor: hexColor(sheet.tabColor || spec.brand?.color || '1F3864')
  };
}

/* ------------------------------------------------------------------ */
/* Serialización de partes                                             */
/* ------------------------------------------------------------------ */

function sheetDimension(model) {
  if (!model.columnCount || !model.rowCount) return 'A1';
  const headerRows = model.columns.length ? 1 : 0;
  const lastRow = headerRows + model.rowCount;
  if (lastRow < 1) return 'A1';
  return `A1:${cellReference(lastRow - 1, model.columnCount - 1)}`;
}

function cellXml(cell, reference, shared) {
  if (!cell || cell.type === 'blank') return '';
  const styleAttribute = cell.style ? ` s="${cell.style}"` : '';
  if (cell.type === 'text') {
    const value = String(cell.value ?? '');
    if (!value) return '';
    let index = shared.map.get(value);
    if (index === undefined) {
      index = shared.items.length;
      shared.items.push(value);
      shared.map.set(value, index);
    }
    shared.count += 1;
    return `<c r="${reference}"${styleAttribute} t="s"><v>${index}</v></c>`;
  }
  if (cell.type === 'number' || cell.type === 'currency' || cell.type === 'percent' || cell.type === 'date') {
    const numeric = numberText(Number(cell.value));
    if (numeric === null) return '';
    return `<c r="${reference}"${styleAttribute}><v>${numeric}</v></c>`;
  }
  if (cell.type === 'boolean') {
    return `<c r="${reference}"${styleAttribute} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
  }
  if (cell.type === 'formula') {
    const formula = escapeXml(cell.formula);
    const cached = cell.cached;
    if (cached && cached.type === 'number' && Number.isFinite(cached.value)) {
      return `<c r="${reference}"${styleAttribute}><f>${formula}</f><v>${numberText(cached.value)}</v></c>`;
    }
    if (cached && cached.type === 'text') {
      return `<c r="${reference}"${styleAttribute} t="str"><f>${formula}</f><v>${escapeXml(cached.value)}</v></c>`;
    }
    if (cached && cached.type === 'boolean') {
      return `<c r="${reference}"${styleAttribute} t="b"><f>${formula}</f><v>${cached.value ? 1 : 0}</v></c>`;
    }
    return `<c r="${reference}"${styleAttribute}><f>${formula}</f></c>`;
  }
  return '';
}

function worksheetXml(model, index, shared) {
  const rowXml = [];
  let rowNumber = 1;
  if (model.columns.length) {
    const cells = model.columns.map((column, columnPosition) => {
      const header = cleanText(column.header ?? '');
      if (!header) return '';
      let stringIndex = shared.map.get(header);
      if (stringIndex === undefined) {
        stringIndex = shared.items.length;
        shared.items.push(header);
        shared.map.set(header, stringIndex);
      }
      shared.count += 1;
      return `<c r="${cellReference(rowNumber - 1, columnPosition)}" s="${STYLE.header}" t="s"><v>${stringIndex}</v></c>`;
    }).join('');
    rowXml.push(`<row r="${rowNumber}" ht="24" customHeight="1">${cells}</row>`);
    rowNumber += 1;
  }
  for (const row of model.rows) {
    const cells = row.map((cell, columnPosition) => cellXml(cell, cellReference(rowNumber - 1, columnPosition), shared)).join('');
    rowXml.push(`<row r="${rowNumber}">${cells}</row>`);
    rowNumber += 1;
  }

  const cols = model.widths.map((width, columnPosition) => `<col min="${columnPosition + 1}" max="${columnPosition + 1}" width="${width}" customWidth="1"/>`).join('');
  const pane = model.freeze && model.columns.length
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : '<selection activeCell="A1" sqref="A1"/>';
  const filter = model.autoFilter
    ? `<autoFilter ref="${sheetDimension(model)}"/>`
    : '';

  return `${XML_HEAD}<worksheet xmlns="${NS.spreadsheet}" xmlns:r="${NS.wordRels}">
<sheetPr><tabColor rgb="FF${model.tabColor}"/></sheetPr>
<dimension ref="${sheetDimension(model)}"/>
<sheetViews><sheetView${index === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rowXml.join('')}</sheetData>
${filter}
<pageMargins left="0.5" right="0.5" top="0.65" bottom="0.65" header="0.3" footer="0.3"/>
${model.watermark ? `<headerFooter><oddHeader>&C&"Calibri,Bold"&9&K808080 ${escapeXml(model.watermark.replace(/&/g, '&&'))}</oddHeader></headerFooter>` : ''}
</worksheet>`;
}

function stylesXml(brand, currency) {
  const headerFill = brand.color;
  const headerText = contrastText(headerFill);
  const code = currencyCode(currency);
  const currencyFormat = `&quot;${escapeXml(code)}&quot;#,##0.00`;
  const totalFill = lighten(brand.color, 0.9);
  return `${XML_HEAD}<styleSheet xmlns="${NS.spreadsheet}">
<numFmts count="5">
<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/>
<numFmt numFmtId="166" formatCode="${currencyFormat}"/>
<numFmt numFmtId="167" formatCode="0.00%"/>
<numFmt numFmtId="168" formatCode="#,##0"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><color theme="1"/><name val="${escapeAttr(brand.font)}"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF${headerText}"/><name val="${escapeAttr(brand.font)}"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF262626"/><name val="${escapeAttr(brand.font)}"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${headerFill}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${totalFill}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>
<border><left/><right/><top style="medium"><color rgb="FF${brand.color}"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="16">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="167" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="168" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="166" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="167" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="168" fontId="2" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Construye todas las partes del XLSX.
 * @param {any} spec
 * @param {{now?:Date}} [options]
 * @returns {Record<string,string>}
 */
export function xlsxParts(spec = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const brand = normalizeBrand(spec.brand || {});
  const title = cleanText(spec.title || 'Libro') || 'Libro';
  const sheetsInput = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: 'Hoja 1', columns: [{ header: 'Concepto' }, { header: 'Valor', type: 'number' }], rows: [] }];
  if (sheetsInput.length > MAX_SHEETS) throw new ValidationError('sheets', 'VALIDATION', `Máximo ${MAX_SHEETS} hojas por libro.`);
  const usedNames = new Set();
  const models = sheetsInput.map((sheet, index) => buildSheetModel(sheet, index, usedNames, { ...spec, brand }));
  const shared = { items: [], map: new Map(), count: 0 };
  const sheetsXml = models.map((model, index) => worksheetXml(model, index, shared));
  const currency = currencyCode(spec.currency);
  const createdAt = spec.created ? parseDateInput(spec.created, now) : now;

  const overrides = [
    { partName: '/xl/workbook.xml', contentType: CT.xlsxWorkbook },
    { partName: '/xl/styles.xml', contentType: CT.xlsxStyles },
    { partName: '/xl/sharedStrings.xml', contentType: CT.xlsxSharedStrings },
    { partName: '/docProps/core.xml', contentType: CT.coreProperties },
    { partName: '/docProps/app.xml', contentType: CT.extendedProperties }
  ];
  models.forEach((_, index) => overrides.push({ partName: `/xl/worksheets/sheet${index + 1}.xml`, contentType: CT.xlsxWorksheet }));

  const workbookXml = `${XML_HEAD}<workbook xmlns="${NS.spreadsheet}" xmlns:r="${NS.wordRels}">
<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>
<workbookPr date1904="0"/>
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>
<sheets>${models.map((model, index) => `<sheet name="${escapeAttr(model.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;

  const workbookRels = relsXml([
    ...models.map((model, index) => ({ id: `rId${index + 1}`, type: REL.worksheet, target: `worksheets/sheet${index + 1}.xml` })),
    { id: `rId${models.length + 1}`, type: REL.styles, target: 'styles.xml' },
    { id: `rId${models.length + 2}`, type: REL.sharedStrings, target: 'sharedStrings.xml' }
  ]);

  const sharedStringsXml = `${XML_HEAD}<sst xmlns="${NS.spreadsheet}" count="${shared.count}" uniqueCount="${shared.items.length}">
${shared.items.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('\n')}
</sst>`;

  const app = appPropsXml({
    application: 'Agenda Copilot P95 (Excel)',
    properties: [
      { name: 'Application', value: 'Agenda Copilot P95 (Excel)' },
      { name: 'AppVersion', value: '16.0300' },
      { name: 'DocSecurity', type: 'i4', value: 0 },
      { name: 'ScaleCrop', type: 'bool', value: false },
      { name: 'Company', value: 'Agenda Copilot P95' }
    ]
  });

  const parts = {
    '[Content_Types].xml': contentTypesXml({
      defaults: [
        { extension: 'rels', contentType: CT.rels },
        { extension: 'xml', contentType: CT.xml }
      ],
      overrides
    }),
    '_rels/.rels': relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'xl/workbook.xml' },
      { id: 'rId2', type: REL.coreProperties, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extendedProperties, target: 'docProps/app.xml' }
    ]),
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': workbookRels,
    'xl/styles.xml': stylesXml(brand, currency),
    'xl/sharedStrings.xml': sharedStringsXml,
    'docProps/core.xml': corePropsXml({
      title,
      subject: spec.subject || 'Libro de cálculo',
      creator: cleanText(spec.author || brand.creator),
      created: createdAt,
      modified: now
    }),
    'docProps/app.xml': app
  };
  models.forEach((model, index) => { parts[`xl/worksheets/sheet${index + 1}.xml`] = sheetsXml[index]; });
  return parts;
}

/**
 * Genera el buffer XLSX listo para descargar.
 * @param {any} spec
 * @param {{now?:Date, compress?:boolean}} [options]
 * @returns {Buffer}
 */
export function renderXlsx(spec = {}, options = {}) {
  const parts = xlsxParts(spec, options);
  return createZip(Object.entries(parts).map(([name, data]) => ({ name, data })), {
    compress: options.compress !== false,
    date: options.now instanceof Date ? options.now : new Date()
  });
}

/** Nombres de hoja normalizados (para documentación y pruebas). */
export function sheetNames(spec = {}) {
  const used = new Set();
  return (Array.isArray(spec.sheets) ? spec.sheets : []).map((sheet, index) => sanitizeSheetName(sheet?.name, `Hoja${index + 1}`, used));
}

export { isoUtc };
export default { renderXlsx, xlsxParts, evaluateFormula, columnName, columnIndex, cellReference, parseCellReference, sheetNames };

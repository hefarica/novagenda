/**
 * Exportación de una tabla de Base a un XLSX real (SpreadsheetML), sin
 * dependencias externas. Reutiliza el generador de documentos.
 */
import { renderXlsx } from '../docs/xlsx.mjs';

const EXCEL_TYPES = Object.freeze({ text: 'text', number: 'number', date: 'date', checkbox: 'boolean' });

export function tableToXlsx(table, { now = new Date() } = {}) {
  const columns = (table?.columns || []).map((column) => ({
    header: column.name,
    type: EXCEL_TYPES[column.type] || 'text',
    width: column.type === 'number' ? 14 : column.type === 'date' ? 14 : 22
  }));
  const rows = (table?.rows || []).map((row) => columns.map((column, index) => {
    const value = row?.values?.[table.columns[index].id];
    if (column.type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1' || value === 'sí' || value === 'si';
    if (value === '' || value === undefined || value === null) return null;
    return value;
  }));
  return renderXlsx({
    title: table?.name || 'Base',
    sheets: [{
      name: table?.name || 'Base',
      columns,
      rows,
      autoFilter: true,
      freeze: true
    }]
  }, { now });
}

export function xlsxFilename(table) {
  const base = String(table?.name || 'tabla')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 50) || 'tabla';
  return `base-${base}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

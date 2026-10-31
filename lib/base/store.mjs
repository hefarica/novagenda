/**
 * Base de tablas de la oficina: registros estructurados (predios, contactos,
 * compromisos) con columnas tipadas y filas editables.
 *
 * Vive en `data.base.tables`. Tipos soportados: texto, número, fecha, casilla.
 * Los IDs son estables `TB-0001` y `ROW-0001`.
 */
import { store } from '../store.mjs';
import { HttpError, ValidationError } from '../http/errors.mjs';

export const COLUMN_TYPES = Object.freeze(['text', 'number', 'date', 'checkbox']);
export const MAX_TABLES = 20;
export const MAX_ROWS = 500;
const MAX_COLUMNS = 12;
const MAX_TABLE_NAME = 80;

function nowIso() {
  return new Date().toISOString();
}

export function ensureBase(data) {
  if (!data.base || typeof data.base !== 'object' || !Array.isArray(data.base.tables)) {
    data.base = { version: 1, tables: [], updatedAt: nowIso() };
  }
  return data.base;
}

function nextId(items, prefix) {
  let max = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(item.id || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function normalizeName(value, field = 'name') {
  const name = String(value ?? '').trim();
  if (!name) throw new ValidationError(field, 'REQUIRED', 'El nombre es obligatorio.');
  if (name.length > MAX_TABLE_NAME) throw new ValidationError(field, 'TOO_LONG', `El nombre supera ${MAX_TABLE_NAME} caracteres.`);
  return name;
}

/** Acepta `Nombre:texto, Fecha:fecha` o [{name,type}]. */
export function parseColumns(input) {
  let source = input;
  if (typeof input === 'string') {
    source = input.split(',').map((part) => {
      const [name, type] = part.split(':');
      return { name, type: type || 'text' };
    });
  }
  if (!Array.isArray(source) || !source.length) {
    throw new ValidationError('columns', 'REQUIRED', 'Define al menos una columna.');
  }
  if (source.length > MAX_COLUMNS) {
    throw new ValidationError('columns', 'TOO_MANY', `Máximo ${MAX_COLUMNS} columnas.`);
  }
  const seen = new Set();
  return source.map((raw, index) => {
    const name = normalizeName(raw?.name, `columns[${index}].name`);
    if (seen.has(name.toLowerCase())) {
      throw new ValidationError(`columns[${index}].name`, 'DUPLICATE', `Columna repetida: ${name}.`);
    }
    seen.add(name.toLowerCase());
    const type = String(raw?.type || 'text').toLowerCase();
    const normalizedType = { texto: 'text', text: 'text', número: 'number', numero: 'number', number: 'number', fecha: 'date', date: 'date', casilla: 'checkbox', checkbox: 'checkbox', sí: 'checkbox', si: 'checkbox', no: 'checkbox' }[type];
    if (!normalizedType || !COLUMN_TYPES.includes(normalizedType)) {
      throw new ValidationError(`columns[${index}].type`, 'INVALID_VALUE', `Tipo no soportado: ${raw?.type}. Usa texto, número, fecha o casilla.`);
    }
    return { id: `c${index + 1}`, name, type: normalizedType };
  });
}

export function publicTable(table, { withRows = true } = {}) {
  return {
    id: table.id,
    name: table.name,
    columns: (table.columns || []).map((column) => ({ ...column })),
    views: (table.views || []).map((view) => ({ ...view, filters: view.filters.map((filter) => ({ ...filter })) })),
    ...(withRows ? { rows: (table.rows || []).map(publicRow) } : {}),
    rowCount: (table.rows || []).length,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt
  };
}

function publicRow(row) {
  return {
    id: row.id,
    values: { ...(row.values || {}) },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function columnMap(table) {
  return new Map(table.columns.map((column) => [column.id, column]));
}

function coerceValue(column, value) {
  if (value === undefined || value === null || value === '') return '';
  if (column.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new ValidationError(column.id, 'INVALID_NUMBER', `«${column.name}» debe ser un número.`);
    return number;
  }
  if (column.type === 'date') {
    const date = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) {
      throw new ValidationError(column.id, 'INVALID_DATE', `«${column.name}» debe ser una fecha AAAA-MM-DD.`);
    }
    return date;
  }
  if (column.type === 'checkbox') {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1' || value === 'sí' || value === 'si';
  }
  const text = String(value);
  if (text.length > 2000) throw new ValidationError(column.id, 'TOO_LONG', `«${column.name}» supera 2000 caracteres.`);
  return text;
}

export function normalizeValues(table, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new ValidationError('values', 'INVALID_BODY', 'values debe ser un objeto columna→valor.');
  }
  const map = columnMap(table);
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    if (!map.has(key)) continue;
    clean[key] = coerceValue(map.get(key), value);
  }
  return clean;
}

export function listTables() {
  const base = ensureBase(store.get());
  return base.tables.map((table) => publicTable(table, { withRows: false }));
}

export function getTable(id) {
  const base = ensureBase(store.get());
  const table = base.tables.find((item) => item.id === id);
  return table ? publicTable(table) : null;
}

const VIEW_OPS = new Set(['eq', 'contains', 'neq', 'gt', 'gte', 'lt', 'lte']);
export const MAX_VIEWS = 10;

function normalizeFilters(table, filters) {
  if (!Array.isArray(filters) || !filters.length) throw new HttpError(400, 'INVALID_VALUE', 'La vista necesita al menos un filtro.', { field: 'filters' });
  if (filters.length > 4) throw new HttpError(400, 'INVALID_VALUE', 'Máximo 4 filtros por vista.', { field: 'filters' });
  const columns = new Map(table.columns.map((column) => [column.id, column]));
  return filters.map((filter) => {
    const column = columns.get(String(filter?.columnId || ''));
    if (!column) throw new HttpError(400, 'INVALID_VALUE', 'La columna del filtro no existe.', { field: 'filters' });
    const op = String(filter?.op || 'contains');
    if (!VIEW_OPS.has(op)) throw new HttpError(400, 'INVALID_VALUE', 'Operador de filtro no válido.', { field: 'filters' });
    const value = String(filter?.value ?? '').slice(0, 200);
    return { columnId: column.id, op, value };
  });
}

function normalizeSort(table, sort) {
  if (!sort || typeof sort !== 'object') return null;
  const column = table.columns.find((item) => item.id === String(sort.columnId || ''));
  if (!column) throw new HttpError(400, 'INVALID_VALUE', 'La columna de orden no existe.', { field: 'sort' });
  const direction = String(sort.direction || 'asc') === 'desc' ? 'desc' : 'asc';
  return { columnId: column.id, direction };
}

export async function createView(tableId, { name, filters, sort } = {}) {
  let created = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    if (!Array.isArray(table.views)) table.views = [];
    if (table.views.length >= MAX_VIEWS) throw new HttpError(409, 'VIEWS_FULL', `Máximo ${MAX_VIEWS} vistas por tabla.`);
    const cleanName = String(name ?? '').trim().slice(0, 60);
    if (!cleanName) throw new HttpError(400, 'INVALID_VALUE', 'La vista necesita un nombre.', { field: 'name' });
    if (table.views.some((view) => view.name.toLowerCase() === cleanName.toLowerCase())) throw new HttpError(409, 'DUPLICATE', 'Ya existe una vista con ese nombre.', { field: 'name' });
    const now = nowIso();
    const view = { id: nextId(table.views, 'BV'), name: cleanName, filters: normalizeFilters(table, filters), sort: normalizeSort(table, sort), createdAt: now };
    table.views.push(view);
    table.updatedAt = now;
    created = view;
  }, { label: 'base-create-view' });
  return { ...created, filters: created.filters.map((filter) => ({ ...filter })) };
}

export async function deleteView(tableId, viewId) {
  let removed = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    if (!Array.isArray(table.views)) table.views = [];
    const index = table.views.findIndex((view) => view.id === viewId);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `No existe la vista ${viewId}.`);
    removed = table.views.splice(index, 1)[0];
    table.updatedAt = nowIso();
  }, { label: 'base-delete-view' });
  return { ...removed, filters: removed.filters.map((filter) => ({ ...filter })) };
}

export async function createTable({ name, columns } = {}) {
  const cleanName = normalizeName(name);
  const cleanColumns = parseColumns(columns);
  let created = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    if (base.tables.length >= MAX_TABLES) {
      throw new HttpError(409, 'BASE_FULL', `La Base alcanzó el máximo de ${MAX_TABLES} tablas.`);
    }
    if (base.tables.some((table) => table.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new HttpError(409, 'DUPLICATE', `Ya existe una tabla llamada ${cleanName}.`, { field: 'name' });
    }
    const now = nowIso();
    created = {
      id: nextId(base.tables, 'TB'),
      name: cleanName,
      columns: cleanColumns,
      rows: [],
      createdAt: now,
      updatedAt: now
    };
    base.tables.push(created);
    base.updatedAt = now;
  }, { label: 'base-create-table' });
  return publicTable(created);
}

export async function renameTable(id, name) {
  const cleanName = normalizeName(name);
  let renamed = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === id);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${id}.`);
    if (base.tables.some((item) => item.id !== id && item.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new HttpError(409, 'DUPLICATE', `Ya existe una tabla llamada ${cleanName}.`, { field: 'name' });
    }
    table.name = cleanName;
    table.updatedAt = nowIso();
    base.updatedAt = table.updatedAt;
    renamed = table;
  }, { label: 'base-rename-table' });
  return publicTable(renamed, { withRows: false });
}

export async function addColumn(tableId, input = {}) {
  const [parsed] = parseColumns([{ name: input.name, type: input.type || 'text' }]);
  let created = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    if (table.columns.length >= MAX_COLUMNS) {
      throw new HttpError(409, 'COLUMN_LIMIT', `La tabla alcanzó el máximo de ${MAX_COLUMNS} columnas.`);
    }
    if (table.columns.some((column) => String(column.name).toLowerCase() === parsed.name.toLowerCase())) {
      throw new HttpError(409, 'DUPLICATE', `Ya existe la columna ${parsed.name}.`, { field: 'name' });
    }
    let max = 0;
    for (const column of table.columns) {
      const match = /^c(\d+)$/.exec(String(column.id || ''));
      if (match) max = Math.max(max, Number(match[1]));
    }
    created = { id: `c${max + 1}`, name: parsed.name, type: parsed.type };
    table.columns.push(created);
    table.updatedAt = nowIso();
    base.updatedAt = table.updatedAt;
  }, { label: 'base-add-column' });
  return { column: created, table: getTable(tableId) };
}

export async function renameColumn(tableId, columnId, name) {
  const cleanName = normalizeName(name, 'name');
  if (cleanName.length > 60) throw new ValidationError('name', 'TOO_LONG', 'El nombre de columna supera 60 caracteres.');
  let renamed = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    const column = table.columns.find((item) => item.id === columnId);
    if (!column) throw new HttpError(404, 'NOT_FOUND', `No existe la columna ${columnId}.`);
    if (table.columns.some((item) => item.id !== columnId && String(item.name).toLowerCase() === cleanName.toLowerCase())) {
      throw new HttpError(409, 'DUPLICATE', `Ya existe la columna ${cleanName}.`, { field: 'name' });
    }
    column.name = cleanName;
    table.updatedAt = nowIso();
    base.updatedAt = table.updatedAt;
    renamed = { ...column };
  }, { label: 'base-rename-column' });
  return { column: renamed, table: getTable(tableId) };
}

export async function deleteColumn(tableId, columnId) {
  let removed = null;
  const removedViews = [];
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    const column = table.columns.find((item) => item.id === columnId);
    if (!column) throw new HttpError(404, 'NOT_FOUND', `No existe la columna ${columnId}.`);
    if (table.columns.length <= 1) {
      throw new HttpError(409, 'LAST_COLUMN', 'La tabla necesita al menos una columna.');
    }
    removed = { ...column };
    table.columns = table.columns.filter((item) => item.id !== columnId);
    for (const row of table.rows) {
      if (row.values && Object.prototype.hasOwnProperty.call(row.values, columnId)) delete row.values[columnId];
    }
    table.views = (table.views || []).filter((view) => {
      const filters = (view.filters || []).filter((filter) => filter.columnId !== columnId);
      if (!filters.length) {
        removedViews.push(view.name);
        return false;
      }
      view.filters = filters;
      if (view.sort && view.sort.columnId === columnId) view.sort = null;
      return true;
    });
    table.updatedAt = nowIso();
    base.updatedAt = table.updatedAt;
  }, { label: 'base-delete-column' });
  return { column: removed, removedViews, table: getTable(tableId) };
}

export async function deleteTable(id) {
  let removed = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const index = base.tables.findIndex((table) => table.id === id);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${id}.`);
    removed = base.tables.splice(index, 1)[0];
    base.updatedAt = nowIso();
  }, { label: 'base-delete-table' });
  return publicTable(removed, { withRows: false });
}

export async function addRow(tableId, values) {
  let created = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    if (table.rows.length >= MAX_ROWS) {
      throw new HttpError(409, 'BASE_ROWS_FULL', `La tabla alcanzó el máximo de ${MAX_ROWS} filas.`);
    }
    const now = nowIso();
    const row = {
      id: nextId(table.rows, 'ROW'),
      values: normalizeValues(table, values || {}),
      createdAt: now,
      updatedAt: now
    };
    table.rows.push(row);
    table.updatedAt = now;
    created = row;
  }, { label: 'base-add-row' });
  return publicRow(created);
}

export async function duplicateRow(tableId, rowId) {
  let created = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    const index = table.rows.findIndex((item) => item.id === rowId);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `No existe la fila ${rowId}.`);
    if (table.rows.length >= MAX_ROWS) {
      throw new HttpError(409, 'BASE_ROWS_FULL', `La tabla alcanzó el máximo de ${MAX_ROWS} filas.`);
    }
    const now = nowIso();
    const source = table.rows[index];
    created = {
      id: nextId(table.rows, 'ROW'),
      values: { ...source.values },
      createdAt: now,
      updatedAt: now
    };
    table.rows.splice(index + 1, 0, created);
    table.updatedAt = now;
  }, { label: 'base-duplicate-row' });
  return publicRow(created);
}

export async function importRows(tableId, rows) {
  let created = [];
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'INVALID_VALUE', 'No hay filas para importar.', { field: 'csv' });
    if (table.rows.length + rows.length > MAX_ROWS) {
      throw new HttpError(409, 'BASE_ROWS_FULL', `La tabla solo admite ${MAX_ROWS} filas; ya tiene ${table.rows.length}.`);
    }
    const now = nowIso();
    const cleaned = rows.map((values, index) => {
      try {
        return normalizeValues(table, values || {});
      } catch (error) {
        error.message = `Fila ${index + 2}: ${error.message}`;
        throw error;
      }
    });
    let sequence = table.rows.reduce((max, row) => {
      const match = /^ROW-(\\d+)$/.exec(String(row.id || ''));
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    created = cleaned.map((values) => ({
      id: `ROW-${String(++sequence).padStart(4, '0')}`,
      values,
      createdAt: now,
      updatedAt: now
    }));
    table.rows.push(...created);
    table.updatedAt = now;
  }, { label: 'base-import-rows' });
  return created.map(publicRow);
}

export async function updateRow(tableId, rowId, values) {
  let updated = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    const row = table.rows.find((item) => item.id === rowId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', `No existe la fila ${rowId}.`);
    const clean = normalizeValues(table, values || {});
    row.values = { ...row.values, ...clean };
    row.updatedAt = nowIso();
    table.updatedAt = row.updatedAt;
    updated = row;
  }, { label: 'base-update-row' });
  return publicRow(updated);
}

export async function deleteRow(tableId, rowId) {
  let removed = null;
  await store.mutate((data) => {
    const base = ensureBase(data);
    const table = base.tables.find((item) => item.id === tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    const index = table.rows.findIndex((item) => item.id === rowId);
    if (index < 0) throw new HttpError(404, 'NOT_FOUND', `No existe la fila ${rowId}.`);
    removed = table.rows.splice(index, 1)[0];
    table.updatedAt = nowIso();
  }, { label: 'base-delete-row' });
  return publicRow(removed);
}


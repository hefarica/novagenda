/**
 * Preguntar a la Base en lenguaje natural, sin SQL y sin inventar.
 *
 * Entiende conteos y filtros simples sobre columnas conocidas:
 *   ¿cuántos predios están pagados?
 *   predios donde estado contiene "pendiente"
 *   contactos con ciudad = Cali
 *
 * Si no reconoce tabla o filtro, responde con la ambigüedad en vez de adivinar.
 */
import { HttpError } from '../http/errors.mjs';
import { getTable, listTables } from './store.mjs';

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function clean(value, max = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function valueText(value) {
  if (value === true) return 'sí';
  if (value === false) return 'no';
  return String(value ?? '');
}

function chooseTable(question, tables, tableId) {
  if (tableId) {
    const table = getTable(tableId);
    if (!table) throw new HttpError(404, 'NOT_FOUND', `No existe la tabla ${tableId}.`);
    return table;
  }
  const q = normalize(question);
  const matches = tables
    .filter((table) => q.includes(normalize(table.name)))
    .sort((a, b) => normalize(b.name).length - normalize(a.name).length);
  if (matches.length) return getTable(matches[0].id);
  if (tables.length === 1) return getTable(tables[0].id);
  return null;
}

function extractFilters(question, table) {
  const q = normalize(question);
  const filters = [];
  for (const column of table.columns) {
    const name = normalize(column.name);
    const index = q.indexOf(name);
    if (index < 0) continue;
    const rest = q.slice(index + name.length, index + name.length + 90);
    let match = /(?:mayor(?:\s+o\s+igual)?(?:\s+que)?|>=)\s*(-?\d+(?:[.,]\d+)?)/.exec(rest);
    if (match) {
      filters.push({ column, op: rest.includes('>=') || rest.includes('igual') ? 'gte' : 'gt', value: Number(match[1].replace(',', '.')) });
      continue;
    }
    match = /(?:menor(?:\s+o\s+igual)?(?:\s+que)?|<=)\s*(-?\d+(?:[.,]\d+)?)/.exec(rest);
    if (match) {
      filters.push({ column, op: rest.includes('<=') || rest.includes('igual') ? 'lte' : 'lt', value: Number(match[1].replace(',', '.')) });
      continue;
    }
    match = /(?:no\s+es|distinto\s+de|diferente\s+de)\s+["“]?([^"”]+?)(?=\s+y\s+|,|\?|$)/.exec(rest);
    if (match) {
      filters.push({ column, op: 'ne', value: match[1].trim() });
      continue;
    }
    match = /(?:contiene|incluye)\s+["“]?([^"”]+?)(?=\s+y\s+|,|\?|$)/.exec(rest);
    if (match) {
      filters.push({ column, op: 'contains', value: match[1].trim() });
      continue;
    }
    match = /(?:es|igual\s+a|=|:)\s*["“]?([^"”]+?)(?=\s+y\s+|,|\?|$)/.exec(rest);
    if (match) {
      filters.push({ column, op: 'eq', value: match[1].trim() });
    }
  }
  return filters;
}

function matches(row, filter) {
  const raw = row.values?.[filter.column.id];
  if (filter.op === 'contains') return normalize(valueText(raw)).includes(normalize(filter.value));
  if (filter.op === 'ne') return normalize(valueText(raw)) !== normalize(filter.value);
  if (filter.op === 'gt' || filter.op === 'gte' || filter.op === 'lt' || filter.op === 'lte') {
    const left = Number(raw);
    const right = Number(filter.value);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (filter.op === 'gt') return left > right;
    if (filter.op === 'gte') return left >= right;
    if (filter.op === 'lt') return left < right;
    return left <= right;
  }
  if (filter.column.type === 'checkbox') {
    const target = ['si', 'sí', 'true', 'verdadero', '1'].includes(normalize(filter.value));
    return raw === target;
  }
  if (filter.column.type === 'number') return Number(raw) === Number(filter.value);
  return normalize(valueText(raw)) === normalize(filter.value);
}

function describe(filter) {
  const op = {
    eq: '=', contains: 'contiene', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤'
  }[filter.op] || filter.op;
  return `${filter.column.name} ${op} «${filter.value}»`;
}

export function askBase(question, { tableId = null } = {}) {
  const prompt = clean(question, 300);
  if (prompt.length < 2) throw new HttpError(400, 'INVALID_VALUE', 'Escribe una pregunta sobre una tabla.', { field: 'question' });
  const tables = listTables();
  if (!tables.length) {
    return {
      answer: 'La Base está vacía: crea una tabla y algunas filas para poder preguntar.',
      table: null, rows: [], total: 0, matched: 0, filters: []
    };
  }
  const table = chooseTable(prompt, tables, tableId);
  if (!table) {
    return {
      answer: `Hay varias tablas (${tables.map((item) => item.name).join(', ')}). Dime el nombre de la tabla en la pregunta.`,
      table: null, rows: [], total: 0, matched: 0, filters: [], ambiguous: true
    };
  }
  const filters = extractFilters(prompt, table);
  const rows = table.rows || [];
  const matched = filters.length ? rows.filter((row) => filters.every((filter) => matches(row, filter))) : rows;
  const countIntent = /cuant|cuánt|total|n[uú]mero|hay/i.test(prompt);
  const preview = matched.slice(0, 20).map((row) => {
    const values = {};
    for (const column of table.columns) values[column.name] = row.values?.[column.id] ?? '';
    return { id: row.id, values };
  });
  const filterText = filters.length ? ` con ${filters.map(describe).join(' y ')}` : '';
  const answer = countIntent
    ? `En «${table.name}» hay ${matched.length} fila(s)${filterText}.`
    : `En «${table.name}» hay ${matched.length} coincidencia(s)${filterText} de ${rows.length} fila(s).`;
  return {
    answer,
    table: { id: table.id, name: table.name, columns: table.columns.map((column) => ({ id: column.id, name: column.name, type: column.type })) },
    rows: preview,
    matched: matched.length,
    total: rows.length,
    filters: filters.map(describe),
    ...(filters.length ? {} : { note: 'No detecté un filtro; muestro el conteo y las primeras filas.' })
  };
}

export { normalize as normalizeAskText };



/**
 * Validación de payloads de documentos (sin dependencias).
 *
 * Todo error es un `ValidationError` (400) con `field` identificable, para que
 * el frontend pueda señalar el campo exacto. Los valores se normalizan (texto
 * recortado, fechas convertidas a `Date`, listas acotadas) antes de llegar a los
 * generadores.
 */
import { ValidationError } from '../http/errors.mjs';
import { cleanText, parseDateInput } from './ooxml.mjs';

export const DOC_TYPES = Object.freeze(['docx', 'xlsx', 'pptx']);
export const TEMPLATE_TYPES = Object.freeze(['docx', 'xlsx', 'pptx', 'any']);

export const LIMITS = Object.freeze({
  title: 200,
  subtitle: 300,
  subject: 300,
  author: 80,
  paragraph: 8000,
  heading: 300,
  sectionBlocks: 200,
  listItems: 200,
  listItem: 1000,
  tableColumns: 20,
  tableRows: 500,
  tableCell: 2000,
  annexParagraphs: 100,
  notes: 8000,
  sheets: 12,
  sheetColumns: 30,
  sheetRows: 2000,
  sheetCell: 2000,
  slides: 60,
  bullets: 12,
  bullet: 2000,
  pptTableColumns: 10,
  pptTableRows: 20,
  pptTableCell: 500,
  attendees: 50,
  agendaItems: 30,
  agreements: 50,
  summaryLines: 10,
  annexNotes: 100,
  emailRecipients: 20,
  emailSubject: 200,
  emailBody: 10000,
  templates: 30
});

const SHEET_COLUMN_TYPES = new Set(['text', 'number', 'currency', 'percent', 'date', 'boolean']);
const SLIDE_LAYOUTS = new Set(['cover', 'section', 'content', 'table']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(field, message) {
  throw new ValidationError(field, 'VALIDATION', message);
}

function requiredObject(value, field) {
  if (!isPlainObject(value)) fail(field, `${field} debe ser un objeto.`);
  return value;
}

function text(value, field, { required = false, max = 500, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(field, `${field} es obligatorio.`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') fail(field, `${field} debe ser texto.`);
  const clean = cleanText(value);
  if (required && !clean) fail(field, `${field} no puede estar vacío.`);
  if (clean.length < min) fail(field, `${field} debe tener al menos ${min} caracteres.`);
  if (clean.length > max) fail(field, `${field} supera ${max} caracteres.`);
  return clean;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || value === '') return '';
  return text(value, field, { max });
}

function boolean(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(field, `${field} debe ser booleano.`);
  return value;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < min || numeric > max) {
    fail(field, `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return numeric;
}

function array(value, field, { required = true, max = 100, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(field, `${field} es obligatorio.`);
    return [];
  }
  if (!Array.isArray(value)) fail(field, `${field} debe ser un arreglo.`);
  if (value.length < min) fail(field, `${field} necesita al menos ${min} elementos.`);
  if (value.length > max) fail(field, `${field} supera ${max} elementos.`);
  return value;
}

function normalizeEmail(value, field) {
  const email = String(value ?? '').trim();
  if (email.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    fail(field, `El correo "${email.slice(0, 80)}" no es válido.`);
  }
  return email;
}

/* ------------------------------------------------------------------ */
/* Bloques DOCX                                                        */
/* ------------------------------------------------------------------ */

function normalizeRuns(value, field) {
  const runs = array(value, field, { max: 200 });
  return runs.map((run, index) => {
    if (!isPlainObject(run)) fail(`${field}[${index}]`, 'Cada carrera debe ser un objeto {text, bold?, italic?}.');
    return {
      text: text(run.text, `${field}[${index}].text`, { max: LIMITS.paragraph }),
      bold: boolean(run.bold, `${field}[${index}].bold`),
      italic: boolean(run.italic, `${field}[${index}].italic`)
    };
  });
}

function normalizeListItems(value, field, max = LIMITS.listItems) {
  const items = Array.isArray(value) ? value : [];
  if (items.length > max) fail(field, `${field} supera ${max} elementos.`);
  return items.map((item, index) => {
    if (isPlainObject(item)) {
      return {
        text: text(item.text, `${field}[${index}].text`, { required: true, max: LIMITS.listItem }),
        level: integer(item.level, `${field}[${index}].level`, { min: 0, max: 2, fallback: 0 }),
        bold: boolean(item.bold, `${field}[${index}].bold`)
      };
    }
    return { text: text(item, `${field}[${index}]`, { required: true, max: LIMITS.listItem }), level: 0, bold: false };
  });
}

function normalizeDocxCell(value, field) {
  if (Array.isArray(value)) {
    if (value.length > 10) fail(field, `${field} admite como máximo 10 líneas.`);
    return value.map((line, index) => text(line, `${field}[${index}]`, { max: LIMITS.tableCell }));
  }
  if (isPlainObject(value)) {
    return text(value.text, `${field}.text`, { max: LIMITS.tableCell });
  }
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return text(value, field, { max: LIMITS.tableCell });
}

function normalizeDocxTable(value, field) {
  const table = requiredObject(value, field);
  const headers = table.headers === undefined ? [] : array(table.headers, `${field}.headers`, { required: false, max: LIMITS.tableColumns });
  const rows = table.rows === undefined ? [] : array(table.rows, `${field}.rows`, { required: false, max: LIMITS.tableRows });
  const normalizedHeaders = headers.map((header, index) => normalizeDocxCell(header, `${field}.headers[${index}]`));
  const normalizedRows = rows.map((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : [row];
    if (cells.length > LIMITS.tableColumns) fail(`${field}.rows[${rowIndex}]`, `Máximo ${LIMITS.tableColumns} columnas por fila.`);
    return cells.map((cell, columnIndex) => normalizeDocxCell(cell, `${field}.rows[${rowIndex}][${columnIndex}]`));
  });
  if (!normalizedHeaders.length && !normalizedRows.length) fail(`${field}`, 'La tabla no tiene headers ni rows.');
  let widths = null;
  if (table.widths !== undefined) {
    widths = array(table.widths, `${field}.widths`, { required: false, max: LIMITS.tableColumns })
      .map((width, index) => {
        const numeric = Number(width);
        if (!Number.isFinite(numeric) || numeric <= 0) fail(`${field}.widths[${index}]`, 'El ancho debe ser un número positivo.');
        return numeric;
      });
  }
  return {
    headers: normalizedHeaders,
    rows: normalizedRows,
    widths,
    caption: optionalText(table.caption, `${field}.caption`, 200)
  };
}

function normalizeDocxBlock(block, field) {
  if (!isPlainObject(block)) fail(field, 'Cada bloque debe ser un objeto.');
  if (block.pageBreak === true) return { pageBreak: true };
  if (block.heading !== undefined) {
    return { heading: text(block.heading, `${field}.heading`, { required: true, max: LIMITS.heading }), level: block.level === 2 ? 2 : 1 };
  }
  if (block.h1 !== undefined) return { heading: text(block.h1, `${field}.h1`, { required: true, max: LIMITS.heading }), level: 1 };
  if (block.h2 !== undefined) return { heading: text(block.h2, `${field}.h2`, { required: true, max: LIMITS.heading }), level: 2 };
  if (block.paragraph !== undefined || block.p !== undefined || block.text !== undefined) {
    const raw = block.paragraph !== undefined ? block.paragraph : block.p !== undefined ? block.p : block.text;
    const style = block.quote === true || block.style === 'Cita' ? 'Cita' : 'Normal';
    let align = null;
    if (block.align !== undefined && block.align !== null && block.align !== '') {
      align = text(block.align, `${field}.align`, { max: 20 }).toLowerCase();
      if (!['left', 'center', 'right', 'justify'].includes(align)) {
        fail(`${field}.align`, 'align debe ser left, center, right o justify.');
      }
    }
    return { paragraph: text(raw, `${field}.paragraph`, { max: LIMITS.paragraph }), style, align };
  }
  if (block.quote !== undefined) return { quote: text(block.quote, `${field}.quote`, { max: LIMITS.paragraph }) };
  if (block.runs !== undefined) return { runs: normalizeRuns(block.runs, `${field}.runs`) };
  if (block.list !== undefined) {
    const list = Array.isArray(block.list) ? { items: block.list } : requiredObject(block.list, `${field}.list`);
    return { list: { ordered: boolean(list.ordered, `${field}.list.ordered`), items: normalizeListItems(list.items, `${field}.list.items`) } };
  }
  if (block.bullets !== undefined) return { list: { ordered: false, items: normalizeListItems(block.bullets, `${field}.bullets`) } };
  if (block.numbered !== undefined) return { list: { ordered: true, items: normalizeListItems(block.numbered, `${field}.numbered`) } };
  if (block.table !== undefined) return { table: normalizeDocxTable(block.table, `${field}.table`) };
  fail(field, 'Bloque sin contenido reconocido (heading, paragraph, quote, list, table, pageBreak o runs).');
}

function normalizeDocxBlocks(value, field, { required = false, max = LIMITS.sectionBlocks } = {}) {
  const blocks = array(value, field, { required, max });
  return blocks.map((block, index) => normalizeDocxBlock(block, `${field}[${index}]`));
}

function normalizeMargins(value, field) {
  if (value === undefined || value === null) return undefined;
  const margins = requiredObject(value, field);
  const result = {};
  for (const key of ['top', 'right', 'bottom', 'left']) {
    if (margins[key] === undefined) continue;
    const numeric = Number(margins[key]);
    if (!Number.isFinite(numeric) || numeric < 360 || numeric > 4320) {
      fail(`${field}.${key}`, 'El margen debe estar entre 360 y 4320 twips (0,25–3 pulgadas).');
    }
    result[key] = Math.round(numeric);
  }
  return result;
}

function normalizeAnnex(value, field) {
  if (value === undefined || value === null) return null;
  const annex = requiredObject(value, field);
  const paragraphs = annex.paragraphs === undefined ? [] : array(annex.paragraphs, `${field}.paragraphs`, { required: false, max: LIMITS.annexParagraphs })
    .map((paragraph, index) => text(paragraph, `${field}.paragraphs[${index}]`, { max: LIMITS.paragraph }));
  const items = annex.items === undefined ? [] : normalizeListItems(annex.items, `${field}.items`);
  const sections = annex.sections === undefined ? [] : normalizeDocxBlocks(annex.sections, `${field}.sections`, { max: 100 });
  if (!paragraphs.length && !items.length && !sections.length && !annex.note) {
    fail(field, 'El anexo necesita paragraphs, items, sections o note.');
  }
  return {
    title: optionalText(annex.title, `${field}.title`, 200) || 'Anexo privado',
    private: boolean(annex.private, `${field}.private`, true),
    note: optionalText(annex.note, `${field}.note`, 1000),
    paragraphs,
    items,
    sections
  };
}

/* ------------------------------------------------------------------ */
/* Campos de la plantilla «acta»                                       */
/* ------------------------------------------------------------------ */

function normalizeAttendees(value, field) {
  if (value === undefined || value === null) return [];
  const attendees = array(value, field, { required: false, max: LIMITS.attendees });
  return attendees.map((attendee, index) => {
    if (isPlainObject(attendee)) {
      return {
        name: text(attendee.name ?? attendee.nombre, `${field}[${index}].name`, { required: true, max: 200 }),
        role: optionalText(attendee.role ?? attendee.cargo, `${field}[${index}].role`, 100),
        attendance: optionalText(attendee.attendance ?? attendee.asistencia, `${field}[${index}].attendance`, 40) || 'Asistió'
      };
    }
    return { name: text(attendee, `${field}[${index}]`, { required: true, max: 200 }), role: '', attendance: 'Asistió' };
  });
}

function normalizeAgenda(value, field) {
  if (value === undefined || value === null) return [];
  const items = array(value, field, { required: false, max: LIMITS.agendaItems });
  return items.map((item, index) => {
    if (isPlainObject(item)) return text(item.text ?? item.tema, `${field}[${index}]`, { required: true, max: 300 });
    return text(item, `${field}[${index}]`, { required: true, max: 300 });
  });
}

function normalizeAgreements(value, field) {
  if (value === undefined || value === null) return [];
  const agreements = array(value, field, { required: false, max: LIMITS.agreements });
  return agreements.map((agreement, index) => {
    if (isPlainObject(agreement)) {
      return {
        text: text(agreement.text ?? agreement.acuerdo ?? agreement.topic, `${field}[${index}].text`, { required: true, max: 500 }),
        owner: optionalText(agreement.owner ?? agreement.responsable, `${field}[${index}].owner`, 100),
        due: optionalText(agreement.due ?? agreement.fecha, `${field}[${index}].due`, 40),
        status: optionalText(agreement.status ?? agreement.estado, `${field}[${index}].status`, 40) || 'Pendiente'
      };
    }
    return { text: text(agreement, `${field}[${index}]`, { required: true, max: 500 }), owner: '', due: '', status: 'Pendiente' };
  });
}

function normalizeSummary(value, field) {
  if (value === undefined || value === null) return [];
  const lines = array(value, field, { required: false, max: LIMITS.summaryLines });
  return lines.map((line, index) => text(line, `${field}[${index}]`, { required: true, max: 300 }));
}

function normalizeAnnexNotes(value, field) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [text(value, field, { max: LIMITS.paragraph })];
  const notes = array(value, field, { required: false, max: LIMITS.annexNotes });
  return notes.map((note, index) => text(note, `${field}[${index}]`, { max: LIMITS.paragraph }));
}

function normalizeActaFields(body) {
  const time = body.time === undefined || body.time === null || body.time === ''
    ? ''
    : String(body.time).trim();
  if (time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
    fail('time', 'La hora debe tener formato HH:MM (24 h).');
  }
  let development = null;
  if (body.body !== undefined && body.body !== null && body.body !== '') {
    development = [{ paragraph: text(body.body, 'body', { max: LIMITS.paragraph }) }];
  }
  if (body.bodySections !== undefined) {
    const blocks = normalizeDocxBlocks(body.bodySections, 'bodySections', { max: 100 });
    development = [...(development || []), ...blocks];
  }
  return {
    topic: optionalText(body.topic ?? body.tema ?? body.subject, 'topic', 200),
    reference: optionalText(body.reference ?? body.referencia, 'reference', 80),
    location: optionalText(body.location ?? body.lugar, 'location', 200),
    modality: optionalText(body.modality ?? body.modalidad, 'modality', 80),
    time,
    attendees: normalizeAttendees(body.attendees ?? body.asistentes, 'attendees'),
    agenda: normalizeAgenda(body.agenda ?? body.ordenDelDia, 'agenda'),
    agreements: normalizeAgreements(body.agreements ?? body.acuerdos, 'agreements'),
    summary: normalizeSummary(body.summary ?? body.resumen, 'summary'),
    annexNotes: normalizeAnnexNotes(body.annexNotes ?? body.notasPrivadas, 'annexNotes'),
    development
  };
}

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

function normalizeSheetCell(value, field) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(field, 'La fecha de la celda no es válida.');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > LIMITS.sheetCell) fail(field, `La celda supera ${LIMITS.sheetCell} caracteres.`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(field, 'El número de la celda no es finito.');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (isPlainObject(value)) {
    if (value.formula !== undefined) {
      const formula = text(value.formula, `${field}.formula`, { required: true, max: 500 });
      return {
        formula,
        bold: boolean(value.bold, `${field}.bold`),
        total: boolean(value.total, `${field}.total`)
      };
    }
    if (value.date !== undefined) {
      return { date: parseDateInput(value.date) };
    }
    if (value.percent !== undefined) {
      const numeric = Number(value.percent);
      if (!Number.isFinite(numeric)) fail(`${field}.percent`, 'El porcentaje debe ser numérico (0,35 = 35 %).');
      return { percent: numeric };
    }
    if (value.currency !== undefined) {
      const numeric = Number(value.currency);
      if (!Number.isFinite(numeric)) fail(`${field}.currency`, 'El importe debe ser numérico.');
      return { currency: numeric };
    }
    if (value.value !== undefined || value.text !== undefined || value.number !== undefined) {
      const raw = value.value !== undefined ? value.value : value.text !== undefined ? value.text : value.number;
      if (raw !== null && typeof raw === 'object') fail(field, 'El valor de la celda debe ser primitivo.');
      return {
        value: raw,
        type: value.type === undefined ? undefined : text(value.type, `${field}.type`, { max: 20 }),
        bold: boolean(value.bold, `${field}.bold`),
        total: boolean(value.total, `${field}.total`)
      };
    }
    fail(field, 'Objeto de celda no reconocido (usa formula, date, percent, currency o value).');
  }
  fail(field, 'Tipo de celda no admitido.');
}

function normalizeSheetColumns(value, field) {
  if (value === undefined || value === null) return [];
  const columns = array(value, field, { required: false, max: LIMITS.sheetColumns });
  return columns.map((column, index) => {
    if (typeof column === 'string') return { header: text(column, `${field}[${index}]`, { required: true, max: 200 }) };
    if (!isPlainObject(column)) fail(`${field}[${index}]`, 'Cada columna debe ser texto u objeto.');
    const header = optionalText(column.header ?? column.title ?? column.key, `${field}[${index}].header`, 200);
    const key = optionalText(column.key, `${field}[${index}].key`, 100);
    if (!header && !key) fail(`${field}[${index}]`, 'La columna necesita header o key.');
    const type = column.type === undefined ? '' : text(column.type, `${field}[${index}].type`, { max: 20 }).toLowerCase();
    if (type && !SHEET_COLUMN_TYPES.has(type)) fail(`${field}[${index}].type`, `Tipo de columna no válido: ${type}.`);
    let width;
    if (column.width !== undefined) {
      const numeric = Number(column.width);
      if (!Number.isFinite(numeric) || numeric < 6 || numeric > 80) fail(`${field}[${index}].width`, 'El ancho de columna debe estar entre 6 y 80.');
      width = Math.round(numeric);
    }
    return {
      header,
      key,
      type: type || undefined,
      width,
      wrap: boolean(column.wrap, `${field}[${index}].wrap`)
    };
  });
}

function normalizeSheetRows(value, field) {
  if (value === undefined || value === null) return [];
  const rows = array(value, field, { required: false, max: LIMITS.sheetRows });
  return rows.map((row, rowIndex) => {
    if (Array.isArray(row)) {
      if (row.length > LIMITS.sheetColumns) fail(`${field}[${rowIndex}]`, `Máximo ${LIMITS.sheetColumns} columnas por fila.`);
      return row.map((cell, columnIndex) => normalizeSheetCell(cell, `${field}[${rowIndex}][${columnIndex}]`));
    }
    if (isPlainObject(row)) {
      const normalized = {};
      for (const [key, cell] of Object.entries(row)) {
        if (key.length > 100) fail(`${field}[${rowIndex}]`, 'Clave de fila demasiado larga.');
        normalized[key] = normalizeSheetCell(cell, `${field}[${rowIndex}].${key}`);
      }
      return normalized;
    }
    fail(`${field}[${rowIndex}]`, 'Cada fila debe ser un arreglo o un objeto.');
  });
}

/* ------------------------------------------------------------------ */
/* PPTX                                                                */
/* ------------------------------------------------------------------ */

function normalizeSlideItems(value, field) {
  if (value === undefined || value === null) return [];
  const items = array(value, field, { required: false, max: LIMITS.bullets });
  return items.map((item, index) => {
    if (isPlainObject(item)) {
      return {
        text: text(item.text, `${field}[${index}].text`, { required: true, max: LIMITS.bullet }),
        level: integer(item.level, `${field}[${index}].level`, { min: 0, max: 2, fallback: 0 }),
        ordered: boolean(item.ordered, `${field}[${index}].ordered`)
      };
    }
    return { text: text(item, `${field}[${index}]`, { required: true, max: LIMITS.bullet }), level: 0, ordered: false };
  });
}

function normalizePptTable(value, field) {
  const table = requiredObject(value, field);
  const headers = table.headers === undefined ? [] : array(table.headers, `${field}.headers`, { required: false, max: LIMITS.pptTableColumns })
    .map((header, index) => text(header, `${field}.headers[${index}]`, { max: LIMITS.pptTableCell }));
  const rows = table.rows === undefined ? [] : array(table.rows, `${field}.rows`, { required: false, max: LIMITS.pptTableRows });
  const normalizedRows = rows.map((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : [row];
    if (cells.length > LIMITS.pptTableColumns) fail(`${field}.rows[${rowIndex}]`, `Máximo ${LIMITS.pptTableColumns} columnas.`);
    return cells.map((cell, columnIndex) => {
      if (Array.isArray(cell)) fail(`${field}.rows[${rowIndex}][${columnIndex}]`, 'La celda de una diapositiva debe ser texto.');
      if (isPlainObject(cell)) return text(cell.text, `${field}.rows[${rowIndex}][${columnIndex}].text`, { max: LIMITS.pptTableCell });
      if (cell === undefined || cell === null) return '';
      if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
      return text(cell, `${field}.rows[${rowIndex}][${columnIndex}]`, { max: LIMITS.pptTableCell });
    });
  });
  if (!headers.length && !normalizedRows.length) fail(field, 'La tabla necesita headers o rows.');
  let widths = null;
  if (table.widths !== undefined) {
    widths = array(table.widths, `${field}.widths`, { required: false, max: LIMITS.pptTableColumns })
      .map((width, index) => {
        const numeric = Number(width);
        if (!Number.isFinite(numeric) || numeric <= 0) fail(`${field}.widths[${index}]`, 'El ancho debe ser positivo.');
        return numeric;
      });
  }
  return { headers, rows: normalizedRows, widths };
}

function normalizeSlides(value, documentNotes) {
  const slides = array(value, 'slides', { required: true, max: LIMITS.slides, min: 1 });
  return slides.map((slide, index) => {
    const field = `slides[${index}]`;
    if (!isPlainObject(slide)) fail(field, 'Cada diapositiva debe ser un objeto.');
    const layout = slide.layout === undefined ? undefined : text(slide.layout, `${field}.layout`, { max: 20 }).toLowerCase();
    if (layout && !SLIDE_LAYOUTS.has(layout)) fail(`${field}.layout`, `layout debe ser: ${[...SLIDE_LAYOUTS].join(', ')}.`);
    const bullets = normalizeSlideItems(slide.bullets, `${field}.bullets`);
    const numbered = normalizeSlideItems(slide.numbered, `${field}.numbered`);
    const table = slide.table === undefined || slide.table === null ? null : normalizePptTable(slide.table, `${field}.table`);
    const cover = slide.cover === true || layout === 'cover' || layout === 'section';
    if (!cover && table && (bullets.length || numbered.length)) {
      fail(field, 'Una diapositiva no puede combinar viñetas y tabla; usa dos diapositivas.');
    }
    if (!cover && !table && !bullets.length && !numbered.length) {
      fail(field, 'La diapositiva necesita bullets, numbered o table.');
    }
    return {
      layout: cover ? (layout === 'section' ? 'section' : 'cover') : table ? 'table' : 'content',
      title: text(slide.title, `${field}.title`, { required: true, max: LIMITS.title }),
      subtitle: optionalText(slide.subtitle, `${field}.subtitle`, LIMITS.subtitle),
      bullets,
      numbered,
      table,
      notes: optionalText(slide.notes, `${field}.notes`, LIMITS.notes) || documentNotes
    };
  });
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Valida y normaliza el cuerpo de `POST /api/docs`.
 * @param {any} body
 * @returns {any} especificación normalizada
 */
export function validateDocumentInput(body) {
  const input = requiredObject(body, 'body');
  const type = text(input.type, 'type', { required: true, max: 10 }).toLowerCase();
  if (!DOC_TYPES.includes(type)) fail('type', `type debe ser uno de: ${DOC_TYPES.join(', ')}.`);
  const title = text(input.title, 'title', { required: true, max: LIMITS.title });
  const register = boolean(input.register, 'register', true);
  const template = optionalText(input.template, 'template', 60);
  const author = optionalText(input.author, 'author', LIMITS.author);
  const subject = optionalText(input.subject, 'subject', LIMITS.subject);
  const notes = optionalText(input.notes, 'notes', LIMITS.notes);
  const date = input.date === undefined || input.date === null || input.date === '' ? undefined : parseDateInput(input.date);
  const brand = input.brand === undefined || input.brand === null ? undefined : requiredObject(input.brand, 'brand');
  const watermark = optionalText(input.watermark, 'watermark', 40);
  const preset = optionalText(input.preset, 'preset', 24) || undefined;
  const brandExplicit = input.brand !== undefined && input.brand !== null;
  const base = { type, title, register, template, author, subject, notes, date, brand, brandExplicit, watermark, preset };

  if (type === 'docx') {
    const sections = normalizeDocxBlocks(input.sections, 'sections', { required: false });
    const annex = normalizeAnnex(input.annex, 'annex');
    const isActa = template.toLowerCase() === 'acta';
    if (!sections.length && !annex && !isActa) {
      fail('sections', 'Un DOCX necesita al menos un bloque en sections o un annex (o la plantilla "acta").');
    }
    return {
      ...base,
      subtitle: optionalText(input.subtitle, 'subtitle', LIMITS.subtitle),
      reference: optionalText(input.reference, 'reference', 80),
      sections,
      annex,
      margins: normalizeMargins(input.margins, 'margins'),
      acta: isActa ? normalizeActaFields(input) : undefined
    };
  }

  if (type === 'xlsx') {
    const sheets = array(input.sheets, 'sheets', { required: true, max: LIMITS.sheets, min: 1 });
    const normalizedSheets = sheets.map((sheet, index) => {
      const field = `sheets[${index}]`;
      if (!isPlainObject(sheet)) fail(field, 'Cada hoja debe ser un objeto.');
      const name = optionalText(sheet.name, `${field}.name`, 31);
      const columns = normalizeSheetColumns(sheet.columns, `${field}.columns`);
      const rows = normalizeSheetRows(sheet.rows, `${field}.rows`);
      if (!columns.length && rows.length && rows.some((row) => isPlainObject(row))) {
        fail(`${field}.columns`, 'Si las filas son objetos, define columns con header o key para mapearlas.');
      }
      if (!columns.length && !rows.length) fail(field, 'La hoja necesita columns o rows.');
      let widths;
      if (sheet.widths !== undefined) {
        widths = array(sheet.widths, `${field}.widths`, { required: false, max: LIMITS.sheetColumns })
          .map((width, widthIndex) => {
            const numeric = Number(width);
            if (!Number.isFinite(numeric) || numeric < 6 || numeric > 80) fail(`${field}.widths[${widthIndex}]`, 'El ancho debe estar entre 6 y 80.');
            return Math.round(numeric);
          });
      }
      return {
        name,
        columns,
        rows,
        widths,
        totals: boolean(sheet.totals, `${field}.totals`),
        freeze: sheet.freeze === undefined ? true : boolean(sheet.freeze, `${field}.freeze`),
        autoFilter: sheet.autoFilter === undefined ? true : boolean(sheet.autoFilter, `${field}.autoFilter`),
        currency: optionalText(sheet.currency, `${field}.currency`, 4)
      };
    });
    return {
      ...base,
      sheets: normalizedSheets,
      currency: optionalText(input.currency, 'currency', 4)
    };
  }

  const slides = normalizeSlides(input.slides, notes);
  return {
    ...base,
    subtitle: optionalText(input.subtitle, 'subtitle', LIMITS.subtitle),
    slides
  };}

/**
 * Valida `POST /api/docs/templates`.
 * @param {any} body
 */
export function validateTemplateInput(body) {
  const input = requiredObject(body, 'body');
  const rawName = text(input.name, 'name', { required: true, max: 60 });
  const name = rawName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(name)) {
    fail('name', 'El nombre de la plantilla debe tener 2-40 caracteres: letras, números, punto, guion o guion bajo.');
  }
  const type = input.type === undefined ? 'any' : text(input.type, 'type', { max: 10 }).toLowerCase();
  if (!TEMPLATE_TYPES.includes(type)) fail('type', `type debe ser uno de: ${TEMPLATE_TYPES.join(', ')}.`);
  if (!isPlainObject(input.brand)) fail('brand', 'brand es obligatorio y debe ser un objeto.');
  return {
    name,
    type,
    brand: input.brand,
    description: optionalText(input.description, 'description', 200)
  };
}

/**
 * Valida `POST /api/docs/:id/send-email`.
 * @param {any} body
 */
export function validateEmailInput(body) {
  const input = requiredObject(body, 'body');
  const recipients = typeof input.to === 'string' ? [input.to] : input.to;
  const list = array(recipients, 'to', { required: true, max: LIMITS.emailRecipients, min: 1 })
    .map((email, index) => normalizeEmail(email, `to[${index}]`));
  const subject = text(input.subject, 'subject', { required: true, max: LIMITS.emailSubject });
  const message = text(input.body, 'body', { required: true, max: LIMITS.emailBody });
  const connectionId = optionalText(input.connectionId, 'connectionId', 80);
  return { to: list, subject, body: message, connectionId };
}

export default {
  DOC_TYPES,
  TEMPLATE_TYPES,
  LIMITS,
  validateDocumentInput,
  validateTemplateInput,
  validateEmailInput
};



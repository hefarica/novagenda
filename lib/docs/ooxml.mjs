/**
 * Utilidades compartidas para generar y verificar paquetes OOXML.
 *
 * - Escape de XML y construcción de partes comunes (`[Content_Types].xml`,
 *   relaciones, `docProps/core.xml` y `docProps/app.xml`).
 * - Normalización de la marca (fuente, color, logotipo textual, firma).
 * - Nombres de archivo seguros y cabecera `Content-Disposition`.
 * - Verificación estructural de un paquete: XML bien formado, tipos de
 *   contenido presentes, relaciones resolubles y partes requeridas.
 */
import { checkXml } from './xmlcheck.mjs';
import { ValidationError } from '../http/errors.mjs';

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const NS = Object.freeze({
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  relationships: 'http://schemas.openxmlformats.org/package/2006/relationships',
  word: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wordRels: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  spreadsheet: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  extendedProperties: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
});

export const REL = Object.freeze({
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  sharedStrings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  presProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps',
  viewProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps',
  tableStyles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles'
});

export const CT = Object.freeze({
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  docxDocument: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docxStyles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  docxNumbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  docxSettings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  docxHeader: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  docxFooter: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  xlsxWorkbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xlsxWorksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  xlsxStyles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  xlsxSharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  xlsxCalcChain: 'application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml',
  pptxPresentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptxSlideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  pptxSlideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  pptxSlide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  pptxNotesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  pptxNotesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  pptxPresProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  pptxViewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  pptxTableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  coreProperties: 'application/vnd.openxmlformats-package.core-properties+xml',
  extendedProperties: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
});

/** Caracteres de control no válidos en XML 1.0. */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Limpia caracteres que XML 1.0 no admite. */
export function sanitizeXmlText(value) {
  return String(value ?? '').replace(INVALID_XML_CHARS, '');
}

/** Escapa contenido de texto XML. */
export function escapeXml(value) {
  return sanitizeXmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Escapa un valor de atributo XML. */
export function escapeAttr(value) {
  return escapeXml(value);
}

/** Convierte un valor a texto UTF-8 sin caracteres inválidos. */
export function cleanText(value) {
  return sanitizeXmlText(value).replace(/\r\n?/g, '\n').trim();
}

/* ------------------------------------------------------------------ */
/* Marca                                                               */
/* ------------------------------------------------------------------ */

export const DEFAULT_BRAND = Object.freeze({
  font: 'Calibri',
  color: '1F3864',
  accent: '2E74B5',
  logoText: 'Agenda Copilot P95',
  signature: 'Generado por Agenda Copilot P95',
  footerText: 'Confidencial',
  creator: 'Agenda Copilot P95'
});

const FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** Normaliza un color hex (#abc, #AABBCC) a `AABBCC` en mayúsculas. */
export function hexColor(value, fallback = DEFAULT_BRAND.color) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return raw.split('').map((char) => char + char).join('').toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  return String(fallback || DEFAULT_BRAND.color).replace(/^#/, '').toUpperCase();
}

/** Texto legible (blanco/negro) sobre un color de fondo. */
export function contrastText(color) {
  const hex = hexColor(color);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '000000' : 'FFFFFF';
}

/** Mezcla un color con blanco (`amount` 0..1) para fondos suaves. */
export function lighten(color, amount = 0.85) {
  const hex = hexColor(color);
  const ratio = Math.min(1, Math.max(0, Number(amount) || 0));
  const parts = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(channel + (255 - channel) * ratio).toString(16).padStart(2, '0');
  });
  return parts.join('').toUpperCase();
}

/** Mezcla un color con negro (`amount` 0..1). */
export function darken(color, amount = 0.25) {
  const hex = hexColor(color);
  const ratio = Math.min(1, Math.max(0, Number(amount) || 0));
  const parts = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(channel * (1 - ratio)).toString(16).padStart(2, '0');
  });
  return parts.join('').toUpperCase();
}

function brandText(value, max, fallback) {
  const text = cleanText(value);
  if (!text) return fallback;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Normaliza la marca de una plantilla. Cualquier valor inválido cae al valor
 * por defecto salvo que se pida estricto (validación de entrada de la API).
 * @param {any} input
 * @param {{strict?:boolean}} [options]
 */
export function normalizeBrand(input = {}, options = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const strict = options.strict === true;
  const brand = { ...DEFAULT_BRAND };
  if (raw.font !== undefined) {
    const font = cleanText(raw.font);
    if (font && FONT_RE.test(font)) brand.font = font;
    else if (strict) throw new ValidationError('brand.font', 'VALIDATION', 'La fuente de la marca no es válida (1-40 caracteres alfanuméricos).');
  }
  for (const key of ['color', 'accent']) {
    if (raw[key] === undefined) continue;
    const value = String(raw[key]).trim();
    if (/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) brand[key] = hexColor(value);
    else if (strict) throw new ValidationError(`brand.${key}`, 'VALIDATION', `El color "${key}" debe ser hexadecimal (#RRGGBB).`);
  }
  const texts = { logoText: 80, signature: 200, footerText: 200, creator: 80 };
  for (const [key, max] of Object.entries(texts)) {
    if (raw[key] === undefined) continue;
    const clean = cleanText(raw[key]);
    if (!clean) continue;
    if (clean.length > max) {
      if (strict) throw new ValidationError(`brand.${key}`, 'VALIDATION', `"${key}" supera ${max} caracteres.`);
      brand[key] = clean.slice(0, max);
    } else {
      brand[key] = clean;
    }
  }
  return brand;
}

/* ------------------------------------------------------------------ */
/* Fechas                                                              */
/* ------------------------------------------------------------------ */

export const MONTHS_ES = Object.freeze([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
]);

/**
 * Interpreta una fecha ISO (`YYYY-MM-DD` o ISO completo). Rechaza fechas
 * imposibles (`2026-02-31`) con `INVALID_DATE`.
 * @param {string|Date|undefined|null} value
 * @param {Date} [fallback]
 * @returns {Date}
 */
export function parseDateInput(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback ? new Date(fallback.getTime()) : new Date();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValidationError('date', 'INVALID_DATE', 'La fecha no es válida.');
    return new Date(value.getTime());
  }
  const text = String(value).trim();
  const key = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (key) {
    const year = Number(key[1]);
    const month = Number(key[2]);
    const day = Number(key[3]);
    const date = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new ValidationError('date', 'INVALID_DATE', `La fecha ${text} no existe en el calendario.`);
    }
    return date;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('date', 'INVALID_DATE', `La fecha "${text}" no es válida (usa YYYY-MM-DD o ISO-8601).`);
  }
  return parsed;
}

export function dateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateLongEs(date = new Date()) {
  return `${date.getDate()} de ${MONTHS_ES[date.getMonth()]} de ${date.getFullYear()}`;
}

export function formatDateTimeEs(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Serial de Excel (sistema 1900, con el bug del 29/02/1900 ya incorporado). */
export function excelSerial(date) {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds());
  const epoch = Date.UTC(1899, 11, 30);
  return (utc - epoch) / 86400000;
}

/** ISO-8601 UTC para docProps (`2026-10-28T12:00:00Z`). */
export function isoUtc(date = new Date()) {
  return new Date(date.getTime()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------------------------------------------ */
/* Nombres y cabeceras                                                 */
/* ------------------------------------------------------------------ */

/**
 * Convierte un título en un nombre de archivo ASCII seguro.
 * @param {string} title
 * @param {{maxLength?:number}} [options]
 */
export function slugify(title, options = {}) {
  const maxLength = Number(options.maxLength) || 70;
  const normalized = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const slug = normalized.slice(0, maxLength).replace(/-+$/g, '');
  return slug || 'documento';
}

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Nombre de archivo presentable y seguro: `<slug>-<YYYY-MM-DD>.<ext>`.
 * @param {string} title
 * @param {string} extension
 * @param {{date?:Date}} [options]
 */
export function buildFilename(title, extension, options = {}) {
  const ext = String(extension || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const date = options.date instanceof Date ? options.date : new Date();
  let slug = slugify(title);
  if (WINDOWS_RESERVED.has(slug)) slug = `${slug}-documento`;
  return `${slug}-${dateKey(date)}.${ext}`;
}

/**
 * Cabecera `Content-Disposition` con respaldo ASCII y `filename*` RFC 5987.
 * @param {string} filename
 * @param {'attachment'|'inline'} [disposition]
 */
export function contentDisposition(filename, disposition = 'attachment') {
  const safe = String(filename || 'documento').replace(/[\r\n]/g, '');
  const ascii = safe.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/* ------------------------------------------------------------------ */
/* Partes comunes del paquete                                          */
/* ------------------------------------------------------------------ */

/**
 * Construye `[Content_Types].xml`.
 * @param {{defaults?:Array<{extension:string, contentType:string}>, overrides?:Array<{partName:string, contentType:string}>}} input
 */
export function contentTypesXml({ defaults = [], overrides = [] } = {}) {
  const defaultLines = defaults.map((item) => `  <Default Extension="${escapeAttr(item.extension)}" ContentType="${escapeAttr(item.contentType)}"/>`);
  const overrideLines = overrides.map((item) => {
    const partName = item.partName.startsWith('/') ? item.partName : `/${item.partName}`;
    return `  <Override PartName="${escapeAttr(partName)}" ContentType="${escapeAttr(item.contentType)}"/>`;
  });
  return `${XML_DECL}<Types xmlns="${NS.contentTypes}">\n${[...defaultLines, ...overrideLines].join('\n')}\n</Types>`;
}

/**
 * Construye un archivo `.rels`.
 * @param {Array<{id:string, type:string, target:string, targetMode?:string}>} relationships
 */
export function relsXml(relationships = []) {
  const lines = relationships.map((item) => {
    const mode = item.targetMode === 'External' ? ' TargetMode="External"' : '';
    return `  <Relationship Id="${escapeAttr(item.id)}" Type="${escapeAttr(item.type)}" Target="${escapeAttr(item.target)}"${mode}/>`;
  });
  return `${XML_DECL}<Relationships xmlns="${NS.relationships}">\n${lines.join('\n')}\n</Relationships>`;
}

/**
 * Construye `docProps/core.xml`.
 * @param {{title?:string, subject?:string, creator?:string, description?:string, keywords?:string, category?:string, created?:Date, modified?:Date, lastModifiedBy?:string, revision?:string}} input
 */
export function corePropsXml(input = {}) {
  const created = isoUtc(input.created || new Date());
  const modified = isoUtc(input.modified || input.created || new Date());
  const creator = cleanText(input.creator) || DEFAULT_BRAND.creator;
  return `${XML_DECL}<cp:coreProperties xmlns:cp="${NS.coreProperties}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}" xmlns:dcmitype="${NS.dcmitype}" xmlns:xsi="${NS.xsi}">
  <dc:title>${escapeXml(input.title || 'Documento')}</dc:title>
  <dc:subject>${escapeXml(input.subject || '')}</dc:subject>
  <dc:creator>${escapeXml(creator)}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(input.lastModifiedBy || creator)}</cp:lastModifiedBy>
  <cp:revision>${escapeXml(input.revision || '1')}</cp:revision>
  <dc:description>${escapeXml(input.description || '')}</dc:description>
  <cp:keywords>${escapeXml(input.keywords || 'Agenda Copilot P95')}</cp:keywords>
  <cp:category>${escapeXml(input.category || '')}</cp:category>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified>
</cp:coreProperties>`;
}

/**
 * Orden canónico de las propiedades extendidas (ECMA-376, Parte 1,
 * `shared-documentPropertiesExtended.xsd`). Word/Excel/PowerPoint son
 * tolerantes, pero respetar la secuencia evita avisos de reparación.
 */
const APP_PROPERTY_ORDER = Object.freeze([
  'Template', 'Manager', 'Company', 'Pages', 'Words', 'Characters', 'PresentationFormat',
  'Lines', 'Paragraphs', 'Slides', 'Notes', 'TotalTime', 'HiddenSlides', 'MMClips',
  'ScaleCrop', 'HeadingPairs', 'TitlesOfParts', 'LinksUpToDate', 'CharactersWithSpaces',
  'SharedDoc', 'HyperlinkBase', 'HLinks', 'HyperlinksChanged', 'DigSig', 'Application',
  'AppVersion', 'DocSecurity'
]);

/**
 * Construye `docProps/app.xml`.
 * @param {{application?:string, company?:string, properties?:Array<{name:string, type?:'lpwstr'|'i4'|'bool', value:string|number|boolean}>}} input
 */
export function appPropsXml(input = {}) {
  const values = new Map();
  for (const item of input.properties || []) {
    if (!item || !item.name || !APP_PROPERTY_ORDER.includes(item.name)) continue;
    values.set(item.name, { type: item.type || 'lpwstr', value: item.value });
  }
  const defaults = [
    ['Application', 'lpwstr', input.application || 'Agenda Copilot P95'],
    ['DocSecurity', 'i4', 0],
    ['ScaleCrop', 'bool', false],
    ['Company', 'lpwstr', input.company || 'Agenda Copilot P95'],
    ['LinksUpToDate', 'bool', false],
    ['SharedDoc', 'bool', false],
    ['HyperlinksChanged', 'bool', false],
    ['AppVersion', 'lpwstr', '1.1']
  ];
  for (const [name, type, value] of defaults) {
    if (!values.has(name)) values.set(name, { type, value });
  }
  const lines = [];
  for (const name of APP_PROPERTY_ORDER) {
    const item = values.get(name);
    if (!item) continue;
    if (item.type === 'bool') lines.push(`  <${name}>${item.value ? 'true' : 'false'}</${name}>`);
    else if (item.type === 'i4') lines.push(`  <${name}>${Number(item.value) || 0}</${name}>`);
    else lines.push(`  <${name}>${escapeXml(item.value)}</${name}>`);
  }
  return `${XML_DECL}<Properties xmlns="${NS.extendedProperties}" xmlns:vt="${NS.vt}">
${lines.join('\n')}
</Properties>`;
}

/* ------------------------------------------------------------------ */
/* Lectura de etiquetas y verificación del paquete                     */
/* ------------------------------------------------------------------ */

/**
 * Extrae los atributos de las etiquetas con un nombre local dado.
 * @param {string} xml
 * @param {string} localName
 * @returns {Array<Record<string,string>>}
 */
export function tagAttributes(xml, localName) {
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b([^>]*)>`, 'g');
  const results = [];
  let match = pattern.exec(String(xml));
  while (match) {
    const attrs = Object.create(null);
    const attrPattern = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr = attrPattern.exec(match[1]);
    while (attr) {
      attrs[attr[1]] = attr[3] !== undefined ? attr[3] : attr[4];
      attr = attrPattern.exec(match[1]);
    }
    results.push(attrs);
    match = pattern.exec(String(xml));
  }
  return results;
}

function dirnameOf(partPath) {
  const index = partPath.lastIndexOf('/');
  return index < 0 ? '' : partPath.slice(0, index);
}

function normalizePartPath(baseDir, target) {
  const raw = String(target || '').replace(/\\/g, '/');
  if (raw.startsWith('/')) {
    const pieces = raw.split('/').filter(Boolean);
    return pieces.join('/');
  }
  const pieces = `${baseDir ? `${baseDir}/` : ''}${raw}`.split('/').filter(Boolean);
  const stack = [];
  for (const piece of pieces) {
    if (piece === '.') continue;
    if (piece === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(piece);
  }
  return stack.join('/');
}

function relsPathFor(partPath) {
  const dir = dirnameOf(partPath);
  const name = partPath.slice(dir ? dir.length + 1 : 0);
  return `${dir ? `${dir}/` : ''}_rels/${name}.rels`;
}

/**
 * Verifica la estructura de un paquete OOXML ya descomprimido:
 *
 * 1. Todas las partes `.xml` / `.rels` son XML bien formado.
 * 2. `[Content_Types].xml` existe y declara cada parte con Override o Default.
 * 3. Todas las relaciones internas apuntan a partes existentes.
 * 4. Los `r:id` usados en las partes existen en su `.rels`.
 * 5. Las partes requeridas por el formato están presentes.
 *
 * @param {ReturnType<import('./zip.mjs').readZip>} archive
 * @param {{type?:'docx'|'xlsx'|'pptx', requiredParts?:string[]}} [options]
 * @returns {{ok:boolean, errors:string[], parts:number, xmlParts:number, relsParts:number}}
 */
export function validateOoxmlPackage(archive, options = {}) {
  const errors = [];
  const names = new Set(archive.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name));
  const xmlEntries = archive.entries.filter((entry) => !entry.isDirectory && (entry.name.endsWith('.xml') || entry.name.endsWith('.rels')));

  for (const entry of xmlEntries) {
    const result = checkXml(entry.data.toString('utf8'), { name: entry.name });
    if (!result.ok) {
      for (const issue of result.errors.slice(0, 3)) errors.push(`${entry.name}: ${issue.message}`);
    }
  }

  if (!names.has('[Content_Types].xml')) {
    errors.push('Falta [Content_Types].xml (parte obligatoria del paquete OPC).');
  } else {
    const xml = archive.map['[Content_Types].xml'].toString('utf8');
    const defaults = new Map(tagAttributes(xml, 'Default').map((item) => [String(item.Extension || '').toLowerCase(), item.ContentType]));
    const overrides = new Map(tagAttributes(xml, 'Override').map((item) => [String(item.PartName || '').replace(/^\//, ''), item.ContentType]));
    for (const [partName, contentType] of overrides) {
      if (!partName || !contentType) errors.push(`[Content_Types].xml: Override incompleto (${partName || 'sin PartName'}).`);
      else if (!names.has(partName)) errors.push(`[Content_Types].xml: Override apunta a una parte inexistente: /${partName}`);
    }
    for (const name of names) {
      if (name === '[Content_Types].xml') continue;
      if (overrides.has(name)) continue;
      const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!defaults.has(extension)) {
        errors.push(`[Content_Types].xml: la parte "${name}" no tiene tipo de contenido (Default .${extension} u Override).`);
      }
    }
    if (!names.has('_rels/.rels')) errors.push('Falta _rels/.rels (relaciones del paquete).');
  }

  // Relaciones: destino existente y sin escapar del paquete.
  let relsParts = 0;
  for (const entry of archive.entries) {
    if (entry.isDirectory || !entry.name.endsWith('.rels')) continue;
    relsParts += 1;
    const relsDir = dirnameOf(dirnameOf(entry.name)); // quita "_rels/<archivo>.rels"
    const sourcePart = entry.name.split('/').slice(-1)[0].replace(/\.rels$/, '');
    const baseDir = entry.name === '_rels/.rels' ? '' : (relsDir || '');
    const xml = entry.data.toString('utf8');
    const relationships = tagAttributes(xml, 'Relationship');
    if (!relationships.length) errors.push(`${entry.name}: no contiene relaciones.`);
    const ids = new Set();
    for (const relationship of relationships) {
      const id = relationship.Id;
      if (!id) errors.push(`${entry.name}: Relationship sin Id.`);
      else if (ids.has(id)) errors.push(`${entry.name}: Id de relación duplicado "${id}".`);
      ids.add(id);
      if (String(relationship.TargetMode || '') === 'External') continue;
      const target = relationship.Target;
      if (!target) {
        errors.push(`${entry.name}: Relationship ${id || '(sin id)'} sin Target.`);
        continue;
      }
      const resolved = normalizePartPath(baseDir, target);
      if (!resolved) {
        errors.push(`${entry.name}: el destino "${target}" escapa del paquete.`);
      } else if (!names.has(resolved)) {
        errors.push(`${entry.name}: el destino "${target}" no existe (${resolved}).`);
      }
    }
    if (entry.name !== '_rels/.rels') {
      // Comprueba los `r:id` usados por la parte propietaria de este .rels.
      const ownerDir = dirnameOf(dirnameOf(entry.name));
      const ownerName = sourcePart;
      const ownerPart = ownerDir ? `${ownerDir}/${ownerName}` : ownerName;
      const ownerBuffer = archive.map[ownerPart];
      if (!ownerBuffer) {
        errors.push(`${entry.name}: no existe la parte propietaria ${ownerPart}.`);
      } else {
        const refs = [...ownerBuffer.toString('utf8').matchAll(/\br:(?:id|embed|link|pict)="([^"]+)"/g)].map((match) => match[1]);
        for (const ref of new Set(refs)) {
          if (!ids.has(ref)) errors.push(`${ownerPart}: referencia r:…="${ref}" sin relación en ${entry.name}.`);
        }
      }
    }
  }

  // Referencias desde el documento principal y partes conocidas sin .rels propio.
  for (const entry of archive.entries) {
    if (entry.isDirectory || !entry.name.endsWith('.xml') || entry.name === '[Content_Types].xml') continue;
    const xml = entry.data.toString('utf8');
    const refs = [...xml.matchAll(/\br:(?:id|embed|link|pict)="([^"]+)"/g)].map((match) => match[1]);
    if (!refs.length) continue;
    const relsPath = relsPathFor(entry.name);
    if (!names.has(relsPath)) {
      errors.push(`${entry.name}: usa relaciones (${[...new Set(refs)].join(', ')}) pero falta ${relsPath}.`);
    }
  }

  for (const part of options.requiredParts || []) {
    if (!names.has(part)) errors.push(`Falta la parte obligatoria: ${part}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    parts: names.size,
    xmlParts: xmlEntries.length,
    relsParts
  };
}

export default {
  XML_DECL,
  DEFAULT_BRAND,
  normalizeBrand,
  escapeXml,
  escapeAttr,
  cleanText,
  hexColor,
  contrastText,
  lighten,
  darken,
  parseDateInput,
  dateKey,
  formatDateLongEs,
  formatDateTimeEs,
  excelSerial,
  isoUtc,
  slugify,
  buildFilename,
  contentDisposition,
  contentTypesXml,
  relsXml,
  corePropsXml,
  appPropsXml,
  tagAttributes,
  validateOoxmlPackage
};

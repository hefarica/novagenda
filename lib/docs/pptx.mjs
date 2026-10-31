/**
 * Generador de PPTX (PresentationML) sin dependencias.
 *
 * Modelo de entrada (`slides`):
 *   { layout: 'cover', title, subtitle, notes }
 *   { title, bullets: ['punto', { text: 'subpunto', level: 1 }], notes }
 *   { title, numbered: ['paso 1', 'paso 2'], notes }
 *   { title, table: { headers: ['A'], rows: [['1']], widths: [40, 60] }, notes }
 *   { layout: 'section', title, subtitle, notes }
 *
 * La primera diapositiva es siempre una portada (se antepone una si el payload
 * no la incluye). El formato es 16:9 (12192000 × 6858000 EMU), con un tema
 * corporativo sobrio, numeración de diapositivas y notas del orador.
 */
import crypto from 'node:crypto';
import { createZip } from './zip.mjs';
import {
  XML_DECL, NS, REL, CT, escapeXml, escapeAttr, cleanText, normalizeBrand,
  hexColor, lighten, contrastText, parseDateInput, formatDateLongEs,
  contentTypesXml, relsXml, corePropsXml, appPropsXml
} from './ooxml.mjs';
import { buildCoverArt, resolvePreset } from '../studio/visuals.mjs';
import { ValidationError } from '../http/errors.mjs';

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MARGIN_X = 838200;
const CONTENT_W = SLIDE_W - MARGIN_X * 2;
const MAX_SLIDES = 60;
const MAX_BULLETS = 12;
const MAX_TABLE_ROWS = 20;
const MAX_TABLE_COLS = 10;
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const PNG_CONTENT_TYPE = 'image/png';

const INLINE_RE = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*)/g;

const LAYOUT = Object.freeze({
  cover: { index: 1, type: 'title', name: 'Portada' },
  content: { index: 2, type: 'obj', name: 'Título y contenido' },
  table: { index: 3, type: 'titleOnly', name: 'Solo título' }
});

function inlineSegments(text, base = {}) {
  const segments = [];
  const source = String(text ?? '');
  let lastIndex = 0;
  let match = INLINE_RE.exec(source);
  while (match) {
    if (match.index > lastIndex) segments.push({ text: source.slice(lastIndex, match.index), bold: !!base.bold, italic: !!base.italic });
    const token = match[0];
    if (token.startsWith('***')) segments.push({ text: token.slice(3, -3), bold: true, italic: true });
    else if (token.startsWith('**')) segments.push({ text: token.slice(2, -2), bold: true, italic: !!base.italic });
    else segments.push({ text: token.slice(1, -1), bold: !!base.bold, italic: true });
    lastIndex = match.index + token.length;
    match = INLINE_RE.exec(source);
  }
  if (lastIndex < source.length) segments.push({ text: source.slice(lastIndex), bold: !!base.bold, italic: !!base.italic });
  return segments.filter((segment) => segment.text !== '');
}

function runProperties({ size = 2000, bold = false, italic = false, color = '262626', font = null, underline = false } = {}) {
  const parts = [`lang="es-ES"`, `sz="${Number(size)}"`];
  if (bold) parts.push('b="1"');
  if (italic) parts.push('i="1"');
  if (underline) parts.push('u="sng"');
  parts.push('dirty="0"');
  const children = [`<a:solidFill><a:srgbClr val="${escapeAttr(hexColor(color))}"/></a:solidFill>`];
  children.push(`<a:latin typeface="${font ? escapeAttr(font) : '+mn-lt'}"/>`);
  return `<a:rPr ${parts.join(' ')}>${children.join('')}</a:rPr>`;
}

function paragraphRuns(text, options = {}) {
  const segments = inlineSegments(text, options);
  if (!segments.length) return '';
  return segments.map((segment) => `<a:r>${runProperties({
    ...options,
    bold: options.bold || segment.bold,
    italic: options.italic || segment.italic
  })}<a:t>${escapeXml(segment.text)}</a:t></a:r>`).join('');
}

function paragraphXml(text, { level = 0, bullet = null, align = null, size = 2000, bold = false, color = '262626', spaceBefore = null, font = null } = {}) {
  const properties = [];
  if (align) properties.push(`algn="${align}"`);
  if (bullet) {
    properties.push(`marL="${342900 + level * 342900}"`, `indent="-342900"`, `lvl="${level}"`);
  }
  const children = [];
  if (spaceBefore) children.push(`<a:spcBef><a:spcPts val="${Number(spaceBefore)}"/></a:spcBef>`);
  if (bullet === 'number') children.push('<a:buFont typeface="+mn-lt"/><a:buAutoNum type="arabicPeriod"/>');
  else if (bullet === 'bullet') children.push('<a:buFont typeface="Arial"/><a:buChar char="•"/>');
  else if (bullet === 'none') children.push('<a:buNone/>');
  const pPr = (properties.length || children.length)
    ? `<a:pPr ${properties.join(' ')}>${children.join('')}</a:pPr>`
    : '';
  return `<a:p>${pPr}${paragraphRuns(text, { size, bold, color, font })}<a:endParaRPr lang="es-ES" sz="${Number(size)}"/></a:p>`;
}

function emptyParagraph() {
  return '<a:p><a:endParaRPr lang="es-ES" sz="1000"/></a:p>';
}

function textBody(paragraphs, { anchor = 't', autofit = false, insets = true } = {}) {
  const attributes = [`anchor="${anchor}"`];
  if (!insets) attributes.push('lIns="0"', 'tIns="0"', 'rIns="0"', 'bIns="0"');
  return `<p:txBody><a:bodyPr ${attributes.join(' ')}>${autofit ? '<a:normAutofit/>' : ''}</a:bodyPr><a:lstStyle/>${paragraphs || emptyParagraph()}</p:txBody>`;
}

function shapeXml({ id, name, x, y, cx, cy, paragraphs = '', type = null, idx = null, txBox = false, anchor = 't', autofit = false }) {
  const ph = type ? `<p:nvPr><p:ph type="${type}"${idx !== null ? ` idx="${idx}"` : ''}/></p:nvPr>` : '<p:nvPr/>';
  const cNvSpPr = txBox ? '<p:cNvSpPr txBox="1"/>' : '<p:cNvSpPr/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeAttr(name)}"/>${cNvSpPr}${ph}</p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>${textBody(paragraphs, { anchor, autofit })}</p:sp>`;
}

function rectangleXml({ id, name, x, y, cx, cy, color }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeAttr(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${escapeAttr(hexColor(color))}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}

function translucentRectangleXml({ id, name, x, y, cx, cy, color, alpha = 35000 }) {
  const value = Math.max(0, Math.min(100000, Math.round(Number(alpha) || 0)));
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeAttr(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${escapeAttr(hexColor(color))}"><a:alpha val="${value}"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}

function pictureXml({ id, name, relId, x = 0, y = 0, cx = SLIDE_W, cy = SLIDE_H }) {
  if (!relId) return '';
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeAttr(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${escapeAttr(relId)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

/**
 * La marca de la plantilla manda cuando el usuario la envía explícitamente; si
 * solo se elige un preset, el preset decide tipografía/paleta. El contenido
 * (logo, firma, pie) siempre se conserva de la marca base.
 */
function resolveVisualBrand(baseBrand, preset, explicit) {
  if (!preset) return baseBrand;
  const presetBrand = {
    font: preset.fonts.heading,
    color: preset.palette.primary,
    accent: preset.palette.accent
  };
  return explicit
    ? { ...presetBrand, ...baseBrand }
    : { ...baseBrand, ...presetBrand };
}

function romanNumeral(value) {
  const number = Math.max(1, Math.min(3999, Math.round(Number(value) || 1)));
  const table = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ];
  let rest = number;
  let text = '';
  for (const [unit, symbol] of table) {
    while (rest >= unit) {
      text += symbol;
      rest -= unit;
    }
  }
  return text;
}

function frameIds() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

function slideNumberParagraph(number, color) {
  const fieldId = `{${crypto.randomUUID().toUpperCase()}}`;
  return `<a:p><a:pPr algn="r"/><a:fld id="${fieldId}" type="slidenum"><a:rPr lang="es-ES" sz="1100" dirty="0"><a:solidFill><a:srgbClr val="${escapeAttr(color)}"/></a:solidFill><a:latin typeface="+mn-lt"/></a:rPr><a:t>${Number(number)}</a:t></a:fld><a:endParaRPr lang="es-ES" sz="1100"/></a:p>`;
}

function footerShapes(brand, dateText, slideNumber, nextId, visual = null) {
  const gray = visual?.palette?.muted || '7F7F7F';
  const accent = visual?.palette?.accent || brand.accent;
  let id = nextId;
  const shapes = [
    shapeXml({
      id: id++, name: 'Pie de página', x: MARGIN_X, y: 6320000, cx: 5600000, cy: 330000,
      paragraphs: paragraphXml(brand.logoText, { size: 1100, color: gray }),
      txBox: true
    }),
    shapeXml({
      id: id++, name: 'Fecha', x: 5000000, y: 6320000, cx: 3600000, cy: 330000,
      paragraphs: paragraphXml(dateText, { size: 1100, color: gray, align: 'r' }),
      txBox: true
    }),
    shapeXml({
      id: id++, name: 'Número de diapositiva', x: 8900000, y: 6320000, cx: 2469200, cy: 330000,
      paragraphs: slideNumberParagraph(slideNumber, accent),
      txBox: true
    })
  ];
  return { shapes: shapes.join(''), nextId: id };
}

function tableXml({ headers = [], rows = [], widths = null }, brand, nextId) {
  const columnCount = Math.max(headers.length, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)), 1);
  if (columnCount > MAX_TABLE_COLS) throw new ValidationError('slides.table', 'VALIDATION', `La tabla admite como máximo ${MAX_TABLE_COLS} columnas.`);
  if (rows.length > MAX_TABLE_ROWS) throw new ValidationError('slides.table', 'VALIDATION', `La tabla admite como máximo ${MAX_TABLE_ROWS} filas de datos.`);
  const allRows = headers.length ? [headers, ...rows] : rows;
  const availableHeight = 4400000;
  const rowHeight = Math.max(150000, Math.min(430000, Math.floor(availableHeight / Math.max(1, allRows.length))));
  let colWidths;
  if (Array.isArray(widths) && widths.length === columnCount) {
    const total = widths.reduce((sum, value) => sum + (Number(value) || 1), 0);
    colWidths = widths.map((value) => Math.max(600000, Math.round((Number(value) / total) * CONTENT_W)));
  } else {
    colWidths = Array.from({ length: columnCount }, () => Math.round(CONTENT_W / columnCount));
  }
  const tableHeight = rowHeight * Math.max(1, allRows.length);
  const y = contentTop();

  const cellXml = (value, { header = false, band = false, width = 0 } = {}) => {
    const fill = header ? brand.color : band ? lighten(brand.color, 0.93) : 'FFFFFF';
    const textColor = header ? contrastText(fill) : '262626';
    const size = allRows.length > 8 ? 1100 : 1300;
    const border = 'D9D9D9';
    const line = (tag) => `<a:${tag} w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="${border}"/></a:solidFill><a:prstDash val="solid"/></a:${tag}>`;
    const paragraphs = Array.isArray(value)
      ? value.map((item) => paragraphXml(typeof item === 'object' && item ? item.text ?? '' : item, { size, bold: header || (typeof item === 'object' && item?.bold === true), color: textColor })).join('')
      : paragraphXml(value ?? '', { size, bold: header, color: textColor });
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs || emptyParagraph()}</a:txBody><a:tcPr>${line('lnL')}${line('lnR')}${line('lnT')}${line('lnB')}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`;
  };

  const rowsXml = allRows.map((row, rowIndex) => {
    const values = Array.isArray(row) ? row : [row];
    const header = headers.length > 0 && rowIndex === 0;
    const cells = Array.from({ length: columnCount }, (_, columnPosition) => cellXml(values[columnPosition] ?? '', {
      header,
      band: !header && rowIndex % 2 === 0,
      width: colWidths[columnPosition]
    })).join('');
    return `<a:tr h="${rowHeight}">${cells}</a:tr>`;
  }).join('');

  return {
    xml: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nextId}" name="Tabla ${nextId}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${MARGIN_X}" y="${y}"/><a:ext cx="${CONTENT_W}" cy="${tableHeight}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${colWidths.map((width) => `<a:gridCol w="${width}"/>`).join('')}</a:tblGrid>${rowsXml}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    nextId: nextId + 1
  };
}

function contentTop(offset = 0) {
  return 1650000 + offset;
}

/* ------------------------------------------------------------------ */
/* Normalización de diapositivas                                       */
/* ------------------------------------------------------------------ */

function bulletList(items, ordered = false) {
  const values = Array.isArray(items) ? items.slice(0, MAX_BULLETS) : [];
  return values.map((item) => {
    if (typeof item === 'object' && item !== null) {
      return { text: cleanText(item.text ?? ''), level: Math.max(0, Math.min(2, Number(item.level) || 0)), ordered: item.ordered === true || ordered };
    }
    return { text: cleanText(item), level: 0, ordered };
  }).filter((item) => item.text !== '');
}

/**
 * Normaliza las diapositivas: garantiza portada, límites y layout coherente.
 */
export function normalizeSlides(spec = {}) {
  const brand = normalizeBrand(spec.brand || {});
  const date = parseDateInput(spec.date, new Date());
  const slides = Array.isArray(spec.slides) ? spec.slides.slice(0, MAX_SLIDES) : [];
  const normalized = [];
  const first = slides[0];
  const hasCover = first && (first.layout === 'cover' || first.cover === true);
  if (!hasCover) {
    normalized.push({
      layout: 'cover',
      title: cleanText(spec.title || 'Presentación'),
      subtitle: cleanText(spec.subtitle || `${brand.logoText} · ${formatDateLongEs(date)}`),
      notes: cleanText(spec.notes || '')
    });
  }
  for (const slide of slides) {
    if (!slide || typeof slide !== 'object') continue;
    const layout = slide.layout === 'cover' || slide.cover === true
      ? 'cover'
      : slide.layout === 'section'
        ? 'section'
        : slide.table
          ? 'table'
          : 'content';
    const bulletItems = bulletList(slide.bullets, false).concat(bulletList(slide.numbered, true));
    const notes = cleanText(slide.notes || '');
    if (layout === 'cover' || layout === 'section') {
      normalized.push({
        layout,
        title: cleanText(slide.title || spec.title || 'Presentación'),
        subtitle: cleanText(slide.subtitle || ''),
        notes
      });
      continue;
    }
    if (layout === 'table') {
      const table = slide.table || {};
      const headers = Array.isArray(table.headers) ? table.headers.map((value) => cleanText(value)) : [];
      const rows = Array.isArray(table.rows) ? table.rows.map((row) => (Array.isArray(row) ? row.map((value) => cleanText(value)) : [cleanText(row)])) : [];
      if (!headers.length && !rows.length) throw new ValidationError('slides.table', 'VALIDATION', 'La tabla de una diapositiva necesita headers o rows.');
      if (bulletItems.length) throw new ValidationError('slides', 'VALIDATION', 'Una diapositiva no puede combinar viñetas y tabla; usa dos diapositivas.');
      normalized.push({ layout: 'table', title: cleanText(slide.title || 'Tabla'), table: { headers, rows, widths: table.widths }, notes });
      continue;
    }
    if (!bulletItems.length) throw new ValidationError('slides', 'VALIDATION', `La diapositiva "${cleanText(slide.title || '(sin título)')}" necesita viñetas o una tabla.`);
    normalized.push({ layout: 'content', title: cleanText(slide.title || 'Contenido'), bullets: bulletItems, notes });
  }
  if (!normalized.length) throw new ValidationError('slides', 'VALIDATION', 'La presentación necesita al menos una diapositiva.');
  if (normalized.length > MAX_SLIDES) normalized.length = MAX_SLIDES;
  return normalized;
}

/* ------------------------------------------------------------------ */
/* Partes XML                                                          */
/* ------------------------------------------------------------------ */

function themeXml(brand, visual = null) {
  const dark = visual?.palette?.deep || '1F3864';
  const light2 = visual?.palette?.surface || 'E7EEF7';
  const accent1 = visual?.palette?.primary || brand.color;
  const accent2 = visual?.palette?.accent || brand.accent;
  const accent3 = visual?.art?.colors?.[0] || visual?.palette?.secondary || '6FA8DC';
  const accent4 = visual?.art?.colors?.[1] || visual?.palette?.secondary || '8EA9DB';
  const accent5 = visual?.art?.colors?.[2] || visual?.palette?.accent || 'C55A11';
  const accent6 = visual?.palette?.secondary || '70AD47';
  const headingFont = visual?.fonts?.heading || brand.font;
  const bodyFont = visual?.fonts?.body || brand.font;
  const themeName = visual ? `Agenda · ${visual.label}` : 'Agenda Copilot P95';
  const fills = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="50000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="100000"/><a:shade val="100000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="50000"/><a:shade val="100000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill>`;
  const lines = `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const effects = `<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>
<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>`;
  const background = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="93000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill>`;
  return `${XML_DECL}<a:theme xmlns:a="${NS.drawing}" name="${escapeAttr(themeName)}">
<a:themeElements>
<a:clrScheme name="Agenda corporativo">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="${dark}"/></a:dk2>
<a:lt2><a:srgbClr val="${light2}"/></a:lt2>
<a:accent1><a:srgbClr val="${accent1}"/></a:accent1>
<a:accent2><a:srgbClr val="${accent2}"/></a:accent2>
<a:accent3><a:srgbClr val="${accent3}"/></a:accent3>
<a:accent4><a:srgbClr val="${accent4}"/></a:accent4>
<a:accent5><a:srgbClr val="${accent5}"/></a:accent5>
<a:accent6><a:srgbClr val="${accent6}"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Agenda corporativo">
<a:majorFont><a:latin typeface="${escapeAttr(headingFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="${escapeAttr(bodyFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Agenda corporativo">
<a:fillStyleLst>${fills}</a:fillStyleLst>
<a:lnStyleLst>${lines}</a:lnStyleLst>
<a:effectStyleLst>${effects}</a:effectStyleLst>
<a:bgFillStyleLst>${background}</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
<a:objectDefaults/>
<a:extraClrSchemeLst/>
</a:theme>`;
}

function slideMasterXml(brand) {
  const layoutIds = Object.values(LAYOUT).map((layout, index) => `<p:sldLayoutId id="${2147483649 + index}" r:id="rId${index + 2}"/>`).join('');
  return `${XML_DECL}<p:sldMaster xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}">
<p:cSld>
<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>${frameIds()}</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst>${layoutIds}</p:sldLayoutIdLst>
<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="3200" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPts val="500"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2000" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:buFont typeface="Arial"/><a:buChar char="–"/><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl2pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>
</p:txStyles>
</p:sldMaster>`;
}

function slideLayoutXml(kind, brand, index, visual = null) {
  const layout = LAYOUT[kind];
  const titleColor = visual?.palette?.primary || brand.color;
  const titleFont = visual?.fonts?.heading || null;
  if (kind === 'cover') {
    const title = shapeXml({
      id: 2, name: 'Título 1', x: MARGIN_X, y: 2380000, cx: CONTENT_W, cy: 1350000,
      paragraphs: paragraphXml('Título de la presentación', { size: 4400, bold: true, color: titleColor, font: titleFont }),
      type: 'title', anchor: 'b'
    });
    const subtitle = shapeXml({
      id: 3, name: 'Subtítulo 2', x: MARGIN_X, y: 3830000, cx: CONTENT_W, cy: 1000000,
      paragraphs: paragraphXml('Subtítulo', { size: 2000, color: visual?.palette?.muted || '595959', bullet: 'none', font: visual?.fonts?.body || null }),
      type: 'subTitle', idx: 1
    });
    return `${XML_DECL}<p:sldLayout xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}" type="title" preserve="1"><p:cSld name="Portada"><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${frameIds()}${title}${subtitle}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  }
  const title = shapeXml({
    id: 2, name: 'Título 1', x: MARGIN_X, y: 520000, cx: CONTENT_W, cy: 850000,
    paragraphs: paragraphXml('Título', { size: 3000, bold: true, color: titleColor, font: titleFont }),
    type: 'title', anchor: 'b'
  });
  const body = kind === 'content'
    ? shapeXml({
      id: 3, name: 'Contenido 2', x: MARGIN_X, y: contentTop(), cx: CONTENT_W, cy: 4450000,
      paragraphs: paragraphXml('Contenido', { size: 2000, bullet: 'bullet', font: visual?.fonts?.body || null }),
      type: 'body', idx: 1, autofit: true
    })
    : '';
  return `${XML_DECL}<p:sldLayout xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}" type="${kind === 'content' ? 'obj' : 'titleOnly'}" preserve="1"><p:cSld name="${escapeAttr(layout.name)}"><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${frameIds()}${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function notesPlaceholderXml({ id, name, type, size = 'quarter', idx = null, x, y, cx, cy, anchor = 't', paragraphs = emptyParagraph(), border = false }) {
  const attributes = [`type="${type}"`];
  if (size) attributes.push(`sz="${size}"`);
  if (idx !== null) attributes.push(`idx="${idx}"`);
  const borderXml = border
    ? '<a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln>'
    : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeAttr(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${attributes.join(' ')}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>${borderXml}</p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function notesMasterXml(brand) {
  // Mismo conjunto de marcadores que usa PowerPoint en el patrón de notas
  // (encabezado, fecha, imagen, cuerpo, pie y número) para que el paquete sea
  // intercambiable sin reparaciones.
  const header = notesPlaceholderXml({ id: 2, name: 'Marcador de encabezado 1', type: 'hdr', idx: null, x: 0, y: 0, cx: 2971800, cy: 458788 });
  const date = notesPlaceholderXml({ id: 3, name: 'Marcador de fecha 2', type: 'dt', size: null, idx: 1, x: 3884613, y: 0, cx: 2971800, cy: 458788 });
  const image = notesPlaceholderXml({ id: 4, name: 'Marcador de imagen de diapositiva 3', type: 'sldImg', size: null, idx: 2, x: 685800, y: 1143000, cx: 5486400, cy: 3086100, anchor: 'ctr', border: true });
  const body = notesPlaceholderXml({ id: 5, name: 'Marcador de notas 4', type: 'body', idx: 3, x: 685800, y: 4400550, cx: 5486400, cy: 3600450 });
  const footer = notesPlaceholderXml({ id: 6, name: 'Marcador de pie de página 5', type: 'ftr', idx: 4, x: 0, y: 8685213, cx: 2971800, cy: 458787, anchor: 'b' });
  const numberField = `<a:p><a:fld id="{${crypto.randomUUID().toUpperCase()}}" type="slidenum"><a:rPr lang="es-ES"/><a:t>‹Nº›</a:t></a:fld><a:endParaRPr lang="es-ES"/></a:p>`;
  const number = notesPlaceholderXml({ id: 7, name: 'Marcador de número de diapositiva 6', type: 'sldNum', idx: 5, x: 3884613, y: 8685213, cx: 2971800, cy: 458787, anchor: 'b', paragraphs: numberField });
  const levelMargins = [0, 457200, 914400, 1371600, 1828800, 2286000, 2743200, 3200400, 3657600];
  const notesStyle = levelMargins.map((margin, index) => `<a:lvl${index + 1}pPr marL="${margin}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${index + 1}pPr>`).join('');
  return `${XML_DECL}<p:notesMaster xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${frameIds()}${header}${date}${image}${body}${footer}${number}</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:notesStyle>${notesStyle}</p:notesStyle>
</p:notesMaster>`;
}

function presetCoverShapes(slide, number, brand, dateText, visual, imageRelId) {
  const palette = visual.palette;
  const cover = visual.cover;
  const centered = cover.align === 'center';
  const align = centered ? 'ctr' : 'l';
  const width = centered ? CONTENT_W : Math.min(CONTENT_W, cover.titleWidth || CONTENT_W);
  let id = 2;
  const parts = [];

  if (imageRelId) {
    parts.push(pictureXml({ id: id++, name: 'Portada abstracta', relId: imageRelId }));
  }

  if (cover.variant === 'executive') {
    parts.push(rectangleXml({ id: id++, name: 'Barra de marca', x: 0, y: 0, cx: 210000, cy: SLIDE_H, color: palette.primary }));
    parts.push(rectangleXml({ id: id++, name: 'Acento', x: 210000, y: 0, cx: 42000, cy: SLIDE_H, color: palette.accent }));
    parts.push(rectangleXml({ id: id++, name: 'Regla de sección', x: MARGIN_X, y: 1760000, cx: 1700000, cy: 22000, color: palette.accent }));
  } else if (cover.variant === 'creative') {
    parts.push(rectangleXml({ id: id++, name: 'Barra creativa', x: 0, y: 0, cx: 150000, cy: SLIDE_H, color: palette.accent }));
    parts.push(translucentRectangleXml({ id: id++, name: 'Panel de antetítulo', x: MARGIN_X - 100000, y: 1130000, cx: 3100000, cy: 430000, color: palette.surface, alpha: 82000 }));
    parts.push(rectangleXml({ id: id++, name: 'Píldora de acento', x: MARGIN_X - 100000, y: 1130000, cx: 90000, cy: 430000, color: palette.accent }));
  } else if (cover.variant === 'data') {
    parts.push(rectangleXml({ id: id++, name: 'Línea superior', x: 0, y: 0, cx: SLIDE_W, cy: 26000, color: palette.accent }));
    parts.push(translucentRectangleXml({ id: id++, name: 'Panel inferior', x: 0, y: 5000000, cx: SLIDE_W, cy: 1858000, color: palette.deep, alpha: 42000 }));
  } else if (cover.variant === 'academic') {
    parts.push(rectangleXml({ id: id++, name: 'Regla académica 1', x: 3600000, y: 1280000, cx: 5000000, cy: 12000, color: palette.accent }));
    parts.push(rectangleXml({ id: id++, name: 'Regla académica 2', x: 3600000, y: 1320000, cx: 5000000, cy: 12000, color: palette.accent }));
    parts.push(rectangleXml({ id: id++, name: 'Ornamento', x: 6020000, y: 1180000, cx: 160000, cy: 160000, color: palette.primary }));
  }

  parts.push(shapeXml({
    id: id++, name: 'Logotipo', x: MARGIN_X, y: 520000, cx: 6500000, cy: 360000,
    paragraphs: paragraphXml(brand.logoText, { size: 1200, bold: true, color: palette.accent, font: visual.fonts.body, align }),
    txBox: true
  }));
  parts.push(shapeXml({
    id: id++, name: 'Antetítulo', x: centered ? 1800000 : MARGIN_X, y: cover.variant === 'academic' ? 1450000 : 1270000,
    cx: centered ? SLIDE_W - 3600000 : 5200000, cy: 320000,
    paragraphs: paragraphXml(cover.eyebrow, { size: 1100, bold: true, color: palette.accent, font: visual.fonts.body, align }),
    txBox: true
  }));
  parts.push(shapeXml({
    id: id++, name: 'Título 1', x: centered ? MARGIN_X : MARGIN_X, y: cover.titleY, cx: width, cy: 1370000,
    paragraphs: paragraphXml(slide.title, {
      size: cover.titleSize || 4200,
      bold: true,
      color: palette.coverInk,
      font: visual.fonts.heading,
      align
    }),
    type: 'title', anchor: centered ? 't' : 'b', autofit: true
  }));
  if (slide.subtitle) {
    parts.push(shapeXml({
      id: id++, name: 'Subtítulo 2', x: MARGIN_X, y: cover.subtitleY, cx: centered ? CONTENT_W : Math.min(CONTENT_W, 9_300_000), cy: 900000,
      paragraphs: paragraphXml(slide.subtitle, { size: 1900, color: palette.coverMuted, font: visual.fonts.body, align, bullet: 'none' }),
      type: 'subTitle', idx: 1
    }));
  }

  if (cover.variant === 'data') {
    const chips = ['EVIDENCIA', 'DECISIÓN', 'IMPACTO'];
    chips.forEach((label, index) => {
      const chipX = MARGIN_X + index * 2350000;
      parts.push(translucentRectangleXml({
        id: id++, name: `Indicador ${label}`, x: chipX, y: 5160000, cx: 2050000, cy: 430000,
        color: palette.accent, alpha: 26000
      }));
      parts.push(shapeXml({
        id: id++, name: `Etiqueta ${label}`, x: chipX + 90000, y: 5210000, cx: 1870000, cy: 300000,
        paragraphs: paragraphXml(label, { size: 1000, bold: true, color: palette.accent, font: visual.fonts.body }),
        txBox: true
      }));
    });
  }

  parts.push(shapeXml({
    id: id++, name: 'Fecha de portada', x: MARGIN_X, y: 6120000, cx: 6300000, cy: 330000,
    paragraphs: paragraphXml(`${brand.footerText} · ${dateText}`, { size: 1000, color: cover.footerInk || palette.coverMuted, font: visual.fonts.body }),
    txBox: true
  }));
  parts.push(shapeXml({
    id: id++, name: 'Número de diapositiva', x: 8900000, y: 6320000, cx: 2469200, cy: 330000,
    paragraphs: slideNumberParagraph(number, palette.accent),
    txBox: true
  }));
  return { shapes: parts.join(''), nextId: id };
}

function presetSectionShapes(slide, number, brand, visual) {
  const palette = visual.palette;
  const section = visual.section;
  const centered = section.align === 'center';
  const align = centered ? 'ctr' : 'l';
  const numeral = section.variant === 'academic' ? romanNumeral(number) : String(number).padStart(2, '0');
  let id = 2;
  const parts = [];

  if (section.variant === 'executive') {
    parts.push(rectangleXml({ id: id++, name: 'Barra de marca', x: 0, y: 0, cx: 210000, cy: SLIDE_H, color: palette.primary }));
    parts.push(rectangleXml({ id: id++, name: 'Acento', x: 210000, y: 0, cx: 42000, cy: SLIDE_H, color: palette.accent }));
    parts.push(rectangleXml({ id: id++, name: 'Regla de sección', x: MARGIN_X, y: 2780000, cx: 2100000, cy: 24000, color: palette.accent }));
  } else if (section.variant === 'creative') {
    parts.push(rectangleXml({ id: id++, name: 'Bloque creativo', x: 8700000, y: 0, cx: SLIDE_W - 8700000, cy: SLIDE_H, color: palette.primary }));
    parts.push(rectangleXml({ id: id++, name: 'Barra de acento', x: 0, y: 0, cx: 150000, cy: SLIDE_H, color: palette.accent }));
    parts.push(shapeXml({
      id: id++, name: 'Número de sección', x: 8_900_000, y: 2050000, cx: 3_000_000, cy: 2_000_000,
      paragraphs: paragraphXml(numeral, { size: 7200, bold: true, color: palette.surface, font: visual.fonts.heading, align: 'ctr' }),
      txBox: true
    }));
  } else if (section.variant === 'data') {
    parts.push(rectangleXml({ id: id++, name: 'Línea superior', x: 0, y: 0, cx: SLIDE_W, cy: 26000, color: palette.accent }));
    parts.push(translucentRectangleXml({ id: id++, name: 'Rejilla 1', x: MARGIN_X, y: 2780000, cx: CONTENT_W, cy: 12000, color: palette.accent, alpha: 30000 }));
    parts.push(translucentRectangleXml({ id: id++, name: 'Rejilla 2', x: MARGIN_X, y: 4550000, cx: CONTENT_W, cy: 12000, color: palette.accent, alpha: 18000 }));
    parts.push(shapeXml({
      id: id++, name: 'Número de sección', x: 8_900_000, y: 1550000, cx: 2_800_000, cy: 1_900_000,
      paragraphs: paragraphXml(numeral, { size: 6600, bold: true, color: palette.accent, font: visual.fonts.heading, align: 'r' }),
      txBox: true
    }));
  } else if (section.variant === 'academic') {
    parts.push(rectangleXml({ id: id++, name: 'Regla académica 1', x: 3600000, y: 2130000, cx: 5000000, cy: 12000, color: palette.accent }));
    parts.push(rectangleXml({ id: id++, name: 'Regla académica 2', x: 3600000, y: 2170000, cx: 5000000, cy: 12000, color: palette.accent }));
    parts.push(shapeXml({
      id: id++, name: 'Número de capítulo', x: MARGIN_X, y: 980000, cx: CONTENT_W, cy: 500000,
      paragraphs: paragraphXml(numeral, { size: 2400, bold: true, color: palette.accent, font: visual.fonts.heading, align: 'ctr' }),
      txBox: true
    }));
  }

  parts.push(shapeXml({
    id: id++, name: 'Antetítulo', x: centered ? 1800000 : MARGIN_X, y: section.variant === 'academic' ? 2280000 : 1420000,
    cx: centered ? SLIDE_W - 3600000 : 6500000, cy: 320000,
    paragraphs: paragraphXml(`${section.eyebrow} ${numeral}`.trim(), { size: 1100, bold: true, color: palette.accent, font: visual.fonts.body, align }),
    txBox: true
  }));
  parts.push(shapeXml({
    id: id++, name: 'Título 1', x: centered ? MARGIN_X : MARGIN_X,
    y: section.variant === 'academic' ? 2700000 : 1850000,
    cx: centered ? CONTENT_W : Math.min(CONTENT_W, 8_800_000), cy: 1600000,
    paragraphs: paragraphXml(slide.title, { size: 4000, bold: true, color: palette.primary, font: visual.fonts.heading, align }),
    type: 'title', anchor: 't', autofit: true
  }));
  if (slide.subtitle) {
    parts.push(shapeXml({
      id: id++, name: 'Subtítulo 2', x: centered ? 1800000 : MARGIN_X,
      y: section.variant === 'academic' ? 4300000 : 3600000,
      cx: centered ? SLIDE_W - 3600000 : Math.min(CONTENT_W, 8_800_000), cy: 900000,
      paragraphs: paragraphXml(slide.subtitle, { size: 1800, color: palette.muted, font: visual.fonts.body, align, bullet: 'none' }),
      type: 'subTitle', idx: 1
    }));
  }
  parts.push(shapeXml({
    id: id++, name: 'Pie de sección', x: MARGIN_X, y: 6320000, cx: 5000000, cy: 300000,
    paragraphs: paragraphXml(brand.logoText, { size: 1000, color: palette.muted, font: visual.fonts.body }),
    txBox: true
  }));
  parts.push(shapeXml({
    id: id++, name: 'Número de diapositiva', x: 8900000, y: 6320000, cx: 2469200, cy: 330000,
    paragraphs: slideNumberParagraph(number, section.variant === 'creative' ? palette.surface : palette.accent),
    txBox: true
  }));
  return { shapes: parts.join(''), nextId: id };
}


function slideXml(slide, number, brand, dateText, watermark = '', options = {}) {
  const cover = slide.layout === 'cover' || slide.layout === 'section';
  const visual = options.visual || null;
  const coverImageRelId = options.coverImageRelId || null;
  let id = 2;
  const parts = [];
  if (cover) {
    if (visual) {
      const block = slide.layout === 'section'
        ? presetSectionShapes(slide, number, brand, visual)
        : presetCoverShapes(slide, number, brand, dateText, visual, coverImageRelId);
      parts.push(block.shapes);
      id = block.nextId;
    } else {
      parts.push(rectangleXml({ id: id++, name: 'Barra de marca', x: 0, y: 0, cx: 210000, cy: SLIDE_H, color: brand.color }));
      parts.push(rectangleXml({ id: id++, name: 'Acento', x: 210000, y: 0, cx: 42000, cy: SLIDE_H, color: brand.accent }));
      parts.push(shapeXml({
        id: id++, name: 'Logotipo', x: MARGIN_X, y: 640000, cx: 6200000, cy: 380000,
        paragraphs: paragraphXml(brand.logoText, { size: 1400, bold: true, color: brand.accent }),
        txBox: true
      }));
      parts.push(shapeXml({
        id: id++, name: 'Título 1', x: MARGIN_X, y: 2380000, cx: CONTENT_W, cy: 1350000,
        paragraphs: paragraphXml(slide.title, { size: 4200, bold: true, color: brand.color }),
        type: 'title', anchor: 'b'
      }));
      if (slide.subtitle) {
        parts.push(shapeXml({
          id: id++, name: 'Subtítulo 2', x: MARGIN_X, y: 3830000, cx: CONTENT_W, cy: 1000000,
          paragraphs: paragraphXml(slide.subtitle, { size: 1900, color: '595959', bullet: 'none' }),
          type: 'subTitle', idx: 1
        }));
      }
      parts.push(shapeXml({
        id: id++, name: 'Fecha de portada', x: MARGIN_X, y: 5900000, cx: 6200000, cy: 350000,
        paragraphs: paragraphXml(`${brand.footerText} · ${dateText}`, { size: 1100, color: '7F7F7F' }),
        txBox: true
      }));
      parts.push(shapeXml({
        id: id++, name: 'Número de diapositiva', x: 8900000, y: 6320000, cx: 2469200, cy: 330000,
        paragraphs: slideNumberParagraph(number, brand.accent),
        txBox: true
      }));
    }
  } else {
    const titleColor = visual?.palette?.primary || brand.color;
    const accentColor = visual?.palette?.accent || brand.accent;
    const bodyFont = visual?.fonts?.body || null;
    parts.push(shapeXml({
      id: id++, name: 'Título 1', x: MARGIN_X, y: 520000, cx: CONTENT_W, cy: 850000,
      paragraphs: paragraphXml(slide.title, { size: visual ? 3000 : 2800, bold: true, color: titleColor, font: visual?.fonts?.heading || null }),
      type: 'title', anchor: 'b'
    }));
    parts.push(rectangleXml({ id: id++, name: 'Regla', x: MARGIN_X, y: 1410000, cx: CONTENT_W, cy: 22000, color: accentColor }));
    if (slide.layout === 'table') {
      const table = tableXml(slide.table, brand, id, contentTop());
      parts.push(table.xml);
      id = table.nextId;
    } else {
      const paragraphs = slide.bullets.map((item) => paragraphXml(item.text, {
        size: item.level === 0 ? 2000 : item.level === 1 ? 1700 : 1500,
        bullet: item.ordered ? 'number' : 'bullet',
        level: item.level,
        color: item.level === 0 ? (visual?.palette?.ink || '262626') : (visual?.palette?.muted || '595959'),
        font: bodyFont
      })).join('');
      parts.push(shapeXml({
        id: id++, name: 'Contenido 2', x: MARGIN_X, y: contentTop(), cx: CONTENT_W, cy: 4400000,
        paragraphs, type: 'body', idx: 1, autofit: true, anchor: 't'
      }));
    }
    const footer = footerShapes(brand, dateText, number, id, visual);
    parts.push(footer.shapes);
    id = footer.nextId;
  }

  if (watermark) {
    parts.push(shapeXml({
      id: id++, name: 'Marca de agua', x: 700000, y: 5820000, cx: 10800000, cy: 300000,
      txBox: true,
      paragraphs: `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="es-ES" sz="1200" b="1"><a:solidFill><a:srgbClr val="C9C9C9"><a:alpha val="55000"/></a:srgbClr></a:solidFill></a:rPr><a:t>${escapeXml(String(watermark).slice(0, 40))}</a:t></a:r><a:endParaRPr lang="es-ES" sz="1200"/></a:p>`
    }));
  }

  return `${XML_DECL}<p:sld xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${frameIds()}${parts.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesSlideXml(notes, number) {
  const lines = String(notes || '').split('\n');
  const hasText = lines.some((line) => line.trim() !== '');
  const paragraphs = hasText
    ? lines.map((line) => `<a:p><a:r><a:rPr lang="es-ES" sz="1200" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="es-ES"/></a:p>`).join('')
    : '<a:p><a:endParaRPr lang="es-ES"/></a:p>';
  const fieldId = `{${crypto.randomUUID().toUpperCase()}}`;
  const image = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Marcador de imagen de diapositiva 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>';
  const body = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Marcador de notas 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  const slideNumber = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Marcador de número de diapositiva 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="${fieldId}" type="slidenum"><a:rPr lang="es-ES"/><a:t>${Number(number)}</a:t></a:fld><a:endParaRPr lang="es-ES"/></a:p></p:txBody></p:sp>`;
  return `${XML_DECL}<p:notes xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}"><p:cSld><p:spTree>${frameIds()}${image}${body}${slideNumber}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Construye todas las partes del PPTX.
 * @param {any} spec
 * @param {{now?:Date}} [options]
 * @returns {Record<string,string>}
 */
export function pptxParts(spec = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const preset = resolvePreset(spec.preset);
  const baseBrand = normalizeBrand(spec.brand || {});
  const explicitBrand = spec.brandExplicit === true || (spec.brandExplicit === undefined && spec.brand !== undefined);
  const brand = resolveVisualBrand(baseBrand, preset, explicitBrand);
  // Si el usuario envía marca explícita, la tipografía/paleta de la marca manda
  // sobre el preset; la composición y el arte siguen siendo los del preset.
  const visual = preset && explicitBrand
    ? {
      ...preset,
      fonts: { heading: brand.font, body: brand.font },
      palette: { ...preset.palette, primary: brand.color, accent: brand.accent }
    }
    : preset;
  const date = parseDateInput(spec.date, now);
  const dateText = formatDateLongEs(date);
  const slides = normalizeSlides({ ...spec, brand, date });
  const title = cleanText(spec.title || slides[0]?.title || 'Presentación') || 'Presentación';
  const coverArt = preset ? buildCoverArt(preset.id, { width: 1280, height: 720 }) : null;
  const coverMediaName = coverArt ? coverArt.filename : null;
  const coverMediaPath = coverMediaName ? `ppt/media/${coverMediaName}` : null;

  const slideParts = [];
  const notesParts = [];
  slides.forEach((slide, index) => {
    const coverImageRelId = index === 0 && slide.layout === 'cover' && coverArt ? 'rId3' : null;
    slideParts.push(slideXml(slide, index + 1, brand, dateText, spec.watermark || '', {
      visual,
      coverImageRelId
    }));
    notesParts.push(notesSlideXml(slide.notes || spec.notes || '', index + 1));
  });

  const presentationRels = [
    { id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: REL.notesMaster, target: 'notesMasters/notesMaster1.xml' },
    { id: 'rId3', type: REL.theme, target: 'theme/theme1.xml' },
    { id: 'rId4', type: REL.presProps, target: 'presProps.xml' },
    { id: 'rId5', type: REL.viewProps, target: 'viewProps.xml' },
    { id: 'rId6', type: REL.tableStyles, target: 'tableStyles.xml' },
    ...slides.map((_, index) => ({ id: `rId${index + 7}`, type: REL.slide, target: `slides/slide${index + 1}.xml` }))
  ];

  const presentationXml = `${XML_DECL}<p:presentation xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}" saveSubsetFonts="1" autoCompressPictures="0">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>
<p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 7}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen16x9"/>
<p:notesSz cx="6858000" cy="9144000"/>
<p:defaultTextStyle><a:defPPr><a:defRPr lang="es-ES"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>
</p:presentation>`;

  const overrides = [
    { partName: '/ppt/presentation.xml', contentType: CT.pptxPresentation },
    { partName: '/ppt/slideMasters/slideMaster1.xml', contentType: CT.pptxSlideMaster },
    ...[1, 2, 3].map((layoutIndex) => ({ partName: `/ppt/slideLayouts/slideLayout${layoutIndex}.xml`, contentType: CT.pptxSlideLayout })),
    { partName: '/ppt/theme/theme1.xml', contentType: CT.theme },
    { partName: '/ppt/theme/theme2.xml', contentType: CT.theme },
    { partName: '/ppt/presProps.xml', contentType: CT.pptxPresProps },
    { partName: '/ppt/viewProps.xml', contentType: CT.pptxViewProps },
    { partName: '/ppt/tableStyles.xml', contentType: CT.pptxTableStyles },
    { partName: '/ppt/notesMasters/notesMaster1.xml', contentType: CT.pptxNotesMaster },
    ...slides.map((_, index) => ({ partName: `/ppt/slides/slide${index + 1}.xml`, contentType: CT.pptxSlide })),
    ...slides.map((_, index) => ({ partName: `/ppt/notesSlides/notesSlide${index + 1}.xml`, contentType: CT.pptxNotesSlide })),
    { partName: '/docProps/core.xml', contentType: CT.coreProperties },
    { partName: '/docProps/app.xml', contentType: CT.extendedProperties }
  ];

  const parts = {
    '[Content_Types].xml': contentTypesXml({
      defaults: [
        { extension: 'rels', contentType: CT.rels },
        { extension: 'xml', contentType: CT.xml },
        ...(coverArt ? [{ extension: 'png', contentType: PNG_CONTENT_TYPE }] : [])
      ],
      overrides
    }),
    '_rels/.rels': relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: REL.coreProperties, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extendedProperties, target: 'docProps/app.xml' }
    ]),
    'ppt/presentation.xml': presentationXml,
    'ppt/_rels/presentation.xml.rels': relsXml(presentationRels),
    'ppt/presProps.xml': `${XML_DECL}<p:presentationPr xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}"><p:extLst/></p:presentationPr>`,
    'ppt/viewProps.xml': `${XML_DECL}<p:viewPr xmlns:a="${NS.drawing}" xmlns:r="${NS.wordRels}" xmlns:p="${NS.presentation}" lastView="sldView"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    'ppt/tableStyles.xml': `${XML_DECL}<a:tblStyleLst xmlns:a="${NS.drawing}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/theme/theme1.xml': themeXml(brand, visual),
    'ppt/theme/theme2.xml': themeXml(brand, visual),
    'ppt/slideMasters/slideMaster1.xml': slideMasterXml(brand),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relsXml([
      { id: 'rId1', type: REL.theme, target: '../theme/theme1.xml' },
      ...Object.values(LAYOUT).map((layout, index) => ({ id: `rId${index + 2}`, type: REL.slideLayout, target: `../slideLayouts/slideLayout${layout.index}.xml` }))
    ]),
    'ppt/notesMasters/notesMaster1.xml': notesMasterXml(brand),
    'ppt/notesMasters/_rels/notesMaster1.xml.rels': relsXml([
      { id: 'rId1', type: REL.theme, target: '../theme/theme2.xml' }
    ]),
    'docProps/core.xml': corePropsXml({
      title,
      subject: cleanText(spec.subject || 'Presentación'),
      creator: cleanText(spec.author || brand.creator),
      created: now,
      modified: now
    }),
    'docProps/app.xml': appPropsXml({
      application: 'Agenda Copilot P95 (PowerPoint)',
      properties: [
        { name: 'PresentationFormat', value: 'Widescreen' },
        { name: 'Slides', type: 'i4', value: slides.length },
        { name: 'Notes', type: 'i4', value: slides.filter((slide) => slide.notes).length },
        { name: 'HiddenSlides', type: 'i4', value: 0 },
        { name: 'MMClips', type: 'i4', value: 0 }
      ]
    })
  };

  ['cover', 'content', 'table'].forEach((kind) => {
    const layout = LAYOUT[kind];
    parts[`ppt/slideLayouts/slideLayout${layout.index}.xml`] = slideLayoutXml(kind, brand, layout.index, visual);
    parts[`ppt/slideLayouts/_rels/slideLayout${layout.index}.xml.rels`] = relsXml([
      { id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }
    ]);
  });

  if (coverMediaPath) parts[coverMediaPath] = coverArt.buffer;

  slides.forEach((_, index) => {
    const layout = slides[index].layout === 'cover' || slides[index].layout === 'section'
      ? LAYOUT.cover
      : slides[index].layout === 'table' ? LAYOUT.table : LAYOUT.content;
    parts[`ppt/slides/slide${index + 1}.xml`] = slideParts[index];
    const slideRelationships = [
      { id: 'rId1', type: REL.slideLayout, target: `../slideLayouts/slideLayout${layout.index}.xml` },
      { id: 'rId2', type: REL.notesSlide, target: `../notesSlides/notesSlide${index + 1}.xml` }
    ];
    if (coverArt && index === 0 && coverMediaName) {
      slideRelationships.push({
        id: 'rId3',
        type: IMAGE_REL,
        target: `../media/${coverMediaName}`
      });
    }
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = relsXml(slideRelationships);
    parts[`ppt/notesSlides/notesSlide${index + 1}.xml`] = notesParts[index];
    parts[`ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`] = relsXml([
      { id: 'rId1', type: REL.slide, target: `../slides/slide${index + 1}.xml` },
      { id: 'rId2', type: REL.notesMaster, target: `../notesMasters/notesMaster1.xml` }
    ]);
  });

  return parts;
}

/**
 * Genera el buffer PPTX listo para descargar.
 * @param {any} spec
 * @param {{now?:Date, compress?:boolean}} [options]
 * @returns {Buffer}
 */
export function renderPptx(spec = {}, options = {}) {
  const parts = pptxParts(spec, options);
  return createZip(Object.entries(parts).map(([name, data]) => ({ name, data })), {
    compress: options.compress !== false,
    date: options.now instanceof Date ? options.now : new Date()
  });
}

export { SLIDE_W, SLIDE_H };
export default { renderPptx, pptxParts, normalizeSlides };


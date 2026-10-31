/**
 * Generador de DOCX (WordprocessingML) sin dependencias.
 *
 * Modelo de entrada (`sections`):
 *   - { heading: 'Texto', level: 1|2 }
 *   - { paragraph: 'Texto con **negrita** y *cursiva*', style?: 'Normal'|'Cita', align? }
 *   - { quote: 'Texto citado' }
 *   - { list: { ordered: false, items: ['uno', { text: 'dos', level: 1 }] } }
 *   - { table: { headers: ['A','B'], rows: [['1','2']], widths?: [40,60], caption?: 'Tabla 1' } }
 *   - { pageBreak: true }
 *   - { runs: [{ text: 'Hola', bold: true }, { text: ' mundo', italic: true }] }
 *   - Atajos: { h1: '…' }, { h2: '…' }, { p: '…' }, { bullets: ['…'] }, { numbered: ['…'] }
 *
 * Siempre se emiten: encabezado con el nombre del documento y la fecha, pie con
 * la marca y «Página X de Y», márgenes de página y estilos Título 1/2, Normal y
 * Cita. El anexo (`annex`) empieza en una página nueva y se marca como privado.
 */
import { createZip } from './zip.mjs';
import {
  XML_DECL, NS, REL, CT, escapeXml, escapeAttr, cleanText, normalizeBrand,
  lighten, contrastText, parseDateInput, dateKey, formatDateLongEs, isoUtc,
  contentTypesXml, relsXml, corePropsXml, appPropsXml
} from './ooxml.mjs';

const PAGE_WIDTH = 11906; // A4 en twips
const PAGE_HEIGHT = 16838;
const DEFAULT_MARGINS = Object.freeze({ top: 1440, right: 1440, bottom: 1440, left: 1440 });

const INLINE_RE = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*)/g;

/**
 * Convierte el marcado inline (`**negrita**`, `*cursiva*`) en carreras.
 * @param {string} text
 * @param {{bold?:boolean, italic?:boolean}} [base]
 * @returns {Array<{text:string, bold:boolean, italic:boolean}>}
 */
export function parseInline(text, base = {}) {
  const runs = [];
  const source = String(text ?? '');
  let lastIndex = 0;
  let match = INLINE_RE.exec(source);
  while (match) {
    if (match.index > lastIndex) {
      runs.push({ text: source.slice(lastIndex, match.index), bold: !!base.bold, italic: !!base.italic });
    }
    const token = match[0];
    if (token.startsWith('***')) {
      runs.push({ text: token.slice(3, -3), bold: true, italic: true });
    } else if (token.startsWith('**')) {
      runs.push({ text: token.slice(2, -2), bold: true, italic: !!base.italic });
    } else {
      runs.push({ text: token.slice(1, -1), bold: !!base.bold, italic: true });
    }
    lastIndex = match.index + token.length;
    match = INLINE_RE.exec(source);
  }
  if (lastIndex < source.length) {
    runs.push({ text: source.slice(lastIndex), bold: !!base.bold, italic: !!base.italic });
  }
  return runs.filter((run) => run.text !== '');
}

function runProperties({ bold, italic, color, size, font, underline } = {}) {
  // Orden de CT_RPr: rFonts, b/bCs, i/iCs, color, sz/szCs, u.
  const parts = [];
  if (font) parts.push(`<w:rFonts w:ascii="${escapeAttr(font)}" w:hAnsi="${escapeAttr(font)}" w:cs="${escapeAttr(font)}"/>`);
  if (bold) parts.push('<w:b/><w:bCs/>');
  if (italic) parts.push('<w:i/><w:iCs/>');
  if (color) parts.push(`<w:color w:val="${escapeAttr(color)}"/>`);
  if (size) parts.push(`<w:sz w:val="${Number(size)}"/><w:szCs w:val="${Number(size)}"/>`);
  if (underline) parts.push('<w:u w:val="single"/>');
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function runXml(text, options = {}) {
  const lines = cleanText(text).split('\n');
  const content = lines
    .map((line, index) => `${index > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join('');
  return `<w:r>${runProperties(options)}${content || '<w:t xml:space="preserve"></w:t>'}</w:r>`;
}

function inlineRunsXml(text, options = {}) {
  return parseInline(text, options)
    .map((run) => runXml(run.text, {
      ...options,
      bold: run.bold || options.bold,
      italic: run.italic || options.italic
    }))
    .join('');
}

function paragraphXml({ text = '', runs = null, style = 'Normal', align = null, numbering = null, spacing = null, border = null, keepNext = false, indent = null } = {}) {
  const properties = [`<w:pStyle w:val="${escapeAttr(style)}"/>`];
  if (keepNext) properties.push('<w:keepNext/>');
  if (numbering) properties.push(`<w:numPr><w:ilvl w:val="${Number(numbering.level) || 0}"/><w:numId w:val="${Number(numbering.numId)}"/></w:numPr>`);
  if (border) properties.push(border);
  if (spacing) properties.push(`<w:spacing w:after="${spacing.after ?? 120}" w:line="${spacing.line ?? 276}" w:lineRule="auto"/>`);
  if (indent) properties.push(`<w:ind w:left="${indent.left || 0}"${indent.hanging ? ` w:hanging="${indent.hanging}"` : ''}/>`);
  if (align) properties.push(`<w:jc w:val="${escapeAttr(align)}"/>`);
  const pPr = `<w:pPr>${properties.join('')}</w:pPr>`;
  if (runs) {
    const xml = runs.map((run) => runXml(run.text || '', run)).join('');
    return `<w:p>${pPr}${xml}</w:p>`;
  }
  return `<w:p>${pPr}${inlineRunsXml(text)}</w:p>`;
}

function pageBreakXml() {
  return '<w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="0"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
}

function fieldXml(instruction, placeholder) {
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    runXml(placeholder, { size: 16, color: '595959' }),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  ].join('');
}

/**
 * Tabla con encabezado repetido, bordes suaves y filas alternas.
 */
function tableXml({ headers = [], rows = [], widths = null, caption = null, captionStyle = 'Normal' } = {}, brand) {
  const columns = Math.max(headers.length, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)), 1);
  if (columns > 20) throw new Error('La tabla admite como máximo 20 columnas.');
  const usable = PAGE_WIDTH - DEFAULT_MARGINS.left - DEFAULT_MARGINS.right;
  let colWidths = [];
  if (Array.isArray(widths) && widths.length === columns) {
    const total = widths.reduce((sum, value) => sum + (Number(value) || 0), 0) || 1;
    colWidths = widths.map((value) => Math.max(500, Math.round((Number(value) / total) * usable)));
  } else {
    colWidths = Array.from({ length: columns }, () => Math.round(usable / columns));
  }
  const headerFill = brand.color;
  const headerText = contrastText(headerFill);
  const zebra = lighten(brand.color, 0.93);
  const borderColor = lighten(brand.color, 0.65);

  const cell = (text, { header = false, zebraFill = false, width = 0 } = {}) => {
    const fill = header ? headerFill : zebraFill ? zebra : null;
    const shading = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
    const options = header ? { bold: true, color: headerText, size: 20 } : { size: 20, color: '333333' };
    const runs = Array.isArray(text)
      ? text.map((item) => (typeof item === 'object' && item ? item : { text: item }))
      : [{ text: text }];
    const content = runs.map((item) => inlineRunsXml(item.text ?? '', { ...options, bold: options.bold || item.bold, italic: item.italic })).join('') || runXml('', options);
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>${header ? '<w:jc w:val="left"/>' : ''}</w:pPr>${content}</w:p></w:tc>`;
  };

  const rowsXml = [];
  if (headers.length) {
    rowsXml.push(`<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${headers.map((header, index) => cell(header, { header: true, width: colWidths[index] })).join('')}</w:tr>`);
  }
  rows.forEach((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : [row];
    rowsXml.push(`<w:tr>${Array.from({ length: columns }, (_, index) => cell(cells[index] ?? '', { zebraFill: rowIndex % 2 === 1, width: colWidths[index] })).join('')}</w:tr>`);
  });

  const captionXml = caption
    ? paragraphXml({
      runs: [{ text: `${caption}`, bold: true, italic: true, color: '595959', size: 18 }],
      style: 'Normal',
      spacing: { after: 60, line: 240 },
      keepNext: true
    })
    : '';

  return `${captionXml}<w:tbl>
<w:tblPr>
<w:tblStyle w:val="TablaCopilot"/>
<w:tblW w:w="${usable}" w:type="dxa"/>
<w:tblInd w:w="0" w:type="dxa"/>
<w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
<w:left w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
<w:right w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
<w:insideV w:val="single" w:sz="4" w:space="0" w:color="${borderColor}"/>
</w:tblBorders>
<w:tblLayout w:type="fixed"/>
<w:tblCellMar>
<w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>
<w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>
</w:tblCellMar>
<w:tblLook w:val="04A0"/>
</w:tblPr>
<w:tblGrid>${colWidths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>
${rowsXml.join('')}
</w:tbl>${paragraphXml({ text: '', style: 'Normal', spacing: { after: 60, line: 240 } })}`;
}

function headingXml(text, level = 1) {
  return paragraphXml({ text, style: level === 2 ? 'Titulo2' : 'Titulo1', spacing: { after: 120, line: 276 } });
}

function listXml(items = [], { ordered = false, numId = null } = {}) {
  const resolvedNumId = numId || (ordered ? 2 : 1);
  return items.map((item) => {
    const value = typeof item === 'object' && item !== null ? item : { text: item };
    const level = Math.max(0, Math.min(2, Number(value.level) || 0));
    return paragraphXml({
      text: value.text ?? '',
      style: 'ListParagraph',
      numbering: { numId: resolvedNumId, level }
    });
  }).join('');
}

/**
 * Renderiza los bloques de contenido.
 * @param {any[]} blocks
 * @param {object} brand
 */
function renderBlocks(blocks = [], brand) {
  const output = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.pageBreak === true) { output.push(pageBreakXml()); continue; }
    if (block.heading !== undefined) { output.push(headingXml(block.heading, block.level === 2 ? 2 : 1)); continue; }
    if (block.h1 !== undefined) { output.push(headingXml(block.h1, 1)); continue; }
    if (block.h2 !== undefined) { output.push(headingXml(block.h2, 2)); continue; }
    if (block.paragraph !== undefined || block.p !== undefined) {
      const text = block.paragraph !== undefined ? block.paragraph : block.p;
      const style = block.style === 'Cita' || block.quote === true ? 'Cita' : (block.style || 'Normal');
      output.push(paragraphXml({ text, style, align: block.align || null }));
      continue;
    }
    if (block.quote !== undefined) { output.push(paragraphXml({ text: block.quote, style: 'Cita' })); continue; }
    if (block.runs !== undefined && Array.isArray(block.runs)) {
      output.push(paragraphXml({ runs: block.runs, style: block.style || 'Normal', align: block.align || null }));
      continue;
    }
    if (block.list) {
      const list = Array.isArray(block.list) ? { items: block.list } : block.list;
      output.push(listXml(list.items || [], { ordered: list.ordered === true }));
      continue;
    }
    if (Array.isArray(block.bullets)) { output.push(listXml(block.bullets, { ordered: false })); continue; }
    if (Array.isArray(block.numbered)) { output.push(listXml(block.numbered, { ordered: true })); continue; }
    if (block.table) {
      output.push(tableXml({ caption: block.caption ?? block.table.caption, ...block.table }, brand));
      continue;
    }
    if (typeof block.text === 'string') {
      output.push(paragraphXml({ text: block.text, style: block.style || 'Normal' }));
    }
  }
  return output.join('\n');
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function collectText(blocks = []) {
  const parts = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    for (const key of ['heading', 'h1', 'h2', 'paragraph', 'p', 'quote', 'text']) {
      if (typeof block[key] === 'string') parts.push(block[key]);
    }
    if (Array.isArray(block.bullets)) parts.push(...block.bullets.map((item) => (typeof item === 'string' ? item : item?.text || '')));
    if (Array.isArray(block.numbered)) parts.push(...block.numbered.map((item) => (typeof item === 'string' ? item : item?.text || '')));
    if (block.list && Array.isArray(block.list.items)) parts.push(...block.list.items.map((item) => (typeof item === 'string' ? item : item?.text || '')));
    if (block.runs && Array.isArray(block.runs)) parts.push(...block.runs.map((run) => run?.text || ''));
    if (block.table) {
      parts.push(...(block.table.headers || []));
      for (const row of block.table.rows || []) {
        for (const value of Array.isArray(row) ? row : [row]) {
          parts.push(typeof value === 'object' && value ? value.text ?? '' : String(value ?? ''));
        }
      }
    }
  }
  return parts.join(' ');
}

function stylesXml(brand) {
  const headingColor = brand.color;
  return `${XML_DECL}<w:styles xmlns:w="${NS.word}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="${escapeAttr(brand.font)}" w:hAnsi="${escapeAttr(brand.font)}" w:cs="${escapeAttr(brand.font)}"/><w:color w:val="262626"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES" w:eastAsia="es-ES"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="TituloDocumento">
    <w:name w:val="Título del documento"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitulo"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="120" w:line="276" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${headingColor}"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitulo">
    <w:name w:val="Subtítulo"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="240" w:line="276" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:i/><w:iCs/><w:color w:val="595959"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Titulo1">
    <w:name w:val="Título 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="120" w:line="276" w:lineRule="auto"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${headingColor}"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Titulo2">
    <w:name w:val="Título 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="80" w:line="276" w:lineRule="auto"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${brand.accent}"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Cita">
    <w:name w:val="Cita"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${brand.accent}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${lighten(brand.color, 0.94)}"/><w:spacing w:before="120" w:after="160" w:line="276" w:lineRule="auto"/><w:ind w:left="280" w:right="200"/></w:pPr>
    <w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="Párrafo de lista"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:after="40" w:line="276" w:lineRule="auto"/><w:ind w:left="720" w:hanging="360"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Metadatos">
    <w:name w:val="Metadatos"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:after="200" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:default="1" w:styleId="TableNormal">
    <w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>
  </w:style>
  <w:style w:type="table" w:styleId="TablaCopilot">
    <w:name w:val="Tabla Copilot"/><w:basedOn w:val="TableNormal"/>
    <w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders></w:tblPr>
  </w:style>
</w:styles>`;
}

function numberingXml() {
  const bulletLevels = ['•', '–', '·'];
  const decimalLevels = ['%1.', '%1.%2.', '%1.%2.%3.'];
  const levels = (abstract, format, texts, font) => texts.map((text, index) => `<w:lvl w:ilvl="${index}">
  <w:start w:val="1"/>
  <w:numFmt w:val="${format}"/>
  <w:lvlText w:val="${escapeAttr(text)}"/>
  <w:lvlJc w:val="left"/>
  <w:pPr><w:ind w:left="${720 + index * 360}" w:hanging="360"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>
</w:lvl>`).join('\n');
  return `${XML_DECL}<w:numbering xmlns:w="${NS.word}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
${levels('bullet', 'bullet', bulletLevels, 'Calibri')}
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>
${levels('decimal', 'decimal', decimalLevels, 'Calibri')}
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
}

function headerXml(brand, title, longDate, watermark = '') {
  const rule = lighten(brand.color, 0.62);
  return `${XML_DECL}<w:hdr xmlns:w="${NS.word}" xmlns:r="${NS.wordRels}">
<w:p>
  <w:pPr>
    <w:pStyle w:val="Normal"/>
    <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
  </w:pPr>
  <w:r><w:rPr><w:b/><w:color w:val="${brand.accent}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${escapeXml(brand.logoText)}</w:t></w:r>
</w:p>
<w:p>
  <w:pPr>
    <w:pStyle w:val="Normal"/>
    <w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${rule}"/></w:pBdr>
    <w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs>
    <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
  </w:pPr>
  <w:r><w:rPr><w:b/><w:color w:val="${brand.color}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r>
  <w:r><w:tab/></w:r>
  <w:r><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(longDate)}</w:t></w:r>
</w:p>
${watermark ? `<w:p>
  <w:pPr>
    <w:pStyle w:val="Normal"/>
    <w:jc w:val="center"/>
    <w:spacing w:before="60" w:after="0" w:line="240" w:lineRule="auto"/>
  </w:pPr>
  <w:r><w:rPr><w:b/><w:color w:val="C9C9C9"/><w:sz w:val="26"/><w:szCs w:val="26"/><w:spacing w:val="40"/></w:rPr><w:t xml:space="preserve">${escapeXml(watermark)}</w:t></w:r>
</w:p>` : ''}
</w:hdr>`;
}

function footerXml(brand) {
  const left = [brand.logoText, brand.footerText].filter(Boolean).join(' · ');
  return `${XML_DECL}<w:ftr xmlns:w="${NS.word}" xmlns:r="${NS.wordRels}">
<w:p>
  <w:pPr>
    <w:pStyle w:val="Normal"/>
    <w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs>
    <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
  </w:pPr>
  <w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${escapeXml(left)}</w:t></w:r>
  <w:r><w:tab/></w:r>
  <w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">Página </w:t></w:r>
  ${fieldXml('PAGE', '1')}
  <w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve"> de </w:t></w:r>
  ${fieldXml('NUMPAGES', '1')}
</w:p>
</w:ftr>`;
}

function marginsXml(margins = {}) {
  const values = { ...DEFAULT_MARGINS };
  for (const key of Object.keys(DEFAULT_MARGINS)) {
    const value = Number(margins[key]);
    if (Number.isFinite(value) && value >= 360 && value <= 4320) values[key] = Math.round(value);
  }
  return `<w:pgMar w:top="${values.top}" w:right="${values.right}" w:bottom="${values.bottom}" w:left="${values.left}" w:header="708" w:footer="708" w:gutter="0"/>`;
}

/**
 * Construye todas las partes del DOCX (sin comprimir).
 * @param {any} spec
 * @param {{now?:Date}} [options]
 * @returns {Record<string,string>}
 */
export function docxParts(spec = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const brand = normalizeBrand(spec.brand || {});
  const title = cleanText(spec.title || 'Documento') || 'Documento';
  const subtitle = cleanText(spec.subtitle || '');
  const date = parseDateInput(spec.date, now);
  const author = cleanText(spec.author || brand.creator);
  const reference = cleanText(spec.reference || '');
  const sections = Array.isArray(spec.sections) ? spec.sections : [];
  const annex = spec.annex && typeof spec.annex === 'object' ? spec.annex : null;

  const body = [];
  body.push(paragraphXml({ text: title, style: 'TituloDocumento' }));
  if (subtitle) body.push(paragraphXml({ text: subtitle, style: 'Subtitulo' }));
  const metaLine = [formatDateLongEs(date), reference, author].filter(Boolean).join(' · ');
  if (metaLine) body.push(paragraphXml({ text: metaLine, style: 'Metadatos' }));
  body.push(renderBlocks(sections, brand));
  if (brand.signature) {
    body.push(paragraphXml({
      runs: [{ text: brand.signature, italic: true, color: '808080', size: 18 }],
      style: 'Normal',
      spacing: { after: 0, line: 240 }
    }));
  }

  if (annex) {
    body.push(pageBreakXml());
    body.push(headingXml(annex.title || 'Anexo privado', 1));
    if (annex.private !== false) {
      body.push(paragraphXml({
        runs: [{ text: 'Documento privado — no distribuir.', bold: true, color: 'C00000', size: 20 }],
        style: 'Cita'
      }));
    }
    if (annex.note) body.push(paragraphXml({ text: annex.note, style: 'Cita' }));
    body.push(renderBlocks(annex.sections || annex.blocks || [], brand));
    if (Array.isArray(annex.paragraphs)) {
      for (const paragraph of annex.paragraphs) body.push(paragraphXml({ text: paragraph, style: 'Normal' }));
    }
    if (Array.isArray(annex.items)) {
      body.push(listXml(annex.items, { ordered: false }));
    }
  }

  const documentXml = `${XML_DECL}<w:document xmlns:w="${NS.word}" xmlns:r="${NS.wordRels}">
<w:body>
${body.filter(Boolean).join('\n')}
<w:sectPr>
<w:headerReference w:type="default" r:id="rId3"/>
<w:footerReference w:type="default" r:id="rId4"/>
<w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>
${marginsXml(spec.margins)}
<w:cols w:space="708"/>
<w:docGrid w:linePitch="360"/>
</w:sectPr>
</w:body>
</w:document>`;

  const allText = [title, subtitle, collectText(sections), collectText(annex ? [annex] : [])].join(' ');
  const words = wordCount(allText);
  const paragraphs = Math.max(1, (documentXml.match(/<w:p>/g) || []).length);
  const pages = annex ? 2 : 1;

  const core = corePropsXml({
    title,
    subject: reference || (annex ? 'Documento con anexo privado' : 'Documento de Agenda Copilot'),
    creator: author,
    description: subtitle ? `${title} — ${subtitle}` : title,
    created: spec.created ? parseDateInput(spec.created, now) : now,
    modified: now
  });
  const app = appPropsXml({
    application: 'Agenda Copilot P95 (Word)',
    properties: [
      { name: 'Template', value: 'Normal.dotm' },
      { name: 'TotalTime', type: 'i4', value: 0 },
      { name: 'Pages', type: 'i4', value: pages },
      { name: 'Words', type: 'i4', value: words },
      { name: 'Characters', type: 'i4', value: allText.length },
      { name: 'Paragraphs', type: 'i4', value: paragraphs },
      { name: 'CharactersWithSpaces', type: 'i4', value: allText.length }
    ]
  });

  return {
    '[Content_Types].xml': contentTypesXml({
      defaults: [
        { extension: 'rels', contentType: CT.rels },
        { extension: 'xml', contentType: CT.xml }
      ],
      overrides: [
        { partName: '/word/document.xml', contentType: CT.docxDocument },
        { partName: '/word/styles.xml', contentType: CT.docxStyles },
        { partName: '/word/numbering.xml', contentType: CT.docxNumbering },
        { partName: '/word/header1.xml', contentType: CT.docxHeader },
        { partName: '/word/footer1.xml', contentType: CT.docxFooter },
        { partName: '/docProps/core.xml', contentType: CT.coreProperties },
        { partName: '/docProps/app.xml', contentType: CT.extendedProperties }
      ]
    }),
    '_rels/.rels': relsXml([
      { id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' },
      { id: 'rId2', type: REL.coreProperties, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extendedProperties, target: 'docProps/app.xml' }
    ]),
    'word/document.xml': documentXml,
    'word/_rels/document.xml.rels': relsXml([
      { id: 'rId1', type: REL.styles, target: 'styles.xml' },
      { id: 'rId2', type: REL.numbering, target: 'numbering.xml' },
      { id: 'rId3', type: REL.header, target: 'header1.xml' },
      { id: 'rId4', type: REL.footer, target: 'footer1.xml' }
    ]),
    'word/styles.xml': stylesXml(brand),
    'word/numbering.xml': numberingXml(),
    'word/header1.xml': headerXml(brand, spec.headerTitle ? cleanText(spec.headerTitle) : title, formatDateLongEs(date), spec.watermark ? cleanText(spec.watermark) : ''),
    'word/footer1.xml': footerXml(brand),
    'docProps/core.xml': core,
    'docProps/app.xml': app
  };
}

/**
 * Genera el buffer DOCX listo para descargar.
 * @param {any} spec
 * @param {{now?:Date, compress?:boolean}} [options]
 * @returns {Buffer}
 */
export function renderDocx(spec = {}, options = {}) {
  const parts = docxParts(spec, options);
  return createZip(Object.entries(parts).map(([name, data]) => ({ name, data })), {
    compress: options.compress !== false,
    date: options.now instanceof Date ? options.now : new Date()
  });
}

/** Fecha ISO del documento (para nombres y cabeceras). */
export function docxDateKey(spec = {}) {
  return dateKey(parseDateInput(spec.date, new Date()));
}

export { isoUtc };
export default { renderDocx, docxParts, parseInline, docxDateKey };



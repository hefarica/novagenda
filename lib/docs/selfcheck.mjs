#!/usr/bin/env node
/**
 * Autocomprobación de documentos ofimáticos (DOCX/XLSX/PPTX).
 *
 * Uso:
 *   node lib/docs/selfcheck.mjs            # valida y limpia el directorio temporal
 *   node lib/docs/selfcheck.mjs --keep     # conserva las muestras generadas
 *
 * Comprueba, sin dependencias externas:
 *   1. ZIP propio: CRC32, almacenado/deflate, nombres UTF-8 y rechazo de rutas.
 *   2. XML bien formado de todas las partes de los tres formatos.
 *   3. Estructura OPC: tipos de contenido, relaciones resolubles y partes
 *      obligatorias (`validateOoxmlPackage`).
 *   4. DOCX: título, estilos, listas, tabla, salto de página, encabezado/pie y
 *      anexo privado; y plantilla «acta» con resumen de 4 líneas.
 *   5. XLSX: 2 hojas, tipos, SUM/AVERAGE/IF con caché, moneda/porcentaje/fecha,
 *      anchos automáticos (moneda 1e9 incluida), `width` explícito respetado y
 *      fila de encabezado congelada.
 *   6. PPTX: portada + 3 diapositivas, viñetas, tabla, notas y numeración.
 *   7. Almacén: crear/listar/leer/borrar en DATA_DIR temporal.
 *   8. API HTTP real (createApp + router): POST/GET/download/DELETE, 400 de
 *      validación, plantillas, `register:false` y 503 de correo no configurado.
 *   9. MIME con adjunto base64 y rechazo limpio cuando Gmail no está conectado.
 *
 * Verificación manual de anchos con Excel COM (ejecutada en la entrega; si
 * Excel no está disponible, la comprobación XML de arriba es la vía válida):
 *   - Abrir `muestras/anchos.xlsx`, `muestras/reporte.xlsx` y
 *     `muestras/http-reporte.xlsx` con `--keep`.
 *   - Recorrer `Range.Text` de las filas de datos y comprobar que ninguna celda
 *     con formato currency/date devuelve `####`; el ancho XML debe ser >= 16
 *     para moneda (21 en la columna con 1e9) y >= 13 para fecha, y `ColumnWidth`
 *     efectivo de Excel queda ~1 punto por debajo de ese valor (suficiente).
 *   - Resultado esperado en Excel 16.0: 0 celdas con `####`; los montos se ven
 *     como `$1.000.000,00`, `$2.600.000,00` y `$1.000.000.000,00`.
 *
 * Los archivos nunca tocan `data/` real: se usa un `DATA_DIR` temporal y un
 * puerto efímero de loopback (siempre > 3124). No reinicia la app del puerto 3000.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const KEEP = process.argv.includes('--keep');
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-docs-selfcheck-'));
const SAMPLES_DIR = path.join(TEMP_DIR, 'muestras');
process.env.DATA_DIR = path.join(TEMP_DIR, 'data');
process.env.NODE_ENV = 'test';
process.env.APP_AUTH = 'off';
process.env.HOST = '127.0.0.1';
process.env.CHANNELS_AUTOSTART = 'off';
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.LOG_LEVEL = 'error';

const results = [];
let currentSection = 'general';

function section(name) {
  currentSection = name;
  console.log(`\n# ${name}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: currentSection, name, ok: true, detail: detail || '' });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ section: currentSection, name, ok: false, error: error?.message || String(error) });
    console.log(`FAIL  ${name} — ${error?.message || error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (se esperaba ${JSON.stringify(expected)}, llegó ${JSON.stringify(actual)})`);
}

function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(message || `No se encontró ${JSON.stringify(needle)}`);
}

function countMatches(text, pattern) {
  return (String(text).match(pattern) || []).length;
}

/* ------------------------------------------------------------------ */
/* Importaciones dinámicas (DATA_DIR ya está definido)                 */
/* ------------------------------------------------------------------ */

const { createZip, readZip, crc32 } = await import('./zip.mjs');
const { checkXml } = await import('./xmlcheck.mjs');
const {
  validateOoxmlPackage, excelSerial, tagAttributes
} = await import('./ooxml.mjs');
const { renderDocx } = await import('./docx.mjs');
const { renderXlsx } = await import('./xlsx.mjs');
const { renderPptx } = await import('./pptx.mjs');
const {
  DOC_TYPES, createDocument, deleteDocument, documentStats, getDocument,
  listDocuments, readDocument, saveTemplate
} = await import('./index.mjs');
const { buildMimeMessage, sendDocumentEmail } = await import('./email.mjs');

/* ------------------------------------------------------------------ */
/* Utilidades de comprobación                                          */
/* ------------------------------------------------------------------ */

function checkAllParts(archive, label, requiredParts = []) {
  const result = validateOoxmlPackage(archive, { requiredParts });
  assert(result.ok, `${label}: ${result.errors.slice(0, 8).join(' | ')}`);
  for (const entry of archive.entries) {
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue;
    const text = entry.data.toString('utf8');
    assert(text.startsWith('<?xml'), `${label}: ${entry.name} no empieza con declaración XML`);
    const parsed = checkXml(text, { name: entry.name, requireDeclaration: true });
    assert(parsed.ok, `${label}: ${entry.name} no es XML bien formado: ${parsed.errors.map((issue) => issue.message).join('; ')}`);
  }
  return result;
}

function zipEntry(archive, name) {
  const data = archive.map[name];
  assert(data, `Falta la parte ${name}`);
  return data.toString('utf8');
}

function sample(pathName, buffer) {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  fs.writeFileSync(path.join(SAMPLES_DIR, pathName), buffer);
}

/* ------------------------------------------------------------------ */
/* 1. ZIP                                                              */
/* ------------------------------------------------------------------ */

section('1. ZIP propio');

await check('CRC32 coincide con el vector estándar (123456789 → CBF43926)', () => {
  assertEqual(crc32('123456789').toString(16).toUpperCase(), 'CBF43926', 'CRC32 incorrecto');
  return '0xCBF43926';
});

await check('ZIP almacenado + deflate + nombre UTF-8, ida y vuelta', () => {
  const zip = createZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'datos/repetición.xml', data: `<r>${'áéíóú'.repeat(80)}</r>` },
    { name: 'vacio.txt', data: '' }
  ], { comment: 'prueba' });
  const archive = readZip(zip);
  assertEqual(archive.entries.length, 3, 'Número de entradas');
  assertEqual(archive.comment, 'prueba', 'Comentario');
  assertEqual(archive.map['datos/repetición.xml'].toString('utf8'), `<r>${'áéíóú'.repeat(80)}</r>`, 'Contenido UTF-8');
  assertEqual(archive.entries.find((entry) => entry.name === '[Content_Types].xml').method, 0, 'Entrada pequeña debe ir almacenada');
  return `${zip.length} bytes, métodos ${archive.entries.map((entry) => entry.method).join('/')}`;
});

await check('El escritor ZIP rechaza rutas con ".." y nombres absolutos', () => {
  let rejected = 0;
  for (const bad of ['../fuera.xml', '/absoluto.xml']) {
    try { createZip([{ name: bad, data: 'x' }]); } catch { rejected += 1; }
  }
  assertEqual(rejected, 2, 'Debería rechazar ambas rutas');
  return '2/2 rechazadas';
});

await check('Un ZIP con CRC corrupto se detecta al leer', () => {
  const zip = createZip([{ name: 'a.xml', data: '<a/>' }]);
  const copy = Buffer.from(zip);
  // Corrompe el CRC del directorio central (offset 16 de la primera entrada).
  const centralOffset = copy.readUInt32LE(zip.length - 6);
  copy.writeUInt32LE(0xDEADBEEF, centralOffset + 16);
  let failed = false;
  try { readZip(copy); } catch { failed = true; }
  assert(failed, 'La lectura debería fallar con CRC incorrecto');
  return 'CRC verificado';
});

/* ------------------------------------------------------------------ */
/* 2. XML                                                              */
/* ------------------------------------------------------------------ */

section('2. Verificador XML');

await check('XML válido con espacios de nombres, entidades y CDATA', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:root xmlns:a="urn:x" xmlns:r="urn:r"><a:item r:id="rId1">á &amp; &lt;ok&gt;</a:item><a:cd><![CDATA[<no-es-etiqueta>]]></a:cd></a:root>';
  const parsed = checkXml(xml, { requireDeclaration: true });
  assert(parsed.ok, parsed.errors.map((issue) => issue.message).join('; '));
  assertEqual(parsed.root, 'a:root', 'Raíz');
  return `${parsed.elements} elementos`;
});

await check('XML inválido: cierre incorrecto, prefijo sin declarar y entidad rota', () => {
  for (const bad of ['<root><a></root>', '<x:root/>', '<r>&mala;</r>', '<r a=1/>', '<a/><b/>']) {
    const parsed = checkXml(bad);
    assert(!parsed.ok, `Debería fallar: ${bad}`);
  }
  return '5/5 detectados';
});

/* ------------------------------------------------------------------ */
/* 3. DOCX                                                             */
/* ------------------------------------------------------------------ */

section('3. DOCX');

const docxSpec = {
  title: 'Informe de validación',
  subtitle: 'Documento de prueba integral',
  date: '2026-10-28',
  author: 'Ana Torres',
  reference: 'INF-2026-001',
  brand: { font: 'Georgia', color: '#1F3864', accent: '#2E74B5', logoText: 'Marca de prueba', signature: 'Firma de prueba', footerText: 'Uso interno' },
  sections: [
    { heading: 'Contexto', level: 1 },
    { paragraph: 'Este párrafo tiene **negrita**, *cursiva* y ***ambas***.' },
    { quote: 'Una cita textual breve.' },
    { heading: 'Listas', level: 2 },
    { list: { ordered: false, items: ['Primero', { text: 'Segundo nivel', level: 1 }] } },
    { list: { ordered: true, items: ['Paso uno', 'Paso dos'] } },
    { table: { caption: 'Tabla 1. Compromisos', headers: ['Acuerdo', 'Responsable', 'Fecha'], rows: [['Cerrar bloqueantes', 'Ana', '2026-10-30'], ['Publicar', 'Luis', '2026-11-01']] } },
    { pageBreak: true },
    { paragraph: 'Contenido después del salto de página.' }
  ],
  annex: {
    title: 'Anexo privado',
    paragraphs: ['Notas internas que no se distribuyen.'],
    items: ['Punto privado A', 'Punto privado B']
  }
};

let docxBuffer = null;
await check('DOCX: paquete OPC válido y XML bien formado', () => {
  docxBuffer = renderDocx(docxSpec, { now: new Date('2026-10-28T15:00:00Z') });
  sample('informe.docx', docxBuffer);
  const archive = readZip(docxBuffer);
  checkAllParts(archive, 'DOCX', [
    'word/document.xml', 'word/styles.xml', 'word/numbering.xml',
    'word/header1.xml', 'word/footer1.xml', 'docProps/core.xml', 'docProps/app.xml'
  ]);
  return `${docxBuffer.length} bytes, ${archive.entries.length} partes`;
});

await check('DOCX: título, tabla, anexo privado y salto de página', () => {
  const archive = readZip(docxBuffer);
  const documentXml = zipEntry(archive, 'word/document.xml');
  includes(documentXml, 'Informe de validación', 'Falta el título');
  includes(documentXml, '<w:tbl>', 'Falta la tabla');
  includes(documentXml, 'Anexo privado', 'Falta el anexo');
  includes(documentXml, 'Notas internas que no se distribuyen.', 'Falta el texto del anexo');
  includes(documentXml, 'w:type="page"', 'Falta el salto de página');
  assert(documentXml.indexOf('w:type="page"') < documentXml.indexOf('Anexo privado'), 'El anexo debe ir después del salto de página');
  assertEqual(countMatches(documentXml, /<w:tbl>/g), 1, 'Número de tablas');
  return 'título + tabla + anexo + salto';
});

await check('DOCX: estilos Título 1/2, Normal y Cita, negrita/cursiva y listas', () => {
  const archive = readZip(docxBuffer);
  const styles = zipEntry(archive, 'word/styles.xml');
  const documentXml = zipEntry(archive, 'word/document.xml');
  for (const styleId of ['Titulo1', 'Titulo2', 'Normal', 'Cita', 'ListParagraph']) {
    includes(styles, `w:styleId="${styleId}"`, `Falta el estilo ${styleId}`);
  }
  includes(documentXml, '<w:b/>');
  includes(documentXml, '<w:i/>');
  includes(documentXml, 'w:numId w:val="1"', 'Falta lista con viñetas');
  includes(documentXml, 'w:numId w:val="2"', 'Falta lista numerada');
  includes(styles, 'Georgia', 'La marca no aplicó la fuente');
  return 'estilos y formato inline';
});

await check('DOCX: encabezado con nombre/fecha y pie con Página X de Y y márgenes', () => {
  const archive = readZip(docxBuffer);
  const header = zipEntry(archive, 'word/header1.xml');
  const footer = zipEntry(archive, 'word/footer1.xml');
  includes(header, 'Informe de validación');
  includes(header, '28 de octubre de 2026');
  includes(footer, 'PAGE');
  includes(footer, 'NUMPAGES');
  includes(zipEntry(archive, 'word/document.xml'), '<w:pgMar');
  return 'encabezado, pie y pgMar';
});

await check('DOCX: plantilla «acta» (cuerpo formal + 4 líneas + anexo)', async () => {
  const summary = ['Línea de resumen uno.', 'Línea de resumen dos.', 'Línea de resumen tres.', 'Línea de resumen cuatro.'];
  const created = await createDocument({
    type: 'docx',
    template: 'acta',
    title: 'Reunión de producto',
    date: '2026-10-28',
    author: 'Ana Torres',
    attendees: [{ name: 'Ana Torres', role: 'Producto' }, 'Luis Pérez'],
    agenda: ['Revisar roadmap', 'Cerrar bloqueantes'],
    agreements: [{ text: 'Publicar el viernes', owner: 'Luis', due: '2026-10-30', status: 'Pendiente' }],
    summary,
    annexNotes: ['Nota privada del acta.'],
    body: 'Se revisó el estado del producto y los bloqueantes abiertos.'
  });
  assert(created.id && /^DOC-/.test(created.id), 'El acta no tiene id');
  assertEqual(created.type, 'docx', 'Tipo');
  assert(created.filename.endsWith('.docx'), 'Extensión del acta');
  const { buffer } = readDocument(created.id);
  sample('acta.docx', buffer);
  const archive = readZip(buffer);
  checkAllParts(archive, 'ACTA', ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']);
  const documentXml = zipEntry(archive, 'word/document.xml');
  for (const line of summary) includes(documentXml, line, `Falta la línea de resumen: ${line}`);
  includes(documentXml, 'Anexo privado');
  includes(documentXml, 'w:type="page"');
  assert(countMatches(documentXml, /<w:tbl>/g) >= 3, 'El acta debe tener tablas de datos, asistentes y acuerdos');
  const summaryStart = documentXml.indexOf('6. Resumen ejecutivo');
  const signatureStart = documentXml.indexOf('7. Firma');
  assert(summaryStart > 0 && signatureStart > summaryStart, 'No se localizan las secciones de resumen/firma');
  const summaryXml = documentXml.slice(summaryStart, signatureStart);
  assertEqual(countMatches(summaryXml, /<w:numPr>/g), 4, 'El resumen debe tener exactamente 4 líneas');
  return `${created.filename}, ${summary.length} líneas de resumen`;
});

await check('DOCX: plantilla de marca guardada se aplica (fuente, color, firma)', async () => {
  const saved = await saveTemplate({
    name: 'marca-prueba',
    type: 'docx',
    brand: { font: 'Georgia', color: '#8B0000', logoText: 'Marca Guardada', signature: 'Firma Guardada', footerText: 'Confidencial' }
  });
  assertEqual(saved.created, true, 'La plantilla debería crearse');
  const created = await createDocument({
    type: 'docx',
    template: 'marca-prueba',
    title: 'Documento con marca',
    date: '2026-10-28',
    sections: [{ paragraph: 'Contenido con marca aplicada.' }]
  });
  const { buffer } = readDocument(created.id);
  const archive = readZip(buffer);
  checkAllParts(archive, 'MARCA');
  const styles = zipEntry(archive, 'word/styles.xml');
  const header = zipEntry(archive, 'word/header1.xml');
  includes(styles, 'Georgia');
  includes(styles, '8B0000');
  includes(header, 'Marca Guardada');
  const documentXml = zipEntry(archive, 'word/document.xml');
  includes(documentXml, 'Firma Guardada');
  return saved.item.name;
});

/* ------------------------------------------------------------------ */
/* 4. XLSX                                                             */
/* ------------------------------------------------------------------ */

section('4. XLSX');

const xlsxSpec = {
  title: 'Reporte financiero',
  currency: '$',
  author: 'Ana Torres',
  date: '2026-10-28',
  sheets: [
    {
      name: 'Resumen',
      columns: [
        { header: 'Concepto', type: 'text', width: 30 },
        { header: 'Monto', type: 'currency' },
        { header: 'Avance', type: 'percent' },
        { header: 'Fecha', type: 'date' }
      ],
      rows: [
        ['Consultoría', 1500000, 0.35, '2026-10-01'],
        ['Soporte', 800000, 0.42, '2026-10-05'],
        ['Licencias', 300000, 0.18, '2026-10-09'],
        ['Total', { formula: 'SUM(B2:B4)' }, { formula: 'AVERAGE(C2:C4)' }, null],
        ['Estado', { formula: 'IF(B5>2000000,"Meta","Revisar")' }, null, null]
      ],
      totals: true
    },
    {
      name: 'Detalle',
      columns: [
        { header: 'Cliente', type: 'text' },
        { header: 'Horas', type: 'number' },
        { header: 'Tarifa', type: 'currency' },
        { header: 'Importe', type: 'currency' }
      ],
      rows: [
        { Cliente: 'Acme', Horas: 40, Tarifa: 50000, Importe: { formula: 'B2*C2' } },
        { Cliente: 'Globex', Horas: 25, Tarifa: 60000, Importe: { formula: 'B3*C3' } },
        ['Total', { formula: 'SUM(B2:B3)' }, null, { formula: 'SUM(D2:D3)' }]
      ]
    }
  ]
};

let xlsxBuffer = null;
await check('XLSX: paquete OPC válido y XML bien formado', () => {
  xlsxBuffer = renderXlsx(xlsxSpec, { now: new Date('2026-10-28T15:00:00Z') });
  sample('reporte.xlsx', xlsxBuffer);
  const archive = readZip(xlsxBuffer);
  checkAllParts(archive, 'XLSX', [
    'xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'
  ]);
  return `${xlsxBuffer.length} bytes, ${archive.entries.length} partes`;
});

await check('XLSX: 2 hojas, congelación de encabezado y anchos', () => {
  const archive = readZip(xlsxBuffer);
  const workbook = zipEntry(archive, 'xl/workbook.xml');
  assertEqual(countMatches(workbook, /<sheet /g), 2, 'Número de hojas');
  includes(workbook, 'fullCalcOnLoad="1"');
  const sheet1 = zipEntry(archive, 'xl/worksheets/sheet1.xml');
  includes(sheet1, 'state="frozen"');
  includes(sheet1, '<cols>');
  includes(sheet1, 'customWidth="1"');
  includes(sheet1, 'autoFilter');
  return '2 hojas, frozen, cols';
});

await check('XLSX: tipos y formatos (fecha, moneda, porcentaje) y fórmula con caché', () => {
  const archive = readZip(xlsxBuffer);
  const styles = zipEntry(archive, 'xl/styles.xml');
  const sheet1 = zipEntry(archive, 'xl/worksheets/sheet1.xml');
  includes(styles, 'numFmtId="164"', 'Falta formato de fecha');
  includes(styles, 'numFmtId="166"', 'Falta formato de moneda');
  includes(styles, 'numFmtId="167"', 'Falta formato de porcentaje');
  includes(styles, '&quot;$&quot;#,##0.00');
  includes(sheet1, '<f>SUM(B2:B4)</f><v>2600000</v>', 'Falta SUM con valor en caché');
  includes(sheet1, '<f>AVERAGE(C2:C4)</f>', 'Falta AVERAGE');
  includes(sheet1, '<f>IF(B5&gt;2000000,&quot;Meta&quot;,&quot;Revisar&quot;)</f>', 'Falta IF');
  includes(sheet1, '>Meta<', 'Falta el resultado en caché de IF');
  const serial = excelSerial(new Date(2026, 9, 1));
  includes(sheet1, `<v>${Math.round(serial * 1e10) / 1e10}</v>`, 'Falta el serial de la fecha 2026-10-01');
  const sheet2 = zipEntry(archive, 'xl/worksheets/sheet2.xml');
  assert(countMatches(sheet2, /<f>/g) >= 4, 'La hoja Detalle debería tener 4 fórmulas');
  return `SUM=2600000, fecha=${serial}`;
});

await check('XLSX: ancho automático cubre moneda/fecha/porcentaje y respeta width explícito', () => {
  const widthsSpec = {
    title: 'Prueba de anchos de columna',
    sheets: [{
      name: 'Anchos',
      columns: [
        { header: 'Concepto', type: 'text' },
        { header: 'Monto', type: 'currency' },
        { header: 'Fecha', type: 'date' },
        { header: 'Avance', type: 'percent' },
        { header: 'Cantidad', type: 'number', width: 25 },
        { header: 'Fijo', type: 'text', width: 9 },
        { header: 'Micro', type: 'currency' },
        { header: 'Corto', type: 'number' }
      ],
      rows: [
        ['Uno', 1000000, '2026-10-01', 0.3167, 123456789, 'OK', 1, 5],
        ['Dos', 2600000, '2026-10-02', 0.5, 2, 'OK', 1, 5],
        ['Tres', 1000000000, '2026-10-03', 0.99, 3, 'OK', 1, 5],
        ['Total', { formula: 'SUM(B2:B4)' }, null, { formula: 'AVERAGE(D2:D4)' }, { formula: 'SUM(E2:E4)' }, null, null, null]
      ]
    }]
  };
  const buffer = renderXlsx(widthsSpec, { now: new Date('2026-10-28T15:00:00Z') });
  sample('anchos.xlsx', buffer);
  const archive = readZip(buffer);
  checkAllParts(archive, 'XLSX-ANCHOS');
  const sheet = zipEntry(archive, 'xl/worksheets/sheet1.xml');
  const styles = zipEntry(archive, 'xl/styles.xml');
  includes(sheet, '<f>SUM(B2:B4)</f><v>1003600000</v>', 'Falta el total con caché en la hoja de anchos');
  includes(styles, '#,##0.00', 'El formato de moneda debe llevar separador de miles y 2 decimales');
  assert(!sheet.includes('####'), 'El XML no debe contener marcas de desbordamiento');
  const widths = {};
  for (const column of tagAttributes(sheet, 'col')) widths[Number(column.min)] = Number(column.width);
  assertEqual(Object.keys(widths).length, 8, 'Número de columnas con ancho');
  const currencyText = (value) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(value);
  const requiredWidth = (text) => Math.ceil((text.length * 11) / 10 + 2);
  const cases = [
    { column: 1, label: 'texto', text: 'Concepto', minimum: 12 },
    { column: 2, label: 'moneda', text: currencyText(1003600000), minimum: 16 },
    { column: 3, label: 'fecha', text: '03/10/2026', minimum: 12 },
    { column: 4, label: 'porcentaje', text: '99.00%', minimum: 10 },
    { column: 7, label: 'moneda corta', text: currencyText(1), minimum: 16 },
    { column: 8, label: 'número', text: '5', minimum: 10 }
  ];
  for (const item of cases) {
    const width = widths[item.column];
    assert(Number.isFinite(width), `Falta el ancho de la columna ${item.column}`);
    assert(width >= item.minimum, `Ancho ${width} menor que el mínimo ${item.minimum} para ${item.label}`);
    assert(width >= requiredWidth(item.text), `Ancho ${width} insuficiente para "${item.text}" (${item.label}): se necesitan ${requiredWidth(item.text)}`);
  }
  assertEqual(widths[5], 25, 'El width explícito 25 de la columna Cantidad debe respetarse');
  assertEqual(widths[6], 9, 'El width explícito 9 de la columna Fijo debe respetarse aunque sea menor que el mínimo de texto');
  assert(widths[2] >= requiredWidth(currencyText(1000000000)), 'La moneda de 1e9 debe caber en su columna');
  return `anchos=${JSON.stringify(widths)}`;
});

/* ------------------------------------------------------------------ */
/* 5. PPTX                                                             */
/* ------------------------------------------------------------------ */

section('5. PPTX');

const pptxSpec = {
  title: 'Agenda Copilot P95 — Revisión de producto',
  subtitle: 'Comité de producto · 28 de octubre de 2026',
  date: '2026-10-28',
  author: 'Ana Torres',
  slides: [
    { title: 'Contexto', bullets: ['Migrar la demo a una app usable', { text: 'Cerrar bloqueantes P0', level: 1 }, 'Medir el índice P95'], notes: 'Recordar mencionar el alcance del piloto.' },
    { title: 'Métricas clave', table: { headers: ['Métrica', 'Valor', 'Meta'], rows: [['Índice P95', '92', '≥ 90'], ['Cumplimiento', '87%', '≥ 85%'], ['Latencia', '180 ms', '< 250 ms']] }, notes: 'Datos del último corte semanal.' },
    { title: 'Siguientes pasos', numbered: ['Cerrar autenticación', 'Publicar runbook', 'Verificar en local'], notes: 'Responsables en el acta.' }
  ]
};

let pptxBuffer = null;
await check('PPTX: paquete OPC válido y XML bien formado', () => {
  pptxBuffer = renderPptx(pptxSpec, { now: new Date('2026-10-28T15:00:00Z') });
  sample('presentacion.pptx', pptxBuffer);
  const archive = readZip(pptxBuffer);
  checkAllParts(archive, 'PPTX', [
    'ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml', 'ppt/slides/slide4.xml', 'ppt/notesSlides/notesSlide2.xml',
    'ppt/notesMasters/notesMaster1.xml'
  ]);
  return `${pptxBuffer.length} bytes, ${archive.entries.length} partes`;
});

await check('PPTX: portada + 3 diapositivas, 16:9 y numeración', () => {
  const archive = readZip(pptxBuffer);
  const presentation = zipEntry(archive, 'ppt/presentation.xml');
  assertEqual(countMatches(presentation, /<p:sldId /g), 4, 'Número de diapositivas');
  includes(presentation, 'cx="12192000" cy="6858000"');
  includes(zipEntry(archive, 'ppt/slides/slide1.xml'), 'type="title"', 'La portada debe ser un título');
  includes(zipEntry(archive, 'ppt/slides/slide2.xml'), 'type="slidenum"', 'Falta numeración');
  return '4 diapositivas 16:9';
});

await check('PPTX: tabla, notas del orador y patrón de notas', () => {
  const archive = readZip(pptxBuffer);
  includes(zipEntry(archive, 'ppt/slides/slide3.xml'), '<a:tbl>');
  includes(zipEntry(archive, 'ppt/slides/slide3.xml'), 'Índice P95');
  includes(zipEntry(archive, 'ppt/notesSlides/notesSlide2.xml'), 'Recordar mencionar el alcance del piloto.');
  includes(zipEntry(archive, 'ppt/notesSlides/notesSlide3.xml'), 'Datos del último corte semanal.');
  includes(zipEntry(archive, 'ppt/notesSlides/notesSlide4.xml'), 'Responsables en el acta.');
  includes(zipEntry(archive, 'ppt/notesMasters/notesMaster1.xml'), 'type="sldImg"');
  return 'tabla + 4 notas';
});

await check('PPTX: portada antepuesta automáticamente si el payload no la trae', () => {
  const buffer = renderPptx({
    title: 'Sin portada explícita',
    slides: [{ title: 'Única', bullets: ['Punto'] }]
  }, { now: new Date('2026-10-28T15:00:00Z') });
  const archive = readZip(buffer);
  checkAllParts(archive, 'PPTX-AUTO');
  const presentation = zipEntry(archive, 'ppt/presentation.xml');
  assertEqual(countMatches(presentation, /<p:sldId /g), 2, 'Debería haber portada + 1 diapositiva');
  return 'portada + 1';
});

/* ------------------------------------------------------------------ */
/* 6. Almacén                                                          */
/* ------------------------------------------------------------------ */

section('6. Almacén DATA_DIR/docs');

const storedIds = [];
await check('Crear/listar/leer/borrar documentos en DATA_DIR temporal', async () => {
  const created = await createDocument({
    type: 'docx',
    title: 'Documento de almacén',
    sections: [{ paragraph: 'Contenido almacenado.' }]
  });
  storedIds.push(created.id);
  assert(getDocument(created.id), 'getDocument no encuentra el documento');
  const { item, buffer } = readDocument(created.id);
  assertEqual(item.id, created.id, 'Id leído');
  assert(buffer.length > 0, 'El buffer está vacío');
  const list = listDocuments({ q: 'almacén' });
  assert(list.items.some((document) => document.id === created.id), 'El documento no aparece en la lista');
  const removed = await deleteDocument(created.id);
  assertEqual(removed.removed, true, 'No se eliminó');
  assertEqual(removed.removedFile, true, 'El archivo físico no se eliminó');
  assertEqual(getDocument(created.id), null, 'El documento sigue tras borrar');
  let failure = null;
  try { readDocument(created.id); } catch (error) { failure = error; }
  assert(failure && failure.code === 'DOC_NOT_FOUND', 'Leer un documento borrado debe dar 404');
  return `stats=${JSON.stringify(documentStats().byType)}`;
});

/* ------------------------------------------------------------------ */
/* 7. API HTTP real                                                    */
/* ------------------------------------------------------------------ */

section('7. API HTTP (createApp + router)');

const { createApp } = await import('../http/app.mjs');
const app = await createApp();
const server = http.createServer((req, res) => {
  Promise.resolve(app.handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error.message, code: 'INTERNAL' }));
    } else {
      res.end();
    }
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const PORT = server.address().port;
assert(PORT >= 3124, `El puerto efímero ${PORT} debería ser ≥ 3124`);

function request({ method = 'GET', path: requestPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: requestPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('timeout HTTP')));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(response) {
  try { return JSON.parse(response.raw.toString('utf8')); } catch { return null; }
}

const apiIds = [];
try {
  await check('POST /api/docs rechaza type inválido y fecha imposible', async () => {
    const badType = await request({ method: 'POST', path: '/api/docs', body: { type: 'pdf', title: 'X' } });
    assertEqual(badType.status, 400, 'type inválido');
    const badTypeJson = parseJson(badType);
    assertEqual(badTypeJson.code, 'VALIDATION', 'Código de type inválido');
    assertEqual(badTypeJson.field, 'type', 'Campo de type inválido');
    const badDate = await request({ method: 'POST', path: '/api/docs', body: { type: 'docx', title: 'X', date: '2026-02-31', sections: [{ paragraph: 'x' }] } });
    assertEqual(badDate.status, 400, 'fecha inválida');
    const badDateJson = parseJson(badDate);
    assertEqual(badDateJson.code, 'INVALID_DATE', 'Código de fecha inválida');
    assertEqual(badDateJson.field, 'date', 'Campo de fecha inválida');
    return '400 VALIDATION + 400 INVALID_DATE';
  });

  await check('POST/GET/download/HEAD/DELETE de DOCX por HTTP', async () => {
    const created = await request({
      method: 'POST',
      path: '/api/docs',
      body: {
        type: 'docx',
        title: 'Acta HTTP',
        date: '2026-10-28',
        sections: [{ heading: 'Sección', level: 1 }, { paragraph: 'Cuerpo del documento.' }, { table: { headers: ['A'], rows: [['1']] } }],
        annex: { title: 'Anexo privado', paragraphs: ['Privado'] }
      }
    });
    assertEqual(created.status, 201, 'Estado de creación');
    const payload = parseJson(created);
    assert(payload.id && /^DOC-/.test(payload.id), 'Falta id');
    assertEqual(payload.type, 'docx', 'Tipo de respuesta');
    assert(payload.filename.endsWith('.docx'), 'Nombre de archivo');
    assert(payload.filename.includes('acta-http'), 'El nombre debe derivar del título');
    assert(payload.bytes > 0 && payload.createdAt, 'bytes/createdAt');
    assert(payload.downloadUrl === `/api/docs/${payload.id}/download`, 'downloadUrl');
    apiIds.push(payload.id);

    const list = await request({ path: '/api/docs?type=docx' });
    assertEqual(list.status, 200, 'Estado de lista');
    const listJson = parseJson(list);
    assert(listJson.items.some((item) => item.id === payload.id), 'No aparece en GET /api/docs');
    assert(listJson.stats, 'Falta stats');

    const download = await request({ path: `/api/docs/${payload.id}/download` });
    assertEqual(download.status, 200, 'Estado de descarga');
    assertEqual(download.headers['content-type'], DOC_TYPES.docx.mime, 'Content-Type de descarga');
    includes(String(download.headers['content-disposition'] || ''), 'attachment', 'Disposition');
    includes(String(download.headers['content-disposition'] || ''), payload.filename, 'Nombre en disposition');
    assertEqual(download.raw.length, payload.bytes, 'Bytes descargados');
    assertEqual(download.raw.slice(0, 2).toString('latin1'), 'PK', 'Firma ZIP');
    checkAllParts(readZip(download.raw), 'HTTP-DOCX');

    const head = await request({ method: 'HEAD', path: `/api/docs/${payload.id}/download` });
    assertEqual(head.status, 200, 'Estado HEAD');
    assertEqual(Number(head.headers['content-length']), payload.bytes, 'Content-Length HEAD');
    assertEqual(head.raw.length, 0, 'HEAD no debe tener cuerpo');

    const metadata = await request({ path: `/api/docs/${payload.id}` });
    assertEqual(metadata.status, 200, 'Estado metadatos');
    assertEqual(parseJson(metadata).item.id, payload.id, 'Metadatos');

    const removed = await request({ method: 'DELETE', path: `/api/docs/${payload.id}` });
    assertEqual(removed.status, 200, 'Estado de borrado');
    assertEqual(parseJson(removed).removed, true, 'Resultado de borrado');
    assertEqual(parseJson(removed).removedFile, true, 'Archivo físico tras borrado');
    const after = await request({ path: `/api/docs/${payload.id}/download` });
    assertEqual(after.status, 404, 'Descarga tras borrar');
    assertEqual(parseJson(after).code, 'DOC_NOT_FOUND', 'Código tras borrar');
    apiIds.pop();
    return `${payload.filename} (${payload.bytes} bytes)`;
  });

  await check('POST/GET/download de XLSX y PPTX por HTTP', async () => {
    const xlsx = await request({
      method: 'POST',
      path: '/api/docs',
      body: {
        type: 'xlsx',
        title: 'Reporte HTTP',
        sheets: [
          {
            name: 'Datos',
            columns: ['Concepto', { header: 'Valor', type: 'currency' }],
            rows: [['A', 1000000], ['B', 2600000], ['C', 1000000000], ['Total', { formula: 'SUM(B2:B4)' }]]
          },
          { name: 'Otra', columns: ['X'], rows: [['Y']] }
        ]
      }
    });
    assertEqual(xlsx.status, 201, 'Estado XLSX');
    const xlsxJson = parseJson(xlsx);
    assert(xlsxJson.filename.endsWith('.xlsx'), 'Extensión XLSX');
    apiIds.push(xlsxJson.id);
    const xlsxDownload = await request({ path: `/api/docs/${xlsxJson.id}/download` });
    assertEqual(xlsxDownload.status, 200, 'Descarga XLSX');
    assertEqual(xlsxDownload.headers['content-type'], DOC_TYPES.xlsx.mime, 'MIME XLSX');
    const httpArchive = readZip(xlsxDownload.raw);
    checkAllParts(httpArchive, 'HTTP-XLSX');
    const httpSheet = zipEntry(httpArchive, 'xl/worksheets/sheet1.xml');
    assert(!httpSheet.includes('####'), 'La descarga HTTP no debe contener marcas de desbordamiento');
    const httpCurrencyColumn = tagAttributes(httpSheet, 'col').find((column) => Number(column.min) === 2);
    assert(httpCurrencyColumn && Number(httpCurrencyColumn.width) >= 21, 'La columna currency descargada debe medir al menos 21');
    sample('http-reporte.xlsx', xlsxDownload.raw);

    const pptx = await request({
      method: 'POST',
      path: '/api/docs',
      body: {
        type: 'pptx',
        title: 'Presentación HTTP',
        slides: [
          { layout: 'cover', title: 'Portada HTTP', subtitle: 'Sub' },
          { title: 'Contenido', bullets: ['Uno', 'Dos'], notes: 'Nota HTTP' }
        ]
      }
    });
    assertEqual(pptx.status, 201, 'Estado PPTX');
    const pptxJson = parseJson(pptx);
    assert(pptxJson.filename.endsWith('.pptx'), 'Extensión PPTX');
    apiIds.push(pptxJson.id);
    const pptxDownload = await request({ path: `/api/docs/${pptxJson.id}/download` });
    assertEqual(pptxDownload.status, 200, 'Descarga PPTX');
    assertEqual(pptxDownload.headers['content-type'], DOC_TYPES.pptx.mime, 'MIME PPTX');
    checkAllParts(readZip(pptxDownload.raw), 'HTTP-PPTX');
    return '2/2 formatos';
  });

  await check('POST /api/docs con plantilla «acta» por HTTP (4 líneas + anexo)', async () => {
    const response = await request({
      method: 'POST',
      path: '/api/docs',
      body: {
        type: 'docx',
        template: 'ACTA',
        title: 'Acta HTTP de plantilla',
        date: '2026-10-28',
        attendees: ['Ana Torres', 'Luis Pérez'],
        agenda: ['Aprobar el orden del día', 'Compromisos'],
        agreements: [{ text: 'Publicar el runbook', owner: 'Luis', due: '2026-10-31' }],
        summary: ['Resumen uno.', 'Resumen dos.', 'Resumen tres.', 'Resumen cuatro.']
      }
    });
    assertEqual(response.status, 201, 'Estado del acta por HTTP');
    const payload = parseJson(response);
    assert(payload.id && payload.filename.endsWith('.docx'), 'Acta sin id/extensión');
    apiIds.push(payload.id);
    const download = await request({ path: `/api/docs/${payload.id}/download` });
    assertEqual(download.status, 200, 'Descarga del acta');
    const archive = readZip(download.raw);
    checkAllParts(archive, 'HTTP-ACTA');
    const documentXml = zipEntry(archive, 'word/document.xml');
    includes(documentXml, '6. Resumen ejecutivo');
    includes(documentXml, 'Anexo privado');
    includes(documentXml, 'Resumen cuatro.');
    const summaryXml = documentXml.slice(documentXml.indexOf('6. Resumen ejecutivo'), documentXml.indexOf('7. Firma'));
    assertEqual(countMatches(summaryXml, /<w:numPr>/g), 4, 'El acta HTTP debe tener 4 líneas de resumen');
    return payload.filename;
  });

  await check('register:false devuelve base64 sin guardar en el índice', async () => {
    const before = parseJson(await request({ path: '/api/docs' })).total;
    const response = await request({
      method: 'POST',
      path: '/api/docs',
      body: { type: 'docx', title: 'Inline', register: false, sections: [{ paragraph: 'Sin guardar.' }] }
    });
    assertEqual(response.status, 200, 'Estado inline');
    const payload = parseJson(response);
    assertEqual(payload.registered, false, 'registered=false');
    assertEqual(payload.id, undefined, 'No debe tener id');
    assert(payload.base64 && payload.base64.length > 100, 'Falta base64');
    const zip = Buffer.from(payload.base64, 'base64');
    assertEqual(zip.slice(0, 2).toString('latin1'), 'PK', 'Base64 no es un ZIP');
    checkAllParts(readZip(zip), 'INLINE-DOCX');
    const after = parseJson(await request({ path: '/api/docs' })).total;
    assertEqual(after, before, 'El registro inline no debe cambiar el índice');
    return `${payload.bytes} bytes`;
  });

  await check('Plantillas: crear, listar, aplicar, borrar y proteger «acta»', async () => {
    const created = await request({
      method: 'POST',
      path: '/api/docs/templates',
      body: { name: 'Acta Marca', type: 'docx', brand: { font: 'Georgia', color: '#8B0000', logoText: 'Marca HTTP' } }
    });
    assertEqual(created.status, 201, 'Estado de creación de plantilla');
    assertEqual(parseJson(created).item.name, 'acta-marca', 'Nombre normalizado');
    const list = await request({ path: '/api/docs/templates' });
    const names = parseJson(list).items.map((item) => item.name);
    assert(names.includes('acta') && names.includes('acta-marca'), 'Faltan plantillas en la lista');
    const generated = await request({
      method: 'POST',
      path: '/api/docs',
      body: { type: 'docx', template: 'acta-marca', title: 'Documento con plantilla', sections: [{ paragraph: 'Marca.' }] }
    });
    assertEqual(generated.status, 201, 'Estado de generación con plantilla');
    const generatedJson = parseJson(generated);
    apiIds.push(generatedJson.id);
    const download = await request({ path: `/api/docs/${generatedJson.id}/download` });
    const archive = readZip(download.raw);
    includes(zipEntry(archive, 'word/styles.xml'), 'Georgia');
    includes(zipEntry(archive, 'word/header1.xml'), 'Marca HTTP');
    const removed = await request({ method: 'DELETE', path: '/api/docs/templates/acta-marca' });
    assertEqual(removed.status, 200, 'Estado de borrado de plantilla');
    const reserved = await request({ method: 'DELETE', path: '/api/docs/templates/acta' });
    assertEqual(reserved.status, 409, 'La plantilla acta debe estar protegida');
    assertEqual(parseJson(reserved).code, 'TEMPLATE_RESERVED', 'Código de plantilla reservada');
    const missing = await request({
      method: 'POST',
      path: '/api/docs',
      body: { type: 'docx', template: 'no-existe', title: 'X', sections: [{ paragraph: 'x' }] }
    });
    assertEqual(missing.status, 404, 'Plantilla inexistente');
    assertEqual(parseJson(missing).code, 'TEMPLATE_NOT_FOUND', 'Código de plantilla inexistente');
    return 'CRUD + protección';
  });

  await check('Correo sin Gmail conectado → 503 EMAIL_NOT_CONFIGURED y documento intacto', async () => {
    const target = apiIds[0];
    assert(target, 'No hay documento para probar el correo');
    const response = await request({
      method: 'POST',
      path: `/api/docs/${target}/send-email`,
      body: { to: ['destino@example.com'], subject: 'Documento adjunto', body: 'Adjunto el documento.' }
    });
    assertEqual(response.status, 503, 'Estado de correo sin configurar');
    assertEqual(parseJson(response).code, 'EMAIL_NOT_CONFIGURED', 'Código de correo sin configurar');
    const download = await request({ path: `/api/docs/${target}/download` });
    assertEqual(download.status, 200, 'El documento debe seguir descargable');
    return '503 y archivo intacto';
  });

  await check('La app no se cae con una ruta de documento inválida', async () => {
    const missing = await request({ path: '/api/docs/DOC-00000000-deadbeef/download' });
    assertEqual(missing.status, 404, 'Documento inexistente');
    const health = await request({ path: '/api/health' });
    assertEqual(health.status, 200, 'La app debe seguir viva');
    return '404 + health 200';
  });
} finally {
  const cleanupIds = [...new Set(apiIds)];
  for (const id of cleanupIds) {
    try { await request({ method: 'DELETE', path: `/api/docs/${id}` }); } catch { /* ignore */ }
  }
  await new Promise((resolve) => server.close(resolve));
}

/* ------------------------------------------------------------------ */
/* 8. Correo (MIME)                                                    */
/* ------------------------------------------------------------------ */

section('8. Correo MIME');

await check('MIME multipart con adjunto base64 y asunto UTF-8', () => {
  const attachmentBytes = Buffer.from('Contenido binario de prueba \u{1F4C4}', 'utf8');
  const mime = buildMimeMessage({
    to: ['uno@example.com', 'dos@example.com'],
    subject: 'Informe de octubre — ñandú',
    body: 'Hola,\nAdjunto el informe.\nSaludos.',
    from: 'origen@example.com',
    date: new Date('2026-10-28T15:00:00Z'),
    attachment: { filename: 'informe-2026-10-28.docx', mimeType: DOC_TYPES.docx.mime, data: attachmentBytes }
  });
  includes(mime, 'multipart/mixed');
  includes(mime, 'To: uno@example.com, dos@example.com');
  includes(mime, '=?UTF-8?B?');
  includes(mime, 'filename="informe-2026-10-28.docx"');
  includes(mime, 'filename*=UTF-8\'\'informe-2026-10-28.docx');
  const boundary = /boundary="([^"]+)"/.exec(mime)?.[1];
  assert(boundary, 'Falta boundary');
  const parts = mime.split(`--${boundary}`);
  assert(parts.length >= 3, 'Faltan partes MIME');
  const attachmentPart = parts[2] || '';
  const base64 = attachmentPart.split('\r\n\r\n')[1]?.replace(/--\s*$/, '').replace(/\s+/g, '') || '';
  assert(Buffer.from(base64, 'base64').equals(attachmentBytes), 'El adjunto base64 no coincide');
  return `${mime.length} caracteres`;
});

await check('sendDocumentEmail sin Gmail → EMAIL_NOT_CONFIGURED (nunca sent:true)', async () => {
  let error = null;
  try {
    await sendDocumentEmail({
      document: { id: 'DOC-20261028-00000000', filename: 'x.docx', mimeType: DOC_TYPES.docx.mime, buffer: Buffer.from('x') },
      to: ['destino@example.com'],
      subject: 'Prueba',
      body: 'Cuerpo'
    });
  } catch (caught) {
    error = caught;
  }
  assert(error, 'Debe lanzar error sin Gmail');
  assertEqual(error.status, 503, 'Estado de error');
  assertEqual(error.code, 'EMAIL_NOT_CONFIGURED', 'Código de error');
  return '503 EMAIL_NOT_CONFIGURED';
});

/* ------------------------------------------------------------------ */
/* 9. Office / verificación manual                                     */
/* ------------------------------------------------------------------ */

section('9. Verificación con Office (informativa)');

const officeCandidates = [
  ['Word', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'],
  ['Excel', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE'],
  ['PowerPoint', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE']
];
const officeFound = officeCandidates.filter(([, file]) => fs.existsSync(file)).map(([name]) => name);
console.log(officeFound.length
  ? `INFO  Office detectado: ${officeFound.join(', ')}. Verificación manual en docs/DOCUMENTOS.md §«Abrir y validar».`
  : 'INFO  No se detecta Microsoft Office. La validación XML/paquete de este selfcheck es la vía automática.');

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

const passed = results.filter((result) => result.ok).length;
const failed = results.filter((result) => !result.ok);
console.log(`\nRESULT: ${failed.length ? 'FAIL' : 'PASS'} (${passed}/${results.length} comprobaciones)`);
if (failed.length) {
  for (const result of failed) console.log(`  · [${result.section}] ${result.name}: ${result.error}`);
}
console.log(`DATA_DIR temporal: ${TEMP_DIR}`);
if (KEEP) {
  console.log(`Muestras conservadas en: ${SAMPLES_DIR}`);
} else {
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exitCode = failed.length ? 1 : 0;

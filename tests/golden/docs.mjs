/** Categoría B: documentos (10 casos). */
import { prepare, runCategory, assert, equal } from './harness.mjs';

prepare('golden-docs-');
const docs = await import(new URL('../../lib/docs/index.mjs', import.meta.url));
const { readZip, entryText } = await import(new URL('../../lib/docs/zip.mjs', import.meta.url));
const { checkXml } = await import(new URL('../../lib/docs/xmlcheck.mjs', import.meta.url));

const DOCX = {
  type: 'docx', title: 'Golden DOCX',
  sections: [
    { heading: 'Contexto', paragraphs: ['Párrafo de prueba del set dorado.'], bullets: ['Uno', 'Dos'] },
    { heading: 'Tabla', table: { headers: ['Concepto', 'Valor'], rows: [['A', '1'], ['B', '2']] } }
  ]
};
const XLSX = {
  type: 'xlsx', title: 'Golden XLSX',
  sheets: [{
    name: 'Resumen',
    columns: [{ header: 'Concepto', type: 'text', width: 30 }, { header: 'Monto', type: 'currency' }, { header: 'Avance', type: 'percent' }],
    rows: [['Ingresos', 1000, 0.5], ['Costos', 400, 0.2], ['Total con un texto largo para probar anchos automáticos', 600, 0.8]]
  }]
};
const PPTX = {
  type: 'pptx', title: 'Golden PPTX',
  slides: [
    { layout: 'cover', title: 'Portada golden', subtitle: 'Set dorado' },
    { layout: 'content', title: 'Puntos', bullets: ['Uno', 'Dos'] },
    { layout: 'table', title: 'Tabla', table: { headers: ['A', 'B'], rows: [['1', '2']] } }
  ]
};

const created = {};
const cases = [
  {
    id: 'DOC-01', name: 'DOCX registrado con id y extensión',
    run: async () => {
      created.docx = await docs.createDocument(DOCX);
      assert(created.docx.id, 'sin id');
      assert(/\.docx$/.test(created.docx.filename), created.docx.filename);
      assert(created.docx.bytes > 1000, `bytes=${created.docx.bytes}`);
    }
  },
  {
    id: 'DOC-02', name: 'DOCX es ZIP con word/document.xml',
    run: async () => {
      const archive = readZip(docs.readDocument(created.docx.id).buffer);
      entryText(archive, '[Content_Types].xml');
      const xml = entryText(archive, 'word/document.xml');
      assert(xml.includes('<w:document'), 'sin w:document');
      assert(xml.includes('Golden DOCX'), 'sin título');
    }
  },
  {
    id: 'DOC-03', name: 'XML del DOCX bien formado',
    run: async () => {
      const archive = readZip(docs.readDocument(created.docx.id).buffer);
      const result = checkXml(entryText(archive, 'word/document.xml'), { name: 'document.xml', requireRoot: true });
      equal(result.ok, true, `xml errors=${JSON.stringify(result.errors || []).slice(0, 200)}`);
    }
  },
  {
    id: 'DOC-04', name: 'XLSX registrado con workbook y hoja',
    run: async () => {
      created.xlsx = await docs.createDocument(XLSX);
      assert(/\.xlsx$/.test(created.xlsx.filename), created.xlsx.filename);
      const archive = readZip(docs.readDocument(created.xlsx.id).buffer);
      entryText(archive, 'xl/workbook.xml');
      assert(archive.entries.some((entry) => entry.name.startsWith('xl/worksheets/sheet')), 'sin hoja');
    }
  },
  {
    id: 'DOC-05', name: 'XLSX con estilos de moneda/porcentaje',
    run: async () => {
      const archive = readZip(docs.readDocument(created.xlsx.id).buffer);
      const styles = entryText(archive, 'xl/styles.xml');
      assert(styles.includes('numFmt'), 'sin numFmt');
      const sheet = archive.entries.find((entry) => entry.name.startsWith('xl/worksheets/sheet'));
      const sheetXml = entryText(archive, sheet.name);
      const shared = archive.map['xl/sharedStrings.xml'] ? entryText(archive, 'xl/sharedStrings.xml') : '';
      assert(sheetXml.includes('Ingresos') || shared.includes('Ingresos'), 'sin datos');
    }
  },
  {
    id: 'DOC-06', name: 'XLSX con anchos de columna',
    run: async () => {
      const archive = readZip(docs.readDocument(created.xlsx.id).buffer);
      const sheet = archive.entries.find((entry) => entry.name.startsWith('xl/worksheets/sheet'));
      const sheetXml = entryText(archive, sheet.name);
      assert(/<col[^>]*width="/.test(sheetXml), 'sin atributo width en <col>');
    }
  },
  {
    id: 'DOC-07', name: 'PPTX registrado con presentation.xml',
    run: async () => {
      created.pptx = await docs.createDocument(PPTX);
      assert(/\.pptx$/.test(created.pptx.filename), created.pptx.filename);
      const archive = readZip(docs.readDocument(created.pptx.id).buffer);
      entryText(archive, 'ppt/presentation.xml');
      const slides = archive.entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
      equal(slides.length, 3, 'nº slides');
    }
  },
  {
    id: 'DOC-08', name: 'PPTX con contenido de portada y viñetas',
    run: async () => {
      const archive = readZip(docs.readDocument(created.pptx.id).buffer);
      const texts = archive.entries
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
        .map((entry) => entryText(archive, entry.name))
        .join('\n');
      assert(texts.includes('Portada golden') && texts.includes('Puntos'), 'sin textos de slides');
    }
  },
  {
    id: 'DOC-09', name: 'readDocument/listDocuments/downloadPath coherentes',
    run: async () => {
      const read = docs.readDocument(created.docx.id);
      assert(Buffer.isBuffer(read.buffer) && read.buffer.length > 1000, 'buffer inválido');
      assert(docs.listDocuments().items.some((item) => item.id === created.docx.id), 'no listado');
      equal(docs.documentDownloadPath(created.docx.id), `/api/docs/${created.docx.id}/download`, 'download path');
    }
  },
  {
    id: 'DOC-10', name: 'deleteDocument elimina y deja de existir',
    run: async () => {
      const target = created.pptx.id;
      await docs.deleteDocument(target);
      assert(!docs.getDocument(target), 'sigue existiendo');
      assert(!docs.listDocuments().items.some((item) => item.id === target), 'sigue listado');
    }
  }
];

await runCategory('docs', cases);


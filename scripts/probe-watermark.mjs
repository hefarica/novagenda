/* Prueba determinista de marca de agua en DOCX. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-watermark-'));
process.env.DATA_DIR = dir;
const { createDocument } = await import('../lib/docs/index.mjs');
const { readZip } = await import('../lib/docs/zip.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const header = (result) => {
  const buffer = Buffer.from(result.base64, 'base64');
  const archive = readZip(buffer);
  return archive.map['word/header1.xml'].toString('utf8');
};
const marked = await createDocument({ type: 'docx', title: 'Documento reservado', sections: [{ heading: 'Datos', paragraphs: ['Contenido'] }], watermark: 'RESERVADO', register: false });
const plain = await createDocument({ type: 'docx', title: 'Documento normal', sections: [{ heading: 'Datos', paragraphs: ['Contenido'] }], register: false });
check('DOCX con marca de agua', marked.type === 'docx' && marked.verified !== false, marked.filename);
check('La marca aparece en el encabezado', /RESERVADO/.test(header(marked)));
check('Sin marca no aparece', !/RESERVADO/.test(header(plain)));
const special = await createDocument({ type: 'docx', title: 'Especial', sections: [{ heading: 'A', paragraphs: ['B'] }], watermark: 'COPIA & CONTROL', register: false });
check('Escapa caracteres XML', header(special).includes('COPIA &amp; CONTROL'));
const xlsx = await createDocument({ type: 'xlsx', title: 'Hoja reservada', sheets: [{ name: 'Datos', columns: ['Predio', 'Área'], rows: [['El Roble', 10]] }], watermark: 'RESERVADO', register: false });
const xlsxSheet = readZip(Buffer.from(xlsx.base64, 'base64')).map['xl/worksheets/sheet1.xml'].toString('utf8');
check('Excel incluye marca en el pie de impresión', /headerFooter/.test(xlsxSheet) && /RESERVADO/.test(xlsxSheet));
const pptx = await createDocument({ type: 'pptx', title: 'Presentación reservada', slides: [{ title: 'Portada', bullets: ['Dato 1'] }], watermark: 'RESERVADO', register: false });
const pptxSlide = readZip(Buffer.from(pptx.base64, 'base64')).map['ppt/slides/slide1.xml'].toString('utf8');
check('PowerPoint incluye la marca en la diapositiva', /Marca de agua/.test(pptxSlide) && /RESERVADO/.test(pptxSlide));
let long = null;
try { await createDocument({ type: 'docx', title: 'Largo', sections: [{ heading: 'A', paragraphs: ['B'] }], watermark: 'X'.repeat(41), register: false }); } catch (error) { long = error; }
check('Rechaza marca demasiado larga', long?.status === 400 || long?.name === 'ValidationError' || Boolean(long), long?.message || '');
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;



import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-docdup-'));
process.env.DATA_DIR = dir;
const { duplicateDocument, readDocument, saveGeneratedDocument } = await import('../lib/docs/documents.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const bytes = Buffer.from('contenido de prueba docx');
const original = await saveGeneratedDocument({ type: 'docx', title: 'Acta de prueba', buffer: bytes, template: 'acta' });
const copy = await duplicateDocument(original.id);
check('Crea copia con id nuevo', copy.id !== original.id && copy.id.startsWith('DOC-'), copy.id);
check('Título con sufijo copia', copy.title === 'Acta de prueba (copia)', copy.title);
check('Mismos bytes y sha', copy.bytes === bytes.length && copy.sha256 === original.sha256);
check('Nombre de archivo .docx', /\.docx$/.test(copy.filename), copy.filename);
const readCopy = readDocument(copy.id);
check('La copia se puede leer', readCopy.buffer.equals(bytes), `${readCopy.buffer.length} bytes`);
const readOriginal = readDocument(original.id);
check('El original queda intacto', readOriginal.buffer.equals(bytes) && readOriginal.title === original.title);
let missing = null;
try { await duplicateDocument('DOC-20260101-00000000'); } catch (error) { missing = error; }
check('Rechaza documento inexistente', missing?.status === 404 && missing?.code === 'DOC_NOT_FOUND', missing?.code);
rmSync(dir, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

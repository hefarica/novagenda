import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-doczip-'));
process.env.DATA_DIR = dir;
const { documentsArchive, saveGeneratedDocument } = await import('../lib/docs/documents.mjs');
const { readZip } = await import('../lib/docs/zip.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const one = await saveGeneratedDocument({ type: 'docx', title: 'Acta de prueba', buffer: Buffer.from('contenido uno') });
const two = await saveGeneratedDocument({ type: 'docx', title: 'Acta de prueba', buffer: Buffer.from('contenido dos') });
const archive = documentsArchive();
check('Empaqueta todos los documentos', archive.count === 2 && archive.buffer.length > 0, `${archive.count} entradas, ${archive.buffer.length} bytes`);
check('Nombre de archivo .zip', /^documentos-\d{4}-\d{2}-\d{2}\.zip$/.test(archive.filename), archive.filename);
const parsed = readZip(archive.buffer);
check('ZIP válido y legible', parsed.entries.length === 2, `${parsed.entries.length}`);
check('Entradas bajo documentos/', parsed.entries.every((entry) => entry.name.startsWith('documentos/') && /\.docx$/.test(entry.name)), parsed.entries.map((entry) => entry.name).join(' | '));
const contents = parsed.entries.map((entry) => entry.data.toString()).sort();
check('Conserva el contenido de cada archivo', contents[0] === 'contenido dos' && contents[1] === 'contenido uno', contents.join(' | '));
const names = parsed.entries.map((entry) => entry.name.toLowerCase());
check('Nombres únicos', new Set(names).size === names.length, names.join(' | '));
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

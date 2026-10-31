/* Prueba determinista de historial de versiones de documentos. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-docver-'));
process.env.DATA_DIR = dir;
const { createDocument } = await import('../lib/docs/index.mjs');
const { documentVersions, deleteDocument } = await import('../lib/docs/documents.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const one = await createDocument({ type: 'docx', title: 'Acta de prueba', sections: [{ heading: 'A', paragraphs: ['Uno'] }] });
const two = await createDocument({ type: 'docx', title: 'Acta de prueba', sections: [{ heading: 'A', paragraphs: ['Dos'] }] });
const other = await createDocument({ type: 'docx', title: 'Otro documento', sections: [{ heading: 'B', paragraphs: ['Tres'] }] });
const versions = documentVersions(two.id);
check('Agrupa mismo título', versions.count === 2 && versions.items.every((item) => item.title === 'Acta de prueba'), `${versions.count}`);
check('Ordena del más nuevo', versions.items[0].id === two.id && versions.items[1].id === one.id);
check('No mezcla otro título', !versions.items.some((item) => item.id === other.id));
const otherVersions = documentVersions(other.id);
check('Otro título tiene una versión', otherVersions.count === 1 && otherVersions.items[0].id === other.id);
await deleteDocument(two.id);
const after = documentVersions(one.id);
check('Refleja borrado', after.count === 1 && after.items[0].id === one.id);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

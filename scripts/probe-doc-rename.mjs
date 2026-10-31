import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agenda-docrename-'));
process.env.DATA_DIR = dir;
const { documentVersions, duplicateDocument, getDocument, renameDocument, saveGeneratedDocument } = await import('../lib/docs/documents.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const buffer = Buffer.from('acta docx');
const first = await saveGeneratedDocument({ type: 'docx', title: 'Acta de liberación', buffer });
const second = await saveGeneratedDocument({ type: 'docx', title: 'Acta de liberación', buffer });
const before = documentVersions(first.id);
check('Agrupa dos documentos por clave', before.count === 2, `${before.count}`);
const renamed = await renameDocument(first.id, 'Acta de liberación El Roble');
check('Renombra el título', renamed.title === 'Acta de liberación El Roble', renamed.title);
check('Cambia el nombre de archivo', /acta-de-liberacion-el-roble/.test(renamed.filename), renamed.filename);
const after = documentVersions(renamed.id);
check('Las versiones siguen agrupadas', after.count === 2 && after.items.some((item) => item.id === second.id), `${after.count}`);
const read = getDocument(second.id);
check('La otra versión conserva su título', read.title === 'Acta de liberación', read.title);
let empty = null;
try { await renameDocument(first.id, '   '); } catch (error) { empty = error; }
check('Rechaza título vacío', empty?.status === 400 && empty?.code === 'DOC_TITLE_REQUIRED', empty?.code);
let missing = null;
try { await renameDocument('DOC-20260101-00000000', 'Nada'); } catch (error) { missing = error; }
check('Rechaza documento inexistente', missing?.status === 404 && missing?.code === 'DOC_NOT_FOUND', missing?.code);
const copy = await duplicateDocument(second.id);
const copyVersions = documentVersions(copy.id);
check('La copia no se mezcla con las versiones', copyVersions.count === 1, `${copyVersions.count}`);
rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


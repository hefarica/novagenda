/* Prueba: la Wiki interna crea, busca, edita y borra con validación. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-wiki-'));
process.env.WORKFLOWS_AUTOSTART = '0';
process.env.CHANNELS_AUTOSTART = 'off';

const {
  createPage, deletePage, getPage, listPages, updatePage, wikiStats
} = await import('../lib/wiki/store.mjs');
const { store } = await import('../lib/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const created = await createPage({
  title: 'Acta de liberación de predio',
  body: 'Procedimiento: revisar escritura, linderos y paz y salvo antes de firmar el acta.',
  tags: 'predios, actas, Predios'
});
check('Crea una página con ID estable', created?.id === 'WK-0001' && created.title === 'Acta de liberación de predio', JSON.stringify(created).slice(0, 120));
check('Normaliza y deduplica etiquetas', JSON.stringify(created.tags) === JSON.stringify(['actas', 'predios']), JSON.stringify(created.tags));
check('Calcula palabras', created.words > 5, `words=${created.words}`);

const listed = listPages({ limit: 10 });
check('Lista sin cargar el cuerpo completo', listed.total === 1 && listed.items.length === 1 && !('body' in listed.items[0]) && !!listed.items[0].bodyPreview);
check('Busca por contenido', listPages({ q: 'linderos' }).total === 1);
check('Filtra por etiqueta', listPages({ tag: 'predios' }).total === 1 && listPages({ tag: 'clientes' }).total === 0);

const updated = await updatePage('WK-0001', {
  title: 'Acta de liberación (procedimiento)',
  body: 'Paso 1: verificar matrícula. Paso 2: revisar linderos.',
  tags: ['predios', 'procedimiento']
});
check('Actualiza título, cuerpo y etiquetas', updated.title.includes('procedimiento') && /matrícula/.test(updated.body) && updated.tags.includes('procedimiento'));
check('La lectura posterior refleja el cambio', getPage('WK-0001')?.body.includes('Paso 1'));

const second = await createPage({ title: 'Contactos de Catastro', body: 'Correo y teléfono de la oficina de catastro.', tags: ['contactos'] });
check('Segunda página usa el siguiente ID', second.id === 'WK-0002', second.id);

let emptyTitle = null;
try { await createPage({ title: '   ', body: 'x' }); } catch (error) { emptyTitle = error; }
check('Rechaza título vacío', emptyTitle?.code === 'REQUIRED' || emptyTitle?.status === 400, emptyTitle?.message);

let emptyBody = null;
try { await createPage({ title: 'Sin cuerpo', body: '  ' }); } catch (error) { emptyBody = error; }
check('Rechaza contenido vacío', emptyBody?.code === 'REQUIRED' || emptyBody?.status === 400, emptyBody?.message);

let longBody = null;
try { await createPage({ title: 'Larga', body: 'x'.repeat(50001) }); } catch (error) { longBody = error; }
check('Rechaza contenido demasiado largo', longBody?.code === 'TOO_LONG' || longBody?.status === 400, longBody?.message);

const stats = wikiStats();
check('Estadísticas coherentes', stats.pages === 2 && stats.words > 10 && stats.tags.includes('predios'), JSON.stringify(stats).slice(0, 120));

await deletePage('WK-0001');
check('Borra la página y desaparece', getPage('WK-0001') === null && listPages({}).total === 1);
check('El borrado persiste en el store', (store.get().wiki?.pages || []).every((page) => page.id !== 'WK-0001'));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

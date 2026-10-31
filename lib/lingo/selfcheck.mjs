/**
 * Autocheck de Lingo (sin servidor ni LLM).
 *
 *   node lib/lingo/selfcheck.mjs
 */
import { pathToFileURL } from 'node:url';
import {
  PROMOTION_CORRECTIONS, createOrUpdateTerm, normalizeKey, setTermStatus
} from './store.mjs';
import { applyCanonical, findTerms, hotwords, learn, suggest } from './engine.mjs';
import * as routeModule from '../routes/lingo.mjs';

const results = [];
function check(name, condition, detail = '') {
  const ok = !!condition;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fresh() {
  return { lingo: { version: 1, terms: [] } };
}

function approved(data, input) {
  const created = createOrUpdateTerm(data, input);
  setTermStatus(data, created.item.id, 'approved', { reason: 'autocheck' });
  return created.item;
}

async function main() {
  // 1) Crear, aprobar y aplicar variantes.
  const data = fresh();
  const created = createOrUpdateTerm(data, {
    term: 'Héctor Fabio Riascos C.',
    variants: ['hector fabio riascos', 'Héctor Riascos'],
    context: 'actas, predios',
    sources: ['manual']
  });
  check('término nuevo en shadow', created.created === true && created.item.status === 'shadow' && created.item.term === 'Héctor Fabio Riascos C.', created.item.status);
  const shadowApply = applyCanonical('Firmó hector fabio riascos ayer.', { data });
  check('shadow no se aplica', shadowApply.changed === false && shadowApply.text.includes('hector fabio riascos'), shadowApply.text);
  setTermStatus(data, created.item.id, 'approved', { reason: 'autocheck' });
  const applied = applyCanonical('Firmó hector fabio riascos ayer y HÉCTOR RIASCOS hoy.', { data });
  check('applyCanonical conserva la forma canónica', applied.text === 'Firmó Héctor Fabio Riascos C. ayer y Héctor Fabio Riascos C. hoy.', applied.text);
  const found = findTerms('Firmó HÉCTOR FABIO RIASCOS C. ayer', { data });
  check('findTerms ignora mayúsculas/tildes', found.length === 1 && found[0].canonical === 'Héctor Fabio Riascos C.', JSON.stringify(found));
  check('normalización de comparación', normalizeKey('Héctor Fabio Riascos C.') === 'hector fabio riascos c', normalizeKey('Héctor Fabio Riascos C.'));

  // 2) Aprendizaje: 1 shadow, 3 approved.
  const learned = fresh();
  const one = learn({ original: 'hector fabio riascos', corrected: 'Héctor Fabio Riascos C.', source: 'asr' }, { data: learned });
  check('learn 1 vez queda shadow', one.item.status === 'shadow' && one.corrections === 1 && one.created === true, JSON.stringify({ status: one.item.status, corrections: one.corrections }));
  const two = learn({ original: 'hector fabio riascos', corrected: 'Héctor Fabio Riascos C.' }, { data: learned });
  check('learn 2 veces sigue shadow', two.item.status === 'shadow' && two.corrections === 2, JSON.stringify({ status: two.item.status, corrections: two.corrections }));
  const three = learn({ original: 'hector fabio riascos', corrected: 'Héctor Fabio Riascos C.' }, { data: learned });
  check('learn 3 veces promueve a approved', three.item.status === 'approved' && three.promoted === true && three.corrections === PROMOTION_CORRECTIONS, JSON.stringify({ status: three.item.status, corrections: three.corrections }));
  check('learn nunca aprueba con una sola', one.item.status !== 'approved');
  check('learn aplica al aprobar', applyCanonical('hector fabio riascos', { data: learned }).text === 'Héctor Fabio Riascos C.');

  // 2.b) La misma corrección con distinta caja/tildes también acumula.
  const same = fresh();
  const s1 = learn({ original: 'predio el rosario', corrected: 'Predio El Rosario', source: 'asr' }, { data: same });
  const s2 = learn({ original: 'predio el rosario', corrected: 'Predio El Rosario', source: 'asr' }, { data: same });
  const s3 = learn({ original: 'predio el rosario', corrected: 'Predio El Rosario', source: 'asr' }, { data: same });
  check('learn acumula caja/tildes (3 → approved)', s1.item.status === 'shadow' && s2.item.status === 'shadow' && s3.item.status === 'approved' && s3.promoted === true, JSON.stringify([s1.item.status, s2.item.status, s3.item.status]));

  // 3) Hotwords: solo approved y respeta presupuesto.
  const words = fresh();
  approved(words, { term: 'Predio El Rosario', variants: ['predio el rosario'], context: 'predios' });
  approved(words, { term: 'Lote 12', variants: ['lote doce'], context: 'predios' });
  approved(words, { term: 'Matrícula 040-123', variants: ['matricula 040 123'], context: 'predios' });
  createOrUpdateTerm(words, { term: 'Shadow no usar', context: 'predios' });
  const hot = hotwords('predios', 30, { data: words });
  check('hotwords solo aprobados', hot.hotwords.every((term) => term !== 'Shadow no usar') && hot.count >= 1, JSON.stringify(hot.hotwords));
  check('hotwords respeta maxChars', hot.chars <= 30 && hot.maxChars === 30, JSON.stringify({ chars: hot.chars, maxChars: hot.maxChars }));
  check('hotwords declara truncado', hot.truncated === true && hot.eligible > hot.count, JSON.stringify({ eligible: hot.eligible, count: hot.count }));

  // 4) Sugerencias en un acta real.
  const acta = 'ACTA DE REUNIÓN. En el predio El Rosario, lote 12, matrícula 040-123, se reunieron Héctor Fabio Riascos C. y la señora Ana María Gómez. Se acordó revisar el lote.';
  const suggestions = suggest(acta, { data });
  const names = suggestions.map((row) => row.candidate);
  check('suggest detecta Héctor Fabio Riascos C.', names.includes('Héctor Fabio Riascos C.'), names.join(' | '));
  check('suggest detecta Ana María Gómez', names.includes('Ana María Gómez'), names.join(' | '));
  check('suggest detecta El Rosario', names.includes('El Rosario'), names.join(' | '));
  check('suggest ordena por confianza', suggestions.every((row, index) => index === 0 || suggestions[index - 1].confidence >= row.confidence), JSON.stringify(suggestions.map((row) => row.confidence)));

  // 5) Conflicto de variantes → 409.
  const conflictData = fresh();
  createOrUpdateTerm(conflictData, { term: 'Predio El Rosario', variants: ['el rosario'] });
  let conflict = null;
  try {
    createOrUpdateTerm(conflictData, { term: 'Lote 12', variants: ['El Rosario'] });
  } catch (error) {
    conflict = error;
  }
  check('conflicto de variantes 409', conflict?.status === 409 && conflict?.code === 'LINGO_CONFLICT', `${conflict?.status || ''} ${conflict?.code || ''} ${conflict?.message || ''}`);

  // 6) Ledger y rutas.
  check('ledger lingo.change en crear/aprobar', (data.office?.ledger || []).filter((entry) => entry.action === 'lingo.change').length >= 2, JSON.stringify((data.office?.ledger || []).map((entry) => entry.payload?.change)));
  check('rutas lingo montadas', routeModule.routes?.length === 7 && routeModule.name === 'lingo' && routeModule.priority === 120, String(routeModule.routes?.length));

  const failed = results.filter((row) => !row.ok);
  console.log(`\nAUTOCHECK ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
  if (failed.length) for (const row of failed) console.log(`  FAIL ${row.name}: ${row.detail}`);
  return failed.length === 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().then((ok) => process.exit(ok ? 0 : 1)).catch((error) => {
    console.error('AUTOCHECK FAIL', error);
    process.exit(1);
  });
}

export { main };

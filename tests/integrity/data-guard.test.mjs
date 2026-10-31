/**
 * Guardia del dato real: la suite NUNCA debe tocar `data/`.
 *
 * - Verifica que el DATA_DIR de este proceso sea temporal.
 * - Verifica que el JSON real es una agenda válida y que no se contaminó con
 *   fixtures de prueba (AG-BAD*, "Cita QA", etc.).
 * - El dato real es una agenda VIVA: el usuario puede crear/editar/borrar
 *   eventos y rutinas (queda auditado en activity/journal). Por eso la guardia
 *   no exige un seed inmutable, sino que la suite no cambie nada.
 * - La comparación hash+conteos antes/después de TODA la suite la hace
 *   `scripts/run-tests.mjs` (envoltorio de `npm test`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, createTempDataDir } from '../helpers/env.mjs';

// Aunque este archivo solo lee, fija un DATA_DIR temporal por si algún helper
// importa el store por accidente.
const testDataDir = createTempDataDir('agenda-guard-');

test('DATA_DIR del proceso apunta a un temporal, no al data/ real', () => {
  const resolved = path.resolve(process.env.DATA_DIR);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), `DATA_DIR=${resolved}`);
  assert.notEqual(resolved, path.resolve(repoRoot, 'data'));
  assert.equal(testDataDir, process.env.DATA_DIR);
});

test('data/ real conserva una agenda válida y no tiene fixtures de prueba', () => {
  const realFile = path.join(repoRoot, 'data', 'agenda-data.json');
  if (!fs.existsSync(realFile)) {
    // En un clon limpio puede no existir todavía: el arranque la crea.
    return;
  }
  const data = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  assert.ok([1, 2].includes(Number(data.version)), `version=${data.version}`);
  assert.ok(Array.isArray(data.agenda));

  const fixtureMarkers = data.agenda.filter((event) => {
    const title = String(event?.title || '');
    return ['AG-BAD1', 'AG-BAD2', 'AG-QA'].includes(String(event?.id)) || /^(QA |Cita QA|fecha rota|31 feb)/i.test(title);
  });
  assert.deepEqual(fixtureMarkers, [], `fixtures de prueba dentro del dato real: ${JSON.stringify(fixtureMarkers.slice(0, 3))}`);

  for (const event of data.agenda) {
    assert.ok(event.id, 'evento sin id en el dato real');
    assert.ok(event.start, `evento ${event.id} sin start`);
  }
  assert.ok(Array.isArray(data.inbox), 'inbox no es lista');
  assert.ok(Array.isArray(data.recurrences), 'recurrences no es lista');
  assert.ok(Array.isArray(data.meetings), 'meetings no es lista');
  assert.ok(Array.isArray(data.okrs), 'okrs no es lista');
});

test('no se escribe nada en data/ desde este proceso de test', () => {
  const realDataDir = path.join(repoRoot, 'data');
  const before = fs.existsSync(realDataDir) ? fs.readdirSync(realDataDir).sort() : [];
  createTempDataDir('agenda-guard-extra-');
  const after = fs.existsSync(realDataDir) ? fs.readdirSync(realDataDir).sort() : [];
  assert.deepEqual(after, before);
});

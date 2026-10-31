/**
 * Tests de estilo propio (t14) e identidad multicorreo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDataDir, importLib, startTestApp, api } from '../helpers/env.mjs';

const DATA_DIR = createTempDataDir('agenda-style-');
await importLib('lib/store.mjs');
const app = await startTestApp();

test.after(async () => { await app.close(); });

const SAMPLES = [
  'Hola Andrés:\n\nGracias por tu mensaje. Reviso el alcance y te confirmo mañana.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial',
  'Hola Marta:\n\nPerfecto, queda agendado para el jueves a las 10.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Buen día Carlos:\n\nAdjunto la propuesta con los ajustes que comentamos.\n\nCordialmente,\nHéctor Ramírez\nGerente Comercial',
  'Hola Laura:\n\n¿Puedes revisar el informe antes del viernes?\n\nGracias,\nHéctor Ramírez\nGerente Comercial',
  'Hola equipo:\n\nComparto el resumen de la reunión y los próximos pasos.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Hola Diego:\n\nQuedo atento a tus comentarios sobre el contrato.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial',
  'Hola Ana:\n\nConfirmo la reunión del martes y llevo el acta.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Hola Sofía:\n\nGracias por la gestión; el pago quedó programado.\n\nCordialmente,\nHéctor Ramírez\nGerente Comercial',
  'Hola Jorge:\n\nRevisé el presupuesto y te envío observaciones puntuales.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial',
  'Hola Paula:\n\nQuedamos así: cierre el viernes y revisión el lunes.\n\nGracias,\nHéctor Ramírez\nGerente Comercial',
  'Hola Camila:\n\nTe comparto el borrador para tu revisión.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial',
  'Hola Felipe:\n\nPerfecto el ajuste, lo incorporo al documento final.\n\nSaludos,\nHéctor Ramírez\nGerente Comercial'
];

test('estilo: importar muestras, perfil, score y redacción', async () => {
  const imported = await api(app.base, 'POST', '/api/style/samples', {
    register: 'colega',
    samples: SAMPLES.map((text) => ({ text }))
  });
  assert.equal(imported.status, 200, imported.text.slice(0, 300));

  const profiles = await api(app.base, 'GET', '/api/style/profiles');
  assert.equal(profiles.status, 200, profiles.text.slice(0, 200));
  const profileText = JSON.stringify(profiles.json);
  assert.ok(/colega/.test(profileText), 'sin perfil colega');

  const scored = await api(app.base, 'POST', '/api/style/score', {
    register: 'colega',
    text: 'Hola Andrés:\n\nReviso el alcance y te confirmo mañana.\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial'
  });
  assert.equal(scored.status, 200, scored.text.slice(0, 200));
  assert.equal(typeof scored.json.score, 'number');
  assert.ok(scored.json.score >= 0 && scored.json.score <= 1, `score=${scored.json.score}`);
  assert.ok(Array.isArray(scored.json.components) || Array.isArray(scored.json.why), 'sin componentes');

  const draft = await api(app.base, 'POST', '/api/style/compose', {
    register: 'colega',
    intent: 'Confirmar la reunión del martes y pedir el acta',
    recipient: { name: 'Andrés Molina', email: 'andres@empresa.com' }
  });
  assert.equal(draft.status, 200, draft.text.slice(0, 300));
  const draftText = String(draft.json.text || draft.json.draft || draft.json.body || '');
  assert.ok(draftText.length > 20, JSON.stringify(draft.json).slice(0, 300));
});

test('identidad: dos correos del mismo nombre resuelven a una persona', async () => {
  const contact = await api(app.base, 'POST', '/api/identity/contacts', {
    name: 'Andrés Molina',
    emails: ['andres@empresa.com', 'a.molina@otro.com'],
    aliases: ['Andrés M.']
  });
  assert.equal(contact.status, 200, contact.text.slice(0, 200));

  const resolved = await api(app.base, 'POST', '/api/identity/resolve', { email: 'a.molina@otro.com' });
  assert.equal(resolved.status, 200, resolved.text.slice(0, 200));
  const candidates = resolved.json.candidates || [];
  assert.ok(candidates.length >= 1, JSON.stringify(resolved.json).slice(0, 300));
  const top = candidates[0];
  assert.ok(Number(top.confidence) > 0, JSON.stringify(top));

  const expanded = await api(app.base, 'POST', '/api/identity/expand', { query: 'Andrés Molina' });
  assert.equal(expanded.status, 200, expanded.text.slice(0, 200));
  const people = expanded.json.people || [];
  assert.ok(people.length >= 1, JSON.stringify(expanded.json).slice(0, 300));
  const emails = people[0].emails || people[0].recipients || [];
  assert.ok(emails.includes('andres@empresa.com') && emails.includes('a.molina@otro.com'), JSON.stringify(emails));
});

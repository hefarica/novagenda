/* Prueba: un acta con acuerdos genera tareas/compromisos (origen acta). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-acta-tasks-'));
process.env.WORKFLOWS_AUTOSTART = '0';

const { createDocument } = await import('../lib/docs/index.mjs');
const { store } = await import('../lib/store.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const doc = await createDocument({
  type: 'docx',
  template: 'acta',
  title: 'Acta de liberación de predio',
  date: '2026-10-28',
  author: 'Héctor Fabio Riascos C.',
  attendees: ['Ana Torres', 'Luis Gómez'],
  agenda: ['Revisar linderos', 'Radicar solicitud'],
  agreements: [
    { text: 'Enviar el acta a Catastro', owner: 'Héctor', due: '2026-10-30' },
    { text: 'Radicar la solicitud de liberación', owner: 'Ana', due: '2026-11-02' }
  ],
  summary: ['Resumen uno.', 'Resumen dos.', 'Resumen tres.', 'Resumen cuatro.'],
  body: 'Se revisó el estado del predio y los acuerdos.'
});

check('El acta se genera', Boolean(doc.id), doc.id);
check('La respuesta incluye las tareas creadas', Array.isArray(doc.tasks) && doc.tasks.length === 2, `tasks=${doc.tasks?.length ?? 0}`);

const tasks = (store.get().tasks || []).filter((task) => task.origin === 'acta');
check('Se crearon 2 tareas con origen acta', tasks.length === 2, `total=${tasks.length}`);
check('Conservan dueño y fecha', tasks.some((task) => task.owner === 'Héctor' && task.due === '2026-10-30') && tasks.some((task) => task.owner === 'Ana' && task.due === '2026-11-02'));
check('Las notas trazan el acta', tasks.every((task) => String(task.notes || '').includes(doc.id)));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

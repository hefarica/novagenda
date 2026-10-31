/* Prueba: los avisos incluyen tareas vencidas y tareas que vencen hoy. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'agenda-nudges-tasks-'));
process.env.WORKFLOWS_AUTOSTART = '0';

const { collectCandidates } = await import('../lib/nudges/detect.mjs');
const { DEFAULT_CONFIG } = await import('../lib/nudges/config.mjs');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const now = new Date('2026-10-28T20:00:00.000Z'); // 15:00 en Bogotá
const settings = { timezone: 'America/Bogota' };
const data = {
  settings,
  agenda: [],
  inbox: [],
  recurrences: [],
  meetings: [],
  metrics: [],
  office: { proposals: [] },
  tasks: [
    { id: 'TK-1', title: 'Enviar el acta', status: 'open', due: '2026-10-27', owner: 'Héctor' },
    { id: 'TK-2', title: 'Radicar la solicitud', status: 'open', due: '2026-10-28', owner: 'Ana' },
    { id: 'TK-3', title: 'Tarea cerrada', status: 'done', due: '2026-10-27', owner: 'Luis' },
    { id: 'TK-4', title: 'Sin fecha', status: 'open', due: null }
  ]
};

const { items } = await collectCandidates({ data, settings, now, config: DEFAULT_CONFIG });
const taskItems = items.filter((item) => item.type === 'task_due' || item.type === 'task_overdue');
check('Detecta 2 tareas (vencida + hoy)', taskItems.length === 2, `items=${taskItems.length}`);
check('La vencida se marca como task_overdue', taskItems.some((item) => item.type === 'task_overdue' && item.taskId === 'TK-1' && item.daysOverdue === 1));
check('La de hoy se marca como task_due', taskItems.some((item) => item.type === 'task_due' && item.taskId === 'TK-2'));
check('La cerrada no avisa', !taskItems.some((item) => item.taskId === 'TK-3'));
check('La tarea sin fecha no inventa vencimiento', !taskItems.some((item) => item.taskId === 'TK-4'));
check('Conserva dueño y fecha', taskItems.every((item) => item.owner && item.due));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

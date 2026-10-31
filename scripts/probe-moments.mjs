/* Prueba determinista de Momentos (resumen semanal). */
import { weeklyMoments, momentsText } from '../lib/moments/index.mjs';

const now = new Date('2026-10-28T12:00:00.000Z');
const iso = (hours) => new Date(now.getTime() + hours * 3_600_000).toISOString();
const data = {
  agenda: [
    { id: 'EV-1', title: 'Evento pasado', start: iso(-48), end: iso(-47) },
    { id: 'EV-2', title: 'Evento próximo', start: iso(24), end: iso(25), location: 'Cali' },
    { id: 'EV-3', title: 'Evento lejano', start: iso(24 * 10), end: iso(24 * 10 + 1) }
  ],
  tasks: [
    { id: 'TK-1', title: 'Cerrada', status: 'done', due: '2026-10-27', createdAt: iso(-72), closedAt: iso(-24) },
    { id: 'TK-2', title: 'Vencida', status: 'open', due: '2026-10-27', createdAt: iso(-24), priority: 'P1' },
    { id: 'TK-3', title: 'Futura', status: 'open', due: '2026-11-02', createdAt: iso(-12) }
  ],
  office: {
    proposals: [
      { id: 'OF-1', status: 'pending', subject: 'Acta pendiente', level: 'N2', createdAt: iso(-5) },
      { id: 'OF-2', status: 'executed', subject: 'Correo enviado', approvedAt: iso(-30), executedAt: iso(-24) }
    ]
  },
  okr: {
    objectives: [
      { id: 'OK-1', title: 'Objetivo sano', status: 'active', keyResults: [{ target: 2, current: 1 }] },
      { id: 'OK-2', title: 'Objetivo riesgoso', status: 'active', keyResults: [{ target: 5, current: 1 }] }
    ]
  },
  rooms: {
    reservations: [
      { id: 'RS-1', status: 'active', title: 'Sala mañana', date: '2026-10-29', start: '09:00', end: '10:00' },
      { id: 'RS-2', status: 'cancelled', title: 'Cancelada', date: '2026-10-29', start: '11:00', end: '12:00' }
    ]
  }
};
const moments = weeklyMoments(data, { now });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
check('Cuenta eventos pasados y próximos', moments.counts.eventsPast === 1 && moments.counts.eventsNext === 1, JSON.stringify(moments.counts));
check('Cuenta tareas cerradas', moments.counts.tasksDone === 1 && moments.counts.tasksCreated === 3);
check('Prioriza aprobaciones y vencidas', moments.needsYou.approvals.length === 1 && moments.needsYou.overdueTasks.length === 1, JSON.stringify(moments.needsYou.overdueTasks));
check('Detecta objetivo en riesgo', moments.needsYou.atRisk.length === 1 && moments.needsYou.atRisk[0].progress === 20, JSON.stringify(moments.needsYou.atRisk));
check('Ordena próximos eventos', moments.next[0]?.id === 'EV-2' && moments.next.length === 1, moments.next.map((event) => event.id).join(','));
check('Incluye salas activas de la semana', moments.reservations.length === 1 && moments.reservations[0].id === 'RS-1');
check('Calcula avance medio OKR', moments.wins.okrProgress === 35, `${moments.wins.okrProgress}%`);
const text = momentsText(moments);
check('Genera texto para copiar', /Momentos/.test(text) && /tarea/.test(text), text.split('\n')[0]);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


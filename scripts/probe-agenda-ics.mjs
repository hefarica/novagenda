/* Prueba determinista de la exportación .ics de agenda. */
import { agendaIcsFilename, buildAgendaIcs } from '../lib/agenda/ics.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const data = {
  settings: { ownerName: 'Héctor Fabio Riascos C.' },
  agenda: [
    {
      id: 'AG-0001',
      title: 'Reunión, linderos; predio La Esperanza',
      start: '2026-10-28T14:00:00-05:00',
      end: '2026-10-28T15:00:00-05:00',
      location: 'Cali; sala 2',
      type: 'Reunión',
      status: 'Pendiente',
      priority: 'P1',
      context: 'Revisar linderos'
    },
    { id: 'AG-0002', title: 'Cancelada', start: '2026-10-29T09:00:00-05:00', status: 'Cancelada' },
    { id: 'AG-0003', title: 'Sin fecha' }
  ]
};
const ics = buildAgendaIcs(data, { now: new Date('2026-10-28T12:00:00-05:00'), calendarName: 'Agenda Héctor' });

check('Cabecera VCALENDAR', ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0'));
check('Un solo evento activo', (ics.match(/BEGIN:VEVENT/g) || []).length === 1);
check('Omite canceladas y sin fecha', !ics.includes('Cancelada') && !ics.includes('Sin fecha'));
check('Fecha en UTC', ics.includes('DTSTART:20261028T190000Z') && ics.includes('DTEND:20261028T200000Z'));
check('Escapa coma, punto y coma y salto', ics.includes('SUMMARY:Reunión\\, linderos\\; predio La Esperanza') && ics.includes('LOCATION:Cali\\; sala 2'));
check('Incluye UID y prioridad', ics.includes('UID:AG-0001@agenda-copilot.local') && ics.includes('PRIORITY:1'));
check('Cierra VCALENDAR', ics.endsWith('END:VCALENDAR\r\n'));

const long = buildAgendaIcs({
  settings: { ownerName: 'Héctor' },
  agenda: [{ id: 'AG-9', title: `Acta ${'muy larga '.repeat(20)}`, start: '2026-10-30T08:00:00-05:00' }]
}, { now: new Date('2026-10-28T12:00:00-05:00') });
const tooLong = long.split('\r\n').filter((line) => Buffer.byteLength(line, 'utf8') > 75);
check('Pliega líneas a 75 octetos', tooLong.length === 0, tooLong[0]?.slice(0, 40) || '');
check('Nombre de archivo legible', agendaIcsFilename(data, { now: new Date('2026-10-28T12:00:00-05:00') }) === 'hector-fabio-riascos-c-2026-10-28.ics', agendaIcsFilename(data));

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

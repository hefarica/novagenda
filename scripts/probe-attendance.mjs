/* Prueba determinista de Jornada. */
import {
  addBreak, attendanceSummary, clockIn, clockOut, deleteShift, listShifts, updateShift
} from '../lib/attendance/store.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const data = {};
const shift = clockIn(data, { at: '2026-10-28T13:00:00.000Z', note: 'Inicio' });
check('Abre jornada', shift.id === 'AT-0001' && shift.open === true && shift.minutes === 0);
let duplicate = null;
try { clockIn(data, { at: '2026-10-28T13:10:00.000Z' }); } catch (error) { duplicate = error; }
check('No abre dos jornadas', duplicate?.code === 'ALREADY_OPEN');
const withBreak = addBreak(data, 30);
check('Registra pausa', withBreak.breakMinutes === 30);
const closed = clockOut(data, { at: '2026-10-28T17:00:00.000Z', note: 'Fin' });
check('Cierra y descuenta pausa', closed.open === false && closed.minutes === 210, `${closed.minutes} min`);
const summary = attendanceSummary(data, { from: '2026-10-28', to: '2026-10-28' });
check('Resume horas del rango', summary.minutes === 210 && summary.days === 1 && summary.shifts === 1, JSON.stringify(summary));
const updated = updateShift(data, shift.id, { breakMinutes: 0 });
check('Corrige pausa', updated.minutes === 240, `${updated.minutes} min`);
let noOpen = null;
try { clockOut(data, { at: '2026-10-28T18:00:00.000Z' }); } catch (error) { noOpen = error; }
check('No cierra sin jornada', noOpen?.code === 'NOT_OPEN');
const listed = listShifts(data, { from: '2026-10-28', to: '2026-10-28' });
check('Lista el turno', listed.items.length === 1 && listed.items[0].id === shift.id);
const deleted = deleteShift(data, shift.id);
check('Borra turno', deleted.id === shift.id && listShifts(data).items.length === 0);
const second = clockIn(data, { at: '2026-10-29T08:00:00.000Z' });
check('Puede abrir otro día', second.id === 'AT-0001' && second.date === '2026-10-29');

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;


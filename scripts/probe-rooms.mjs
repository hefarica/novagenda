/* Prueba determinista de salas y reservas. */
import {
  availability, cancelReservation, createReservation, createRoom, deleteRoom,
  listRooms, roomsStats, updateReservation, updateRoom
} from '../lib/rooms/store.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const data = {};
const room = createRoom(data, { name: 'Sala Junta', location: 'Sede norte', capacity: 8 });
check('Crea sala', room.id === 'RM-0001' && room.name === 'Sala Junta' && room.capacity === 8);
const second = createRoom(data, { name: 'Sala 2', location: 'Piso 1', capacity: 4 });
check('Crea segunda sala', second.id === 'RM-0002');
const reservation = createReservation(data, room.id, { title: 'Reunión Andrés', date: '2026-10-28', start: '09:00', end: '10:00' });
check('Reserva en horario libre', reservation.id === 'RS-0001' && reservation.status === 'active');
let conflict = null;
try {
  createReservation(data, room.id, { title: 'Choque', date: '2026-10-28', start: '09:30', end: '10:30' });
} catch (error) { conflict = error; }
check('Detecta cruce de horario', conflict?.status === 409 && conflict?.code === 'ROOM_CONFLICT', conflict?.code);
const adjacent = createReservation(data, room.id, { title: 'Siguiente', date: '2026-10-28', start: '10:00', end: '11:00' });
check('Permite reserva contigua', adjacent.id === 'RS-0002');
const listed = listRooms(data, { date: '2026-10-28' });
check('Lista reservas del día', listed.items.find((item) => item.id === room.id)?.reservations.length === 2);
const free = availability(data, '2026-10-28');
check('Calcula salas libres', free.free === 1 && free.total === 2, `${free.free}/${free.total}`);
const moved = updateReservation(data, reservation.id, { title: 'Reunión Andrés (editada)', start: '08:00', end: '09:00' });
check('Edita reserva sin moverla de sala', moved.title.includes('editada') && moved.start === '08:00' && moved.end === '09:00');
let updateConflict = null;
try { updateReservation(data, adjacent.id, { start: '08:30', end: '09:30' }); } catch (error) { updateConflict = error; }
check('Rechaza edición que cruza otra reserva', updateConflict?.status === 409 && updateConflict?.code === 'ROOM_CONFLICT', updateConflict?.code);
const cancelled = cancelReservation(data, reservation.id);
check('Cancela reserva', cancelled.status === 'cancelled');
let cancelledEdit = null;
try { updateReservation(data, reservation.id, { title: 'No se puede' }); } catch (error) { cancelledEdit = error; }
check('No edita reserva cancelada', cancelledEdit?.status === 409 && cancelledEdit?.code === 'RESERVATION_INACTIVE', cancelledEdit?.code);
const rebooked = createReservation(data, room.id, { title: 'Reunión Andrés', date: '2026-10-28', start: '09:00', end: '10:00' });
check('Permite reservar tras cancelar', rebooked.status === 'active');
let blocked = null;
try { deleteRoom(data, room.id); } catch (error) { blocked = error; }
check('No borra sala con reservas activas', blocked?.code === 'ROOM_HAS_RESERVATIONS');
cancelReservation(data, rebooked.id);
cancelReservation(data, adjacent.id);
const deleted = deleteRoom(data, room.id);
check('Borra sala sin reservas activas', deleted.id === room.id && roomsStats(data).rooms === 1);
const updated = updateRoom(data, second.id, { capacity: 6, notes: 'Proyector' });
check('Edita sala', updated.capacity === 6 && updated.notes === 'Proyector');
let badDate = null;
try { availability(data, '2026-02-30'); } catch (error) { badDate = error; }
check('Rechaza fecha irreal', badDate?.status === 400 && badDate?.code === 'INVALID_DATE');

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;

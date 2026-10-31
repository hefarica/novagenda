/* Prueba determinista de tipos de aprobación y solicitudes. */
import {
  approvalsStats, createRequest, createType, decideRequest, deleteType, listRequests, listTypes,
  updateType
} from '../lib/approvals/store.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const data = {};
const type = createType(data, { name: 'Permiso de salida', level: 'N2', fields: 'Motivo:texto, Fecha:fecha, Horas:número', slaHours: 2 });
check('Crea tipo con campos', type.id === 'APT-0001' && type.fields.length === 3 && type.level === 'N2' && type.slaHours === 2, JSON.stringify(type.fields));
const editedType = updateType(data, type.id, { name: 'Permiso editado', level: 'N1', slaHours: 4, description: 'Actualizado' });
check('Edita tipo sin tocar campos', editedType.name === 'Permiso editado' && editedType.level === 'N1' && editedType.slaHours === 4 && editedType.fields.length === 3, JSON.stringify(editedType));
let badTypeUpdate = null;
try { updateType(data, 'APT-9999', { name: 'Fantasma' }); } catch (error) { badTypeUpdate = error; }
check('Rechaza editar tipo inexistente', badTypeUpdate?.status === 404, badTypeUpdate?.code);
const request = createRequest(data, { typeId: type.id, title: 'Salir el viernes', values: { c1: 'Trámite', c2: '2026-10-30', c3: 3 } });
check('Crea solicitud', request.id === 'APR-0001' && request.status === 'pending' && request.values.c3 === 3 && Boolean(request.dueAt) && request.overdue === false);
let missing = null;
try { createRequest(data, { typeId: type.id, title: 'Incompleta', values: { c1: 'Solo motivo' } }); } catch (error) { missing = error; }
check('Exige campos obligatorios', missing?.status === 400 && missing?.field === 'c2', missing?.message);
const approved = decideRequest(data, request.id, { by: 'owner', reason: 'ok' });
check('Aprueba solicitud', approved.status === 'approved' && approved.decidedBy === 'owner');
let twice = null;
try { decideRequest(data, request.id, { decision: 'rejected', by: 'owner' }); } catch (error) { twice = error; }
check('No decide dos veces', twice?.code === 'ALREADY_DECIDED');
const second = createRequest(data, { typeId: type.id, title: 'Otra', values: { c1: 'Compra', c2: '2026-10-31', c3: 1 } });
const rejected = decideRequest(data, second.id, { decision: 'rejected', by: 'owner', reason: 'No aplica' });
check('Rechaza solicitud', rejected.status === 'rejected' && rejected.reason === 'No aplica');
const pending = listRequests(data, { status: 'pending' });
check('Lista pendientes', pending.items.length === 0 && pending.pending === 0);
const overdueReq = createRequest(data, { typeId: type.id, title: 'Vencida', values: { c1: 'Tarde', c2: '2026-10-30', c3: 1 } });
data.approvals.requests.find((item) => item.id === overdueReq.id).dueAt = '2026-01-01T00:00:00.000Z';
const overdueList = listRequests(data, { status: 'pending' });
check('Marca solicitud vencida', overdueList.items[0]?.overdue === true && overdueList.items[0]?.overdueHours > 0);
check('Cuenta vencidas en stats', approvalsStats(data).overdue === 1);
check('Estadísticas', approvalsStats(data).approved === 1 && approvalsStats(data).rejected === 1 && approvalsStats(data).types === 1);
let badLevel = null;
try { createType(data, { name: 'Malo', level: 'N3', fields: '' }); } catch (error) { badLevel = error; }
check('Rechaza nivel no permitido', badLevel?.status === 400);
let badSla = null;
try { createType(data, { name: 'SLA malo', level: 'N2', fields: '', slaHours: 0 }); } catch (error) { badSla = error; }
check('Rechaza SLA fuera de rango', badSla?.status === 400);
const deleted = deleteType(data, type.id);
check('Borra tipo y conserva solicitudes', deleted.id === type.id && listTypes(data).count === 0 && listRequests(data).count === 3);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESUMEN: ${failed.length ? `${failed.length} fallo(s)` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;



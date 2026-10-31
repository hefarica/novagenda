/** Categoría C: agenda y rutinas (10 casos). */
import { prepare, runCategory, assert, equal } from './harness.mjs';

prepare('golden-agenda-');
const { store, localDateKey } = await import(new URL('../../lib/store.mjs', import.meta.url));
const engine = await import(new URL('../../lib/agenda/index.mjs', import.meta.url));
const travel = await import(new URL('../../lib/travel/index.mjs', import.meta.url)).catch(() => null);

const today = localDateKey();
const tomorrow = engine.addDaysKey(today, 1);
let created = null;

const cases = [
  {
    id: 'AG-01', name: 'Crear cita válida',
    run: async () => {
      const result = await engine.createAgendaEvent({
        data: store.get(), settings: store.get().settings,
        payload: { title: 'Golden cita', start: engine.isoAtLocal(tomorrow, '06:00'), end: engine.isoAtLocal(tomorrow, '06:30'), priority: 'P2', impact: 4, urgency: 3 },
        check: false, syncGoogle: false
      });
      assert(result.ok, JSON.stringify(result).slice(0, 200));
      created = result.event;
      equal(created.status, 'Pendiente');
    }
  },
  {
    id: 'AG-02', name: 'Editar cita recalcula score',
    run: async () => {
      const result = await engine.patchAgendaEvent({
        data: store.get(), settings: store.get().settings, id: created.id,
        patch: { title: 'Golden cita v2', impact: 5 }, check: false, syncGoogle: false
      });
      assert(result.ok, JSON.stringify(result).slice(0, 200));
      equal(result.event.title, 'Golden cita v2');
      assert(Number.isFinite(result.event.score), 'sin score');
    }
  },
  {
    id: 'AG-03', name: 'Completar cita con minutos reales',
    run: async () => {
      const result = await engine.completeAgendaEvent({ data: store.get(), settings: store.get().settings, id: created.id, actualMin: 25, syncGoogle: false });
      assert(result.ok, JSON.stringify(result).slice(0, 200));
      equal(result.event.status, 'Hecho');
      equal(result.event.actualMin, 25);
    }
  },
  {
    id: 'AG-04', name: 'Cancelar cita',
    run: async () => {
      const result = await engine.cancelAgendaEvent({ data: store.get(), settings: store.get().settings, id: created.id, syncGoogle: false });
      assert(result.ok, JSON.stringify(result).slice(0, 200));
      equal(result.event.status, 'Cancelada');
    }
  },
  {
    id: 'AG-05', name: 'Borrado duro elimina el evento',
    run: async () => {
      const result = await engine.deleteAgendaEventHard({ data: store.get(), id: created.id });
      assert(result.ok, JSON.stringify(result).slice(0, 200));
      assert(!store.get().agenda.some((event) => event.id === created.id), 'sigue en agenda');
    }
  },
  {
    id: 'AG-06', name: 'Conflicto con rutina futura R-002',
    run: async () => {
      let wednesday = today;
      for (let index = 0; index < 14; index += 1) {
        if (engine.weekdayCodeOfKey(wednesday) === 'MIE' && wednesday > today) break;
        wednesday = engine.addDaysKey(wednesday, 1);
      }
      const conflicts = await engine.checkConflicts({
        data: store.get(), settings: store.get().settings, includeGoogle: false,
        start: engine.isoAtLocal(wednesday, '07:30'), end: engine.isoAtLocal(wednesday, '08:15')
      });
      assert(conflicts.conflicts.some((item) => item.routineId === 'R-002'), JSON.stringify(conflicts.conflicts));
      equal(conflicts.canBook, false, 'canBook');
    }
  },
  {
    id: 'AG-07', name: 'findSlotsDetailed propone 3 huecos sin solape',
    run: async () => {
      const from = engine.addDaysKey(today, 1);
      const result = await engine.findSlotsDetailed({
        durationMin: 60, fromIso: engine.isoAtLocal(from, '07:00'), days: 3, count: 3,
        data: store.get(), settings: store.get().settings, includeGoogle: false
      });
      equal(result.slots.length, 3, 'slots');
      const busy = await engine.collectBusyDetailed(
        engine.isoAtLocal(from, '00:00'), engine.isoAtLocal(engine.addDaysKey(from, 2), '23:59'),
        { data: store.get(), settings: store.get().settings, includeGoogle: false }
      );
      for (const slot of result.slots) {
        const start = new Date(slot.start).getTime();
        const end = new Date(slot.end).getTime();
        equal(end - start, 60 * 60000, 'duración');
        equal(engine.isWeekend(slot.date), false, 'fin de semana');
        for (const block of busy.busy) {
          assert(!(start < new Date(block.end).getTime() && end > new Date(block.start).getTime()), `solape ${block.source}`);
        }
      }
    }
  },
  {
    id: 'AG-08', name: 'Rutina mensual día 31 hace clamp',
    run: async () => {
      const dates = engine.previewRoutine(
        { frequency: 'MENSUAL', rule: '31', time: '08:00', title: 'Cierre mensual', durationMin: 60, active: true },
        { count: 4, fromKey: '2027-01-01', settings: {} }
      ).map((row) => row.date);
      equal(dates, ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'], 'fechas');
    }
  },
  {
    id: 'AG-09', name: 'Viaje Cali→Palmira 16:00→16:30 inviable con alternativas',
    run: async () => {
      assert(travel, 'módulo travel no disponible');
      const date = engine.addDaysKey(today, 1);
      const plan = await travel.planTravel({
        fromPlace: 'Cali', fromAt: engine.isoAtLocal(date, '16:00'),
        toPlace: 'Palmira', toAt: engine.isoAtLocal(date, '16:30'), mode: 'auto'
      });
      equal(plan.feasible, false, 'feasible');
      assert(Number(plan.km) > 20, `km=${plan.km}`);
      assert(Array.isArray(plan.alternatives) && plan.alternatives.length >= 2, 'alternativas');
    }
  },
  {
    id: 'AG-10', name: 'Viaje con holgura es viable',
    run: async () => {
      assert(travel, 'módulo travel no disponible');
      const date = engine.addDaysKey(today, 2);
      const plan = await travel.planTravel({
        fromPlace: 'Cali', fromAt: engine.isoAtLocal(date, '08:00'),
        toPlace: 'Palmira', toAt: engine.isoAtLocal(date, '10:00'), mode: 'auto'
      });
      equal(plan.feasible, true, 'feasible');
    }
  }
];

await runCategory('agenda', cases);


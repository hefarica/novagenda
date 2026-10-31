# Motor de agenda P95 (`lib/agenda/**`)

Este directorio implementa la fidelidad al modelo Excel
`docs/Agenda_P95_Modelo_Canonico_2026.xlsx` y las reglas de negocio de la
agenda. No tiene dependencias npm: solo built-ins de Node 24.

> **Aviso para pruebas:** importar `lib/agenda/index.mjs`, `lib/agenda/routines.mjs`
> o cualquier módulo de rutas toca `lib/store.mjs`. Define siempre
> `DATA_DIR` a un directorio temporal ANTES de importar (y `TIMEZONE`), para no
> modificar `data/agenda-data.json`.

## Fórmulas canónicas

### Índice P95 (`08_DASHBOARD!A4` + `12_CONFIG`)

```
ROUND(
  MIN(1, ejecuciónHoy / 0.85) * 0.25 * 100
+ MIN(1, focoMinHoy / 120) * 0.20 * 100
+ MIN(1, MAX(0, 1 - vencidas / MAX(1, 2))) * 0.15 * 100
+ MIN(1, efectividadReuniones / 4) * 0.10 * 100
+ MIN(1, okrProgress / 0.70) * 0.15 * 100
+ MIN(1, ejecuciónSemanal / 0.80) * 0.10 * 100
+ MIN(1, revisiónSemanal / 1) * 0.05 * 100
, 1)
```

- Metas y pesos se leen de `settings.p95`; se aceptan tanto
  `p95.weights: {agendaExecution, deepFocus, overdue, meetingEffectiveness, okrProgress, weeklyExecution, weeklyReview}`
  como pesos planos `weightExecution`, `weightDeepFocus`, etc.
- **No hay puntos fijos**: si un componente vale 0, aporta 0.
- `computeP95(inputs, settingsP95)` es puro y sirve para tests.
- Referencia verificada del propio Excel: con
  `{ejecución:0, foco:0, vencidas:3, efectividad:0, okr:0.611764705882353, semanal:0, revisión:0}`
  el resultado es **13.1** (el valor cacheado de `08_DASHBOARD!A4`).
- Con el seed de la app (2026-10-27): **39.9** (`p95Score` 40), componentes
  `[7.35, 0, 15, 0, 15, 2.5, 0]`.

Semántica de las entradas (igual que el Excel):

| Componente | Fuente |
|---|---|
| Ejecución de agenda | `Hecho` / total de eventos con `Fecha` = hoy (incluye canceladas, como COUNTIFS del Excel) |
| Foco profundo | suma de `actualMin` de eventos de hoy con `deepFocus` |
| Vencidas abiertas | `due < hoy` y estado ≠ Hecho/Cancelada |
| Efectividad de reuniones | `AVERAGE(04_REUNIONES!Efectividad)` (ignora vacíos) |
| Progreso OKR | `AVERAGE(05_OKR!Progreso)` |
| Ejecución semanal | `Hecho` / total de la semana lunes→domingo |
| Revisión semanal | 1 si hay métrica de la semana con `weeklyReview` |

### Score de prioridad (`02_AGENDA!Y4`)

```
ROUND((impacto*4 + urgencia*3 + prioridad(P1=5/P2=4/P3=3/otro=2)*2 + focoProfundo(5/3)) * 2, 0)
```

Escala 0–100. Se recalcula al crear y editar; el Top 3 y el orden de la agenda
lo usan aunque el dato guardado esté desactualizado (`withComputedScore`).

## Rutinas

`kind: 'recurrence' | 'meeting'` unificadas. Persisten en `recurrences` y
`meetings` para no romper `/api/bootstrap`.

- `DIARIA`, `LABORABLES`, `SEMANAL` (regla LUN-MAR-…), `MENSUAL` y
  `TRIMESTRAL` (día 1–31).
- Mensual con **clamp a fin de mes**: día 31 → 30/29/28 según el mes.
- Festivos configurables (`settings.holidays` y opcional `settings.holidayCalendar: 'CO'`).
- Fines de semana configurables (`settings.workdays`).
- Excepciones por fecha (`exceptions` o `skipDates`) que también cancelan la
  instancia materializada.
- Materialización idempotente por `routineKey = id:fecha` y por
  `recurrentId`/`meetingId`/`routineId` + fecha.
- Backfill de días perdidos (`settings.routinesLastRun`, por defecto 7 días).

## Conflictos

`checkConflicts()` reúne:

1. eventos locales no cancelados,
2. **plantillas futuras** de rutinas aún no materializadas,
3. FreeBusy de Google y **eventos de día completo** (que no salen en FreeBusy).

Si Google falla, `errors` queda poblado y `unknown: true`; **nunca** se asume
libre. Las rutas devuelven 409 `FREEBUSY_UNAVAILABLE` salvo `allowUnverified`.
`findSlotsDetailed()` propone hasta `count` huecos dentro de
`settings.workdayStart`–`workdayEnd`, saltando festivos/fines de semana y sin
solapes.

## Google bidireccional (`lib/google.mjs`)

- `PATCH`/`DELETE` de la agenda actualizan/borran el evento en Calendar.
- Reconciliación periódica (`settings.syncIntervalMin`, mínimo 5 min):
  push de eventos sin vínculo + pull incremental con `syncToken`.
  La programa el scheduler de workflows (t8) llamando a
  `reconcileGoogle({force:true})`; este módulo no arranca timers por sí solo.
  `startGoogleReconciler()` queda disponible solo para ejecución standalone.
- `410 GONE` → resync completo; `429/5xx` → backoff con `Retry-After`.
- Desconectar revoca el token (`oauth2/revoke`).
- Los cambios externos se aplican a eventos locales por `google.eventId`
  (título, inicio/fin, cancelación). Los eventos externos nuevos no se
  duplican en la agenda: bloquean vía FreeBusy/día completo.
- `setGoogleTransport(fn)` permite mockear toda la API en tests.

## Métricas (`lib/metrics/metrics.mjs`)

`06_METRICAS_DIARIAS`, exactamente 14 campos:
`date, focusPlanMin, focusRealMin, interruptions, meetingMin, agendaPlanMin,
agendaDoneMin, planDaily, closeDaily, weeklyReview, energyAM, energyPM,
improvement, comments`.

`planDaily/closeDaily/weeklyReview` se detectan por el **rol** de la rutina
(`role`, o inferido por título/config `settings.metricRoles`), nunca por IDs
hardcodeados. `snapshotDailyMetrics` es idempotente por fecha y conserva la
captura manual (energía, interrupciones, mejora, comentarios).

## Autochequeo

```bash
node lib/agenda/selfcheck.mjs
```

Crea un `DATA_DIR` temporal, mockea Google con `setGoogleTransport` y verifica
las aceptaciones del motor (P95 Excel, score/Top 3, conflictos con R-002,
día completo, FreeBusy roto, sync Google, preview 30, clamp mensual, skip,
idempotencia, 14 campos de métricas, Inbox→cita y comandos del asistente)
sin tocar la agenda real ni la red.

## Pruebas manuales rápidas

```bash
DATA_DIR=$(mktemp -d) node --input-type=module -e "
import {store} from './lib/store.mjs';
import {computeP95FromData, priorityScore, checkConflicts, previewRoutineById} from './lib/agenda/index.mjs';
const d=store.get();
console.log('p95', computeP95FromData(d).index);
console.log('score', priorityScore(d.agenda[1]));
console.log('preview', previewRoutineById(d,'R-002',{count:30,settings:d.settings}).length);
"
```

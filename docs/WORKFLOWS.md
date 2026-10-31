# Motor de workflows, señales y automatizaciones (t8)

> Esta es la guía del motor que ejecuta **todo lo programado** en Agenda Copilot
> P95: briefings, chequeos, cierres, reportes, recordatorios, reconciliación con
> Google, resumen nocturno, resumen horario de cambios y señales proactivas.
> Todo funciona sin LLM (con textos deterministas) y se enriquece con el router
> de t3 cuando hay proveedor configurado.

---

## 1. Decisión de arquitectura (decisión B del capitán)

- `server.mjs` y `lib/routes/core.mjs` **no programan intervalos**, no envían
  mensajes y no materializan rutinas. Solo crean el servidor HTTP, montan el
  router y registran el cierre limpio / `store.flush`.
- `lib/workflows/scheduler.mjs` es el **único dueño de los intervalos**.
- `lib/routes/workflows.mjs` se monta por auto-descubrimiento y **arranca el
  scheduler al importarse**, con guardas:
  - `WORKFLOWS_AUTOSTART=0` → no programa nada,
  - `NODE_ENV=test`, `NODE_TEST_CONTEXT` o `--test` → no programa nada,
  - `setInterval(...).unref()` → no impide que Node termine,
  - flag de módulo idempotente + `startScheduler()` / `stopScheduler()`,
  - handlers `SIGTERM`/`SIGINT` idempotentes que **solo limpian los timers**
    (el apagado del store lo hace t1).
- Una instalación existente no reenvía avisos ya enviados: se conservan las
  claves históricas de `notificationLog` (`<job>:<YYYY-MM-DD>` y
  `<eventId>:<startISO>`).

```
server.mjs (t1) ── HTTP + router + shutdown + flush
      │
      └─ auto-descubre lib/routes/workflows.mjs (t8)
             │ import
             ├─ startScheduler()  ← único setInterval de la app
             │      └─ workflowTick()
             │           ├─ materializeRoutines()      (t2, handoff t1)
             │           ├─ workflows declarativos      (brief, cierre, …)
             │           ├─ recordatorios por cita
             │           ├─ reconcileGoogle()           (t2)
             │           └─ evaluateSignals()           (señales)
             └─ endpoints /api/workflows y /api/signals
```

### Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/workflows/defaults.mjs` | Workflows base, reglas de señales base, catálogos de tipos |
| `lib/workflows/state.mjs` | Semilla idempotente, ledger de ejecuciones, cooldowns, claves históricas |
| `lib/workflows/time.mjs` | Ventanas locales, zona horaria, catch-up, intervalos |
| `lib/workflows/runner.mjs` | Ejecución de acciones, recordatorios, materialización, Google, métricas |
| `lib/workflows/llm.mjs` | Puente con el router LLM de t3 y fallback determinista |
| `lib/workflows/notify.mjs` | Puente con canales (t4), dry-run y entrega por canal |
| `lib/workflows/messages.mjs` | Textos deterministas (los históricos + nocturno/horario) |
| `lib/workflows/scheduler.mjs` | Tick, vencimientos, claims, backoff, auditoría, ciclo de vida |
| `lib/signals/engine.mjs` | Reglas, detección, cooldown/descarte, enriquecido LLM, emisión |
| `lib/routes/workflows.mjs` | Endpoints, validación estricta y autostart |
| `docs/WORKFLOWS.md` | Este documento |

---

## 2. Cómo funciona el scheduler

### 2.1 Tick

- Por defecto cada **30 s** (`WORKFLOWS_TICK_MS`, mín. 5 s, máx. 300 s).
- Al arrancar hay un tick de `startup` ~1,5 s después del boot.
- Cada tick:
  1. siembra (solo la primera vez) los workflows/reglas,
  2. calcula vencimientos (`computeDueJobs`), sin escribir,
  3. ejecuta los jobs **en serie** (sin solapes; además hay un candado por
     workflow para que un disparo manual no se cruce con el programado),
  4. evalúa señales como máximo cada `SIGNALS_EVERY_MIN` (def. 5 min).
- Si el almacén está en solo lectura, el tick se salta sin romper nada.
- Un tick nunca lanza: cada job va en `try/catch` y los datos corruptos se
  ignoran (una cita con `start` inválido no tumba el proceso).

### 2.2 Ventanas e idempotencia

Cada ejecución se identifica por **`workflowId + windowKey`**:

| Trigger | windowKey | Ejemplo |
|---|---|---|
| `daily` | `WF:AAAA-MM-DD` | `WF-BRIEF:2026-10-27` |
| `weekly` | `WF:AAAA-MM-DD` (día de la ocurrencia) | `WF-WEEKLY:2026-10-30` |
| `interval` | `WF:AAAA-MM-DDT HH:MM` (inicio de ventana) | `WF-GOOGLE-SYNC:2026-10-27T10:00` |
| `always` | sin ventana (idempotencia por evento) | recordatorios |
| manual | `WF:manual:<ISO>` | botón "probar ahora" |

- Si ya existe una ejecución `ok`/`skipped` para esa ventana → **no se repite**
  (ni tras reiniciar el servidor: el ledger está en disco).
- Para los avisos diarios además se respeta `notificationLog`
  (`brief:fecha`, `midday:fecha`, `close:fecha`, `weekly:fecha`) → una
  instalación actualizada no reenvía lo que ya envió el motor anterior.
- Si el proceso cae a mitad de una ejecución, al volver la ejecución `running`
  obsoleta (> 10 min) se marca como error y se reintenta con backoff.

### 2.3 Catch-up (ejecuciones perdidas)

- Al volver de una caída, la **ocurrencia vencida más reciente** se ejecuta
  **una sola vez** si está dentro de `trigger.catchUpMaxMin`:
  - `daily`: 720 min (12 h) por defecto,
  - `weekly`: 1440 min (24 h),
  - `interval`: ventana actual (no se acumulan horas perdidas),
  - `catchUpMaxMin: 0` desactiva el catch-up.
- La ejecución se audita con `reason: "catch-up"`.
- Ejemplo: servidor caído a las 06:30; arranca a las 09:00 → brief una vez.
  Reinicia de nuevo a las 09:10 → no se repite.

### 2.4 Reintentos y backoff

- Máximo **3 intentos** por ventana.
- Espera creciente: 60 s → 300 s → 900 s (`nextAttemptAt` en la auditoría).
- Un fallo de materialización marca la ejecución como `error` y reintenta.
- Un fallo de Google o de entrega queda registrado como advertencia visible,
  pero no genera tormenta de reenvíos.

### 2.5 Auditoría (`data.workflowRuns`, máx. 500)

Cada ejecución guarda:

```json
{
  "id": "RUN-0001",
  "workflowId": "WF-BRIEF",
  "workflowName": "Brief matinal",
  "windowKey": "WF-BRIEF:2026-10-27",
  "reason": "catch-up",
  "status": "ok",
  "attempt": 1,
  "maxAttempts": 3,
  "startedAt": "2026-10-27T14:03:03.000Z",
  "finishedAt": "2026-10-27T14:03:03.031Z",
  "durationMs": 31,
  "scheduledFor": "2026-10-27T11:30:00.000Z",
  "steps": [
    { "name": "notify", "ok": true, "template": "brief", "chars": 210,
      "llm": { "used": false, "reason": "LLM_NOT_CONFIGURED",
               "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 } } }
  ],
  "llm": { "used": false, "fallback": true, "reason": "LLM_NOT_CONFIGURED" },
  "tokens": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "delivery": [],
  "error": null,
  "textPreview": "📌 AGENDA COPILOT — …"
}
```

- `durationMs` usa el reloj real (no la hora simulada del tick).
- `scheduledFor` conserva la hora programada de la ocurrencia.
- Los jobs internos también se auditan: `system:materialize` y
  `system:signals`.

### 2.6 Handlers externos del tick (`registerTickHandler`)

Otros módulos pueden ejecutar trabajo al final de cada `workflowTick` **sin
crear timers propios**:

```js
import { registerTickHandler } from '../workflows/scheduler.mjs';

const unregister = registerTickHandler(async ({ now, dryRun }) => {
  // `now` es la hora del tick; `dryRun` debe respetarse (no enviar ni escribir).
  return { ok: true };
});

// Más tarde (tests, apagado, etc.):
unregister();
```

Contrato:

- `registerTickHandler(fn)` es **idempotente** para la misma función y devuelve
  `unregister()`; llamar a `unregister()` dos veces no falla.
- Los handlers se ejecutan **en serie**, después de workflows y señales.
- Cada handler va aislado: `try/catch` individual + **timeout de 5 s**
  (`Promise.race`). Un handler que lanza o se cuelga **no rompe** el tick ni los
  workflows; el fallo se registra como `TICK_HANDLER_TIMEOUT` o con su error.
- El resultado del tick incluye `handlers: [{ ok, durationMs, result|error }]`
  **solo cuando hay handlers registrados**. Con cero handlers, el resultado es
  exactamente el mismo que antes del hook (paridad verificada en el autocheck
  de t16).
- Reciben `{ now, dryRun }`: en un tick dry-run no deben enviar ni mutar.
- El primer consumidor es **t16 (avisos inteligentes)**:
  `lib/routes/nudges.mjs` registra `nudgesTick` una sola vez bajo los mismos
  guards de autostart (`WORKFLOWS_AUTOSTART=0`, `NODE_ENV=test`,
  `NODE_TEST_CONTEXT`, `--test`). Ver `docs/AVISOS.md`.

---

## 3. Workflows base (editables en datos)

Se siembran una sola vez en `data.workflows` (8 workflows). Después mandan las
copias persistidas: el usuario puede crear, editar, desactivar o borrar.

| id | Nombre | Cuándo | Acciones | LLM | Clave histórica |
|---|---|---|---|---|---|
| `WF-BRIEF` | Brief matinal | diario 06:30 (catch-up 12 h) | notificar `brief` | `brief` | `brief:<fecha>` |
| `WF-MIDDAY` | Chequeo de mediodía | diario 12:00 (4 h) | notificar `midday` | `midday` | `midday:<fecha>` |
| `WF-CLOSE` | Cierre diario | diario 17:30 (6 h) | capturar métricas + notificar `close` | `close` | `close:<fecha>` |
| `WF-WEEKLY` | Reporte semanal | viernes 17:45 (24 h) | notificar `weekly` | `weekly` | `weekly:<fecha>` |
| `WF-GOOGLE-SYNC` | Reconciliación Google | intervalo = `settings.syncIntervalMin` (mín. 5) | `google_reconcile` | off | — |
| `WF-REMINDERS` | Recordatorios por cita | cada tick | `reminders` | off | `<eventId>:<ISO start>` |
| `WF-NIGHTLY` | Resumen nocturno | diario 21:00 (4 h) | notificar `nightly` | `schedule_summary` | — |
| `WF-HOURLY` | Resumen horario de cambios | cada 60 min en jornada laboral | notificar `hourly_changes` | `schedule_summary` | — |

Además, el scheduler ejecuta un job interno **`system:materialize`** a las
00:05 y al arrancar: llama a `materializeRoutines({ backfillDays: 7 })` de t2
(backfill, clamp mensual, festivos, excepciones, score e idempotencia).

> **Días de la semana (`trigger.weekdays`):** el motor usa los códigos
> `LUN, MAR, MIE, JUE, VIE, SAB, DOM` (los mismos de `weekdayCodeOfKey()`).
> Por compatibilidad con clientes en inglés se aceptan alias `MON…SUN` y
> `MONDAY…SUNDAY`, y se normalizan a español antes de guardar. El seed del
> reporte semanal usa `["VIE"]`; la migración v1→v2 corrige instalaciones que
> tuvieran `["FRI"]` y no disparaban el workflow.

### Condiciones

- `skipWeekend`: no ejecutar sábados/domingos (según `settings.workdays`).
- `skipHolidays`: no ejecutar festivos (`settings.holidays` o calendario CO).
- `notifyWhenEmpty`: si el mensaje no tiene contenido (p. ej. resumen horario
  sin cambios), no enviarlo (`false`).
- `trigger.workingDayOnly` / `trigger.workHoursOnly`: restringen a días/horas
  laborables configurados (`settings.workdays`, `workdayStart`, `workdayEnd`).
- `trigger.catchUpMaxMin`: ventana de recuperación.
- `trigger.timezone`: zona IANA propia (por defecto `settings.timezone`).

### Ejemplo de workflow persistido

```json
{
  "id": "WF-BRIEF",
  "name": "Brief matinal",
  "description": "Resumen del día con Top 3, choques y foco recomendado.",
  "active": true,
  "trigger": { "type": "daily", "at": "06:30", "catchUpMaxMin": 720 },
  "conditions": { "skipWeekend": false, "skipHolidays": false, "notifyWhenEmpty": true },
  "actions": [{ "type": "notify", "template": "brief", "subject": "Brief diario Agenda Copilot" }],
  "llm": { "enabled": true, "profile": "brief", "deadlineMs": 25000 },
  "channels": [],
  "subject": "Brief diario Agenda Copilot",
  "compatKey": "brief",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`channels: []` significa **todos los canales configurados**; también se puede
limitar a `["telegram"]`, `["whatsapp"]`, `["email"]` o combinaciones.

---

## 4. LLM en cada workflow (router de t3)

- Cada workflow tiene `llm.enabled` y `llm.profile` editables por separado.
  Con `enabled: false` **no se llama al LLM**: se envía el texto determinista.
- Perfiles soportados: `brief`, `midday`, `close`, `weekly`, `signals`,
  `schedule_summary`, `conflict`, `channel`, `chat`.
- El enriquecido pasa por `runWorkflow()` de t3, que aplica:
  proveedor configurado, timeout, reintentos, **kill-switch global**,
  presupuesto diario/por workflow, rate limit y registro de uso.
- Si no hay proveedor, está apagado, el perfil está desactivado, se agota el
  presupuesto o hay error → **fallback determinista** con los textos actuales.
- Los tokens y el proveedor quedan auditados en `workflowRuns[].tokens`,
  `.llm` y `.steps[].llm`.

Ejemplos de toggles:

```bash
# Apagar solo el LLM del brief (sigue enviando el texto determinista)
curl -s -X PATCH http://127.0.0.1:3000/api/workflows/WF-BRIEF \
  -H 'content-type: application/json' -d '{"llm":{"enabled":false}}'

# Cambiar el perfil del cierre y su presupuesto de tiempo
curl -s -X PATCH http://127.0.0.1:3000/api/workflows/WF-CLOSE \
  -H 'content-type: application/json' -d '{"llm":{"profile":"close","deadlineMs":20000}}'
```

---

## 5. Motor de señales

Reglas persistidas en `data.signalRules` (7 reglas base, editables):

| id | Condición | Umbral | Ventana | Cooldown | Acción |
|---|---|---|---|---|---|
| `SIG-CONFLICTS` | Choques hoy (local + rutinas) | ≥ 1 | 06:00–22:00 | 240 min | notificar (LLM `conflict`) |
| `SIG-OVERDUE` | Citas abiertas con fecha pasada | ≥ 3 | 08:00–21:00 | 360 min | notificar |
| `SIG-FOCUS-LOW` | Foco real del día < umbral | < 60 min | 12:00–20:00 | 180 min | notificar + proponer bloque |
| `SIG-FREE-GAP` | Hueco libre ≥ umbral | ≥ 60 min | 09:00–17:00 | 120 min | notificar |
| `SIG-MEETING-NO-RESULT` | Reuniones de hoy sin resultado | ≥ 1 | 08:00–20:00 | 360 min | notificar |
| `SIG-MEETING-OVERLOAD` | Minutos de reunión del día | ≥ 240 | 10:00–20:00 | 360 min | notificar |
| `SIG-INACTIVITY` | Minutos sin cierres/cambios | ≥ 120 | 09:00–18:00 | 180 min | notificar |

Cada regla define: **condición** (`type`), **umbral** (`threshold`),
**ventana** (`window`), **canales** (`channels`), **cooldown** (`cooldownMin`)
y **acción** (`action.type` = `notify`, `propose_focus`, `create_focus`,
`ask_llm`, `silent`; `autoApply` decide si crea el bloque de foco sin preguntar).

Reglas de comportamiento:

- Una señal no se repite dentro de su `cooldownMin` (misma regla/día).
- Si el usuario la **descarta**, no se vuelve a emitir ese día.
- `payload` incluye los hechos verificados y, si aplica, una propuesta
  (`proposal.start`, `proposal.end`, `proposal.durationMin`).
- En producción (no dry-run), cada señal se persiste en `data.signals`
  (máx. 200), se envía por los canales indicados y se audita la entrega.
- El LLM de una señal usa `rule.llm.profile` con un prompt propio y el
  borrador determinista como fallback. Respeta kill-switch y presupuesto.

Crear una señal manual o evaluar reglas:

```bash
# Evaluar sin efectos (no envía, no escribe, no llama al LLM)
curl -s -X POST http://127.0.0.1:3000/api/signals/evaluate \
  -H 'content-type: application/json' -d '{"dryRun":true}'

# Evaluar y notificar de verdad (solo reglas de choques y vencidas)
curl -s -X POST http://127.0.0.1:3000/api/signals/evaluate \
  -H 'content-type: application/json' \
  -d '{"dryRun":false,"notify":true,"types":["conflicts","overdue"]}'

# Descartar una señal
curl -s -X POST http://127.0.0.1:3000/api/signals/SIG-0001/dismiss
```

---

## 6. API

Todos los endpoints viven bajo `/api` y comparten la sesión de t1 (en local no
piden login; con `HOST≠loopback` o `APP_AUTH=on` exigen sesión).

### Workflows

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/api/workflows` | `{items, count, total, scheduler}` |
| `POST` | `/api/workflows` | `201 {item}` |
| `GET` | `/api/workflows/:id` | `{item}` |
| `PATCH` | `/api/workflows/:id` | `{item}` |
| `DELETE` | `/api/workflows/:id` | `{ok:true, removed}` |
| `POST` | `/api/workflows/:id/run?dryRun=1` | `{ok:true, run}` |
| `GET` | `/api/workflows/runs?limit=50&workflowId=&status=` | `{items, count, total}` |
| `GET` | `/api/workflows/status` | `{scheduler, signals, catalog}` |

Errores: `400 UNKNOWN_FIELD / EMPTY_PATCH / INVALID_FORMAT / INVALID_VALUE`,
`404 NOT_FOUND`, `409 WORKFLOW_DISABLED / WORKFLOW_RUNNING`.

### Señales

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/api/signals?limit=50&type=&unread=1&includeDismissed=1` | `{items, count, total, unread}` |
| `POST` | `/api/signals` | `201 {item}` |
| `POST` | `/api/signals/evaluate` | `{ok, dryRun, evaluated, emitted, items, candidates, errors}` |
| `GET` | `/api/signals/rules` | `{items, count, total, types}` |
| `PATCH` | `/api/signals/rules/:id` | `{item}` |
| `POST` | `/api/signals/:id/read` | `{item read:true}` |
| `POST` | `/api/signals/:id/dismiss` | `{item dismissed:true}` |

### Ejemplos rápidos

```bash
# Listar workflows y ver el estado del scheduler
curl -s http://127.0.0.1:3000/api/workflows | jq '.count, .scheduler'
curl -s http://127.0.0.1:3000/api/workflows/status | jq '.scheduler'

# Probar el brief ahora sin enviar nada (dry-run)
curl -s -X POST 'http://127.0.0.1:3000/api/workflows/WF-BRIEF/run?dryRun=1' \
  | jq '.run.status, .run.steps[0].text'

# Forzar una ejecución real (queda auditada)
curl -s -X POST http://127.0.0.1:3000/api/workflows/WF-CLOSE/run | jq '.run'

# Crear un workflow propio: lunes a viernes a las 08:15
curl -s -X POST http://127.0.0.1:3000/api/workflows \
  -H 'content-type: application/json' -d '{
    "name": "Preparar el día",
    "trigger": { "type": "daily", "at": "08:15" },
    "conditions": { "skipWeekend": true, "skipHolidays": true },
    "actions": [{ "type": "notify", "template": "custom", "text": "Respira, elige el Top 3 y empieza." }],
    "llm": { "enabled": false }
  }'

# Historial de ejecuciones con duración y tokens
curl -s 'http://127.0.0.1:3000/api/workflows/runs?limit=10' \
  | jq '.items[] | {workflowId, status, durationMs, tokens}'
```

---

## 7. Recetas listas

### 7.1 «Si hay 2 choques, avísame por Telegram»

```bash
curl -s -X PATCH http://127.0.0.1:3000/api/signals/rules/SIG-CONFLICTS \
  -H 'content-type: application/json' -d '{
    "threshold": 2,
    "channels": ["telegram"],
    "cooldownMin": 60,
    "window": { "from": "07:00", "to": "21:00" }
  }'
```

El scheduler evalúa cada 5 min; la primera vez que haya 2 choques emite la
señal y la envía por Telegram. No se repite en 60 min, y si la descartas no
vuelve ese día. Para verla sin enviar: `POST /api/signals/evaluate` con
`{"dryRun":true,"types":["conflicts"]}`.

### 7.2 «Cada hora, resumen de cambios»

Ya existe `WF-HOURLY` (cada 60 min en jornada laboral). Para ajustarlo:

```bash
curl -s -X PATCH http://127.0.0.1:3000/api/workflows/WF-HOURLY \
  -H 'content-type: application/json' -d '{
    "trigger": { "type": "interval", "everyMin": 60, "workingDayOnly": true, "workHoursOnly": true },
    "conditions": { "skipWeekend": true, "skipHolidays": true, "notifyWhenEmpty": false },
    "llm": { "enabled": true, "profile": "schedule_summary" },
    "channels": ["telegram"]
  }'
```

Si no hubo cambios no envía nada (`notifyWhenEmpty: false`). El texto
determinista lista nuevas, movidas y completadas; el LLM añade contexto.

### 7.3 «Si no hay foco a las 12, propón un bloque»

Ya existe `SIG-FOCUS-LOW`. Para que proponga un bloque de 90 min y avise por
Telegram:

```bash
curl -s -X PATCH http://127.0.0.1:3000/api/signals/rules/SIG-FOCUS-LOW \
  -H 'content-type: application/json' -d '{
    "threshold": 60,
    "window": { "from": "12:00", "to": "18:00" },
    "channels": ["telegram"],
    "params": { "durationMin": 90, "days": 3, "includeGoogle": false },
    "action": { "type": "propose_focus", "autoApply": false }
  }'
```

La señal incluye `payload.proposal` con día/hora reales (sin solapes y dentro
de la jornada). Con `autoApply: true` el motor crea el bloque de foco, pero por
defecto solo propone: la decisión es del usuario.

### 7.4 Otras recetas

- **Brief por WhatsApp**: `PATCH WF-BRIEF {"channels":["whatsapp"]}`.
- **Silenciar el nocturno**: `PATCH WF-NIGHTLY {"active":false}`.
- **Reconciliación cada 5 min**: `PATCH` de ajustes `syncIntervalMin=5` (el
  workflow lo lee en cada ventana).
- **Resumen de cambios sin LLM**: `PATCH WF-HOURLY {"llm":{"enabled":false}}`.
- **Recordatorio único por cita**: se controla con `reminderMin` de la cita;
  el motor usa la clave `<eventId>:<startISO>` y nunca repite.

---

## 8. Apagar el scheduler en tests (obligatorio)

El motor arranca al importar `lib/routes/workflows.mjs`. En pruebas:

```bash
# PowerShell
$env:WORKFLOWS_AUTOSTART = "0"
$env:NODE_ENV = "test"
$env:DATA_DIR = Join-Path $env:TEMP ("agenda-test-" + [guid]::NewGuid())
node --test
```

```bash
# bash / CI
WORKFLOWS_AUTOSTART=0 NODE_ENV=test DATA_DIR="$(mktemp -d)" node --test
```

- `WORKFLOWS_AUTOSTART=0` → `startScheduler()` no crea ningún `setInterval`
  (verificable con `schedulerStatus().started === false`).
- `NODE_ENV=test`, `NODE_TEST_CONTEXT` o `--test` → tampoco arranca.
- Para probar el scheduler a propósito en un test: `startScheduler({ force: true, tickMs: 5000 })`
  y cerrar con `stopScheduler()`.
- Para ejecutar un tick determinista sin esperar: `workflowTick({ now: new Date(...) })`.
- El tick de arranque tarda ~1,5 s; `stopScheduler()` limpia también ese timer.

Variables de entorno del motor:

| Variable | Uso | Defecto |
|---|---|---|
| `WORKFLOWS_AUTOSTART` | `0` desactiva el arranque automático | activo |
| `WORKFLOWS_TICK_MS` | periodo del tick (5000–300000) | `30000` |
| `SIGNALS_EVERY_MIN` | cada cuánto se evalúan señales | `5` |
| `NODE_ENV=test` | desactiva el arranque automático | — |

---

## 9. Persistencia y compatibilidad

Claves nuevas en `data/` (todas viajan en backup/restore):

| Clave | Contenido | Límite |
|---|---|---|
| `workflows` | workflows declarativos | sin límite práctico |
| `workflowsMeta` | marca de siembra (no re-siembra si borras todo) | — |
| `workflowRuns` | auditoría de ejecuciones | 500 |
| `signalRules` | reglas de señales editables | 7 base |
| `signalRulesMeta` | marca de siembra | — |
| `signals` | señales emitidas | 200 |
| `signalCooldowns` | último aviso/descarte por regla y día | 7 días |
| `notificationLog` | **claves históricas** de idempotencia | sin cambio |

- `reset-demo` deja `workflows=[]` y borra la marca → el siguiente tick vuelve
  a sembrar los 8 workflows y las 7 reglas (los datos de agenda también se
  reinician, como define t1).
- Restaurar un backup antiguo sin estas claves no rompe nada: se siembran.
- No se necesitan migraciones de esquema: son claves nuevas y opcionales.

---

## 10. Seguridad y límites

- Autenticación y CSRF: las rutas usan la sesión de t1; con red (`HOST≠loopback`)
  exigen login y validan `Origin` en escrituras.
- Validación estricta: listas blancas por campo, fechas/horas reales, umbrales
  acotados, `params` ≤ 8 KB, acciones ≤ 5. Los campos desconocidos devuelven
  `400 UNKNOWN_FIELD`; nunca se hace `Object.assign` de cuerpos sin filtrar.
- Secretos: los canales y el LLM leen de la bóveda de t1; este motor nunca
  escribe claves ni las devuelve.
- Contenido de mensajes: se sanea en los canales; los logs usan la redacción
  global de t1.
- Límites: el scheduler vive **en un proceso**. Si ejecutas dos instancias con
  el mismo `DATA_DIR`, arranca solo una con el scheduler y la otra con
  `WORKFLOWS_AUTOSTART=0`.
- El ledger y las señales están acotados para que el JSON no crezca sin control.

---

## 11. Añadir un workflow nuevo (2 minutos)

1. Créalo por API (no hace falta tocar código):

```bash
curl -s -X POST http://127.0.0.1:3000/api/workflows \
  -H 'content-type: application/json' -d '{
    "name": "Revisar OKR los lunes",
    "trigger": { "type": "weekly", "at": "09:00", "weekdays": ["LUN"] },
    "actions": [{ "type": "notify", "template": "custom", "text": "Revisa tus OKR y elige el foco de la semana." }],
    "channels": [],
    "llm": { "enabled": true, "profile": "schedule_summary" }
  }'
```

2. Compruébalo en dry-run: `POST /api/workflows/<id>/run?dryRun=1`.
3. Cuando quieras mensajes reales, activa los canales en el centro de
   integraciones (t4); sin canales configurados el envío devuelve `[]` y queda
   auditado, pero no rompe nada.

### Añadir una señal nueva

Las reglas son datos; los tipos de condición están en `lib/signals/engine.mjs`
(`detectRule`). Para una condición nueva: añade el `case` y el catálogo en
`lib/workflows/defaults.mjs` (`SIGNAL_TYPES`), luego crea la regla con
`POST /api/signals` o `PATCH /api/signals/rules/:id`. No hay que tocar el
scheduler.

---

## 12. Diagnóstico rápido

| Síntoma | Causa probable | Solución |
|---|---|---|
| No se envía nada | Canales sin configurar | Centro de integraciones (t4); `GET /api/channels` |
| El brief no se reenvió hoy | Ya se envió (clave histórica) | `GET /api/workflows/runs?workflowId=WF-BRIEF` |
| Un job no aparece en runs | Scheduler apagado o sin ventana vencida | `GET /api/workflows/status`; `WORKFLOWS_AUTOSTART` |
| Señal no aparece | Cooldown/descarte o fuera de ventana | `POST /api/signals/evaluate {"dryRun":true}` |
| Todo falla en 503 `STORE_READ_ONLY` | JSON corrupto (t1) | `POST /api/backup/restore` |
| LLM no enriquece | Sin proveedor, kill-switch, perfil off, presupuesto | `GET /api/llm/usage`, `GET /api/llm/status` |
| Quiero probar sin enviar | Dry-run | `POST /api/workflows/:id/run?dryRun=1` |

---

## 13. Criterios de aceptación de t8 (verificados)

- [x] Un job perdido se ejecuta **exactamente una vez** al volver (in-process y
      tras reinicio con el mismo `DATA_DIR`).
- [x] Las señales no se repiten dentro de su cooldown; si se descartan, no
      vuelven ese día.
- [x] Cada workflow puede activar/desactivar el LLM de forma independiente.
- [x] El dry-run no envía mensajes, no muta la agenda y no llama al LLM.
- [x] Todas las ejecuciones quedan auditadas con duración real y tokens.
- [x] Con `WORKFLOWS_AUTOSTART=0` no se programa ningún intervalo.
- [x] Un evento con fecha inválida no tumba el proceso (tick `ok`).
- [x] El brief sale con LLM (mock OpenAI-compatible verificado) o con fallback
      determinista (sin proveedor / kill-switch).
- [x] Materialización de rutinas con backfill desde el scheduler (handoff t1).
- [x] Reconciliación Google cada `settings.syncIntervalMin` sin timers propios
      de t2.
- [x] El reporte semanal se dispara el viernes (`weekdays: ["VIE"]`) y la
      migración v1→v2 corrige seeds antiguos con `["FRI"]`; la API acepta y
      normaliza alias `MON…SUN`.

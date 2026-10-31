# Avisos inteligentes (t16)

> El “recordatorio inteligente” de Agenda Copilot: te avisa de lo que se te
> pasó, lo que falta, lo que llegó y lo que conviene priorizar **sin spamear y
> sin sonar a bot**. Funciona sin LLM (plantillas naturales) y se enriquece con
> el perfil `signals` cuando hay proveedor.

---

## 1. Cómo se integra (sin timers propios)

El motor **no crea intervalos**. Se engancha al scheduler de t8 con el hook
`registerTickHandler`:

```
lib/workflows/scheduler.mjs  (único dueño de los intervalos)
        │ tick cada 30 s
        └─ handlers externos (aislados, timeout 5 s)
               └─ lib/nudges/engine.mjs → nudgesTick({now, dryRun})
```

- `lib/routes/nudges.mjs` registra el handler **una sola vez** al importarse,
  con los mismos guards que el scheduler (`WORKFLOWS_AUTOSTART=0`,
  `NODE_ENV=test`, `NODE_TEST_CONTEXT`, `--test`).
- Cada handler se ejecuta en su propio `try/catch` con **timeout de 5 s**: si
  un aviso falla o se cuelga, el tick y los workflows siguen.
- `registerTickHandler(fn)` es idempotente y devuelve `unregister()`.
- En **dry-run** el handler recibe `dryRun:true` y no envía ni escribe.
- Detalle del hook en `docs/WORKFLOWS.md` (§2.6).

También se puede evaluar a mano por HTTP o en el autocheck, sin esperar al tick.

---

## 2. Catálogo de avisos

| Tipo | Cuándo se genera | Umbral / ventana | Impacto base |
|---|---|---|---|
| `overdue` | Citas abiertas con `due` anterior a hoy | Hasta 8; las más vencidas primero | 100 |
| `approvals` | Propuestas de la oficina en estado `pending`/`held` sin decidir | Hasta 5; ignora expiradas | 95 |
| `meeting_no_place` | Reunión de hoy próxima **sin lugar ni enlace** | `meetingLookaheadMin` (180 min) | 88 |
| `daily_close` | Pasada `closeCheckAt` (17:30) y el cierre del día no está hecho | 1 por día | 82 |
| `unanswered` | Mensajes entrantes de canales sin respuesta | `unansweredMin` (30 min), últimos 24 h | 76 |
| `focus_unmet` | Foco real por debajo del objetivo (`settings.p95.deepFocusDailyMin` o `focusTargetMin`) | A partir de 14:00 (o 12:00 si va <40 %) | 70 |
| `undated` | Capturas accionables del inbox sin fecha | Hasta 6 | 56 |
| `free_gap` | Hueco libre ≥ `freeGapMin` dentro de la jornada | 1 al día por evaluación (sin Google) | 46 |

Notas:

- `meeting_no_place` entiende como “lugar” `location`, `place`, `room`,
  `context`, `meetLink`, `meetingUrl`, `google.hangoutLink`… si contiene una
  URL de videollamada, sala, oficina, dirección o “presencial”.
- `approvals` lee `data.office.proposals` (módulo Oficina) **sin inicializarlo
  ni mutarlo**; si la oficina no existe o no hay propuestas, no genera aviso.
- `unanswered` lee la bandeja normalizada de canales (`data.channelState.messages`)
  y considera respondido un entrante si hay un saliente con `replyTo` o una
  respuesta en los 5 minutos siguientes.
- Todos los detectores ignoran citas con fechas inválidas: nunca rompen el tick.

### Priorización (`rank.mjs`)

Cada candidato se puntúa con:

```
score = impacto_base
      + urgencia   (minutos hasta la cita, días vencidos, mensajes acumulados)
      + bonus por hora del día (mañana: vencidas/pendientes; mediodía: hueco/foco;
                                tarde: cierre/mensajes/vencidas)
      − penalización por esfuerzo estimado
```

Se ordenan de mayor a menor y se elige **un aviso con hasta 3 asuntos**
(`maxItems`). El aviso se identifica por una **huella** estable (hash de los
asuntos) para no repetirlo.

---

## 3. Anti-spam (todo persistido en `data.nudges.state`)

| Regla | Defecto | Configurable |
|---|---|---|
| Cooldown por tipo | 90 min | `cooldownMin` (0–1440) |
| Silencio nocturno | 21:30–07:00 | `silence.enabled/from/to` |
| Cadencia entre avisos | 30 min | `cadenceMin` (5–240) |
| Máximo por hora | 2 | `maxPerHour` (1–12) |
| Máximo por día | 8 | `maxPerDay` (1–50) |
| Anti-duplicado por huella | 360 min | `dedupeTtlMin` (0–2880) |
| Asuntos por aviso | 3 | `maxItems` (1–3) |

- Si descartas un aviso (`dismiss`), sus asuntos no vuelven a aparecer durante
  al menos 24 h (y el aviso queda en el feed como descartado).
- El silencio y los topes se aplican **también** en dry-run: de noche no se
  genera nada y al llegar al tope se devuelve `skipped` explicando el motivo.
- El motor no envía nada si no hay canales configurados: `delivery.attempted`
  queda en `false` con `reason: "no-channels"`.

---

## 4. Configuración editable (no está en código)

`GET /api/nudges/config` devuelve la configuración efectiva, el estado
(contadores, último envío, canales destino) y el catálogo de tipos.

`POST /api/nudges/config` acepta un parche con estos campos:

```json
{
  "enabled": true,
  "cadenceMin": 30,
  "silence": { "enabled": true, "from": "21:30", "to": "07:00" },
  "channels": [],
  "maxPerHour": 2,
  "maxPerDay": 8,
  "cooldownMin": 90,
  "maxItems": 3,
  "freeGapMin": 60,
  "focusTargetMin": null,
  "unansweredMin": 30,
  "meetingLookaheadMin": 180,
  "closeCheckAt": "17:30",
  "reportAt": "18:00",
  "dedupeTtlMin": 360,
  "llmEnabled": true
}
```

- `channels: []` = todos los canales configurados; también acepta
  `["telegram"]`, `["whatsapp"]`, `["email"]` o combinaciones.
- `focusTargetMin: null` usa el objetivo P95 (`deepFocusDailyMin`).
- Campos desconocidos → `400 UNKNOWN_FIELD`; valores fuera de rango →
  `400 OUT_OF_RANGE`; horas inválidas → `400 INVALID_FORMAT`.

Ejemplos:

```bash
# Silenciar todo el día (modo vacaciones)
curl -s -X POST http://127.0.0.1:3000/api/nudges/config \
  -H 'content-type: application/json' -d '{"enabled":false}'

# Solo Telegram, máximo 1 aviso por hora y sin LLM
curl -s -X POST http://127.0.0.1:3000/api/nudges/config \
  -H 'content-type: application/json' \
  -d '{"channels":["telegram"],"maxPerHour":1,"llmEnabled":false}'

# Cambiar el silencio nocturno a 22:30–06:30
curl -s -X POST http://127.0.0.1:3000/api/nudges/config \
  -H 'content-type: application/json' \
  -d '{"silence":{"from":"22:30","to":"06:30"}}'
```

---

## 5. API

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/api/nudges/config` | `{config, state, types}` |
| `POST` | `/api/nudges/config` | `{ok, config, state, types}` |
| `GET` | `/api/nudges/feed?limit=20&includeDismissed=1` | `{items, count, total}` |
| `GET` | `/api/nudges/status` | config, estado, tipos, silencio activo, hook |
| `GET` | `/api/nudges/report?date=YYYY-MM-DD` | `{date, report}` |
| `POST` | `/api/nudges/evaluate` | `{ok, dryRun, skipped, nudges, candidates, counters, dailyReport}` |
| `POST` | `/api/nudges/:id/dismiss` | `{ok, item}` |

`POST /api/nudges/evaluate`:

- **Dry-run por defecto** (`dryRun:true`): devuelve los avisos priorizados sin
  enviar, sin escribir y sin llamar al LLM.
- `{ "dryRun": false }` evalúa de verdad (respeta silencio, cooldown y topes).
- `{ "force": false }` respeta además la cadencia entre avisos.
- Los candidatos incluyen `type`, `title`, `score`, `eventId`, `due`, `start`,
  `minutesToStart`, `daysOverdue`, `count`…

Ejemplos:

```bash
# Previsualizar sin enviar ni mutar
curl -s -X POST http://127.0.0.1:3000/api/nudges/evaluate \
  -H 'content-type: application/json' -d '{"dryRun":true}' | jq

# Evaluar de verdad y ver el feed
curl -s -X POST http://127.0.0.1:3000/api/nudges/evaluate \
  -H 'content-type: application/json' -d '{"dryRun":false}'
curl -s 'http://127.0.0.1:3000/api/nudges/feed?limit=10' | jq '.items[0]'

# Descartar un aviso (no vuelve a aparecer)
curl -s -X POST http://127.0.0.1:3000/api/nudges/NUD-0001/dismiss

# Estado del enganche al scheduler
curl -s http://127.0.0.1:3000/api/nudges/status | jq '.hook'
```

---

## 6. Entrega y redacción

- Canales: `notifyChannels` de t4, solo los configurados. Nunca se intenta
  enviar a un canal sin credenciales.
- Mensajes: **una sola frase**, sin listas ni markdown, variando plantillas
  según aviso/día. Ejemplos reales:

  > «Vencida AG-0002» sigue abierta desde hace 2 días; ¿la cierras ahora o le
  > buscas hueco?

  > Tienes 60 minutos libres a las 3:00 p. m.; úsalos para adelantar lo
  > importante.

  > La reunión «Planeación semanal» empieza a las 9:00 y no tiene lugar ni
  > enlace; define dónde será.

  > Tienes 2 mensajes sin responder en Telegram desde las 11:20.

- Si hay LLM, se reescribe el borrador con el perfil **`signals`** (máximo 45
  palabras, sin inventar datos). Respeta kill-switch, presupuesto, rate limit y
  timeout de 3,5 s para caber en el hook de 5 s. Si falla o está apagado, se
  envía la plantilla determinista.
- Los tokens/proveedor quedan en el historial (`llm.usage`).

---

## 7. Reporte diario

A partir de `reportAt` (18:00 por defecto) el primer tick genera **una vez al
día** un resumen con:

- cuántos avisos se enviaron,
- cuántos descartaste,
- qué quedó pendiente (hasta 3 asuntos).

Se guarda en `data.nudges.state.reports[YYYY-MM-DD]`, aparece en el feed como
`kind: "daily_report"` y se entrega por los mismos canales (si hay). No cuenta
para los topes de avisos. Consulta:

```bash
curl -s http://127.0.0.1:3000/api/nudges/report?date=2026-10-28 | jq
```

---

## 8. Datos persistidos y compatibilidad

Todo vive en `data.nudges` (clave nueva, incluida en backup/restore):

```
{
  version: 1,
  config: { … },                       // editable
  state: {
    counters: { dateKey, sent, dismissed, reports },
    hourBuckets: { "YYYY-MM-DDTHH": { count, at } },
    cooldowns: { overdue: ISO, … },    // por tipo
    frames: { <huella>: ISO },         // anti-duplicado
    dismissedItems: { <huella>: ISO }, // descartes
    history: [ … ≤200 … ],             // feed
    reports: { "YYYY-MM-DD": { … } },
    lastEvaluateAt, lastSentAt
  }
}
```

- `reset-demo` reinicia `data.nudges` (config y estado); la configuración se
  vuelve a sembrar con los valores por defecto al siguiente uso.
- No requiere migración de esquema: es una clave opcional.
- Los avisos no usan `notificationLog` (ese es de t8); su idempotencia es
  propia y no interfiere con los briefings/recordatorios.

---

## 9. Cómo silenciarlos

| Quiero… | Acción |
|---|---|
| Silenciar todo temporalmente | `POST /api/nudges/config {"enabled":false}` |
| Solo de noche | Ajustar `silence.from/to` o `silence.enabled:false` |
| Silenciar un tipo | Aún no hay interruptor por tipo; descarta sus avisos o sube `cooldownMin` |
| Solo un canal | `{"channels":["telegram"]}` |
| No molestar más de 1/hora | `{"maxPerHour":1}` |
| Parar el motor entero | `WORKFLOWS_AUTOSTART=0` (también apaga workflows) o `enabled:false` |

---

## 10. Autocheck (sin enviar mensajes reales)

```bash
node lib/nudges/selfcheck.mjs
```

Verifica, con `DATA_DIR` temporal y canales desactivados:

1. hook idempotente, `unregister`, paridad del tick sin handlers;
2. handler que lanza → el tick sobrevive;
3. handler lento → se corta a 5 s;
4. evaluate dry-run devuelve priorizados sin enviar ni mutar;
5. dos evaluaciones seguidas no repiten (cooldown);
6. dismiss excluye y el feed lo oculta por defecto;
7. máximo 2/hora y máximo diario;
8. de noche no genera;
9. sin canales no intenta enviar;
10. reporte diario;
11. el aviso se ejecuta dentro del tick real y queda en el feed;
12. dry-run del tick no envía ni muta.

Salida esperada: `AUTOCHECK t16: 18/18 PASS` y código 0.

---

## 11. Diagnóstico rápido

| Síntoma | Causa probable | Solución |
|---|---|---|
| No llega nada | Canales sin configurar | `GET /api/channels`; configurar en Integraciones |
| `skipped: "silence"` | Franja nocturna | `GET /api/nudges/status` → `silence` |
| `skipped: "max-per-hour"` / `"max-per-day"` | Topes | Subir `maxPerHour`/`maxPerDay` |
| `skipped: "cooldown"` (candidato) | Cooldown del tipo | Bajar `cooldownMin` o esperar |
| No veo el aviso en el feed | Fue descartado | `?includeDismissed=1` |
| `hook.registered=false` | Autostart apagado o `NODE_ENV=test` | Arrancar normal |
| El aviso tarda | Cadencia 30 min / tick 30 s | `cadenceMin` o `POST evaluate` |
| Se envió sin LLM | Sin proveedor/kill-switch | `GET /api/llm/status`; es el fallback esperado |

---

## 12. Criterios de aceptación de t16 (verificados)

- [x] `evaluate` devuelve avisos priorizados sin enviar (dry-run por defecto,
      sin mutar el store).
- [x] Dos evaluaciones seguidas no repiten el mismo aviso (cooldown + huella).
- [x] De noche (21:30–07:00) no genera.
- [x] Máximo 2 avisos por hora (y máximo diario configurable).
- [x] `dismiss` excluye el aviso en las siguientes evaluaciones.
- [x] Con canales sin configurar no se intenta enviar (`attempted:false`).
- [x] Autocheck PASS/FAIL: 18/18.
- [x] Hook de t8 documentado y probado (paridad, error aislado, timeout 5 s,
      registro idempotente, dry-run).

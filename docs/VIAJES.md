# Agenda física: lugares, viajes, Meet y tareas (t15)

Este módulo añade geografía y tiempo de viaje a Agenda Copilot P95. Todo
funciona **offline** y sin dependencias npm; Google Distance Matrix es opcional.

- Código: `lib/travel/**`
- Rutas: `lib/routes/travel.mjs`
- Autochequeo: `node lib/travel/selfcheck.mjs`
- UI/otros módulos no se tocan: las rutas se auto-descubren en `lib/routes/*.mjs`.

---

## 1. Catálogo de lugares

Persistencia: `store.places` (array). Si aún no existe se usa un catálogo semilla
en memoria con Cali, Palmira, Yumbo, el aeropuerto Alfonso Bonilla Aragón,
Bogotá, Medellín, Buenaventura, Candelaria y “Oficina Cali”. La primera mutación
(POST/PATCH/DELETE) materializa la semilla en el store.

Campos:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | `PL-0001…` |
| `name` | string | obligatorio, máx. 160 |
| `city` | string | ciudad |
| `lat`, `lon` | number | latitud −90..90, longitud −180..180 |
| `category` | enum | `ciudad, oficina, cliente, aeropuerto, hotel, planta, bodega, otro` |
| `aliases` | string[] | nombres alternativos (“aeropuerto cali”, “sede cali”) |
| `address`, `notes` | string | informativos |

### Resolución difusa

`location` de una cita se resuelve contra el catálogo con normalización
(mayúsculas, tildes, puntuación), coincidencia exacta, prefijo/contiene, solape
de tokens y distancia de edición (Levenshtein). Umbral por defecto 0.55.

Ejemplos:

- `Cali` → `PL-0001` (score 1.0)
- `Palmira, Valle` → `PL-0002` (coincide por ciudad/alias)
- `3.4516,-76.5320` → lugar efímero por coordenadas
- `https://meet.google.com/...` → se considera **en línea** (sin viaje)
- `Marte` → `null` (no se inventa un lugar)

### Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/travel/places?q=&city=&category=` | lista `{items,count,total}` |
| POST | `/api/travel/places` | crea `{item}` (201) |
| GET | `/api/travel/places/:id` | detalle `{item}` |
| PATCH | `/api/travel/places/:id` | edita campos parciales |
| DELETE | `/api/travel/places/:id` | elimina `{ok,item}` |
| GET | `/api/travel/resolve?text=Palmira` | resuelve `{item,score,method,label}` |

---

## 2. Cálculo de desplazamiento (ETA)

### Distancia

Distancia haversine (radio terrestre 6371.0088 km) entre las coordenadas de
origen y destino, redondeada a 0,1 km.

```
km = haversine(origen, destino)
```

### Perfil de velocidad y margen

| Modo | Velocidad | Margen |
|---|---|---|
| `urbano` | 22 km/h | 20 min |
| `mixto` | 45 km/h | 20 min |
| `carretera` | 70 km/h | 35 min |

`mode=auto` (por defecto):

- misma ciudad → `urbano`
- distancia ≤ 35 km → `mixto`
- distancia > 35 km → `carretera`

El margen cubre parqueo, caminata, recepción y holgura. Se puede sobrescribir
con `marginMin` en la petición.

### Franja de punta

Días laborables, en hora local de `settings.timezone`:

- 06:30–08:30
- 11:30–13:00
- 16:30–18:30

Fuera de esas ventanas el factor es 1; dentro, **1.35** sobre el tiempo base.

```
etaMin   = ceil((km / velocidad) * 60 * factorPunta)
totalMin = etaMin + marginMin
feasible = gapMin >= totalMin
```

### Google Distance Matrix (opcional)

Sin clave se usa el cálculo offline anterior. Para usar tiempos de tráfico
reales:

1. En Google Cloud habilita **Distance Matrix API** y una clave con restricción
   de IP/referrer.
2. Define `GOOGLE_DISTANCE_MATRIX_KEY` (o `GOOGLE_MAPS_API_KEY`) en el entorno
   del servidor. Nunca en el frontend ni en el repositorio.
3. Si la API falla, hay timeout (8 s), cuota agotada o no hay red, se cae
   automáticamente al cálculo offline. La respuesta indica `source:"offline"`
   o `source:"google"`.

La llamada usa `duration_in_traffic` cuando está disponible y cachea 10 minutos
por par origen/destino y bloque de 10 minutos.

### Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/travel/eta?fromPlace=Cali&toPlace=Palmira&at=2026-10-29T16:00:00-05:00&mode=auto` | estimación |
| POST | `/api/travel/eta` | igual, body JSON |
| GET | `/api/travel/config` | perfiles, márgenes, punta y si hay clave de Google |

Respuesta (top-level, sin envoltorio `item`):

```json
{
  "km": 27.2, "etaMin": 37, "marginMin": 20, "totalMin": 57,
  "feasible": false, "gapMin": 30, "mode": "mixto",
  "rush": false, "rushFactor": 1, "source": "offline",
  "from": {"name": "Cali"}, "to": {"name": "Palmira"}
}
```

---

## 3. Planificador

`POST /api/travel/plan`

```json
{
  "fromPlace": "Cali",
  "fromAt": "2026-10-29T16:00:00-05:00",
  "toPlace": "Palmira",
  "toAt": "2026-10-29T16:30:00-05:00",
  "mode": "auto",
  "durationMin": 60,
  "horizonDays": 7
}
```

Regla dura: si no se llega, el plan **nunca** devuelve un “ok” silencioso;
devuelve `feasible:false` y alternativas reales.

### Ejemplo del jefe (Cali → Palmira)

Con el catálogo semilla y el perfil `auto`:

```
km = 27.2
eta = ceil(27.2 / 45 × 60) = 37 min
margen = 20 min
total = 57 min
gap = 16:00 → 16:30 = 30 min
⇒ feasible = false
```

Alternativas devueltas (3, todas válidas):

1. **17:00** — hora mínima viable (salida 16:03).
2. **17:30** — 30 min de holgura sobre la mínima.
3. **Siguiente día hábil 09:00** — primer hueco libre de la semana sin choques
   de agenda.

La cifra exacta depende de las coordenadas y del tráfico; el ejemplo canónico
del modelo habla de ~55 min, aquí salen 57 min por la geometría real de las
coordenadas semilla. Lo importante es la regla: 30 min < 57 min ⇒ imposible.

### Alternativas

Cada alternativa incluye:

```json
{
  "at": "2026-10-29T17:30:00-05:00",
  "date": "2026-10-29",
  "why": "Opción con 30 min de holgura sobre la hora mínima",
  "kind": "minimum|comfortable|next-gap|next-day",
  "departureAt": "2026-10-29T16:33:00-05:00",
  "gapMin": 90
}
```

El “primer hueco” se busca en los próximos días hábiles (`settings.workdays`,
`settings.holidays`) entre 09:00 y 17:00, en pasos de 30 min, comprobando que
no choque con la agenda y que el viaje quepa.

---

## 4. Integración con la agenda

- `location` es un campo editable y validado (máx. 300 caracteres).
- `placeId` y `travelMode` (`auto|urbano|mixto|carretera`) son opcionales.
- Al crear o mover una cita con lugar se calcula el viaje desde el **evento
  anterior con lugar** del mismo día (o desde `settings.travel.defaultOriginPlace`
  si está configurado).
- El evento guarda `travel` y, si no llega, `travelWarning`. **Nunca se bloquea
  la creación/edición por viaje**: se avisa y se guarda el dato. Así el usuario
  decide, y el asistente puede proponer alternativas.
- `GET /api/agenda/:id/travel` recalcula en vivo y devuelve
  `{item, travel, feasible, warning, alternatives}`.

Ejemplo de `travel` en la respuesta de `/api/agenda`:

```json
{
  "resolved": true, "feasible": false,
  "fromPlace": {"name": "Cali"},
  "toPlace": {"name": "Palmira"},
  "previousEventId": "AG-0006",
  "km": 27.2, "etaMin": 37, "marginMin": 20, "totalMin": 57, "gapMin": 30,
  "warning": "No llegas a Palmira: …",
  "alternatives": [{ "at": "…", "why": "…" }]
}
```

Si la ubicación es un enlace de Meet/Zoom/Teams o contiene “virtual/remoto”, se
marca `online:true` y no se calcula viaje. Si el lugar no está en el catálogo,
`resolved:false` y no se inventa una distancia.

---

## 5. Meet (videollamada)

`POST /api/agenda/:id/meet`

- **Con Google conectado**: crea o actualiza el evento de Calendar con
  `conferenceData` (`hangoutsMeet`, `conferenceDataVersion=1`) y devuelve el
  `hangoutLink` real (`generated:false`, `provider:"google"`). Si el evento no
  tenía vínculo, lo crea y guarda `event.google`.
- **Sin Google o si falla**: entrega una sala **Jitsi real y pública**
  `https://meet.jit.si/AgendaP95-<12 hex>`, guardada en `event.meetLink` y en
  `event.meet = {provider:"jitsi", generated:false, fallback:true, note:"Sala
  Jitsi real; Google Meet requiere conectar Google"}`. **Nunca se fabrica un
  enlace `meet.google.com`**: esos enlaces solo existen si Google los creó.
- La operación es idempotente: si ya hay un `meetLink` válido, lo devuelve. Un
  enlace local viejo con formato `meet.google.com` (marcado `generated:true`) se
  regenera como Jitsi.
- `GET /api/agenda/:id/meet` devuelve el enlace guardado.

Nota: la sala Jitsi funciona sin cuenta y sin Google. Es pública: cualquiera con
el enlace puede entrar, así que se comparte con el mismo cuidado que un Meet.
Para un enlace de Google Meet real hay que conectar Google en Integraciones.

---

## 6. Tareas

Persistencia: `store.tasks`. Orígenes: `chat`, `correo`, `acta`, `manual`,
`whatsapp`, `telegram`, `agente`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/tasks?status=open|done|cancelled|all&owner=&origin=&q=&due=&eventId=` | lista + resumen |
| POST | `/api/tasks` | crea `{item}`; acepta `title` o `text` de chat |
| GET | `/api/tasks/:id` | detalle |
| PATCH | `/api/tasks/:id` | edita |
| POST | `/api/tasks/:id/close` | cierra (`{result,closedBy}`), idempotente |
| POST | `/api/tasks/:id/reopen` | reabre |
| DELETE | `/api/tasks/:id` | elimina |
| GET | `/api/tasks/summary` | totales por estado/vencidas |
| GET | `/api/tasks/parse?text=…` | probar el parser de chat |

Ejemplo:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks \
  -H 'content-type: application/json' \
  -d '{"text":"asignar tarea a Laura: revisar contrato","due":"2026-10-30","priority":"P1","origin":"chat"}'
```

Resultado: `owner:"Laura"`, `title:"revisar contrato"`, `status:"open"`.
`POST /api/tasks/:id/close` devuelve `alreadyClosed:true` si ya estaba cerrada.

Para vincular a una cita: `eventId`. Si no existe, 404 `EVENT_NOT_FOUND`.
También se puede vincular a una persona con `person`.

---

## 7. Autochequeo

```bash
node lib/travel/selfcheck.mjs
```

Usa `DATA_DIR` temporal y Google mockeado (sin red) y verifica:

- catálogo semilla, resolución difusa y CRUD;
- haversine/ETA/margen/punta;
- Cali 16:00 → Palmira 16:30 `feasible:false` con ≥2 alternativas válidas;
- traslado holgado `feasible:true`;
- evento con warning de viaje y recálculo al mover;
- Meet generado y Meet real con `conferenceDataVersion=1` (mock);
- tareas crear/listar/cerrar/idempotencia;
- rutas HTTP con contexto falso.

Salida esperada: `=== TRAVEL SELFCHECK === 35 checks, 0 failed`.

---

## 8. Configuración avanzada

`settings.travel` (si el despliegue lo siembra en el store):

```json
{
  "speeds": {"urbano": 22, "mixto": 45, "carretera": 70},
  "margins": {"urbano": 20, "mixto": 20, "carretera": 35},
  "rushFactor": 1.35,
  "rushWindows": [[6.5, 8.5], [11.5, 13.0], [16.5, 18.5]],
  "rushWeekdays": ["LUN", "MAR", "MIE", "JUE", "VIE"],
  "autoModes": {"urbanoMaxKm": 8, "mixtoMaxKm": 35},
  "defaultOriginPlace": "Oficina Cali",
  "google": {"enabled": true, "cacheMinutes": 10, "timeoutMs": 8000}
}
```

Sin `settings.travel` se usan los valores por defecto de esta documentación.

---

## 9. Límites y decisiones

- Sin dependencias npm; solo `node:*` y `fetch` global.
- Sin red obligatoria: el plan funciona con haversine y perfiles.
- No se bloquean citas por viaje; se advierte y se devuelven alternativas.
- Sin Google se entrega una sala Jitsi real (`provider:"jitsi"`); nunca se fabrica un enlace `meet.google.com`.
- Los lugares y tareas viven en el mismo store JSON (atomicidad y backup ya
  existentes); no se añaden migraciones destructivas.
- Las pruebas nunca deben tocar `data/agenda-data.json`: usar `DATA_DIR`
  temporal y un puerto ≥ 3122.



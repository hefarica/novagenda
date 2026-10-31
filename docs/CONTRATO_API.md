# CONTRATO API — Agenda Copilot P95

**Estado:** definitivo y estable para la versión `1.1.0` / `apiVersion: 1`.
**Revisión t22 (2026-10-28):** se incorporan los módulos oficina, estilo,
identidad, viajes/tareas, avisos, documentos, research, hilos y MCP (§14-§22),
con inventario de módulos (§1.12) y verificación de cobertura (§28).
**Fuente de verdad:** este documento. Si un módulo necesita cambiar una forma,
primero se actualiza aquí (backend-core) y después se implementa.
**Ámbito:** API HTTP local (`http://127.0.0.1:3000` por defecto) + módulos de
rutas auto-descubiertos. Toda la UI y los mensajes están en español.

> Convenciones del proyecto: Node 24, ES modules, **cero dependencias npm**
> (solo built-ins y `fetch`), `DATA_DIR` aislado en pruebas, sin tocar el
> `data/agenda-data.json` real ni el `.env` real.

---

## Índice

1. Reglas generales · 2. Salud y estado · 3. Autenticación · 4. Secretos ·
5. Agenda · 6. Inbox · 7. Rutinas y reuniones · 8. Canales · 9. Google ·
10. Ajustes · 11. Métricas y P95 · 12. LLM y agente · 13. Workflows, señales y backup ·
**14. Oficina** · **15. Estilo** · **16. Identidad** · **17. Viajes, Meet y tareas** ·
**18. Avisos** · **19. Documentos** · **20. Research** · **21. Hilos** · **22. MCP** ·
23. Códigos de error · 24. Persistencia · 25. Variables de entorno · 26. Ejemplos ·
27. Checklist · 28. Cobertura de rutas t13-t27.


## 1. Reglas generales

### 1.1 Transporte

- Base: `http://HOST:PORT` (`HOST=127.0.0.1` por defecto, `PORT=3000`).
- Todas las respuestas de la API son JSON UTF-8 salvo:
  - `GET /api/backup` → adjunto `application/json` con `Content-Disposition`.
  - `GET /api/whatsapp/webhook` (handshake) → `text/plain` con el challenge.
  - `GET /api/auth/google/start` y `.../callback` → `302` a Google / a `/`.
- `HEAD` funciona en todas las rutas `GET`: mismas cabeceras y
  `Content-Length` que el `GET`, sin cuerpo. `HEAD /api/health` → `200`.
- `OPTIONS` responde `204` con `Allow` para rutas existentes; `404` si la ruta
  no existe.
- `Cache-Control: no-store` en toda la API.
- Límite de cuerpo: **1 000 000 bytes** (1 MB) por defecto →
  `413 PAYLOAD_TOO_LARGE`. Excepción: `POST /api/backup/restore` admite 16 MB.
- `Content-Type` distinto de JSON en escrituras → `415 UNSUPPORTED_MEDIA_TYPE`.
- JSON inválido → `400 INVALID_JSON`, `field: "body"`.

### 1.2 Cabeceras de seguridad (todas las respuestas)

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; form-action 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(),
  magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Request-Id: <uuid de la petición>
```

`Strict-Transport-Security` solo si la petición llega por HTTPS.

### 1.3 Request-id

Toda petición recibe `X-Request-Id` (se respeta el entrante si cumple
`^[A-Za-z0-9_.:-]{8,128}$`). En errores, el body incluye `requestId`.

### 1.4 Forma de error

```json
{
  "error": "end debe ser posterior a start.",
  "code": "INVALID_RANGE",
  "field": "end",
  "details": null,
  "requestId": "8b0d…"
}
```

- `field` y `details` son opcionales (`null` si no aplican).
- `details` nunca contiene secretos; los valores sensibles se redactan.
- Errores 5xx no controlados: `{"error":"Error interno del servidor","code":"INTERNAL"}`.
- Códigos usados (lista completa en §23).

### 1.5 Envelopes

- **Listas:** `{"items":[…],"count":N,"total":M}` (+ campos extra del módulo).
- **Objeto:** `{"item":{…}}` en agenda, inbox, rutinas y métricas.
  Los recursos “de estado” (`bootstrap`, `settings`, `dashboard`, `health`,
  `auth/status`, `report/*`) devuelven el objeto **directo** sin envelope.
- Colecciones internas del store (`bootstrap.agenda`, etc.) van como arrays
  crudos por compatibilidad histórica.
- Los módulos nuevos (§14-§22) documentan su envelope exacto en cada endpoint;
  no todos usan `{item}` (por ejemplo `office` y `mcp` devuelven objetos con
  `ok`/campos directos y `{items}` en listas).

### 1.6 Fechas, horas y zona

- Instantes: ISO-8601. Se aceptan `Z`, offset explícito (`-05:00`) o **naive**
  (`2026-11-01T10:00`), que se interpreta en `settings.timezone`.
- Se **rechazan** fechas imposibles (`2026-02-31`, `2026-04-31`), horas fuera
  de rango (`25:00`) y textos (`x`, `no-es-fecha`) → `400 INVALID_DATE`.
- `dateKey`: `YYYY-MM-DD` validado contra calendario real.
- `time`: `HH:MM` 24 h (se acepta `H:MM` y `HH:MM:SS`, se normaliza a `HH:MM`).
- Internamente los instantes nuevos se guardan normalizados a UTC (`…Z`);
  los datos heredados con offset local se conservan tal cual.

### 1.7 Rangos y enumeraciones

| Campo | Valores |
|---|---|
| `priority` | `P1`, `P2`, `P3` |
| `energy` | `Alta`, `Media`, `Baja` |
| `status` (agenda) | `Pendiente`, `En curso`, `Hecho`, `Cancelada` |
| `frequency`/`cadence` | `DIARIA`, `LABORABLES`, `SEMANAL`, `MENSUAL`, `TRIMESTRAL` |
| `impact`, `urgency` | entero 1–5 |
| `score` | entero 0–100 |
| `reminderMin` | 0–1440 (rutinas admiten hasta 40320) |
| `estimatedMin`, `plannedMin` | 0–10080 |
| `theme` | `auto`, `claro`, `oscuro` |

Longitudes máximas: `title` 200, `result` 500, `notes` 4000, `context` 200,
`owner` 80, `type` 60, `input` 2000, `attendees` 50 correos, `q` 200.

### 1.8 Enrutado por módulos

`lib/routes/*.mjs` se descubre automáticamente al arrancar. Cada módulo:

```js
export const name = 'mi-modulo';   // opcional, default = nombre del archivo
export const priority = 100;       // opcional; core.mjs = 0
export const routes = [
  {
    method: 'GET',                  // 'GET'|'POST'|'PATCH'|'PUT'|'DELETE'
    path: '/api/mi-recurso/:id',    // absoluto, siempre /api/...
    name: 'mi.recurso.get',         // opcional
    auth: 'required',               // 'required'|'optional'|'none' (ver §1.9)
    localOnly: false,               // true → solo socket loopback
    rawBody: false,                 // true → ctx.rawBody() (firmas)
    maxBodyBytes: 1_000_000,
    webhook: false,                 // true → exento de check de Origin
    csrf: true,                     // false → exento de check de Origin
    handler: async (ctx) => ctx.json(200, { item })
  }
];
```

- **Conflicto de rutas:** gana mayor `priority`; empate → orden alfabético de
  archivo. Los perdedores se listan en `GET /api/health → conflicts[]`.
- **Especificidad:** el router prefiere segmentos estáticos (`/api/routines/preview`)
  sobre parámetros (`/api/routines/:id`) y luego la ruta con más segmentos.
- `HEAD` casa con rutas `GET`.
- Módulo que falla al importar: la app arranca igual y el error aparece en
  `health.modules[].error`.
- Un handler puede devolver un objeto → se serializa como `200` JSON si no
  llamó antes a `ctx.json`/`ctx.text`.

#### Contexto `ctx` disponible

| Miembro | Descripción |
|---|---|
| `ctx.req`, `ctx.res`, `ctx.url`, `ctx.method`, `ctx.path` | petición cruda |
| `ctx.params`, `ctx.query` (`URLSearchParams`) | parámetros de ruta y query |
| `ctx.requestId`, `ctx.ip`, `ctx.head` | metadatos |
| `ctx.auth` | `{required, mode:'local'|'session', configured, authenticated, user, session}` |
| `ctx.json(status, payload, headers?, {redact:false}?)` | respuesta JSON (redactada) |
| `ctx.text(status, body, contentType?)` | texto plano |
| `ctx.redirect(url, status=302)` | redirección |
| `ctx.empty(status, headers?)` | sin cuerpo |
| `await ctx.body()` | JSON parseado (`{}` si vacío); errores 400/413/415 tipados |
| `await ctx.rawBody()` | `Buffer` para firmas HMAC |
| `ctx.log.debug/info/warn/error` | log redactado |

### 1.9 Autenticación y red

Decisión al arrancar (`HOST` o `APP_HOST`; `APP_AUTH` fuerza):

| Condición | Modo | Acceso a `/api/*` |
|---|---|---|
| `HOST` loopback y `APP_AUTH` off | `local` | directo, sin login |
| `HOST≠loopback` **o** `APP_AUTH=on` | `session` | cookie de sesión obligatoria |

- Rutas públicas en ambos modos (`auth:'none'`): `GET /api/health`,
  `GET /api/auth/status`, `POST /api/auth/setup|login|logout`,
  `GET /api/auth/google/callback`, webhooks de WhatsApp/Telegram/generic.
- En modo `session`, cualquier otra `/api/*` sin cookie válida → `401
  UNAUTHENTICATED` + `WWW-Authenticate: Session`.
- `localOnly:true` exige socket loopback **y** que `X-Forwarded-For` (si existe)
  también sea loopback → si no, `403 LOCAL_ONLY`. Solo lo usa
  `POST /api/reset-demo`.
- CSRF: en `POST/PUT/PATCH/DELETE` sin `webhook`, si llega cabecera `Origin` y
  su host no coincide con `Host` (ni con `APP_URL`), → `403 BAD_ORIGIN`.
  Además de `SameSite=Strict`.
- Los webhooks están exentos de `Origin` y se validan por firma/secreto (§8).

#### Sesión

- Cookie `ac_sid=<payload>.<hmac>`: `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Secure` si HTTPS, `Max-Age` 30 días.
- Firma HMAC-SHA256 con subclave derivada de la clave maestra; payload
  `{v,sid,sub,iat,exp,ep}`. `ep` (epoch) cambia al cambiar la contraseña →
  todas las sesiones previas quedan invalidadas.
- Logout revoca el `sid` en memoria (se pierde al reiniciar, caduca a los 30 días).
- Contraseñas con `scrypt` (`N=16384,r=8,p=1`, 64 bytes, sal de 16 bytes).
- Login limitado a 5 fallos/15 min por IP → `429 TOO_MANY_REQUESTS` + `Retry-After`.

### 1.10 Programación y tareas de fondo

Los intervalos y envíos programados viven en `lib/workflows/scheduler.mjs` (t8).
`server.mjs` no programa ticks. `core.mjs` tampoco programa ticks ni envía
avisos: cualquier módulo que necesite temporizadores debe registrarlos a través
del scheduler de t8 (auto-descubierto desde `lib/routes/workflows.mjs`).
Tampoco `lib/llm/**` programa timers de negocio (ver §12): el scheduler invoca
sus workflows (`dailyBrief`, `middayCheck`, `dailyClose`, `weeklyReview`).

El estado compartido `notificationLog` se conserva en el store con las claves
`<job>:<YYYY-MM-DD>` (briefing/mediodía/cierre/semanal) y
`<eventId>:<startISO>` (recordatorios), para que t8 reutilice exactamente las
mismas claves sin migración.

### 1.11 Bóveda de secretos y redacción
- Los valores se cifran con **AES-256-GCM** en `store.secrets[name]`
  (subclave derivada de la clave maestra).
- **Prioridad:** variable de entorno > bóveda > default.
- Al arrancar, los valores de la bóveda se materializan en `process.env` para
  los módulos heredados (canales/Google) sin editar su código.
- El valor en claro **nunca** vuelve al frontend ni se escribe en logs.
  La API solo devuelve `configured`, `source` y `hint` (`••••` + últimos 4).
- Redacción en capas: valores registrados, patrones (`Bearer`, JWT, `sk-*`,
  `AIza*`, tokens de bot, GitHub, AWS, PEM) y claves sensibles en objetos.
  Se aplica a logs (`console.*` parcheado), stacks y respuestas.
- Cambiar la clave maestra (`AGENDA_MASTER_KEY`/`APP_SECRET`/`.master-key`)
  invalida secretos y tokens guardados; el backup no incluye la clave.

### 1.12 Inventario de módulos y rutas

`health.routes` cuenta las rutas **efectivas** (215); `modules[].routes` cuenta
las **declaradas** por cada módulo (236). La diferencia son 21 conflictos de
rutas heredadas (`core` pierde frente a `agenda`, `inbox`, `routines` y
`channels`; `docs` pierde `POST /api/docs/:id/send-email` frente a `channels`
por prioridad), visibles en `health.conflicts[]`.

| Módulo | priority | rutas declaradas |
|---|---:|---:|
| `core` | 0 | 48 |
| `agenda` | 100 | 21 |
| `inbox` | 100 | 7 |
| `routines` | 100 | 15 |
| `channels` | 200 | 30 |
| `llm` | 120 | 17 |
| `workflows` | 100 | 15 |
| `office` | 130 | 16 |
| `style` | 120 | 5 |
| `identity` | 120 | 4 |
| `travel` | 100 | 22 |
| `nudges` | 100 | 7 |
| `docs` | 120 | 9 |
| `research` | 100 | 8 |
| `thread` | 120 | 3 |
| `mcp` | 140 | 9 |
| **Total** | — | **236** |

Los módulos t13-t27 no tienen conflictos entre sí; su cobertura exacta está en
§28. El orden de resolución y la especificidad se describen en §1.8.

Ninguna ruta de §14-§22 es pública: todas usan `auth:'default'`. Solo siguen
siendo públicas las rutas históricas de salud, setup/login/logout, callback de
Google y webhooks descritas en §1.9.

---

## 2. Salud y estado

### `GET /api/health` — público

`200` siempre que el proceso viva (aunque el store esté degradado).

```json
{
  "ok": true,
  "status": "ok",
  "app": "Agenda Copilot P95",
  "version": "1.1.0",
  "apiVersion": 1,
  "time": "2026-10-27T17:00:00.000Z",
  "uptimeSec": 42,
  "node": "v24.12.0",
  "port": 3000,
  "host": "127.0.0.1",
  "auth": {"required": false, "mode": "local", "configured": false},
  "store": {
    "readOnly": false, "version": 2, "schemaVersion": 2,
    "loadError": null, "loadWarning": null, "persistError": null,
    "lastSavedAt": "…"
  },
  "vault": {"catalog": 25, "stored": 1, "configured": 2, "fromEnv": 1, "decryptFailures": []},
  "channels": {
    "whatsapp": {"configured": false, "phoneNumberId": null},
    "telegram": {"configured": false},
    "email": {"configured": false, "to": null}
  },
  "office": {"enforceOutbound": true, "allowDirectSend": false, "allowAutonomousOutbound": false},
  "webhooksStrict": false,
  "routes": 215,
  "modules": [
    {"name": "core", "file": "core.mjs", "priority": 0, "routes": 48, "ok": true},
    {"name": "agenda", "file": "agenda.mjs", "priority": 100, "routes": 21, "ok": true}
  ],
  "conflicts": [
    {"method": "GET", "path": "/api/report/weekly", "ignored": "core", "winner": "agenda", "reason": "ruta duplicada (gana mayor priority)"}
  ]
}
```

- `modules[].routes` es el conteo **declarado** de cada módulo; `conflicts[]`
  indica los ganadores/ignorados. El ejemplo anterior muestra solo dos módulos;
  el inventario completo (16 módulos, **236 declaradas**, **215 efectivas** y
  **21 conflictos**) está en §1.12. Las rutas nuevas §14-§22 no generan
  conflictos; `POST /api/docs/:id/send-email` y `/api/channels/:id/send` forman
  parte de los cambios de canales.
- Store corrupto → `ok:false`, `status:"degraded"`, `store.readOnly:true` y
  `store.loadError` con el motivo. Las escrituras → `503 STORE_READ_ONLY`.

### `HEAD /api/health`

`200` con cabeceras y `Content-Length`, sin cuerpo (usado por el lanzador y CI).

### `GET /api/bootstrap` — autenticado (salvo modo local)

Estado completo para el frontend:

```json
{
  "version": "1.1.0", "apiVersion": 1,
  "settings": {…}, "agenda": […], "inbox": […], "recurrences": […],
  "meetings": […], "okrs": […], "activity": [ …20 ],
  "dashboard": {…}, "googleConnections": [ {…sin token…} ],
  "channels": {…}, "serverTime": "…", "timezone": "America/Bogota",
  "auth": {"required": false, "mode": "local", "configured": false,
           "authenticated": true, "user": "local", "sessionExpiresAt": null},
  "store": {"readOnly": false, "version": 2, "schemaVersion": 2, "error": null},
  "vault": [{"name": "llm.openai.apiKey", "group": "llm", "label": "OpenAI API Key",
             "configured": true, "source": "store", "secret": true}]
}
```

Nunca incluye valores de secretos, tokens de Google ni hashes.

### `GET /api/dashboard` — autenticado (módulo `agenda`)

Devuelve `dashboard()` de `lib/assistant.mjs`: `date, p95, execution, focusMin,
overdue, meetingMin, okrProgress, total, done, pending, conflicts, todayEvents,
top3`. El índice P95 y el score de prioridad se calculan con el motor de
`lib/agenda/p95.mjs` y `lib/agenda/score.mjs`.

### `GET /api/activity?limit=30` — autenticado

`{"items":[{"at","type","text",…}],"count":N}` (máx 100).

### `POST /api/assistant` — autenticado

Compatibilidad con el asistente determinista (comandos históricos intactos).

```json
{"text":"CAPTURA llamar a Juan"}
```

```json
{"reply":"📥 Capturado IN-0002: llamar a Juan"}
```

- `200` con `{reply, event?, dashboard?}`.
- Comandos garantizados sin LLM: `HOY`, `CAPTURA …`, `HECHO AG-xxxx`,
  `POSPONER|MOVER AG-xxxx N`, `FOCO N título`, `CIERRE`, `SEMANA`, `balance`,
  `agenda …`, respuestas `1|2|3` a alternativas pendientes.
- `400 REQUIRED` si `text` falta o está vacío; máximo 4000 caracteres.
- t3 implementa `/api/agent/chat` (y su alias `/api/agent/command`) con el
  agente LLM/ determinista: ver §12. `POST /api/assistant` sigue siendo la vía
  determinista garantizada y no depende del LLM.

---

## 3. Autenticación

### `GET /api/auth/status` — público

```json
{
  "authRequired": true, "mode": "session", "host": "0.0.0.0",
  "configured": true, "authenticated": false, "user": null,
  "sessionExpiresAt": null,
  "setupRequired": false, "setupAvailable": false, "setupRequiresToken": true,
  "setupPolicyReason": "already-configured",
  "username": "owner", "lastLoginAt": "2026-10-27T…",
  "cookieSecure": false, "ttlSeconds": 2592000
}
```

### `POST /api/auth/setup` — público (solo primera vez)

```json
{"username":"owner","password":"ClaveSegura123"}
```

- `201` + `Set-Cookie` y `{ok:true,user:{username},expiresAt,auth}`.
- Solo si `configured=false`; si ya existe → `409 AUTH_ALREADY_CONFIGURED`.
- Desde loopback siempre permitido. Desde red exige `APP_SETUP_TOKEN` en
  `setupToken`; si no → `403 SETUP_FORBIDDEN`
  (`details.requiresToken:true`).
- Contraseña 8–200 caracteres → `400 WEAK_PASSWORD` si no cumple.

### `POST /api/auth/login` — público

```json
{"username":"owner","password":"ClaveSegura123"}
```

- `200` + cookie y `{ok:true,user:{username},expiresAt}`.
- Credenciales malas → `401 UNAUTHENTICATED` (mensaje genérico).
- Sin cuenta configurada → `409 AUTH_NOT_CONFIGURED`.
- 5 fallos/15 min por IP → `429 TOO_MANY_REQUESTS`.

### `POST /api/auth/logout` — público

Revoca la sesión actual (si existe) y limpia la cookie.
`200 {"ok":true,"revoked":true|false}`.

### `POST /api/auth/password` — autenticado

```json
{"currentPassword":"ClaveSegura123","newPassword":"NuevaClave456"}
```

- `200` + nueva cookie (epoch incrementado: el resto de sesiones caducan).
- Actual incorrecta → `401`; nueva débil → `400 WEAK_PASSWORD`;
  igual a la actual → `400 SAME_PASSWORD`.

---

## 4. Secretos (bóveda)

### Catálogo

| Nombre | Variable de entorno | Secreto |
|---|---|---|
| `llm.provider` | `LLM_PROVIDER` | no (default `auto`) |
| `llm.openai.apiKey` | `OPENAI_API_KEY` | **sí** |
| `llm.openai.baseUrl` | `OPENAI_BASE_URL` | no (`https://api.openai.com/v1`) |
| `llm.openai.model` | `OPENAI_MODEL` | no (`gpt-4o-mini`) |
| `llm.ollama.url` | `OLLAMA_URL` | no (`http://127.0.0.1:11434`) |
| `llm.ollama.model` | `OLLAMA_MODEL` | no (`llama3.2:3b`) |
| `llm.timeoutMs` | `LLM_TIMEOUT_MS` | no (`20000`) |
| `channels.whatsapp.enabled` | `WA_ENABLED` | no |
| `channels.whatsapp.accessToken` | `WA_ACCESS_TOKEN` | **sí** |
| `channels.whatsapp.verifyToken` | `WA_VERIFY_TOKEN` | **sí** |
| `channels.whatsapp.appSecret` | `WA_APP_SECRET` | **sí** |
| `channels.whatsapp.phoneNumberId` | `WA_PHONE_NUMBER_ID` | no |
| `channels.whatsapp.defaultTo` | `WA_DEFAULT_TO` | **sí** |
| `channels.whatsapp.templateName` | `WA_TEMPLATE_NAME` | no |
| `channels.whatsapp.templateLanguage` | `WA_TEMPLATE_LANGUAGE` | no (`es_CO`) |
| `channels.telegram.enabled` | `TELEGRAM_ENABLED` | no |
| `channels.telegram.botToken` | `TELEGRAM_BOT_TOKEN` | **sí** |
| `channels.telegram.webhookSecret` | `TELEGRAM_WEBHOOK_SECRET` | **sí** |
| `channels.telegram.defaultChatId` | `TELEGRAM_DEFAULT_CHAT_ID` | **sí** |
| `channels.email.enabled` | `EMAIL_ENABLED` | no |
| `channels.email.to` | `NOTIFY_EMAIL_TO` | **sí** |
| `webhooks.generic.secret` | `WEBHOOK_SECRET` | **sí** |
| `google.clientId` | `GOOGLE_CLIENT_ID` | no |
| `google.clientSecret` | `GOOGLE_CLIENT_SECRET` | **sí** |
| `app.publicUrl` | `APP_URL` | no |

### `GET /api/secrets` — autenticado

```json
{
  "items": [
    {"name":"llm.openai.apiKey","env":"OPENAI_API_KEY","label":"OpenAI API Key",
     "group":"llm","secret":true,"configured":true,"source":"store",
     "hint":"••••3456","updatedAt":"2026-10-27T…"},
    {"name":"llm.ollama.model","env":"OLLAMA_MODEL","label":"Modelo Ollama",
     "group":"llm","secret":false,"configured":true,"source":"default",
     "hint":"llama3.2:3b","value":"llama3.2:3b","updatedAt":null}
  ],
  "groups": {"llm":[…],"channels":[…],"webhooks":[…],"google":[…],"app":[…]},
  "vault": {"catalog":25,"stored":1,"configured":2,"fromEnv":1,"decryptFailures":[]}
}
```

- Entradas `secret:true`: **nunca** `value`; solo `hint` (últimos 4).
- Entradas `secret:false`: incluyen `value` (no son credenciales).
- `source`: `env` | `store` | `default` | `null`.

### `PUT /api/secrets/:name` — autenticado

```json
{"value":"sk-…"}
```

- `200 {"ok":true,"secret":{…estado sin valor…}}`.
- Nombre desconocido → `404 UNKNOWN_SECRET`; valor vacío → `400 REQUIRED`;
  demasiado largo → `400 TOO_LONG`.
- Actualiza `process.env` del proceso para que canales/LLM lo vean al instante.

### `DELETE /api/secrets/:name` — autenticado

`200 {"ok":true,"deleted":true,…estado…}`. Si el valor venía de la bóveda se
elimina también de `process.env`; una variable definida por el usuario no se toca.

---

## 5. Agenda

> Implementado por el módulo `agenda` (priority 100). `core.mjs` conserva una
> versión de respaldo con la misma validación; si el módulo no carga, sigue
> funcionando (envelope directo en vez de `{item}`).

### `GET /api/agenda` — autenticado

Query: `from`, `to` (ISO o `YYYY-MM-DD`), `date`, `status`, `type`, `q`,
`limit` (1–2000, def. 500), `order` (`start`|`score`).

`200`:

```json
{
  "items": [{
    "id":"AG-0006","start":"2026-10-28T19:00:00.000Z","end":"…",
    "title":"Prueba","type":"Foco","result":"","priority":"P1",
    "impact":3,"urgency":3,"energy":"Media","status":"Pendiente","owner":"Yo",
    "due":"2026-10-28","plannedMin":60,"actualMin":0,"score":72,
    "deepFocus":false,"context":"","notes":"","attendees":[],
    "google":null,"syncError":null,"createdAt":"…","updatedAt":"…"
  }],
  "count": 1, "total": 1, "date": null
}
```

Cuando el evento no está vinculado a Google, `google` y `syncError` vienen como
`null` (no `undefined`) para que el frontend no tenga que comprobarlo.

Filtros inválidos `status` u `order` → `400 INVALID_VALUE`. `from`/`to`
malformados se ignoran (no aplican filtro): usa ISO o `YYYY-MM-DD`.

### `POST /api/agenda` — autenticado

Campos admitidos: `title` (obligatorio), `start`, `end` (obligatorios salvo que
uses la alternativa `date` + `time` + `durationMin`), `type`, `result`,
`priority`, `impact`, `urgency`, `energy`, `status`, `owner`, `reminderMin`,
`whatsapp`, `calendar`, `due`, `plannedMin`, `actualMin`, `score`, `deepFocus`,
`context`, `notes`, `attendees` (correos), `category`, `objective`, `okrId`,
`delegable`, `location`.

Alternativa a `start`/`end`: `date` (`YYYY-MM-DD`) + `time` (`HH:MM`) +
`durationMin` (5–720); el servidor calcula ambos instantes en
`settings.timezone`. La usan el asistente y `POST /api/inbox/:id/convert`.

Controles (no se guardan en el evento): `force` (ignora conflicto),
`check` (default `true`), `allowUnverified`.

`201`:

```json
{"item": { …evento creado… }}
```

Errores:

| Caso | Status | code | field |
|---|---|---|---|
| `start`/`end` ausentes | 400 | `REQUIRED` | `start`/`end` |
| fecha imposible / texto | 400 | `INVALID_DATE` | `start`/`end` |
| `end ≤ start` o rango > 31 días | 400 | `INVALID_RANGE` | `end` |
| campo no permitido | 400 | `UNKNOWN_FIELD` | `<campo>` |
| solape con otro evento/Google | 409 | `CONFLICT` | — (`details.conflicts[]`) |
| Google sin verificar y sin `allowUnverified` | 409 | `FREEBUSY_UNAVAILABLE` | — |

### `GET /api/agenda/:id` — autenticado

`200 {"item":{…}}`; inexistente → `404 NOT_FOUND`.

### `PATCH /api/agenda/:id` — autenticado

Mismos campos que el alta (todos opcionales) + `force`/`check`/`allowUnverified`.
`id`, `google`, `createdAt`, `syncError`, `recurrentId`, `meetingId` no son
editables → `400` con `code` `UNKNOWN_FIELD` o `FIELD_NOT_EDITABLE` y
`field` igual al campo.

`200 {"item":{…},"changed":["title"]}`.

Reglas: si cambia `start`/`end` se revalida el rango y se comprueban conflictos
(salvo `force`); si pasa a `Hecho` se fija `completedAt` y `actualMin`; si sale
de `Hecho` se limpia `completedAt`; si el evento está sincronizado con Google
se actualiza el evento remoto (`410` → se marca para resync).

### `DELETE /api/agenda/:id` — autenticado

Cancelación lógica: `200 {"ok":true,"item":{…status:"Cancelada"…},"google":…}`.

### `POST /api/agenda/:id/cancel` — autenticado

Igual que `DELETE`.

### `DELETE /api/agenda/:id/hard` — autenticado

Eliminación física: `200 {"ok":true,"item":{…}}`.

### `POST /api/agenda/:id/complete` — autenticado

```json
{"actualMin":45,"notes":"cerrado en reunión"}
```

`200 {"item":{…}}` con `status:"Hecho"`, `completedAt` y `actualMin`.

### `GET /api/agenda/slots` — autenticado

Query: `durationMin` (5–720, def. 60), `from` (ISO/fecha), `days` (1–60),
`count` (1–10), `ignoreId`, `includeWeekend`.

`200 {"slots":[{"start","end",…}],"errors":[],"unknown":false,"horizon":{…}}`.
`unknown` es booleano: `true` = no se pudo verificar disponibilidad externa
(Google) y el resultado es parcial; `errors[]` detalla los motivos.

### `GET /api/agenda/conflicts` — autenticado

Query: `start`, `end`, `ignoreId`.

`200 {"conflicts":[…],"conflictCount":N,"errors":[],"unknown":false,
"canBook":true,"warnings":[]}`. Faltan `start`/`end` → `400`.

### `GET /api/agenda/:id/slots` y `GET /api/agenda/:id/conflicts`

Igual que los anteriores usando el evento como referencia. `404` si no existe.

### `POST /api/agenda/recalculate-scores` — autenticado

`200 {"ok":true,"changed":N}` (recalcula el score de prioridad de toda la agenda).

---

## 6. Inbox

### `GET /api/inbox` — autenticado

Query: `processed` (`true|false`), `source`, `q`, `limit` (1–2000, def. 500).
`200 {"items":[…],"count":N,"total":M}`.

### `POST /api/inbox` — autenticado

```json
{"input":"Preparar propuesta","source":"App","type":"Tarea","context":"Móvil",
 "actionable":true,"due":"2026-10-30","estimatedMin":30,"priority":"P2","notes":""}
```

`input` obligatorio (1–2000). `201 {"item":{…id:"IN-xxxx",processed:false,agendaId:null…}}`.

### `GET /api/inbox/:id` — autenticado

`200 {"item":{…}}`; `404` si no existe.

### `PATCH /api/inbox/:id` — autenticado

Campos: `input`, `type`, `context`, `actionable`, `due`, `estimatedMin`,
`priority`, `notes`, `source`, `processed`, `dismissed`.
`200 {"item":{…}}`. Campos extra → `400 UNKNOWN_FIELD`.

### `DELETE /api/inbox/:id` — autenticado

`200 {"ok":true,"item":{…}}`.

### `POST /api/inbox/:id/convert` — autenticado

Convierte la captura en cita:

```json
{"start":"2026-10-30T09:00:00-05:00","end":"2026-10-30T10:00:00-05:00"}
```

Alternativas: `{"date":"2026-10-30","time":"09:00","durationMin":45}` o sin
horario (usa el primer hueco). Controles `force`, `check`, `allowUnverified`.

`200 {"item":{…captura…},"event":{…cita creada…}}`.
Errores: `409 ALREADY_PROCESSED`, `409 NO_SLOT`, `409 CONFLICT`,
`409 FREEBUSY_UNAVAILABLE`, `400 INVALID_DATE`/`INVALID_RANGE`.

### `POST /api/inbox/:id/dismiss` — autenticado

`200 {"item":{…dismissed:true…}}`.

---

## 7. Rutinas y reuniones

Un único motor (`lib/agenda/routines.mjs`) con `kind: 'recurrence' | 'meeting'`.
`recurrences` y `meetings` siguen existiendo en el store (compatibilidad).

### `GET /api/routines` — autenticado

Query: `kind` (`recurrence|meeting`), `active` (`true|false`), `q`.
`200 {"items":[rutinaNormalizada],"count":N,"total":M}`.
Cada item incluye `nextDate`, `nextStart`, `raw`.

### `POST /api/routines` — autenticado

Campos: `kind`, `active`, `title` (o `name`), `frequency` (o `cadence`),
`rule`, `time` (`HH:MM`), `durationMin` (5–720), `type`, `result`, `priority`,
`impact`, `urgency`, `deepFocus`, `energy`, `reminderMin`, `whatsapp` (o
`whatsappReminder`), `calendar`, `owner`, `start`/`startDate`, `end`/`endDate`,
`notes`, `skipHolidays`, `role`, `exceptions` (o `skipDates`), `purpose`,
`requiredOutput`, `participants`, `effectiveness`, `preRead`, `agendaLink`.

`201 {"item":{…}}`. Campos extra → `400 UNKNOWN_FIELD`; regla semanal/mensual
inválida → `400 INVALID_VALUE`/`INVALID_FORMAT`.

### `GET|PATCH|DELETE /api/routines/:id`

- `GET` → `200 {"item":{…}}`.
- `PATCH` (mismos campos, todos opcionales) → `200 {"item":{…}}`.
- `DELETE` → `200 {"ok":true,"item":{…}}` (conserva por defecto las citas ya
  generadas: `keepGenerated`).

### `POST /api/routines/:id/toggle`

`{"active":true}` (o vacío para invertir) → `200 {"item":{…}}`.

### `POST /api/routines/:id/skip`

`{"date":"2026-10-30","reason":"feriado"}` → `200 {"item":{…},"date":"…","cancelled":N}`
(añade la excepción y cancela la ocurrencia de ese día si existe).

### `GET /api/routines/:id/preview?count=30&from=YYYY-MM-DD`

`200 {"items":[{"date","start","end","endLocal","skipped","due"}],
"count":N,"total":N,"id":"R-001","requested":30}`.

### `POST /api/routines/preview` — borrador sin guardar

Mismo body que `POST /api/routines`. `200` con el mismo envelope de preview +
`"routine":{…borrador normalizado…}`.

### `POST /api/routines/materialize`

`{"todayKey":"2026-10-27"?}` → materializa hoy (idempotente). Lo ejecuta el
scheduler de t8 en su tick diario o una llamada explícita.
`200 {"ok":true,"summary":{"from","to","created":[…],"skipped":N,"errors":[],
"generated":N,"today","lastRun","backfilled"}}`.

### `GET /api/routines/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD`

`200 {"items":[{date,start,end,routineId,title,kind,…}],"count","total","from","to","timezone"}`.

### Compatibilidad histórica

- `GET /api/recurrences` ≡ `GET /api/routines?kind=recurrence` (`{items,count,total}`).
- `GET /api/meetings` ≡ `GET /api/routines?kind=meeting`.
- `PATCH /api/recurrences/:id` y `PATCH /api/meetings/:id` → validador de rutinas.
- `DELETE /api/meetings/:id` → elimina la reunión (misma semántica que `DELETE /api/routines/:id`); responde `{ok,removed,removedGenerated}` y audita el cambio.

### Materialización

El scheduler de t8 (`lib/workflows/scheduler.mjs`) llama en su tick diario a
`materializeRoutines({backfillDays:7})` de `lib/assistant.mjs` (motor canónico):
rellena días perdidos, hace clamp 31→fin de mes, respeta festivos/excepciones y
calcula el score de cada cita generada. Es idempotente por rutina+fecha
(`event.routineId`/`recurrentId`/`meetingId` + día). `server.mjs` no programa
ticks ni materializa al arrancar; no existe doble motor.

---

## 8. Canales (módulo `channels`, priority 200)

> Implementado por `lib/routes/channels.mjs` y `lib/channel/**`; **30 rutas**.
> `auth:'default'` salvo webhooks y callback OAuth (`auth:'none'`). Los envíos a
> terceros **no se ejecutan directos**: crean una propuesta de la Oficina (202) y
> solo salen al aprobar/ejecutar `POST /api/office/proposals/:id/execute`.
> Persistencia: `data.channelState` y el ledger de Oficina; los ejecutores de
> canal viven en `lib/channel/executors.mjs` y se registran en el registro de
> `lib/office/executors.mjs` (email/WhatsApp/Telegram/simulador con adjuntos).

### Rutas (30)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/channels/approvals/pending` | propuestas pendientes de aprobación |
| GET | `/api/channels/approvals/status` | estado del centro de aprobaciones |
| POST | `/api/channels/approvals/config` | configuración de aprobaciones |
| POST | `/api/channels/approvals/:id/send` | enviar tarjeta de aprobación |
| POST | `/api/channels/approvals/:id/remind` | recordar propuesta pendiente |
| POST | `/api/channels/:id/send` | crear propuesta de salida (nueva) |
| POST | `/api/channels/send-document` | crear propuesta con documento |
| GET | `/api/channels/documents/status` | salud de documentos de canal |
| GET | `/api/channels/documents/:docId` | resolver documento de canal |
| GET | `/api/channels` | estado de todos los canales |
| GET | `/api/channels/health` | salud del subsistema |
| GET | `/api/channels/inbox` | bandeja normalizada |
| GET | `/api/channels/messages` | alias de bandeja |
| POST | `/api/channels/simulate` | conversación local sin red |
| GET | `/api/channels/email/oauth/start` | OAuth Gmail (lectura) |
| GET | `/api/channels/email/oauth/callback` | callback OAuth Gmail |
| GET | `/api/channels/:id` | estado de un canal |
| POST | `/api/channels/:id/config` | credenciales/ajustes |
| POST | `/api/channels/:id/test` | prueba solo al dueño/simulador |
| POST | `/api/channels/:id/enable` | activar/desactivar |
| POST | `/api/channels/telegram/poll` | pasada manual de getUpdates |
| POST | `/api/channels/telegram/delete-webhook` | borrar webhook de Telegram |
| POST | `/api/channels/email/poll` | revisión manual de Gmail |
| POST | `/api/channels/inbound/:id` | webhook genérico autenticado |
| POST | `/api/webhooks/generic` | alias del webhook genérico |
| POST | `/api/docs/:id/send-email` | propuesta de correo con documento |
| POST | `/api/whatsapp/test` | prueba al dueño (heredada) |
| POST | `/api/telegram/test` | prueba al dueño (heredada) |
| POST | `/api/whatsapp/webhook` | webhook Meta |
| POST | `/api/telegram/webhook` | webhook Telegram |

### Salida a terceros = propuesta

`lib/channel/outbound.mjs` convierte `/send`, `/send-document` y
`/docs/:id/send-email` en propuestas N2; **no envía**. El envío real solo ocurre
tras aprobar/ejecutar la propuesta y usa el ejecutor del canal. El ledger registra
`proposal.created`, `proposal.approved`, `proposal.executed` (y
`email.direct_override` si se usa el override de Gmail de §8.4).

> **Autonomía explícita (opt-in, t35):** las rutas de canal fuerzan propuesta
> pendiente (`forceApproval`) salvo que `settings.office.allowAutonomousOutbound
> === true`, el modo sea `total`/`autonomo`, el riesgo sea ≤2, el destinatario
> sea un contacto conocido y el nivel no sea N3. En ese caso se aprueba y
> ejecuta automáticamente; **antes del envío** se registra
> `outbound.autonomous` en el ledger. Sin el flag o sin cualquier condición
> queda `pending`, incluso en modo total. N3 nunca se auto-ejecuta. Detalle:
> [CANALES.md §Autonomía de salida](CANALES.md#autonomía-de-salida-opt-in-t35).

### WhatsApp Cloud API

`GET /api/whatsapp/webhook` (público, handshake):

- `hub.mode=subscribe` + `hub.verify_token` correcto → `200 text/plain` con `hub.challenge`.
- Token incorrecto → `403 VERIFY_TOKEN_INVALID`.
- Sin `WA_VERIFY_TOKEN`: modo local → `403`; modo estricto → `503 WEBHOOK_SECRET_MISSING`.

`POST /api/whatsapp/webhook` (público, firma):

- Verifica `x-hub-signature-256` con `channels.whatsapp.appSecret` (HMAC-SHA256 hex).
- Firma inválida → `401 WEBHOOK_SIGNATURE_INVALID`.
- Sin secreto: modo local procesa con warning; `NODE_ENV=production` o red →
  `503 WEBHOOK_SECRET_MISSING`.
- Responde `200 {"received":true}` de inmediato y procesa en segundo plano.

`POST /api/whatsapp/test` — autenticado. Prueba **solo al dueño configurado o al
simulador**; un `to` fuera de la lista blanca → `403 NOT_OWNER` con
`details.listField` (`allowedNumbers`). Si el destino se omite, se usa el dueño
por defecto. Cuerpo `{"to":"573001112233","text":"Prueba"}`; respuesta del
adaptador o `502 CHANNEL_ERROR`.

### Telegram

`POST /api/telegram/webhook` (público, secreto):

- Cabecera `x-telegram-bot-api-secret-token` comparada en tiempo constante con
  `channels.telegram.webhookSecret`.
- Sin secreto: local → warning; estricto → `503`.
- Secreto inválido → `401`. Responde `200 {"received":true}` y procesa async.

`POST /api/telegram/test` — autenticado `{"chatId":"123","text":"Prueba"}`.
Prueba solo al dueño configurado (`allowedChatIds`) o simulador; tercero →
`403 NOT_OWNER` con `details.listField`. `POST /api/telegram/set-webhook` sigue
registrando `APP_URL/api/telegram/webhook`.

### 8.1 `POST /api/channels/:id/send` (nueva)

Canales que aceptan propuesta: `email`, `whatsapp`, `telegram`, `simulator`
(otros → `400 CHANNEL_NO_PROPOSAL`). Autenticado.

```json
{"to":["tercero@example.com"], "subject":"Propuesta", "body":"Hola",
 "attachments":["DOC-…"]}
```

- `to`/`recipients`: 1–20; `body` 1–20000; `subject` ≤300; `attachments` ≤10
  (referencias de documentos). `to` puede ser string o array.
- **No envía**; crea propuesta N2 y responde **202**:

```json
{
  "status": "pending_approval",
  "approvalRequired": true,
  "proposal": {
    "id": "OF-0001", "level": "N2", "status": "pending",
    "channel": "email", "recipients": ["tercero@example.com"],
    "subject": "Propuesta", "body": "Hola", "attachments": [],
    "createdAt": "…",
    "policy": {"mode":"asistido","action":"approve","requiresApproval":true,"requiresCode":false,"reason":"…"},
    "card": {"title":"N2 · email · OF-0001","summary":"…","actions":["approve","reject"]}
  },
  "auto": false,
  "executed": false,
  "message": "Pendiente de aprobación en la Oficina. No se ha enviado nada.",
  "approvalUrl": "/api/office/proposals/OF-0001"
}
```

- Errores reales: `400 REQUIRED|INVALID_TYPE|TOO_LONG|UNKNOWN_FIELD|
  CHANNEL_NO_PROPOSAL|UNKNOWN_CHANNEL|VALIDATION` (con `field` cuando aplica).
- `message` y `approvalUrl` están presentes desde t35. El `proposal` no incluye
  `risk`/`flags` en esta respuesta (sí `policy` y `card`); la forma objetivo de
  t34 los mencionaba, pero el código actual no los devuelve. La UI puede usar
  `proposal.id` y `approvalUrl`.
- La implementación actual **no** aplica `NOT_OWNER` a `/send`: un tercero se
  convierte en propuesta (es el flujo seguro). `NOT_OWNER` se aplica a `/test`
  (§8.3). Tampoco hay un 503 propio de esta ruta: si la Oficina no puede crear la
  propuesta se propaga el error tipado correspondiente.

### 8.2 `POST /api/channels/send-document`

Canales `email|whatsapp|telegram|simulator`. Autenticado. **Ya no acepta
inline** (`filename`+`base64`): exige un `docId` resoluble.

```json
{"docId":"DOC-20261028-…", "channel":"email", "to":"tercero@example.com",
 "subject":"Acta", "caption":"Adjunto el acta", "connectionId":"opcional"}
```

- `docId` obligatorio (≤160). `to` opcional: si falta se usa el dueño por
  defecto del canal; para terceros se crea propuesta.
- `202`:

```json
{
  "status": "pending_approval", "approvalRequired": true,
  "proposal": {"id":"OF-0003","level":"N2","status":"pending",
    "channel":"email","recipients":["tercero@example.com"],
    "subject":"Acta","body":"Adjunto el acta","attachments":["DOC-…"],
    "createdAt":"…","policy":{…},"card":{…}},
  "doc": {"id":"DOC-20261028-…","filename":"acta.docx",
    "mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "size":6814,"type":"docx","origin":"t17"},
  "auto": false, "executed": false,
  "message": "Pendiente de aprobación en la Oficina. No se ha enviado nada.",
  "approvalUrl": "/api/office/proposals/OF-0003"
}
```

- Errores reales: `400 REQUIRED` (`docId`), `VALIDATION`, `UNKNOWN_FIELD`,
  `CHANNEL_NO_PROPOSAL`, `UNKNOWN_CHANNEL`, `TOO_LONG`; `404 DOC_NOT_FOUND`;
  `413 DOC_TOO_LARGE`. La implementación actual no emite `403 NOT_OWNER`, `409`
  ni `503` propios en esta ruta; el resumen de t34 los mencionaba, pero el código
  solo valida canal/docId y crea la propuesta.

### 8.3 `POST /api/channels/:id/test` y rutas heredadas

Autenticado. Cuerpo `{to?, chatId?, text?}`. Prueba real del adaptador **solo**
contra el dueño configurado o el simulador:

- `to`/`chatId` fuera de la lista blanca → `403 NOT_OWNER` con
  `details:{channel,listField,hint}`; `listField` ∈ `allowedNumbers` (WhatsApp),
  `allowedChatIds` (Telegram), `allowFrom` (email) o
  `approvals.owners.<canal>`.
- `simulator` está exento.
- Destino omitido → se usa el dueño por defecto.
- `200` con `{...result,item:getChannel(id)}` (`result` incluye `ok`, `detail` y
  `result`/`item` del adaptador); canal desconocido → `404`, no listo →
  `409 CHANNEL_NOT_READY`/`NOT_CONFIGURED`, fallo del proveedor → `502
  CHANNEL_ERROR`.

Las rutas heredadas `/api/whatsapp/test` y `/api/telegram/test` están
implementadas por `channels.mjs` (priority 200) y aplican la misma regla:
tercero → `403 NOT_OWNER` con `details.listField`. `/api/telegram/set-webhook`
sigue en `core.mjs`.

### 8.4 `POST /api/docs/:id/send-email` (ruta efectiva)

La ruta efectiva la sirve `channels.mjs` (`priority:200`); la versión antigua de
`docs.mjs` queda **ignorada** por conflicto (health.conflicts). Autenticado.

```json
{"to":"tercero@example.com","subject":"Acta","body":"Adjunto el acta",
 "connectionId":"opcional"}
```

- Si Gmail no está conectado (adaptador email no configurado y sin
  `googleConnections`) → **`503 EMAIL_NOT_CONFIGURED`**, sin envío ni propuesta.
- Con Gmail conectado → **202** con la misma forma de §8.2 (`status`,
  `approvalRequired`, `proposal`, `doc`, `auto`, `executed`, `error?`); **no
  envía**. El envío real solo tras aprobar/ejecutar la propuesta.
- Errores: `400 VALIDATION|REQUIRED|UNKNOWN_FIELD`, `404 DOC_NOT_FOUND`,
  `503 EMAIL_NOT_CONFIGURED`.

### 8.5 `POST /api/gmail/send` — gate de Oficina

Autenticado.

```json
{"to":"destino@example.com","subject":"Resumen","body":"Texto","connectionId":"opcional"}
```

**Por defecto NO envía:** valida y crea una propuesta N2 en la Oficina; responde
`202`:

```json
{
  "status": "pending_approval",
  "proposal": {"id":"OF-0001","level":"N2","risk":{…},"flags":[…]},
  "message": "Correo pendiente de aprobación. Apruébalo y ejecútalo desde la Oficina.",
  "approvalUrl": "/api/office/proposals/OF-0001"
}
```

El envío real solo ocurre al aprobar y ejecutar
(`POST /api/office/proposals/:id/approve` + `.../execute`), que usa el ejecutor
`email`. Sin Gmail conectado la propuesta se crea igual (no hay envío ni 500).
El correo saliente usa `forceApproval` interno: incluso en modo
`total`/`autónomo` nace `pending`.

- `direct:true` → `403 APPROVAL_REQUIRED` salvo
  `settings.office.allowDirectSend === true` (defecto `false`). Con override
  permitido se registra `email.direct_override` en el ledger **antes** de llamar
  a Gmail; si la auditoría falla no se envía. Con éxito `200
  {ok:true,id,direct:true}`.
- Sin Oficina → `503 OFFICE_UNAVAILABLE` (nunca envío directo).
- Gmail falla en override/ejecución → `502 CHANNEL_ERROR`.
- `GET /api/health` y `GET /api/office/status` exponen
  `office.enforceOutbound:true`, `allowDirectSend` y
  `allowAutonomousOutbound`. Ver §14.

### Webhook genérico

`POST /api/webhooks/generic` — público con secreto `webhooks.generic.secret`
(`Authorization: Bearer <secreto>` o `X-Webhook-Secret`). Cuerpo libre JSON;
`200 {"received":true,"signal":{…}}`. Secreto inválido → `401`; sin secreto en
modo estricto → `503`. Alias: `POST /api/channels/inbound/:id` con
`verifyInboundToken`.

### Centro de integraciones (API real)

- `GET /api/channels` → estado por canal + configuración enmascarada.
- `GET /api/channels/:id`, `GET /api/channels/health`,
  `GET /api/channels/inbox`, `GET /api/channels/messages`.
- `POST /api/channels/:id/config`, `POST /api/channels/:id/enable`,
  `POST /api/channels/:id/test`.
- `POST /api/channels/simulate` → `{text,userId?}` → conversación local sin red.
- `GET /api/channels/approvals/pending`, `.../status`,
  `POST .../config`, `.../:id/send`, `.../:id/remind`; `GET
  /api/channels/documents/status`, `GET /api/channels/documents/:docId`.
- `POST /api/channels/telegram/poll`, `.../delete-webhook`,
  `POST /api/channels/email/poll`; OAuth `GET /api/channels/email/oauth/start`
  y `/callback`.
- Persistencia de canales: `data.channelState`; los documentos se resuelven con
  los proveedores de `lib/channel/documents.mjs`.

---

## 9. Google Calendar y Gmail

### `GET /api/google/events?days=14&timeMin&timeMax` — autenticado

`200 {"events":[…],"timeMin","timeMax"}`. Cada evento:
`{source:"google"|"error",connectionId,account,calendarId,eventId,title,start,end,
allDay,location,status,htmlLink}` o `{source:"error",account,calendarId,error}`.

### OAuth

- `GET /api/auth/google/start?label=Personal` — autenticado → `302` a Google.
  `state` de 24 bytes, caduca a los 10 min.
- `GET /api/auth/google/callback` — público → `302 /?connected=google` o
  `302 /?google=error`; `state` inválido → `400 OAUTH_STATE_INVALID`.
  (Con `SameSite=Strict`, si el navegador no envía la cookie el callback no
  inicia sesión: el frontend debe pedir login de nuevo.)
- `POST /api/google/connections/:id/refresh` — autenticado → `200 {"calendars":[…]}`.
- `DELETE /api/google/connections/:id` — autenticado → `200 {"ok":true}`.
- `GET|POST /api/google/sync` (módulo agenda): estado / reconciliación forzada
  → `{ok,report}`. Errores Google: `410` → resync, `429` → backoff.

---

## 10. Ajustes

### `GET /api/settings` — autenticado

Devuelve `settings` completo (objeto directo). El bloque `office` se normaliza
al leer, sin migración:
`{enforceOutbound:true, allowDirectSend:<bool>, allowAutonomousOutbound:<bool>}`
(defaults `false`/`false`). También se incluye normalizado en
`GET /api/bootstrap`.

### `POST /api/settings` — autenticado

Mezcla parcial profunda; devuelve `200 settings` completo. Acepta el bloque
`office` con **solo** `allowDirectSend` y `allowAutonomousOutbound` (booleanos).
`enforceOutbound` es derivado (`true`) y cualquier campo desconocido o intento de
cambiarlo → `400 UNKNOWN_FIELD`. Si cambia alguno de los dos flags, se escribe
`office.settings` en el ledger de la Oficina (`{by:"user",changes:{…}}`) **antes**
de persistir; si el ledger falla → `503 OFFICE_UNAVAILABLE` y no se cambia nada.

Campos admitidos: `timezone` (IANA), `workdayStart`, `workdayEnd`
(`HH:MM`, `end > start`), `defaultDurationMin` (5–480), `reminderMin` (0–1440),
`autoSyncGoogle` (bool), `defaultGoogle` (`null` o `{connectionId,calendarId}`),
`selectedCalendars` (`{connectionId:[calendarId,…]}`), `locale`, `theme`,
`p95` (objeto), y los siguientes campos del motor (todos opcionales):

| Campo | Tipo | Default | Uso |
|---|---|---|---|
| `syncIntervalMin` | entero 5–1440 | `60` | intervalo del job de reconciliación Google |
| `googleSyncEnabled` | bool | `true` | kill-switch de sincronización |
| `holidays` | lista de `YYYY-MM-DD` (máx 100, fechas reales) | `[]` | festivos configurables |
| `holidayCalendar` | `'CO'` \| `null` | `null` | festivos colombianos (Ley Emiliani) |
| `workdays` | subconjunto no vacío de `LUN…DOM` | `["LUN","MAR","MIE","JUE","VIE"]` | días laborables |
| `slotStepMin` | entero 5–120 | `30` | paso de búsqueda de huecos |
| `slotIncludeWeekend` | bool | `false` | incluir fin de semana en huecos |
| `routineBackfillDays` | entero 1–60 | `7` | días de backfill de rutinas |
| `metricRoles` | `null` o `{plan?,close?,weeklyReview?}` (regex ≤200) | `null` | redefine qué rutina cuenta como plan/cierre/revisión |
| `office` | `{allowDirectSend?: boolean, allowAutonomousOutbound?: boolean}` | `{allowDirectSend:false, allowAutonomousOutbound:false}` | flags auditados de salida (override Gmail / autonomía de canales); `enforceOutbound` no editable |

`GET /api/bootstrap` y `GET /api/settings` exponen estos valores (con los
defaults si el store no los tenía). Valores inválidos → `400` con
`code`/`field` específicos (`INVALID_DATE`, `INVALID_VALUE`, `INVALID_FORMAT`,
`OUT_OF_RANGE`).

`p95` admite las 7 componentes del modelo Excel:

```json
{"p95":{
  "agendaExecution":0.85,"deepFocusDailyMin":120,"overdueOpen":2,
  "meetingEffectiveness":4,"okrProgress":0.70,"weeklyExecution":0.80,
  "weeklyReview":1
}}
```

y **pesos editables** (opcionales, 0–1):

```json
{"p95":{"weights":{
  "agendaExecution":0.20,"deepFocus":0.20,"overdue":0.10,
  "meetingEffectiveness":0.10,"okrProgress":0.15,
  "weeklyExecution":0.15,"weeklyReview":0.10
}}}
```

- Se acepta `weights` parcial (p. ej. `{"weights":{"deepFocus":0.4}}`).
- También se aceptan planos: `weightAgendaExecution`, `weightDeepFocus`,
  `weightOverdue`, `weightMeetingEffectiveness`, `weightOkrProgress`,
  `weightWeeklyExecution`, `weightWeeklyReview`.
- Cada peso 0–1 → fuera de rango `400 INVALID_NUMBER`/`INVALID_VALUE`.
- Si llegan los 7, la suma debe quedar en **0.9–1.1** →
  `400 INVALID_VALUE` (`field: "p95.weights"`).
- Clave desconocida → `400 UNKNOWN_FIELD`.
- Nota: cambiar `timezone` en caliente no reescribe los cálculos del store ya
  cargado; requiere reinicio para que el scheduler use la nueva zona.

---

## 11. Métricas, P95 y reportes (módulo `agenda`)

### `GET /api/p95` — autenticado

`200 {"index","score","components":[{"key","label","raw","target","weight",
"ratio","points","met","unit","inverse"}, …7],"weights":{…},"targets":{…},
"inputs":{…},"weightsSum"}`. El índice se calcula con los 7 componentes del
modelo Excel y los pesos de `settings.p95.weights` (normalizados).

### `GET /api/metrics?days=90&from&to` — autenticado

`200 {"items":[…],"rows":[…],"count","total","from","to","days","fields",
"totals":{…},"p95":N,"components":[{"key","label","raw","target","weight",
"ratio","points","met","unit","inverse"}, …7]}`. Cada fila tiene los 14 campos
del modelo Excel (`date, focusPlanMin, focusRealMin, interruptions, meetingMin,
agendaPlanMin, agendaDoneMin, planDaily, closeDaily, weeklyReview, energyAM,
energyPM, improvement, comments`).

### `POST /api/metrics` — autenticado

Body: `{energyAM,energyPM,interruptions,improvement,comments,planDaily,
closeDaily,weeklyReview,date?}` → `200 {"item":{…14 campos…}}`.
`date` inválida → `400 INVALID_DATE`.

### `GET /api/report/weekly` — autenticado

`200 {"text":"…","report":{…},"metrics":[…],"monthly":"…"}`.

### `GET /api/report/monthly` — autenticado

`200 {"text":"…","report":{…},"metrics":[…]}`.

---

## 12. LLM y agente (t3)

> Implementado por `lib/routes/llm.mjs` (módulo `llm`, `priority: 120`),
> `lib/llm/**` y `lib/agent/**`. Documento ampliado: `docs/LLM.md`.
> **La app funciona igual sin LLM**: cascada
> `API OpenAI-compatible/Responses/Anthropic → Ollama → determinista`, con
> `fallback` y `errorCode` en cada respuesta.
> **La API key vive cifrada en la bóveda (§4)** (`llm.openai.apiKey`,
> AES-256-GCM) y **NUNCA** se devuelve: el estado solo expone `configured`,
> `keyConfigured`, `keySource`, `model` y `baseUrl` saneada. `PUT
> /api/secrets/llm.openai.apiKey` y `POST /api/llm/config {"apiKey":"…"}` son
> las dos vías para guardarla.
> **Sin timers de negocio:** `lib/llm/**` no programa workflows ni
> recordatorios (`lib/workflows/scheduler.mjs` de t8 es el dueño de los
> intervalos). Solo usa `AbortSignal`/timeouts por petición y un *debounce*
> interno de persistencia de uso (1,2 s, `.unref()` en `usage.mjs`).

- **Autenticación:** todas las rutas usan `auth:'default'` (ninguna es pública).
  En modo local sin login se accede directo; con `HOST≠loopback` o
  `APP_AUTH=on` exigen sesión (401 UNAUTHENTICATED).
- **Envelopes:** objetos JSON directos (sin `{item}`), salvo listas
  `{items,count}`.
- **Perfiles por workflow** (override en `store.llm.profiles`):

| Perfil | Uso | Temp. | Máx. tokens | Caché |
|---|---|---|---|---|
| `chat` | chat libre | 0.3 | 800 | no |
| `brief` | brief diario | 0.4 | 500 | 180 s |
| `midday` | chequeo de mediodía | 0.4 | 400 | 120 s |
| `close` | cierre diario | 0.3 | 450 | 120 s |
| `weekly` | reporte semanal | 0.4 | 900 | 600 s |
| `channel` | respuestas de canales | 0.2 | 350 | no |
| `conflict` | explicar conflictos | 0.2 | 400 | 60 s |
| `signals` | señales → acciones | 0.3 | 450 | no |
| `schedule_summary` | resumen horario | 0.3 | 400 | 60 s |
| `autocomplete` | campos de cita (JSON) | 0.1 | 600 | 60 s |
| `intent` | intención del agente (JSON) | 0.1 | 700 | no |

Alias aceptados: `asistente`, `brief_diario`, `mediodia`, `cierre`, `semanal`,
`canales`, `conflictos`, `senales`, `resumen_horario`, `autocompletado`,
`intencion`, `agente`.

### 12.1 `GET /api/llm/status` — autenticado

Query opcional: `probe=1|true` fuerza un health check real (si no, caché de 30 s).

```json
{
  "provider": "openai", "model": "mi-modelo",
  "available": true, "reachable": true, "fallback": "deterministic",
  "latencyMs": 420, "lastError": null, "errorCode": null,
  "ollamaUrl": "http://127.0.0.1:11434", "ollamaConfigured": false,
  "openaiConfigured": true,
  "configured": true, "enabled": true, "killSwitch": false,
  "requestedProvider": "auto", "kind": "openai",
  "baseUrl": "https://api.openai.com/v1", "timeoutMs": 20000, "maxRetries": 2,
  "checkedAt": "2026-10-27T18:00:00.000Z",
  "chain": [{
    "provider": "openai", "model": "mi-modelo", "configured": true,
    "reachable": true, "available": true, "latencyMs": 420,
    "error": null, "errorCode": null, "via": null,
    "checkedAt": "2026-10-27T18:00:00.000Z"
  }],
  "activeProvider": "openai", "mode": "api",
  "usage": {"date": "2026-10-27", "calls": 4, "tokens": 1200, "errors": 0,
            "cached": 1, "remaining": {"calls": 496, "tokens": 298800}},
  "limits": {"dailyCalls": 500, "dailyTokens": 300000, "ratePerMin": 30,
             "perWorkflow": {}},
  "cache": {"size": 2, "ttlSec": 300},
  "profiles": {"chat": {"id": "chat", "enabled": true, "model": null,
                         "temperature": 0.3, "maxTokens": 800, "cacheable": false,
                         "json": false, "label": "…", "description": "…"}, "brief": {}},
  "lastTestAt": "2026-10-27T17:55:00.000Z",
  "lastTest": {"at": "…", "ok": true, "provider": "openai", "model": "mi-modelo",
               "latencyMs": 310, "error": null, "errorCode": null, "attempts": []}
}
```

- `mode`: `api` (proveedor principal), `ollama` (local) o `deterministic`.
- `reachable`: hay al menos un eslabón que responde; `available` además exige
  `enabled=true` y `killSwitch=false`.
- `chain[]` conserva el orden de la cascada; cada eslabón informa `error`/
  `errorCode` aunque no se use.
- `lastTest` puede ser `null`. `profiles` es el mapa resuelto de 11 perfiles.

### 12.2 `GET /api/llm/models` — autenticado

Consulta el catálogo del proveedor (o el modelo configurado si el proveedor no
lista). Timeout interno 8 s.

```json
{
  "items": [{"id": "mi-modelo", "provider": "openai", "sizeBytes": null}],
  "count": 1, "provider": "openai", "configured": true, "error": null
}
```

`sizeBytes` solo se rellena si el proveedor lo informa (típico en Ollama).
Si no hay proveedor, `items: []` y `error` con el motivo.

### 12.3 `POST /api/llm/test` — autenticado

```json
{"probe": "chat"}
```

`probe`: `chat` (defecto, llamada real mínima) o `health` (solo disponibilidad).
Siempre responde `200`; el resultado está en `ok`.

```json
{
  "at": "2026-10-27T18:00:00.000Z", "ok": true,
  "provider": "openai", "model": "mi-modelo", "latencyMs": 310,
  "error": null, "errorCode": null,
  "usage": {"promptTokens": 20, "completionTokens": 1, "totalTokens": 21, "reported": true},
  "attempts": [{"provider": "openai", "ok": true, "latencyMs": 310,
                "error": null, "errorCode": null}],
  "configured": true, "enabled": true, "killSwitch": false
}
```

Fallo típico: `{"ok":false,"errorCode":"LLM_AUTH","error":"…","attempts":[…]}`.
`400 INVALID_VALUE` si `probe` no es `chat|health`.

### 12.4 `POST /api/llm/config` — autenticado

Guarda secretos en la bóveda (§4) y ajustes no secretos en `store.llm`.
Campos admitidos (lista blanca estricta; extra → `400 UNKNOWN_FIELD`):

| Campo | Tipo/rango | Destino |
|---|---|---|
| `provider` | `auto`, `openai`, `openai-responses`, `anthropic`, `ollama` | bóveda `llm.provider` |
| `baseUrl` | URL `http(s)` ≤300 | bóveda `llm.openai.baseUrl` |
| `model` | texto ≤120 | bóveda `llm.openai.model` |
| `apiKey` | texto ≤512, sin saltos de línea | bóveda `llm.openai.apiKey` (**nunca se devuelve**) |
| `ollamaUrl` | URL `http(s)` ≤300 | bóveda `llm.ollama.url` |
| `ollamaModel` | texto ≤120 | bóveda `llm.ollama.model` |
| `timeoutMs` | entero 1000–120000 | bóveda `llm.timeoutMs` |
| `apiVersion` | texto ≤40 o `null` | `store.llm.apiVersion` |
| `extraHeaders` | objeto ≤12 cabeceras `^[A-Za-z0-9-]{1,40}$` ≤200; prohibidas `authorization`, `cookie`, `host`, etc. | `store.llm.extraHeaders` |
| `maxRetries` | entero 0–4 | `store.llm.maxRetries` |
| `enabled` | bool | `store.llm.enabled` |
| `killSwitch` | bool | `store.llm.killSwitch` |
| `ollamaEnabled` | bool | `store.llm.ollamaEnabled` |
| `limits` | `{dailyCalls 0–100000, dailyTokens 0–100000000, ratePerMin 1–600, cacheTtlSec 0–86400, perWorkflow:{<perfil>:{calls 0–10000, tokens 0–10000000}}}` | `store.llm.limits` |
| `profiles` | `{<perfil>:{enabled?, model?:text|null, temperature? 0–2, maxTokens? 16–4096, cacheable?, cacheTtlSec? 0–86400, json?}}` | `store.llm.profiles` |
| `memory` | `{maxMessages 4–50, maxConversations 1–500, pendingTtlSec 30–7200}` | `store.llm.memory` |
| `clearApiKey` | bool (no se puede combinar con `apiKey`) | borra la clave de la bóveda |

`200`:

```json
{"ok": true, "config": { …publicConfig… }, "profiles": { …mapa de 11 perfiles… }}
```

`config` (público) tiene: `enabled`, `killSwitch`, `configured`,
`provider{requested,kind,label,configured,keyConfigured,keySource,model,baseUrl,apiVersion,extraHeaders:[nombres],timeoutMs,maxRetries}`,
`ollama{enabled,configured,url,model}`,
`limits{dailyCalls,dailyTokens,ratePerMin,cacheTtlSec,perWorkflow}`,
`memory{maxMessages,maxConversations,pendingTtlSec}`,
`profiles{<id>:{id,label,description,temperature,maxTokens,enabled,model,cacheable,cacheTtlSec?,json}}`.
`keySource` ∈ `env|store|null`; **nunca** incluye `apiKey`.

Errores: `400` `UNKNOWN_FIELD`, `EMPTY_PATCH`, `INVALID_URL`, `REQUIRED`,
`TOO_LONG`, `INVALID_CHARS`, `INVALID_TYPE`, `INVALID_VALUE`, `OUT_OF_RANGE`,
`INVALID_NUMBER`; `INVALID_VALUE` si se envían `apiKey` y `clearApiKey` juntos.

### 12.5 `GET /api/llm/usage?days=7` — autenticado

`days`: 1–30 (def. 7). Devuelve el snapshot de uso + estado del subsistema:

```json
{
  "date": "2026-10-27",
  "today": {"calls": 4, "promptTokens": 900, "completionTokens": 300,
            "tokens": 1200, "errors": 0, "cached": 1,
            "byWorkflow": {"chat": {"calls": 2, "tokens": 700, "errors": 0, "cached": 0}},
            "byProvider": {"openai": {"calls": 4, "tokens": 1200}}},
  "totals": {"calls": 10, "tokens": 2500, "errors": 0, "cached": 2},
  "byWorkflow": {…}, "byProvider": {…},
  "history": [{"date": "2026-10-21", "calls": 2, "tokens": 500, "errors": 0, "cached": 0}],
  "days": [ … igual que history … ],
  "limits": {"dailyCalls": 500, "dailyTokens": 300000, "ratePerMin": 30, "perWorkflow": {}},
  "remaining": {"calls": 496, "tokens": 298800},
  "updatedAt": "2026-10-27T17:59:00.000Z", "storage": "ok",
  "enabled": true, "killSwitch": false, "configured": true,
  "provider": "openai", "profiles": {…},
  "config": { …publicConfig… }
}
```

`storage`: `ok|read-only` si el store está degradado.

### 12.6 `POST /api/llm/chat` — autenticado

```json
{"messages":[{"role":"user","content":"Hola"}],
 "profile":"chat","temperature":0.2,"maxTokens":512,
 "requireLlm":false,"cache":false,"channel":"web","userId":"owner"}
```

- `messages`: 1–24 mensajes `{role: system|user|assistant, content ≤8000}` **o**
  `text` (≤4000) como atajo.
- `profile`: perfil o alias (tabla de perfiles); defecto `chat`.
- `temperature` 0–2; `maxTokens` 16–4096; `requireLlm` bool (def. false);
  `cache` bool (def. `auto` según perfil); `channel` `^[a-z0-9_-]{1,40}$`;
  `userId` ≤80.

`200`:

```json
{"reply": "…", "provider": "openai", "model": "mi-modelo",
 "latencyMs": 900, "usage": {"promptTokens": 12, "completionTokens": 80,
 "totalTokens": 92, "reported": true},
 "fallback": false, "cached": false, "profile": "chat",
 "error": null, "errorCode": null}
```

Sin proveedor (o si falla la cascada) devuelve `200` con `fallback:true` y un
texto determinista. Con `requireLlm:true` y `fallback:true` →
`503 {"error":"…","code":"LLM_UNAVAILABLE","details":{"errorCode":"…","attempts":[…],"fallbackAvailable":true}}`.

### 12.7 `POST /api/llm/workflow` — autenticado

```json
{"workflow": "brief", "input": {}, "text": "opcional", "channel": "web", "userId": "owner"}
```

- `workflow` (obligatorio): `chat`, `brief`, `midday`, `close`, `weekly`,
  `channel`, `conflict`, `signals`, `schedule_summary`, `autocomplete`
  (`intent` no es un workflow público → `400 INVALID_VALUE`).
- `input`: objeto ≤8000 caracteres; `text`: ≤2000.

`200` (general):

```json
{"workflow": "brief", "text": "…", "provider": "openai", "model": "mi-modelo",
 "fallback": false, "cached": false, "latencyMs": 950,
 "usage": {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "reported": false},
 "error": null, "errorCode": null}
```

Para `workflow:"autocomplete"` añade
`proposal`, `warnings`, `suggestedRequest`, `source` (misma forma que §12.8).
`text` siempre es string (fallback determinista si el proveedor falla). El
campo interno `facts` **no** se expone por HTTP.

### 12.8 `POST /api/llm/autocomplete` — autenticado

Alias exacto de `POST /api/agent/autocomplete`.

```json
{"text": "reunión con Ana mañana 10:00 45 min urgente para revisar la propuesta",
 "channel": "web", "userId": "owner"}
```

`200`:

```json
{
  "proposal": {
    "title": "Reunión con Ana", "type": "Reunión", "priority": "P1",
    "impact": 5, "urgency": 5, "energy": "Alta", "context": "Oficina",
    "location": "", "durationMin": 45, "reminderMin": 10, "notes": "…",
    "deepFocus": false, "date": "2026-10-28", "time": "10:00",
    "start": "2026-10-28T15:00:00.000Z", "end": "2026-10-28T15:45:00.000Z"
  },
  "fields": { "…igual que proposal…" },
  "suggestedRequest": {"title": "Reunión con Ana", "type": "Reunión",
    "priority": "P1", "impact": 5, "urgency": 5, "energy": "Alta",
    "durationMin": 45, "reminderMin": 10, "notes": "…", "deepFocus": false,
    "context": "Oficina", "date": "2026-10-28", "time": "10:00"},
  "warnings": [], "meta": {"dateSource": "hint", "timeSource": "hint",
    "durationSource": "hint", "timezone": "America/Bogota"},
  "validated": true, "requiresConfirmation": true, "saved": false,
  "source": "llm", "provider": "openai", "model": "mi-modelo",
  "fallback": false, "latencyMs": 800,
  "usage": {"promptTokens": 40, "completionTokens": 120, "totalTokens": 160, "reported": true},
  "error": null, "errorCode": null, "profile": "autocomplete"
}
```

- **Nunca guarda**: el cliente confirma creando la cita con `suggestedRequest`
  en `POST /api/agenda` (el motor de t2 revalida y comprueba conflictos).
- Sin LLM propone con pistas deterministas y lo marca en `warnings`.
- `meta.dateSource|timeSource|durationSource` ∈ `hint|llm|default|none`.

### 12.9 `POST /api/agent/chat` — autenticado

Alias compatible: `POST /api/agent/command` (mismo handler y shapes).

```json
{"text": "agenda reunión con Ana mañana 10:00 45 min",
 "channel": "web", "userId": "owner", "dryRun": false,
 "confirmToken": null, "confirm": false, "deadlineMs": 25000}
```

- `text` obligatorio ≤4000. `channel` `^[a-z0-9_-]{1,40}$`.
- `dryRun:true` no escribe ni guarda memoria; devuelve acciones propuestas.
- `deadlineMs` 3000–25000 (presupuesto total; defecto 25 s).
- `confirmToken` (el `pending.confirmCode` de un turno anterior) o `confirm:true`
  ejecutan el pendiente sin depender del texto.

`200`:

```json
{
  "reply": "✅ Agendado AG-0007: Reunión con Ana …",
  "provider": "openai", "model": "mi-modelo", "fallback": false,
  "source": "llm",
  "intent": {"action": "crear_cita", "args": {"title": "Reunión con Ana", "date": "2026-10-28", "time": "10:00"}},
  "actions": [{"type": "create", "status": "ok", "agendaId": "AG-0007", "title": "Reunión con Ana"}],
  "pending": null,
  "event": { "…evento de agenda…" },
  "dashboard": { "…§2 dashboard…" },
  "conversation": {"key": "web:owner", "messages": 4},
  "latencyMs": 1200,
  "usage": {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "reported": false},
  "error": null, "errorCode": null,
  "dryRun": false, "iterations": 2, "choice": null
}
```

- `source`: `llm` o `deterministic`; `fallback:true` cuando respondió el motor
  determinista (comandos `HOY`, `CAPTURA …`, `HECHO AG-…`, `POSPONER|MOVER …`,
  `FOCO N …`, `CIERRE`, `SEMANA`, `balance`).
- `actions[]` es auditoría de lo ejecutado (formas: `create`, `move`, `cancel`,
  `complete`, `capture`, `find_slots`, `routine`, `inbox`, `email`…). Cada
  entrada incluye al menos `{type, status:'ok'|'planned'|'error'}`.
- `event` es la cita afectada (o `null`).
- `pending` es `null` o:

```json
{"type": "confirm", "action": "mover_cita",
 "summary": "moverla a las 15:00 del mismo día: AG-0007 «Reunión con Ana»…",
 "confirmCode": "A1b2C3d4E5", "requiresConfirmation": true,
 "options": null, "createdAt": "2026-10-27T18:00:00.000Z"}
```

  Para elección (`type:"choose"`) `options` es
  `[{"index":1,"start":"…","end":"…"}]` (huecos) o
  `[{"index":1,"id":"AG-0007","title":"…","label":"…"}]` (candidatas).
  **`confirmCode`** (no `token`) es el nombre público: el serializador HTTP
  enmascara cualquier propiedad `*token`; se acepta igual en §12.10.
- Acciones destructivas (mover, cancelar, completar, editar/activar rutinas,
  convertir inbox, enviar correo/WhatsApp/Telegram) **no se ejecutan en el
  primer turno**: devuelven `pending` y se confirman con «sí», con el número de
  opción o con `confirmCode`. El pendiente caduca a los 10 min
  (`memory.pendingTtlSec`, 30–7200 s).

### 12.10 `POST /api/agent/confirm` — autenticado

```json
{"confirmCode": "A1b2C3d4E5", "channel": "web", "userId": "owner", "dryRun": false}
```

También acepta `{"token":"…"}` (mismo valor). `confirmCode`/`token` obligatorio.
Devuelve **el mismo shape que §12.9** (ejecuta el pendiente y lo consume). Si no
hay pendiente vigente: `200` con `reply:"No hay una acción pendiente…"` y
`pending:null`.

### 12.11 `GET /api/agent/actions?limit=50` — autenticado

`limit`: 1–200 (def. 50), máximo almacenado 200.

```json
{"items": [{
  "id": "LA-m2x9a-4f3k1", "at": "2026-10-27T18:00:00.000Z",
  "type": "crear_cita", "status": "ok", "agendaId": "AG-0007",
  "detail": "✅ Agendado AG-0007: Reunión con Ana (detalle redactado, ≤300)",
  "channel": "web", "user": "owner", "dryRun": false,
  "source": "llm", "intent": "crear_cita"
}], "count": 1}
```

`status`: `ok|error|pending_confirmation`; `source`: `llm|deterministic`;
`agendaId`/`channel`/`user`/`intent` pueden ser `null`.

### 12.12 `GET /api/agent/history` — autenticado

Query: `channel` (def. `web`), `userId` (def. usuario de la sesión o `local`),
`limit` 1–50 (def. 12).

```json
{"key": "web:owner",
 "items": [{"role": "user", "content": "agenda …", "at": "…", "source": "user"},
           {"role": "assistant", "content": "✅ …", "at": "…", "source": "llm"}],
 "pending": {"type": "confirm", "action": "mover_cita", "summary": "…",
             "confirmCode": "…", "requiresConfirmation": true,
             "options": null, "createdAt": "…"}}
```

`pending` usa la misma forma pública de §12.9 (o `null`).

### 12.13 `GET /api/agent/conversations` — autenticado

Query: `limit` 1–100 (def. 20), `channel` (filtro exacto opcional).

```json
{"items": [{
  "key": "web:owner", "channel": "web", "userId": "owner",
  "updatedAt": "2026-10-27T18:00:00.000Z", "messageCount": 6,
  "lastMessage": {"role": "assistant", "content": "✅ …", "at": "…"},
  "pending": {"type": "confirm", "action": "mover_cita", "summary": "…",
              "createdAt": "…"}
}], "count": 1}
```

### 12.14 `GET|DELETE /api/agent/conversations/:key` — autenticado

`:key` es `canal:usuario` (p. ej. `web%3Aowner`). Si no contiene `:` se
construye con `?channel=` (def. `web`) y el propio `:key` como usuario.

`GET` (query `limit` 1–50, def. 12):

```json
{"key": "web:owner",
 "messages": [{"role": "user", "content": "…", "at": "…", "source": "user"}],
 "count": 1}
```

`DELETE` → `{"ok": true, "key": "web:owner"}` (idempotente; `ok:false` solo si
el store está en solo lectura).

### 12.15 Códigos de error de LLM/agente

**HTTP:** `400` con `{error, code, field, requestId}` usando los códigos de
validación comunes (`UNKNOWN_FIELD`, `REQUIRED`, `INVALID_TYPE`, `INVALID_VALUE`,
`INVALID_FORMAT`, `INVALID_URL`, `INVALID_CHARS`, `TOO_LONG`, `OUT_OF_RANGE`,
`INVALID_NUMBER`, `EMPTY_PATCH`, `INVALID_BODY`); `401 UNAUTHENTICATED` si la
app exige sesión; `413/415` como el resto de la API;
`503 LLM_UNAVAILABLE` (solo `requireLlm:true`).

**En el cuerpo (`errorCode`) con HTTP 200:** `LLM_NOT_CONFIGURED`, `LLM_AUTH`,
`LLM_TIMEOUT`, `LLM_NETWORK`, `LLM_UPSTREAM`, `LLM_RATE_LIMITED`,
`LLM_BAD_REQUEST`, `LLM_BAD_RESPONSE`, `LLM_CONFIG`, `LLM_DISABLED`,
`LLM_KILL_SWITCH`, `LLM_PROFILE_DISABLED`, `LLM_BUDGET_CALLS`,
`LLM_BUDGET_TOKENS`, `LLM_BUDGET_EXCEEDED` (genérico), `LLM_JSON_INVALID`,
`LLM_UNAVAILABLE`, `LLM_ERROR`, `LLM_UNKNOWN`.
A nivel de módulo, `runWorkflow` puede lanzar `UNKNOWN_WORKFLOW` (400); la ruta
HTTP lo traduce a `INVALID_VALUE` sobre `workflow`.

**Reglas de degradación:** kill-switch, `enabled:false`, perfil apagado,
presupuesto agotado, rate limit o proveedor caído **nunca** rompen la app:
responden `200` con `fallback:true`, `error`/`errorCode` y texto determinista.

---

## 13. Workflows, señales y backup

### Workflows — *reservado t6/t8*

- `GET /api/workflows` → `{"items":[{"id","name","trigger","conditions","actions","active","createdAt","updatedAt"}],"count","total"}`.
- `POST /api/workflows` → `201 {"item":{…}}`.
- `PATCH|DELETE /api/workflows/:id` → `200 {"item"|"ok":true}`.
- `POST /api/workflows/:id/run` → `200 {"ok":true,"run":{"id","workflowId","status":"ok|error|skipped","steps":[…],"startedAt","finishedAt"}}`.
- Errores: `404 NOT_FOUND`, `400 UNKNOWN_FIELD`, `409 WORKFLOW_DISABLED`.

**Planificador (t8):** `lib/workflows/scheduler.mjs` es el único dueño de los
intervalos y envíos programados (briefing, mediodía, cierre, semanal,
recordatorios, materialización de rutinas). Reutiliza `store.notificationLog`
con las claves `<job>:<YYYY-MM-DD>` y `<eventId>:<startISO>`. `server.mjs` no
programa ticks.

No confundir los **workflows de automatización** de esta sección
(`/api/workflows`, propiedad de t8) con los **workflows LLM** de §12.7
(`POST /api/llm/workflow`: brief, cierre, conflictos, señales…). El scheduler
puede invocar los workflows LLM (`dailyBrief`, `middayCheck`, `dailyClose`,
`weeklyReview` de `lib/llm/workflows.mjs`), pero `lib/llm/**` no programa
timers.

### Señales — *reservado t6*

- `GET /api/signals?limit=50&type=` → `{"items":[{"id","at","type","source","payload","read"}],"count","total"}`.
- `POST /api/signals` (interno/autenticado) → `201 {"item":{…}}`.
- `POST /api/signals/:id/read` → `200 {"item":{…read:true}}`.
- Sin streaming SSE en v1; el frontend hace polling.

### `GET /api/backup?secrets=none` — autenticado

Descarga JSON con `Content-Disposition: attachment; filename="agenda-backup-<ts>.json"`.

```json
{
  "app":"Agenda Copilot P95","appVersion":"1.1.0","schemaVersion":2,
  "exportedAt":"…","timezone":"America/Bogota","includesSecrets":true,
  "data": { …store completo: version, settings, agenda, inbox, recurrences,
            meetings, okrs, metrics, googleConnections, activity, signals,
            workflows, auth (hash scrypt), secrets (cifrados), … }
}
```

- Incluye secretos **cifrados** (inútiles sin la clave maestra) y el hash de
  contraseña. `?secrets=none` los omite.
- El backup **no** incluye la clave maestra (`.master-key` o env).

### `POST /api/backup/restore` — autenticado (máx 16 MB)

```json
{"confirm":"RESTORE","data":{ …payload de backup o data directa… }}
```

- `confirm` obligatorio; ausente o distinto de `RESTORE`/`RESTAURAR` →
  `400 CONFIRMATION_REQUIRED`.
- Valida estructura (`INVALID_BACKUP`), migra si hace falta, guarda copia
  `agenda-data.json.pre-restore-<ts>.json` y restaura.
- **Funciona en modo solo lectura** (vía de recuperación) y lo desactiva.
- `200 {"ok":true,"restored":true,"version":2,"counts":{…},
  "restoredAt":"…","store":{…}}`.
- `store` en read-only y sin backup válido → sigue read-only.

### `GET /api/backup/journal?limit=50` — autenticado

```json
{"entries":[{"seq":23,"at":"…","label":"reset-demo","version":2,
  "counts":{"agenda":5,"inbox":1,"recurrences":6,"okrs":2},
  "prev":"<sha256>","digest":"<sha256>"}],
 "journal":{"seq":23,"digest":"…","entries":23,"lastAt":"…",
  "file":"<DATA_DIR>/journal.jsonl"}}
```

Cadena de hashes: cada `digest` = SHA-256 de `{seq,at,label,counts,prev}`.

### `POST /api/reset-demo` — autenticado + **solo loopback**

- Reinicia agenda, inbox, rutinas, reuniones, OKR, métricas, actividad y
  notificaciones al seed de demo.
- **Conserva** autenticación, secretos, conexiones Google y `settings`.
- `200` con el mismo payload de `bootstrap`.
- En `NODE_ENV=production` → `403 RESET_DISABLED`.
- Desde red → `403 LOCAL_ONLY` (aunque haya sesión).
- `X-Forwarded-For` no loopback también → `403 LOCAL_ONLY`.

---

## 14. Oficina (t13)

> Implementado por `lib/routes/office.mjs` (`priority: 130`) y `lib/office/**`.
> Documento ampliado: `docs/OFFICE.md`. Todas las rutas usan
> `auth:'default'` (ninguna es pública). El secreto HMAC de las aprobaciones se
> toma de `OFFICE_HMAC_SECRET`/`APP_SECRET` o de la clave maestra (§1.11) y
> **nunca** se devuelve. Persistencia: `data.office`
> (`mode`, `proposals`, `ledger`, `contacts`), sin migración.

La Oficina es el gate de gobierno: una propuesta se evalúa por riesgo, recibe
opiniones consultivas de los 7 roles, se firma con HMAC-SHA256 al aprobarse y se
ejecuta **una sola vez** por un ejecutor inyectable. Niveles: `N0` lectura
automática, `N1` borrador automático con ventana de deshacer, `N2` aprobación,
`N3` aprobación + código de 6. Modos: `sombra`, `asistido`, `autonomo`, `total`.

### Rutas (16)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/office/roster` | organigrama de 7 roles |
| GET | `/api/office/mode` | modo actual + catálogo |
| POST | `/api/office/mode` | cambiar modo |
| GET | `/api/office/status` | resumen de propuestas/ledger |
| GET | `/api/office/proposals` | listar propuestas (`status`, `limit`, `offset`) |
| POST | `/api/office/proposals` | crear propuesta (riesgo, nivel, opiniones) |
| GET | `/api/office/proposals/:id` | detalle público |
| POST | `/api/office/proposals/:id/approve` | aprobar y firmar |
| POST | `/api/office/proposals/:id/reject` | rechazar |
| POST | `/api/office/proposals/:id/execute` | ejecutar (código N3) |
| POST | `/api/office/proposals/:id/undo` | deshacer borrador N1 |
| POST | `/api/office/parse` | interpretar “ok/dale/no/corrige:” |
| GET | `/api/office/ledger` | entradas del ledger |
| GET | `/api/office/ledger/verify` | verificar cadena |
| GET | `/api/office/ledger/export` | descargar ledger JSON |
| GET | `/api/office/executors` | ejecutores disponibles |

### `GET /api/office/roster`

`200`:

```json
{"ok":true,"items":[{"id":"chief_of_staff","nombre":"…","descripcion":"…",
"capacidades":["…"],"puede_proponer":true,"puede_ejecutar":true,
"canal_de_salida":"interno"}],"count":7,"roles":[…],"mode":"asistido",
"levels":[…],"modes":[…],"voiceThreshold":0.75,"undoWindowSec":300,
"approvalTtlSec":1800}
```

### `GET /api/office/mode` · `POST /api/office/mode`

`GET` devuelve `{ok, mode, info, levels, modes, defaultMode, voiceThreshold,
undoWindowSec, approvalTtlSec, updatedAt, updatedBy}`.

`POST` requiere `{mode}` (`sombra|asistido|autonomo|total`; alias `shadow`,
`assisted`, `autonomous`, `full`) y acepta `{by}`. `200 {ok, mode, previous,
updatedAt, updatedBy, …vista}`. Modo inválido → `400 INVALID_VALUE` (field
`mode`).

### `GET /api/office/status`

`200` con `mode`, `modeInfo`, `proposals` (total), `counts` por estado,
`pending`, `approved`, `executed`, `contacts`, `ledger:{entries,head,lastAt}`,
`undoWindowSec`, `approvalTtlSec`, `voiceThreshold`, `updatedAt`,
`enforceOutbound:true`, `allowDirectSend` y `allowAutonomousOutbound` (desde
`settings.office.*`, defaults `false`). También se exponen en
`office:{enforceOutbound,allowDirectSend,allowAutonomousOutbound}` para
consumidores de salud. `allowAutonomousOutbound` habilita la autonomía auditada
de canales descrita en §8 (ver
[CANALES.md §Autonomía de salida](CANALES.md#autonomía-de-salida-opt-in-t35)).

### `POST /api/office/proposals`

```json
{"kind":"email","channel":"email","recipients":["cliente@externo.com"],
 "subject":"Propuesta","body":"Adjunto la propuesta…","attachments":["p.pdf"],
 "meta":{"deadline":"2026-10-29"}}
```

- `kind` slug, `channel` ∈ `email|whatsapp|telegram|document|note|read|webhook|none|internal`;
  los canales de envío exigen destinatarios. `recipients` ≤50, `subject` ≤300,
  `body` 1–20000, `attachments` ≤10, `meta` objeto ≤4000 bytes.
- `201`:

```json
{"ok":true,"item":{"id":"OF-0001","level":"N2","status":"pending",
 "risk":{"score":5,"maxScore":10,"flags":[…],"signals":{…}},
 "flags":["EXTERNAL_RECIPIENT","NEW_CONTACT","ATTACHMENTS"],
 "opinions":[{"role":"chief_of_staff","nombre":"…","score":0.85,
 "verdict":"aprobar","note":"…","source":"rubric"}],
 "voice":0.76,"policy":{"mode":"asistido","action":"approve",
 "requiresApproval":true,"requiresCode":false,"reason":"…"},
 "card":{"title":"…","summary":"…","text":"…","actions":["approve","reject"],…},
 "approval":null,"execution":null,"createdAt":"…","updatedAt":"…"},
 "id":"OF-0001","level":"N2","status":"pending","risk":{…},"flags":[…],
 "card":{…},"code":null,"auto":false,"executed":false,"error":null}
```

- En N0/N1 (o N2 automático) `auto:true`, `executed:true` y `item.execution`
  cuando el ejecutor está disponible. Si el automático no tiene ejecutor,
  `item.status` queda `approved`, `error.code="EXECUTOR_UNAVAILABLE"` y no se
  ejecuta. La respuesta puede incluir `item` con `approval` para autoaprobadas.

### `GET /api/office/proposals?status=&limit=&offset=`

`200 {ok, items:[…], count, total, status, proposals:items}`. `status` ∈
`pending|held|approved|rejected|executing|executed|failed|reverted`; inválido
→ `400 INVALID_VALUE`. Orden: más recientes primero; `limit` 1–500 (def. 50).

### `GET /api/office/proposals/:id`

`200 {ok,item}`; inexistente → `404 NOT_FOUND`. El item público nunca incluye
`approval.codeHash` ni datos internos del código.

### `POST /api/office/proposals/:id/approve`

```json
{"by":"jefe","note":"visto bueno"}
```

`by` obligatorio. `200`:

```json
{"ok":true,"item":{…,"status":"approved","approval":{…}},
 "approval":{"by":"jefe","at":"…","nonce":"…","issuedAt":"…","expiresAt":"…",
 "payloadHash":"…","signature":"<hmac-sha256-hex>","token":"…","alg":"HMAC-SHA256"},
 "signature":"…","nonce":"…","expiresAt":"…","token":"…","code":null,"card":{…}}
```

- TTL 1800 s. En N3 `code` es el código de 6 caracteres (una sola vez); en N2/N1
  es `null`. Errores: `409 ALREADY_APPROVED|ALREADY_EXECUTED|EXECUTE_IN_PROGRESS|
  REJECTED|REVERTED|INVALID_STATE`; `404 NOT_FOUND`.

### `POST /api/office/proposals/:id/reject`

`{"by":"jefe","reason":"no aplica"}` → `200 {ok,item(status:"rejected")}`.
No se puede rechazar algo ejecutado/en ejecución. `404` si no existe.

### `POST /api/office/proposals/:id/execute`

```json
{"code":"A1B2C3"}
```

`code` solo N3. `200 {ok,item,status:"executed",executed:true,execution:{…}}`.
La ejecución verifica modo, estado, TTL, `payloadHash`, firma HMAC y código N3
antes de marcar `executing`; es única e idempotente a nivel de estado.

| Caso | HTTP | code |
|---|---|---|
| modo `sombra` | 409 | `SHADOW_MODE` |
| sin aprobar | 409 | `NOT_APPROVED` |
| payload alterado | 409 | `SIGNATURE_INVALID` |
| aprobación caducada | 409 | `APPROVAL_EXPIRED` |
| N3 sin código | 400 | `CODE_REQUIRED` |
| N3 código incorrecto | 409 | `INVALID_CODE` |
| N3 código ya usado | 409 | `CODE_USED` |
| doble ejecución | 409 | `ALREADY_EXECUTED` |
| ejecución concurrente | 409 | `EXECUTE_IN_PROGRESS` |
| sin ejecutor | 503 | `EXECUTOR_UNAVAILABLE` |
| ejecutor falla | 502 | `EXECUTOR_FAILED` |

### `POST /api/office/proposals/:id/undo`

Solo N1 ejecutado y dentro de `undoUntil`. `200 {ok,item(status:"reverted")}`.
`409 NOT_UNDOABLE`, `409 UNDO_EXPIRED`, `409 UNDO_NOT_SUPPORTED`.

### `POST /api/office/parse`

```json
{"text":"dale"}
```

`200 {ok, decision:"approve"|"reject"|"correct"|"unknown", text,
correction, matched, confidence}`. Reconoce `ok/dale/sí/adelante/hazlo`,
`no/rechaza/cancela`, `corrige:/cambia/ajusta`.

### Ledger

`GET /api/office/ledger?limit=100&offset=0` →
`{ok, items:[{seq,ts,actor,action,payloadHash,prevHash,hash,payload}], count,
total, head, genesis, entries:items}`.

`GET /api/office/ledger/verify` →
`{ok, entries:<número>, broken:[{seq,reason}], head, genesis}`. `ok:false` si se
manipuló payload/hash/prevHash.

`GET /api/office/ledger/export` → adjunto
`Content-Disposition: attachment; filename="office-ledger.json"` con
`{app, document:"office-ledger", exportedAt, mode, genesis, verification,
entries:[…]}`. El payload del ledger está sanitizado (no guarda cuerpos).

`GET /api/office/executors` → `{ok, items:[{id,name,available,revert}], count}`.

### Persistencia y errores

`data.office` (`mode`, `proposals`, `ledger`, `contacts`, `undoWindowSec`,
`approvalTtlSec`, `voiceThreshold`) se crea de forma perezosa; **no hay
migración**. El ledger sobrevive reinicios y no se poda. Acciones auditadas
incluyen `proposal.created|approved|rejected|executed|execution_failed|
execution_blocked|reverted`, `mode.changed`, `email.direct_override`,
`office.settings` (cambios de flags de Ajustes) y `outbound.autonomous` (antes
de un envío autónomo de canal).

Errores propios: `ALREADY_APPROVED`, `ALREADY_EXECUTED`, `EXECUTE_IN_PROGRESS`,
`REJECTED`, `REVERTED`, `INVALID_STATE`, `NOT_APPROVED`, `SIGNATURE_INVALID`,
`APPROVAL_EXPIRED`, `CODE_REQUIRED`, `INVALID_CODE`, `CODE_USED`, `SHADOW_MODE`,
`EXECUTOR_UNAVAILABLE`, `EXECUTOR_FAILED`, `UNDO_EXPIRED`,
`UNDO_NOT_SUPPORTED`, `NOT_UNDOABLE`, `NOT_FOUND`.

---

## 15. Estilo («como yo») (t14)

> Implementado por `lib/routes/style.mjs` (`priority: 120`) y `lib/style/**`.
> Documento ampliado: `docs/ESTILO.md`. `auth:'default'`; persistencia
> `data.style` (`samples`, `profiles`, `variations`), sin migración.

### Rutas (5)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/style/samples` | añadir muestras y recalcular perfiles |
| GET | `/api/style/profiles` | perfiles por registro + global/default |
| DELETE | `/api/style/profiles/:register` | borrar muestras de un registro |
| POST | `/api/style/score` | puntuar un texto 0–1 con explicación |
| POST | `/api/style/compose` | borrador con la voz del perfil |

### `POST /api/style/samples`

```json
{"register":"colega","samples":["Hola Andrés:\n\nGracias…\n\nUn abrazo,\n…"]}
```

`register` ∈ `cliente|proveedor|entidad|colega|familiar`; `samples` 1–50
muestras (texto u `{text}`), 20–8000 caracteres; mínimo 10 por registro para
usar el perfil del registro (si no, global; si no, neutro). `200`:

```json
{"ok":true,"register":"colega","added":2,"skipped":0,"samples":12,
 "totalSamples":12,"source":"register",
 "profile":{"register":"colega","source":"register","sampleCount":12,
 "minSamples":10,"greeting":"Hola","greetingTemplate":"Hola {nombre}:",
 "closing":"Un abrazo,","signature":["…"],"sentenceMean":14.2,
 "sentenceStd":4.1,"paragraphs":3.2,"meanWords":95,"formality":0.3,
 "emojiRate":0,"questionRate":0.1,"bulletRate":0,"hedges":[…],
 "blacklistHits":[…]}}
```

### `GET /api/style/profiles`

`200 {items:[{register,samples,source,profile}], global, default, registers,
minSamples, totalSamples, updatedAt}`. `source` ∈ `register|global|default`; el
perfil incluye saludo/plantilla, despedida, firma, métricas de frases, párrafos,
formalidad, emojis, preguntas, viñetas, matices y frases delatoras.

### `DELETE /api/style/profiles/:register`

`200 {ok:true,register,deleted:<muestras borradas>,totalSamples}`.
Registro inválido → `400 INVALID_VALUE`.

### `POST /api/style/score`

```json
{"register":"colega","text":"Hola Andrés:\n\n…\n\nUn abrazo,\n…"}
```

`text` 1–20000; `register` opcional. `200 {register, profileSource:"register"|
"global"|"default", score:0..1, why:[…], components:{…}, penalties:{…}}`.
Si el registro no tiene 10 muestras se puntúa contra global/default.

### `POST /api/style/compose`

```json
{"register":"colega","intent":"Cerrar el alcance y revisar el calendario",
 "facts":{"proyecto":"Piloto","entrega":"jueves 30"},
 "recipient":{"name":"Andrés M.","email":"andres@empresa.com"},
 "thread":["Andrés: te paso la propuesta el lunes."],"opening":"opcional"}
```

`intent` 3–2000; `facts` objeto/array/texto ≤8000; `recipient` texto o
`{name,email,emails[]}` (≤10 correos); `thread` ≤10 mensajes de 2000; `opening`
≤120. `200`:

```json
{"draft":"Hola Andrés:\n\n…","score":0.99,"why":[…],
 "components":{…},"register":"colega","profileSource":"register",
 "samplesUsed":3,"engine":"deterministic",
 "recipient":{"key":"andres@empresa.com","name":"Andrés M.",
 "email":"andres@empresa.com"},
 "variation":{"contact":"andres@empresa.com","register":"colega",
 "windowDays":7,"opening":"Hola Andrés:","closing":"Un abrazo,",
 "openingReplaced":false,"openingSynthesized":false,
 "closingReplaced":false,"closingSynthesized":false,"recorded":[…]}}
```

`engine` ∈ `deterministic|llm`; la variación se registra en
`data.style.variations` (7 días por contacto/tipo). Sin LLM funciona igual.
Errores: `400 UNKNOWN_FIELD|EMPTY_PATCH|REQUIRED|INVALID_TYPE|INVALID_FORMAT|
INVALID_VALUE|TOO_LONG`, `404` no aplica.

---

## 16. Identidad multicorreo (t14)

> Implementado por `lib/routes/identity.mjs` (`priority: 120`) y
> `lib/identity/resolve.mjs`. `auth:'default'`; persistencia `data.identity`
> (`contacts`, `metadata`, `gmailMessages`), sin migración. Gmail solo se usa si
> hay conexión y metadatos importados; este módulo no lee cuerpos ni llama a la
> red.

### Rutas (4)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/identity/people?q=&limit=` | grafo/búsqueda de personas |
| POST | `/api/identity/resolve` | resolver nombre/correo |
| POST | `/api/identity/expand` | expandir a correos sin duplicados |
| POST | `/api/identity/contacts` | alta/merge manual de contacto |

### `GET /api/identity/people`

Query `q` (≤200), `limit` 1–100 (def. 50). `200`:

```json
{"items":[{"id":"P-…","name":"Andrés Mendoza","aliases":[],
 "emails":["andres@empresa.com","a.mendoza@empresa.com"],
 "domains":["empresa.com"],"confidence":0.848,
 "requiresConfirmation":false,"evidenceCount":4}],
 "count":1,"total":1,"evidenceCount":7}
```

### `POST /api/identity/resolve`

`{name?}` o `{email?}` (al menos uno; `email` válido). `200`:

```json
{"query":{"name":"Andrés M.","email":null},
 "candidates":[{"id":"P-…","name":"Andrés Mendoza","aliases":[],
 "emails":["…"],"domains":["…"],"confidence":0.848,
 "requiresConfirmation":false,
 "evidence":[{"type":"name_match","detail":"…","weight":0.9,"email":null}],
 "evidenceCount":4}],
 "matched":1,"requiresConfirmation":false,
 "reason":null}
```

`requiresConfirmation` si no hay candidatos, confianza <0.8 o ambigüedad.
`reason`: `sin coincidencias`, `confianza menor que 0.8`, `varias personas con
confianza parecida` o `null`. `400 REQUIRED` si faltan ambos; `INVALID_FORMAT`
si el correo no es válido.

### `POST /api/identity/expand`

`{"query":"Andrés M."}` (2–200). `200`:

```json
{"query":"Andrés M.","people":[{"name":"Andrés Mendoza","emails":[…],
 "confidence":0.848,"requiresConfirmation":false,"evidence":[…]}],
 "recipients":["andres@empresa.com","a.mendoza@empresa.com"],
 "duplicatesRemoved":0,"requiresConfirmation":false,"matched":1,
 "resolution":{"reason":null,"candidates":[…]}}
```

### `POST /api/identity/contacts`

```json
{"name":"Andrés Mendoza","emails":["andres@tercero.com"],
 "aliases":["Andrés M."],"note":"cuenta personal"}
```

`name` 2–120; `emails` 1–10 válidos; `aliases` ≤10; `note` ≤500. Hace merge por
nombre (normalizado). `200 {ok:true, contact:{name,emails,aliases,note,
updatedAt}, total}`. Errores comunes de validación.

---

## 17. Viajes, Meet y tareas (t15)

> Implementado por `lib/routes/travel.mjs` (`priority: 100`) y `lib/travel/**`.
> Documento ampliado: `docs/VIAJES.md`. `auth:'default'`; persistencia
> `data.places` y `data.tasks` (arrays del store), sin migración. ETA es offline
> por defecto; Google Distance Matrix es opcional y nunca bloquea.

### Rutas (22)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/travel/places?q=&city=&category=` | catálogo de lugares |
| POST | `/api/travel/places` | crear lugar |
| GET | `/api/travel/places/:id` | detalle |
| PATCH | `/api/travel/places/:id` | editar |
| DELETE | `/api/travel/places/:id` | eliminar |
| GET | `/api/travel/resolve?text=` | resolver lugar difuso |
| GET | `/api/travel/eta` | ETA por query |
| POST | `/api/travel/eta` | ETA por body |
| GET | `/api/travel/config` | perfiles, márgenes y Google |
| POST | `/api/travel/plan` | planificar viaje/alternativas |
| GET | `/api/agenda/:id/travel` | recalcular viaje de una cita |
| POST | `/api/agenda/:id/meet` | crear/obtener Meet |
| GET | `/api/agenda/:id/meet` | leer Meet guardado |
| GET | `/api/tasks` | listar tareas + resumen |
| POST | `/api/tasks` | crear tarea |
| GET | `/api/tasks/summary` | totales por estado/vencidas |
| GET | `/api/tasks/parse?text=` | parser de tareas de chat |
| GET | `/api/tasks/:id` | detalle |
| PATCH | `/api/tasks/:id` | editar |
| DELETE | `/api/tasks/:id` | eliminar |
| POST | `/api/tasks/:id/close` | cerrar (idempotente) |
| POST | `/api/tasks/:id/reopen` | reabrir |

### Lugares

Campos: `name` (obligatorio, ≤160), `city`, `lat` (−90..90), `lon`
(−180..180), `category` ∈ `ciudad|oficina|cliente|aeropuerto|hotel|planta|
bodega|otro`, `aliases[]`, `address`, `notes`. `POST` → `201 {item}`;
`GET lista` → `{items,count,total,cities,categories}`; `GET/PATCH` → `{item}`;
`DELETE` → `{ok,item}`. Errores: `400 VALIDATION|UNKNOWN_FIELD|EMPTY_PATCH`,
`404 NOT_FOUND|PLACE_NOT_FOUND`, `409 PLACE_EXISTS`.

`GET /api/travel/resolve?text=Palmira` → `{item,score,method,label}` o
`404 PLACE_NOT_FOUND` con `suggestions[]`; sin `text` → `400 VALIDATION`.

### ETA y plan

`GET /api/travel/eta?fromPlace=Cali&toPlace=Palmira&at=2026-10-29T16:00:00-05:00&mode=auto`
y `POST /api/travel/eta` con `{fromPlace,toPlace,at,mode,marginMin,speedKmh,gapMin}`.
`mode` ∈ `auto|urbano|mixto|carretera`. `200` directo:

```json
{"km":27.2,"etaMin":37,"marginMin":20,"totalMin":57,"feasible":false,
 "gapMin":30,"mode":"mixto","speedKmh":45,"rush":false,"rushFactor":1,
 "rushWindow":null,"source":"offline","departAt":"2026-10-29T21:00:00.000Z",
 "formula":"km = haversine; eta = ceil(km / velocidad × 60 × factorPunta); total = eta + margen",
 "from":{"id":"PL-0001","name":"Cali","label":"Cali"},
 "to":{"id":"PL-0002","name":"Palmira","label":"Palmira"},"summary":"…"}
```

`source` ∈ `offline|google|local`; `mode:"local"` para distancias ≤0.3 km.
Lugar no encontrado → `404 PLACE_NOT_FOUND`; fecha inválida → `400 INVALID_DATE`.

`POST /api/travel/plan` acepta `{fromPlace,fromAt,toPlace,toAt,mode,durationMin,
horizonDays}` y devuelve `{feasible,km,etaMin,marginMin,totalMin,gapMin,from,to,
mode,rush,rushFactor,departureAt,arrivalAt,requestedArrivalAt,source,formula,
warning,alternatives[…],durationMin,horizonDays}`. Cada alternativa:
`{at,date,why,kind,departureAt,gapMin}` con `kind` ∈ `minimum|comfortable|
next-gap|next-day`. `fromAt`/`toAt` inválidos → `400 INVALID_DATE`; lugares
desconocidos → `404 PLACE_NOT_FOUND`.

`GET /api/travel/config` → `{item:{modes,speedsKmh,marginsMin,rushFactor,
rushWindows,autoModes,googleDistanceMatrix,places,defaultPlaces}}`.

### Agenda: viaje y Meet

`GET /api/agenda/:id/travel` → `{item:evento, travel, feasible, warning,
alternatives[]}`. `travel` puede ser `{resolved:false,online:true,
feasible:true,reason:"reunión en línea"}` o `{resolved:false,feasible:null,
reason:"lugar no encontrado…"}`; nunca bloquea. `404` si la cita no existe.

`POST /api/agenda/:id/meet` → `{ok:true,item,meetLink,generated,provider,note,
googleError,meet}`. Con Google conectado crea `conferenceData` y devuelve
`provider:"google"`/`generated:false`; sin Google entrega una sala Jitsi real (`provider:"jitsi"`, `generated:false`, `fallback:true`)
La nota avisa “Sala Jitsi real; Google Meet requiere conectar Google”. Nunca
fabrica un enlace `meet.google.com`. Idempotente.
`GET /api/agenda/:id/meet` → `{item, meetLink, generated, provider, note, meet}`.

### Tareas

Campos: `title`/`text` (texto de chat: `"asignar tarea a Laura: revisar contrato"`),
`owner`/`responsable` (≤120), `due` (`YYYY-MM-DD`), `priority`
(`P1|P2|P3|P4`; alias alta/media/baja), `origin` ∈ `chat|correo|acta|manual|
whatsapp|telegram|agente`, `status` ∈ `open|done|cancelled`, `eventId`, `person`,
`notes` (≤2000), `result` (≤2000 en close; ≤200 en PATCH), `closedBy`/`person`
(≤200). `eventId` inexistente →
`404 EVENT_NOT_FOUND`.

- `GET /api/tasks?status=all|open|done|cancelled&owner=&origin=&q=&due=&eventId=&limit=`
  → `{items,count,total,summary:{total,open,done,cancelled,overdue},
  origins,priorities,statuses}`.
- `POST` → `201 {item}`; `GET/PATCH` → `{item}`; `DELETE` → `{ok,item}`.
- `POST /:id/close` `{result?,closedBy?}` → `{ok,item,alreadyClosed}`;
  idempotente. `POST /:id/reopen` → `{item}`.
- `GET /api/tasks/summary` → `{item:summary}`.
- `GET /api/tasks/parse?text=…` → `{item:{title,owner}}`; sin `text` → `400 VALIDATION`.
- Errores: `400 VALIDATION|UNKNOWN_FIELD|EMPTY_PATCH|INVALID_DATE`,
  `404 NOT_FOUND|EVENT_NOT_FOUND`.

---

## 18. Avisos inteligentes (t16)

> Implementado por `lib/routes/nudges.mjs` (`priority: 100`) y `lib/nudges/**`.
> Documento ampliado: `docs/AVISOS.md`. `auth:'default'`; persistencia
> `data.nudges` (`config`, `state`) sin migración. No hay timers propios: se
> engancha al scheduler de t8.

### Rutas (7; 6 familias)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/nudges/config` | configuración + estado + tipos |
| POST | `/api/nudges/config` | parche de configuración |
| GET | `/api/nudges/feed?limit=20&includeDismissed=1` | historial de avisos |
| GET | `/api/nudges/status` | estado + hook del scheduler |
| GET | `/api/nudges/report?date=YYYY-MM-DD` | reporte diario guardado |
| POST | `/api/nudges/evaluate` | evaluar (dry-run por defecto) |
| POST | `/api/nudges/:id/dismiss` | descartar aviso |

`GET /api/nudges/config` → `{config:{enabled,cadenceMin,silence:{enabled,from,
to},channels[],maxPerHour,maxPerDay,cooldownMin,maxItems,freeGapMin,
focusTargetMin,unansweredMin,meetingLookaheadMin,closeCheckAt,reportAt,
dedupeTtlMin,llmEnabled}, state:{counters,lastSentAt,lastEvaluateAt,history,
reports,targets}, types:[…]}`.

`POST config`: lista blanca estricta; `enabled` bool; `cadenceMin` 5–240;
`silence.from/to` `HH:MM`; `channels` subconjunto de
`telegram|whatsapp|email` (máx. 3, [] = canales configurados); `maxPerHour`
1–12; `maxPerDay` 1–50; `cooldownMin` 0–1440; `maxItems` 1–3; `freeGapMin`
15–240; `focusTargetMin` 15–600 o `null`; `unansweredMin` 5–1440;
`meetingLookaheadMin` 15–720; `closeCheckAt`/`reportAt` `HH:MM`;
`dedupeTtlMin` 0–2880; `llmEnabled` bool. `200 {ok, config, state, types}`.
Campos extra → `400 UNKNOWN_FIELD`; rangos → `400 OUT_OF_RANGE`/`INVALID_VALUE`.

`GET feed`: `limit` 1–100 (def. 20), `includeDismissed` bool →
`{items,count,total}`; cada aviso tiene `{id,at,type,score,text,subject,
items[],fingerprint,llm,dismissed,dismissedAt?}`.

`GET status` → `{enabled,config,state,types,silence:{active,enabled,from,to},
targets,hook:{registered,autostart,scheduler}}`.

`GET report`: `date` opcional real `YYYY-MM-DD`; inválida → `400 INVALID_DATE`.
`200 {date, report}` (`report:null` si no existe). `POST evaluate`: body
`{dryRun?,force?}` y query `dryRun`; por defecto **`dryRun:true`**; `force`
por defecto `true`; `200 {ok,at,dryRun,skipped,nudges,candidates,counters,
targets,dailyReport}`. `skipped` ∈ `disabled|silence|max-per-hour|max-per-day|
cadence|no-candidates|busy`. `POST /:id/dismiss` → `{ok,item}`; inexistente →
`404 NOT_FOUND`.

### Hook `registerTickHandler` (scheduler t8)

`lib/routes/nudges.mjs` registra `nudgesTick` una sola vez al importarse (con
guards `WORKFLOWS_AUTOSTART=0`, `NODE_ENV=test`, `NODE_TEST_CONTEXT`, `--test`).

Contrato del hook expuesto por `lib/workflows/scheduler.mjs`:

```js
const unregister = registerTickHandler(async ({ now, dryRun }) => {
  // now: Date del tick; dryRun: true ⇒ no enviar ni mutar
  return { ok: true };
});
unregister(); // idempotente; dos llamadas no fallan
```

- `registerTickHandler(fn)` es idempotente para la misma función (Set) y devuelve
  `unregister()`; lanza `TypeError` si `fn` no es función.
- Los handlers se ejecutan **en serie** al final de `workflowTick`, después de
  workflows y señales.
- Cada handler va aislado con `try/catch` y **timeout de 5 s** (`Promise.race`);
  un fallo/cuelgue no rompe el tick; se registra como `TICK_HANDLER_TIMEOUT` o
  con su error.
- El tick incluye `handlers:[{ok,durationMs,result|error,code?}]` **solo cuando
  hay handlers registrados**; con cero handlers el resultado es idéntico al de
  antes del hook (paridad verificada).
- `dryRun:true` no debe enviar ni escribir; el motor de avisos lo respeta.

---

## 19. Documentos ofimáticos (t17/t26)

> Implementado por `lib/routes/docs.mjs` (`priority: 120`) y `lib/docs/**`.
> Documento ampliado: `docs/DOCUMENTOS.md`. `auth:'default'`; los binarios y el
> índice viven en `DATA_DIR/docs` (`index.json`, `templates.json`,
> `<ID>.<ext>`), **no** en el store ni en `public/`. No hay migración.

### Rutas (9 + HEAD)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/docs?type=&q=&limit=&offset=` | listar documentos |
| POST | `/api/docs` | crear DOCX/XLSX/PPTX |
| GET | `/api/docs/templates` | plantillas integradas + guardadas |
| POST | `/api/docs/templates` | crear/actualizar plantilla |
| DELETE | `/api/docs/templates/:name` | borrar plantilla guardada |
| GET | `/api/docs/:id` | metadatos |
| GET | `/api/docs/:id/download` | binario adjunto |
| DELETE | `/api/docs/:id` | borrar documento y archivo |
| POST | `/api/docs/:id/send-email` | **202 propuesta** (ruta efectiva `channels`); no envía |

`HEAD /api/docs/:id/download` devuelve las mismas cabeceras y `Content-Length`
sin cuerpo (el router lo resuelve sobre el `GET`).

### Crear y listar

`POST /api/docs`:

```json
{"type":"docx","title":"Acta de reunión","register":true,"template":"acta",
 "date":"2026-10-28","author":"Ana Torres","subject":"Comité",
 "brand":{"font":"Calibri","color":"#1F3864","accent":"#2E74B5",
 "logoText":"Mi empresa","signature":"Firma autorizada","footerText":"Confidencial"},
 "sections":[…],"annex":{…},"margins":{"top":1440,"right":1440,"bottom":1440,"left":1440}}
```

`type` ∈ `docx|xlsx|pptx` y `title` 1–200 obligatorios. `201` con
`{id,type,title,filename,mimeType,bytes,sha256,createdAt,template,registered,
downloadUrl}`. `register:false` no escribe índice ni disco y responde `200` con
`registered:false`, sin `id`, más `base64` del ZIP.

`GET /api/docs` → `{items,count,total,limit,offset,stats}`; item público
`{id,type,title,filename,mimeType,bytes,sha256,createdAt,template,downloadUrl,
missing?}`. `limit` 1–200 (def. 50), `offset` ≥0; `type` inválido → `400
VALIDATION`. `GET /:id` → `{item,stats}`; inexistente → `404 DOC_NOT_FOUND`.

### Descarga, borrado y correo

`GET/HEAD /api/docs/:id/download` → binario con `Content-Type` real,
`Content-Disposition: attachment`, `Content-Length`, `Cache-Control:
private, no-store`. `404 DOC_NOT_FOUND` / `404 DOC_FILE_MISSING`.

`DELETE /api/docs/:id` → `{ok,id,removed,removedFile,bytesFreed,stats}`.

`POST /api/docs/:id/send-email` (ruta efectiva servida por `channels.mjs`,
priority 200; la versión de `docs.mjs` queda ignorada por conflicto — ver
health.conflicts y §8.4):

```json
{"to":"destino@example.com","subject":"Acta del comité",
 "body":"Adjunto el acta.\nSaludos.","connectionId":"opcional"}
```

**No envía.** Con Gmail conectado crea una propuesta N2 y responde `202` con
`{status:"pending_approval",approvalRequired:true,proposal:{id,level,status,
channel,recipients,subject,body,attachments,createdAt,policy,card},
doc:{id,filename,mimeType,size,type,origin},auto:false,executed:false}` (misma
forma que §8.2). Sin Gmail → `503 EMAIL_NOT_CONFIGURED`, sin envío ni propuesta.
El envío real solo ocurre al aprobar/ejecutar la propuesta. Errores:
`400 VALIDATION|REQUIRED|UNKNOWN_FIELD`, `404 DOC_NOT_FOUND`,
`503 EMAIL_NOT_CONFIGURED`.

### Plantillas

`GET /api/docs/templates` → `{items,count,total}` (incluye `acta` integrada).
`POST` body `{name,type:"docx|xlsx|pptx|any",brand:{…},description?}` → `201` si
es nueva o `200` si actualiza, con `{item,created}`. `DELETE /:name` →
`{ok,name,removed}`. Reservada `acta` → `409 TEMPLATE_RESERVED`; máximo 30 →
`409 TEMPLATE_LIMIT`; inexistente → `404 TEMPLATE_NOT_FOUND`; tipo distinto →
`400 TEMPLATE_TYPE_MISMATCH`.

> **Pendiente/limitación:** no existe `PATCH /api/docs/:id` (los documentos son
> inmutables) ni `PATCH /api/docs/templates/:name` (la plantilla se actualiza con
> `POST`, que es upsert). Si el producto exige edición in-place, no está
> implementada en esta versión.

### Anchos automáticos y límites

- XLSX calcula el ancho de columna con el texto formateado (incluida moneda
  1.000.000.000 y fechas) si no se indica `width`; evita `####` en Excel. El
  redondeo de moneda usa 2 decimales y el ancho se estima con ese texto.
- Límites: cuerpo HTTP 1 MB; 200 documentos; 12 MB/documento; 96 MB total;
  30 plantillas; DOCX 200 bloques, tablas 20×500, listas 200, párrafo 8.000;
  XLSX 12 hojas, 2.000 filas, 30 columnas, celda 2.000; PPTX 60 diapositivas,
  12 viñetas, tabla 10×20, notas 8.000; acta 50 asistentes/30 agenda/50 acuerdos.
- Errores propios: `DOC_NOT_FOUND`, `DOC_FILE_MISSING`, `DOC_TOO_LARGE`,
  `DOC_LIMIT`, `DOC_STORAGE_LIMIT`, `TEMPLATE_*`, `EMAIL_*`, `VALIDATION`.

---

## 20. Research web con fuentes (t25)

> Implementado por `lib/routes/research.mjs` (`priority: 100`) y
> `lib/research/**`. Documento ampliado: `docs/RESEARCH.md`. `auth:'default'`;
> persistencia `data.research` (`sources`, `reports`), sin migración.
> **No hay buscador por defecto**: se aceptan URLs explícitas.

### Rutas (8)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/research/fetch` | descargar + extraer una URL |
| POST | `/api/research/report` | informe con citas y fuentes |
| GET | `/api/research/sources?limit=` | fuentes persistidas |
| DELETE | `/api/research/sources/:id` | borrar fuente |
| GET | `/api/research/reports?limit=` | informes persistidos |
| GET | `/api/research/reports/:id` | metadatos del informe |
| GET | `/api/research/reports/:id/markdown` | descarga markdown |
| GET | `/api/research/status` | límites, proveedor y contadores |

`POST fetch`: `{url|href|link, save?}`; `save:false` no persiste. `200` con
`{url,finalUrl,status,contentType,bytes,redirects,elapsedMs,title,author,
publishedAt,language,siteName,text,excerpt,links,length,wordCount,source}`.
Sin URL → `400 VALIDATION`.

`POST report`:

```json
{"question":"¿Cómo proteger una agenda de investigación?",
 "urls":["https://ejemplo.com/a","https://ejemplo.org/b"],"maxSources":5,
 "useLlm":true,"attachDocument":true,"emailTo":"destino@example.com"}
```

`200`:

```json
{"reportId":"RP-…","question":"…","answer":"# Informe… [1] … [2] …",
 "markdown":"# Informe…","citations":[1,2,1],"citationCount":3,
 "usedLlm":false,"provider":null,"model":null,"llmError":null,
 "sources":[{"id":"RS-0001","url":"…","title":"…","retrievedAt":"…",
 "excerpt":"…"}],"sourceCount":2,"errors":[],
 "document":{"id":"DOC-…","filename":"….docx","downloadUrl":"…"},
 "documentError":null,"proposal":{"id":"OF-…","level":"N2","status":"pending",
 "channel":"email"},"proposalError":null,
 "downloadUrl":"/api/research/reports/<id>/markdown","generatedAt":"…",
 "limits":{…}}
```

- Sin LLM: frases literales y citas `[n]`; con LLM se validan citas y si no son
  válidas se usa el determinista (`usedLlm:false`, `llmError`).
- `maxSources` 1–8 (def. 5); URLs ≤10; `question` 3–500. Sin fuentes válidas →
  `422 NO_SOURCES`.
- `sources`/`reports` listas `{items,count,total}`; report markdown
  `Content-Type: text/markdown; charset=utf-8` y `Content-Disposition:
  attachment; filename="informe-RP-….md"`.

### SSRF y límites

`lib/research/fetchSafe.mjs` permite solo `http/https`; rechaza credenciales,
`file:`, `data:`, `gopher:`, loopback/privadas (`127/8`, `10/8`, `172.16/12`,
`192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`, metadata cloud,
IPv4-mapped y 6to4 privadas), resuelve **todas** las IPs y revalida cada una de
las **3** redirecciones. Límites: timeout **8 s**, **2 MB**, content-types
HTML/texto/JSON/XML, UA identificable. Errores: `403 SSRF_BLOCKED`,
`400 UNSUPPORTED_PROTOCOL|INVALID_URL`, `413 TOO_LARGE`,
`415 UNSUPPORTED_CONTENT_TYPE`, `502 DNS_ERROR|TOO_MANY_REDIRECTS|HTTP_ERROR`,
`504 TIMEOUT`.

`GET status` → `{item:{limits:{maxBytes,maxRedirects,timeoutMs,maxTextChars,
maxSources,defaultSources},sources,reports,searchProvider:null,
searchProviderNote,llmConfigured}}`.

---

## 21. Hilos y acuses (t27)

> Implementado por `lib/routes/thread.mjs` (`priority: 120`) y `lib/thread/**`.
> Documento ampliado: `docs/HILOS.md`. `auth:'default'`. No crea store nuevo:
> lee `data.channelState.messages` (o `inbox`) y persiste variaciones de acuse en
> `data.style.variations`; sin migración.

### Rutas (3)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/thread/context` | contexto determinista del hilo |
| POST | `/api/thread/ack` | acuse variado sin repetir |
| GET | `/api/thread/summary?channel=&userId=&limit=` | resumen + línea |

### `POST /api/thread/context`

```json
{"channel":"simulator","userId":"demo-hilo","limit":20}
```

`channel` 2–40 `^[a-z0-9_-]+$`; `userId` 1–200; `limit` 1–50 (def. 20). `200`:

```json
{"context":{"channel":"simulator","userId":"demo-hilo","messages":[…],
 "messageCount":8,"hasHistory":true,"state":"pendiente_mío|pendiente_suyo|
 cerrado|sin_historial","stateLabel":"…","stateReason":"…",
 "commitments":[…],"pendingMine":[…],"pendingTheirs":[…],"topics":[…],
 "topicDetails":[…],"lastIntent":"pregunta|solicitud|confirmación|compromiso|mensaje",
 "lastIntentText":"…","lastIntentDetail":{…},"summary":"…",
 "summarySource":"determinista|llm","summaryFallback":"…","usedLlm":false,
 "sources":[…]},
 "summary":"…","usedLlm":false,"sources":[…]}
```

Sin historial: `messageCount:0`, `hasHistory:false`, `state:"sin_historial"`.

### `POST /api/thread/ack`

```json
{"channel":"simulator","userId":"demo-hilo",
 "intent":"prometo entregar el viernes","urgency":"normal"}
```

`intent` 2–1000; `urgency` ∈ `baja|normal|alta|urgente` (def. normal). Construye
el contexto determinista (sin LLM) y devuelve `200`:

```json
{"context":{…},"ack":"Recibí tu mensaje; lo estoy gestionando…",
 "ackMeta":{"urgency":"normal","neutral":false,"replaced":false,
 "synthesized":false,"exhausted":false,"windowDays":7,"recorded":[…]},
 "usedLlm":false,"sources":[…]}
```

Reglas duras: no repite fórmula con el mismo contacto en 7 días, no copia
fechas/IDs/enlaces de la intención, sin historial usa fórmula neutra.

### `GET /api/thread/summary`

Query `channel` y `userId` obligatorios, `limit` 1–50. `200` con `{context,
summary,line,usedLlm,sources}`. Faltan `channel`/`userId` → `400 REQUIRED`;
`limit` fuera de rango → `400 OUT_OF_RANGE`; campos extra → `400 UNKNOWN_FIELD`.

---

## 22. MCP: herramientas externas con gate (t24)

> Implementado por `lib/routes/mcp.mjs` (`priority: 140`) y `lib/mcp/**`.
> Documento ampliado: `docs/MCP.md`. `auth:'default'`; persistencia `data.mcp`
> (`servers`, `secrets` cifrados, `pendingCalls`), sin migración. Los valores de
> `env`/`headers` y los argumentos pendientes se cifran con AES-256-GCM (clave
> maestra); la API **nunca** devuelve valores, solo `envKeys`/`headerKeys`.

### Rutas (9)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/mcp/status` | gate + resumen + defaults |
| GET | `/api/mcp/servers` | listar servidores |
| POST | `/api/mcp/servers` | crear servidor |
| GET | `/api/mcp/servers/:id` | detalle público |
| PATCH | `/api/mcp/servers/:id` | editar |
| DELETE | `/api/mcp/servers/:id` | borrar servidor/secretos/pendientes |
| POST | `/api/mcp/servers/:id/probe` | handshake + tools/list |
| GET | `/api/mcp/servers/:id/tools` | herramientas + clasificación |
| POST | `/api/mcp/servers/:id/call` | llamar herramienta (gate si efecto) |

### Servidores

`POST` body:

```json
{"name":"mock","transport":"stdio|http|sse","command":"node","args":["…"],
 "url":null,"env":{"KEY":"valor"},"headers":{"Authorization":"Bearer …"},
 "envKeys":[],"headerKeys":[],"enabled":true,"toolAllowlist":[],
 "timeoutMs":10000}
```

- `stdio` exige `command` y no admite `url`; `http|sse` exigen `url` http(s) sin
  credenciales y no admiten `command`. `name` 1–80; args ≤50×500; env ≤50;
  headers ≤30; allowlist ≤100; timeout 1000–60000.
- `env`/`headers` son los únicos campos con valores; se cifran. `envKeys`/
  `headerKeys` son metadatos de solo nombres. En `PATCH`, `null` borra una
  entrada.
- `toolAllowlist`: lista exacta de herramientas permitidas o `["*"]`; vacía =
  sin restricción explícita, pero las herramientas con efectos **siempre** pasan
  por el gate de Oficina (nunca se ejecutan directas).
- `201 {ok,item,id,name,envKeys,headerKeys}`. Item público:
  `{id,name,transport,command,args,url,enabled,toolAllowlist,timeoutMs,envKeys,
  headerKeys,secretCount,createdAt,updatedAt,lastProbe}`.
- `GET` lista `{ok,items,count,total,gate}`; `GET :id` `{ok,item}`;
  `PATCH` `{ok,item}`; `DELETE` `{ok,deleted:true,id}`. Errores:
  `404 MCP_SERVER_NOT_FOUND`, `400 MCP_INVALID_CONFIG`.

### Probe, tools y call

`POST /:id/probe` (body opcional `{timeoutMs}`) → `{ok,item,probe:{protocolVersion,
serverInfo,capabilities,toolCount,latencyMs},tools:[{name,description,inputSchema,
annotations,effect,readOnly,reason}],count}`; actualiza `lastProbe`.
`GET /:id/tools` → `{ok,item,tools,count,serverInfo,protocolVersion}`.
Servidor deshabilitado → `409 MCP_SERVER_DISABLED`.

`POST /:id/call` body `{tool,args?}` (args objeto ≤8 KB). Herramienta de lectura
→ `200 {ok,gated:false,server,tool,result:{content,text,structuredContent,
isError}}`. Herramienta con efectos → `202` **gated**, sin ejecutar:

```json
{"ok":true,"gated":true,"status":"pending","executed":false,"auto":false,
 "server":{…},"tool":{name,effect,readOnly,reason},
 "proposal":{id,level:"N2",status:"pending",policy:{…},meta:{mcp:{…}}},
 "gate":{"provider":"office","proposalId":"OF-…","level":"N2",
 "status":"pending","requiresApproval":true,"requiresCode":false,
 "mode":"asistido","approvalHint":"…"}}
```

La propuesta debe aprobarse/ejecutarse por la API de Oficina (§14); al ejecutarla, el
ejecutor MCP recupera los argumentos cifrados y llama a la herramienta. Si la
Oficina no está disponible (o `MCP_GATE_DISABLE=1`) → `503
MCP_GATE_UNAVAILABLE` sin ejecutar. Errores: `403 MCP_TOOL_NOT_ALLOWED`,
`404 MCP_TOOL_NOT_FOUND`, `409 MCP_SERVER_DISABLED`, `502 MCP_SPAWN_FAILED|
MCP_PROCESS_EXITED|MCP_RPC_ERROR|MCP_PROTOCOL_ERROR|MCP_RESPONSE_TOO_LARGE`,
`503 MCP_GATE_UNAVAILABLE`, `504 MCP_TIMEOUT`.

`GET status` → `{ok,gate:{available,disabledByEnv,module,executorRegistered},
summary:{servers,enabled,pendingCalls,version,updatedAt},defaults:{timeoutMs,
maxResponseBytes}}`.

---

## 23. Códigos de error

| code | status típico | significado |
|---|---|---|
| `REQUIRED` | 400 | falta un campo obligatorio |
| `INVALID_TYPE` | 400 | tipo incorrecto |
| `INVALID_NUMBER` | 400 | número/entero inválido |
| `INVALID_DATE` | 400 | fecha imposible o formato inválido |
| `INVALID_RANGE` | 400 | `end ≤ start`, rango > 31 días, jornada invertida |
| `TOO_LONG` / `TOO_SHORT` | 400 | longitud fuera de límite |
| `INVALID_VALUE` | 400 | valor fuera de enumeración/rango o suma de pesos |
| `INVALID_FORMAT` | 400 | patrón (`HH:MM`, email, regla semanal) |
| `INVALID_CHARS` | 400 | caracteres de control |
| `UNKNOWN_FIELD` | 400 | campo no permitido |
| `FIELD_NOT_EDITABLE` | 400 | campo inmutable (`id`, `google`, `createdAt`) |
| `EMPTY_PATCH` | 400 | PATCH sin campos |
| `INVALID_BODY` | 400 | cuerpo no es objeto JSON |
| `INVALID_JSON` | 400 | JSON mal formado |
| `INVALID_PATH` / `INVALID_URL` | 400 | ruta/URL inválida |
| `INVALID_TIMEZONE` | 400 | zona IANA inexistente |
| `CONFIRMATION_REQUIRED` | 400 | falta `confirm:"RESTORE"` |
| `INVALID_BACKUP` | 400 | backup con estructura inválida |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` no JSON |
| `PAYLOAD_TOO_LARGE` | 413 | cuerpo > límite |
| `NOT_FOUND` | 404 | recurso/ruta inexistente |
| `METHOD_NOT_ALLOWED` | 405 | método no soportado |
| `UNAUTHENTICATED` | 401 | sesión requerida/credenciales inválidas |
| `SETUP_FORBIDDEN` | 403 | setup remoto sin token |
| `AUTH_ALREADY_CONFIGURED` | 409 | setup repetido |
| `AUTH_NOT_CONFIGURED` | 409 | login sin cuenta |
| `WEAK_PASSWORD` / `SAME_PASSWORD` / `INVALID_USERNAME` | 400 | política de credenciales |
| `TOO_MANY_REQUESTS` | 429 | rate limit de login |
| `BAD_ORIGIN` | 403 | CSRF por `Origin` cruzado |
| `LOCAL_ONLY` | 403 | ruta solo loopback |
| `STORE_READ_ONLY` | 503 | almacén degradado |
| `UNKNOWN_SECRET` | 404 | nombre de secreto no catalogado |
| `WEBHOOK_SECRET_MISSING` | 503 | webhook sin secreto en modo estricto |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | firma/token de webhook inválido |
| `VERIFY_TOKEN_INVALID` | 403 | handshake de WhatsApp inválido |
| `NOT_OWNER` | 403 | channels | prueba a destino fuera de la lista blanca; `details.listField` |
| `CHANNEL_NO_PROPOSAL` | 400 | channels | canal sin propuesta de salida (solo email/WhatsApp/Telegram/simulador) |
| `UNKNOWN_CHANNEL` | 400 | channels | canal/adaptador desconocido |
| `CHANNEL_NOT_READY` / `NOT_CONFIGURED` | 409 | channels | canal o prueba no configurada |
| `CHANNEL_ERROR` | 502 | fallo de WhatsApp/Telegram/Gmail |
| `GOOGLE_NOT_CONFIGURED` / `GOOGLE_ERROR` / `OAUTH_STATE_INVALID` | 400 | OAuth/Google |
| `CONFLICT` | 409 | solape de agenda |
| `FREEBUSY_UNAVAILABLE` | 409 | no se pudo verificar disponibilidad externa |
| `ALREADY_PROCESSED` / `NO_SLOT` | 409 | conversión de inbox |
| `RESET_DISABLED` | 403 | reset-demo en producción |
| `INTERNAL` | 500 | error no controlado |

Body de error siempre `{error, code, field?, details?, requestId}`.

### 23.1 Códigos propios de los módulos t13-t27

| code | status | módulo | significado |
|---|---:|---|---|
| `ALREADY_APPROVED` | 409 | office | propuesta ya aprobada |
| `ALREADY_EXECUTED` | 409 | office | propuesta ya ejecutada |
| `EXECUTE_IN_PROGRESS` | 409 | office | ejecución concurrente en curso |
| `REJECTED` / `REVERTED` | 409 | office | estado terminal incompatible |
| `INVALID_STATE` | 409 | office | transición no permitida |
| `NOT_APPROVED` | 409 | office | falta aprobación |
| `SIGNATURE_INVALID` | 409 | office | payload alterado o HMAC inválida |
| `APPROVAL_EXPIRED` | 409 | office | TTL de aprobación vencido |
| `CODE_REQUIRED` | 400 | office | N3 sin código |
| `INVALID_CODE` / `CODE_USED` | 409 | office | código N3 incorrecto o ya usado |
| `SHADOW_MODE` | 409 | office | modo sombra bloquea ejecución |
| `APPROVAL_REQUIRED` | 403 | gmail | `direct:true` sin `settings.office.allowDirectSend` |
| `OFFICE_UNAVAILABLE` | 503 | gmail/office/settings/channels | la Oficina o su ledger no está disponible; no se envía ni se persisten flags |
| `OFFICE_ERROR` | 502 | gmail | no se pudo crear la propuesta de correo |
| `EXECUTOR_UNAVAILABLE` | 503 | office | no hay ejecutor para el canal |
| `EXECUTOR_FAILED` | 502 | office | el ejecutor lanzó un error |
| `UNDO_EXPIRED` / `UNDO_NOT_SUPPORTED` / `NOT_UNDOABLE` | 409 | office | deshacer no aplicable |
| `VALIDATION` | 400 | travel/docs/research | validación de módulo (con `field`) |
| `PLACE_NOT_FOUND` | 404 | travel | lugar no encontrado |
| `PLACE_EXISTS` | 409 | travel | duplicado de nombre+ciudad |
| `EVENT_NOT_FOUND` | 404 | travel/tasks | `eventId` inexistente |
| `DOC_NOT_FOUND` / `DOC_FILE_MISSING` | 404 | docs | documento/archivo inexistente |
| `DOC_TOO_LARGE` | 413 | docs | documento > 12 MB |
| `DOC_LIMIT` / `DOC_STORAGE_LIMIT` | 409 | docs | límites de documentos/almacén |
| `TEMPLATE_NOT_FOUND` | 404 | docs | plantilla inexistente |
| `TEMPLATE_RESERVED` / `TEMPLATE_LIMIT` | 409 | docs | plantilla `acta` o límite |
| `TEMPLATE_TYPE_MISMATCH` | 400 | docs | plantilla de otro tipo |
| `EMAIL_NOT_CONFIGURED` | 503 | channels/docs | Gmail no conectado; no crea propuesta |
| `UNSUPPORTED_PROTOCOL` / `INVALID_URL` | 400 | research | protocolo/URL no permitido |
| `SSRF_BLOCKED` | 403 | research | host/IP privada, loopback o metadata |
| `DNS_ERROR` / `TOO_MANY_REDIRECTS` / `HTTP_ERROR` / `FETCH_ERROR` | 502 | research | fallo de red/redirección |
| `UNSUPPORTED_CONTENT_TYPE` | 415 | research | tipo de contenido no permitido |
| `TOO_LARGE` | 413 | research | respuesta > 2 MB |
| `TIMEOUT` | 504 | research | fetch > 8 s |
| `NO_SOURCES` | 422 | research | sin fuentes válidas para el informe |
| `OUT_OF_RANGE` | 400 | nudges/thread | rango/limit inválido |
| `MCP_INVALID_CONFIG` | 400 | mcp | configuración de servidor inválida |
| `MCP_SERVER_NOT_FOUND` | 404 | mcp | servidor no existe |
| `MCP_SERVER_DISABLED` | 409 | mcp | servidor deshabilitado |
| `MCP_TOOL_NOT_ALLOWED` | 403 | mcp | herramienta fuera de allowlist |
| `MCP_TOOL_NOT_FOUND` | 404 | mcp | herramienta inexistente |
| `MCP_SPAWN_FAILED` / `MCP_PROCESS_EXITED` | 502 | mcp | el proceso hijo no arranca/muere |
| `MCP_TIMEOUT` | 504 | mcp | operación MCP > timeout |
| `MCP_RPC_ERROR` / `MCP_PROTOCOL_ERROR` / `MCP_HTTP_ERROR` | 502 | mcp | error JSON-RPC/protocolo/HTTP |
| `MCP_RESPONSE_TOO_LARGE` | 502 | mcp | respuesta > `MCP_MAX_RESPONSE_BYTES` |
| `MCP_SECRET_ERROR` | 500 | mcp | no se pudo descifrar un secreto |
| `MCP_GATE_UNAVAILABLE` | 503 | mcp | Oficina no disponible; efecto denegado |
| `MCP_GATE_FAILED` | 502 | mcp | no se pudo crear la propuesta de gate |
| `MCP_PENDING_CALL_MISSING` | 409 | mcp | token de llamada pendiente ausente/caducado |

---

## 24. Persistencia, migración y recuperación

- Archivo: `DATA_DIR/agenda-data.json` (schema **v2**), `journal.jsonl`,
  rotación `agenda-data.json.bak`, `.bak.1`, `.bak.2`.
- Escritura atómica: temporal + `fsync` + rotación + `rename` + `fsync` de
  directorio; recuperación automática desde `.bak`/`.tmp` si falta el principal.
- Migración v1→v2 con backup previo obligatorio
  (`agenda-data.json.pre-v1-<ts>.json`); la v2 añade `auth`, `secrets`,
  `signals`, `workflows`, `llm`, `channelState`.
- JSON corrupto: **no** se sobrescribe con el seed → se renombra a
  `agenda-data.json.corrupt[-<ts>]` y la app arranca en **solo lectura**
  (`health.ok=false`, `health.store.loadError`, escrituras `503`).
  `POST /api/backup/restore` recupera y vuelve a modo normal.
- `reset-demo` conserva auth, secretos, Google y ajustes (§13).

### 24.1 Persistencia nueva de t13-t27 (sin migración)

Estas claves se crean **perezosamente** y no cambian `schemaVersion` (sigue en
v2). El store conserva claves desconocidas al cargar/migrar, por lo que no hace
falta migración ni reinicio para empezar a usarlas:

| Clave | Módulo | Contenido |
|---|---|---|
| `data.office` | office | `mode`, `proposals[]`, `ledger[]`, `contacts[]`, ventanas/config |
| `data.style` | style/thread | `samples{}`, `profiles{}`, `variations[]` |
| `data.identity` | identity | `contacts[]`, `metadata[]`, `gmailMessages[]` |
| `data.places` | travel | catálogo de lugares (`PL-…`); seed en memoria hasta la primera mutación |
| `data.tasks` | travel | tareas (`TK-…`) con estado/origen/eventId |
| `data.nudges` | nudges | `config`, `state` (historial, contadores, cooldowns) |
| `data.research` | research | `sources[]` (máx. 200), `reports[]` (máx. 50) |
| `data.mcp` | mcp | `servers[]`, `secrets` cifrados AES-256-GCM, `pendingCalls` cifrados |
| `data.channelState` | thread | mensajes normalizados que lee el contexto de hilo (existente) |
| `DATA_DIR/docs/` | docs | `index.json`, `templates.json` y binarios `<ID>.<ext>` (fuera del store) |

- `style.variations` también guarda los acuses de `thread` (tipo `acuse`,
  ventana 7 días) sin crear otra clave.
- Los binarios y plantillas de `docs` **no** van dentro de
  `agenda-data.json`; el backup del store no los incluye (son archivos).
- Los secretos de MCP no se guardan en claro: cajas AES-256-GCM en
  `data.mcp.secrets`; los argumentos de llamadas pendientes también.
- El ledger de oficina y las propuestas sobreviven reinicios; el ledger no se
  poda.

---

## 25. Variables de entorno

| Variable | Uso |
|---|---|
| `PORT` | puerto (def. 3000) |
| `HOST` / `APP_HOST` | bind (def. `127.0.0.1`); ≠ loopback ⇒ auth obligatoria |
| `APP_AUTH` | `on|true|1|si` fuerza login también en local |
| `APP_SECRET` / `AGENDA_MASTER_KEY` | clave maestra (≥8 chars). Sin ella se usa `DATA_DIR/.master-key` |
| `APP_SETUP_TOKEN` | permite `POST /api/auth/setup` desde red |
| `APP_URL` | URL pública (webhooks/OAuth, origen permitido) |
| `DATA_DIR` | directorio de datos (def. `./data`) |
| `TIMEZONE` | zona por defecto (def. `America/Bogota`) |
| `NODE_ENV=production` | activa modo estricto (webhooks con secreto, reset-demo off) |
| `LOG_LEVEL` | `debug|info|warn|error` (def. `info`) |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | LLM OpenAI-compatible |
| `OLLAMA_URL`, `OLLAMA_MODEL` | LLM local |
| `WA_*`, `TELEGRAM_*`, `EMAIL_*`, `GOOGLE_*`, `WEBHOOK_SECRET` | canales/Google (ver §4) |
| `OFFICE_HMAC_SECRET` | secreto HMAC de aprobaciones de Oficina; si falta se usa `APP_SECRET`/clave maestra |
| `GOOGLE_DISTANCE_MATRIX_KEY` / `GOOGLE_MAPS_API_KEY` | ETA de viajes con tráfico real; sin clave se usa el cálculo offline |
| `MCP_GATE_DISABLE=1` | **solo pruebas**: simula Oficina ausente y devuelve `MCP_GATE_UNAVAILABLE` para efectos |
| `MCP_MAX_RESPONSE_BYTES` | límite de respuesta MCP (def. 1 000 000) |
| `WORKFLOWS_AUTOSTART=0` | desactiva el scheduler y el hook de avisos; también `NODE_ENV=test` |

Las variables de entorno tienen prioridad sobre la bóveda. Los `env`/`headers`
de servidores MCP **no** se leen de variables de entorno: se guardan cifrados en
`data.mcp.secrets` y solo se descifran al lanzar el proceso MCP.

---

## 26. Ejemplos rápidos

```bash
# salud + cabeceras
curl -i http://127.0.0.1:3000/api/health
curl -I http://127.0.0.1:3000/api/health

# fecha inválida → 400 y el servidor sigue vivo
curl -s -o - -w '\n%{http_code}\n' -X POST http://127.0.0.1:3000/api/agenda \
  -H 'content-type: application/json' \
  -d '{"title":"x","start":"x","end":"y"}'

# alta válida
curl -s -X POST http://127.0.0.1:3000/api/agenda \
  -H 'content-type: application/json' \
  -d '{"title":"Reunión","start":"2026-11-02T10:00:00-05:00","end":"2026-11-02T11:00:00-05:00"}'

# secreto (nunca se devuelve)
curl -s -X PUT http://127.0.0.1:3000/api/secrets/llm.openai.apiKey \
  -H 'content-type: application/json' -d '{"value":"sk-…"}'
curl -s http://127.0.0.1:3000/api/secrets

# backup + restore
curl -s http://127.0.0.1:3000/api/backup -o backup.json
curl -s -X POST http://127.0.0.1:3000/api/backup/restore \
  -H 'content-type: application/json' \
  -d "{\"confirm\":\"RESTORE\",\"data\":$(cat backup.json)}"

# modo red: login obligatorio
HOST=0.0.0.0 APP_AUTH=on npm start
curl -s -o - -w '\n%{http_code}\n' http://127.0.0.1:3000/api/bootstrap   # 401
curl -s -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/setup \
  -H 'content-type: application/json' -d '{"password":"ClaveSegura123"}' # 201
curl -s -b cookies.txt http://127.0.0.1:3000/api/bootstrap               # 200

# oficina: propuesta N2, aprobación y ejecución
curl -s -X POST http://127.0.0.1:3000/api/office/proposals \
  -H 'content-type: application/json' \
  -d '{"kind":"document","channel":"document","recipients":[],"subject":"Nota","body":"Borrador"}'
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/approve \
  -H 'content-type: application/json' -d '{"by":"owner"}'
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/execute \
  -H 'content-type: application/json' -d '{}'

# viajes: plan Cali → Palmira (16:00 → 16:30)
curl -s -X POST http://127.0.0.1:3000/api/travel/plan \
  -H 'content-type: application/json' \
  -d '{"fromPlace":"Cali","fromAt":"2026-10-29T16:00:00-05:00","toPlace":"Palmira","toAt":"2026-10-29T16:30:00-05:00"}'

# documentos: crear y descargar
curl -s -X POST http://127.0.0.1:3000/api/docs \
  -H 'content-type: application/json' \
  -d '{"type":"docx","title":"Acta","sections":[{"heading":"Resumen","level":1},{"paragraph":"…"}]}'
curl -s -o acta.docx http://127.0.0.1:3000/api/docs/DOC-…/download

# MCP: registrar el mock y hacer probe
curl -s -X POST http://127.0.0.1:3000/api/mcp/servers \
  -H 'content-type: application/json' \
  -d '{"name":"mock","transport":"stdio","command":"node","args":["scripts/mock-mcp-server.mjs"]}'
curl -s -X POST http://127.0.0.1:3000/api/mcp/servers/MCP-0001/probe \
  -H 'content-type: application/json' -d '{}'
```

---

## 27. Checklist para módulos nuevos (t3-t27)

1. Crear `lib/routes/<modulo>.mjs` con `export const routes = […]` y
   `priority ≥ 1`; no editar `server.mjs`.
2. Usar `ctx.json/ctx.text/ctx.body/ctx.params/ctx.query`; no escribir en `res`.
3. Validar toda escritura con `lib/validate.mjs` (o equivalencia estricta:
   fechas reales, rangos, longitudes, lista blanca de campos).
4. Errores: lanzar `HttpError(status, code, message, {field})` de
   `lib/http/errors.mjs`; mantener `{error, code, field, requestId}`.
5. Secretos: leer con `getSecret(name)` de `lib/security/vault.mjs`; **nunca**
   devolver el valor ni loguearlo.
6. Persistencia: `store.mutate(fn, {label})`; nunca escribir el JSON a mano.
7. No definir rutas ya cubiertas por `agenda`/`inbox`/`routines` salvo que sea
   una sustitución deliberada (mayor `priority`) y esté en este contrato.
8. **No programes temporizadores en `server.mjs` ni en tu módulo**: registra los
   trabajos periódicos en `lib/workflows/scheduler.mjs` (t8).
9. Añadir la ruta a este documento (o pedirlo a backend-core) y verificar
   `node --check`, `GET /api/health` (módulo `ok:true`) y una petición real.
10. Actualizar la tabla de inventario (§1.12) y la cobertura del bloque que
    corresponda (§28) con 0 faltantes / 0 extras.

---

## 28. Cobertura de rutas de los módulos t13-t27

Verificación ejecutada contra `lib/routes/*.mjs` y este contrato (extracción de
pares método+ruta, ignorando `HEAD` implícito). **0 faltantes / 0 extras** por
módulo:

| Módulo | priority | Implementadas | Documentadas | Faltantes | Extras |
|---|---:|---:|---:|---:|---:|
| office | 130 | 16 | 16 | 0 | 0 |
| style | 120 | 5 | 5 | 0 | 0 |
| identity | 120 | 4 | 4 | 0 | 0 |
| travel + tasks | 100 | 22 | 22 | 0 | 0 |
| nudges | 100 | 7 | 7 | 0 | 0 |
| docs | 120 | 9 | 9 | 0 | 0 |
| research | 100 | 8 | 8 | 0 | 0 |
| thread | 120 | 3 | 3 | 0 | 0 |
| mcp | 140 | 9 | 9 | 0 | 0 |
| **Total** | — | **83** | **83** | **0** | **0** |

Notas:

- `nudges` son 7 rutas (6 familias; `config` tiene GET y POST). El resumen de
  t16 hablaba de “6 endpoints”; la implementación real y este contrato fijan 7.
- `HEAD` sobre rutas GET (p. ej. `/api/docs/:id/download`) es semántica HTTP del
  router, no una ruta adicional.
- El inventario global del router (§1.12) suma **236 declaraciones** y **215
  rutas efectivas** tras resolver **21 conflictos** de rutas heredadas; las
  rutas de este bloque no tienen conflictos. Los conflictos nuevos de canales
  son `POST /api/docs/:id/send-email` (docs→channels), `POST
  /api/whatsapp/test` y `POST /api/telegram/test` (core→channels).


---

## 29. Wiki interna (2026-10-28)

Memoria escrita consultable. Datos en `data.wiki.pages`; clave nueva, incluida
en backup/restore. Sin dependencia de Google.

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/wiki/pages?q=&tag=&limit=&offset=` | — | `{ok, items[], total, count}` con `bodyPreview` |
| POST | `/api/wiki/pages` | `{title, body, tags?}` | 201 `{ok, item}` |
| GET | `/api/wiki/pages/:id` | — | `{ok, item}` con `body` completo |
| PATCH | `/api/wiki/pages/:id` | `{title?, body?, tags?}` | `{ok, item}` |
| DELETE | `/api/wiki/pages/:id` | — | `{ok, item, deleted:true}` |
| GET | `/api/wiki/stats` | — | `{ok, pages, words, tags[], updatedAt}` |

Reglas:

- `title` 1–160, `body` 1–50.000, máximo 12 etiquetas normalizadas (sin `#`,
  deduplicadas por minúsculas) y 500 páginas (`WIKI_FULL`).
- IDs estables `WK-0001`; `updatedAt` cambia en cada edición.
- Errores: 400 `REQUIRED`/`TOO_LONG`/`EMPTY_PATCH`, 404 `NOT_FOUND`, 409
  `WIKI_FULL`.
- La UI escapa título, etiquetas, contenido y preview; el cuerpo no se devuelve
  en el listado para no cargar páginas enteras al buscar.

Pruebas: `scripts/probe-wiki.mjs` (15/15, en `npm test`) y
`scripts/verify-wiki.mjs` (12/12, API + Chrome real).

---

## 30. Reglas de correo y cuarentena (2026-10-28)

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/mail/rules` | — | `{ok, items[], count}` |
| POST | `/api/mail/rules` | `{field:"from"|"subject", match:"contains"|"equals"|"domain", value, action:"quarantine"|"skip"}` | 201 `{ok, item}` |
| DELETE | `/api/mail/rules/:id` | — | `{ok, item, deleted:true}` |
| GET | `/api/mail/quarantine?status=held&limit=` | — | `{ok, items[], total}` |
| POST | `/api/mail/quarantine/:id/release` | `{compose?:boolean}` | `{ok, item, proposal\|null}` |
| POST | `/api/mail/quarantine/:id/discard` | — | `{ok, item}` |

Reglas:

- `value` 1–120; IDs estables `MR-0001` y `Q-0001`.
- `domain` cubre subdominios (`sub.spam.test` coincide con `spam.test`).
- El auto-borrador consulta las reglas tras descartar remitentes automáticos;
  si la acción es `quarantine`, guarda el mensaje y **no** crea propuesta.
- `release` con `compose:true` compone una propuesta N2 (firma de Héctor) y
  devuelve su `id`; si la composición falla, el elemento sigue retenido (la
  liberación se hace después de componer).
- `discard` conserva el registro con `discardedAt`; no borra evidencia.
- Errores: 400 `REQUIRED`/`INVALID_VALUE`, 404 `NOT_FOUND`.

---

## 31. Base de tablas (2026-10-28)

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/base/tables` | — | `{ok, items[], count, types[]}` sin filas |
| POST | `/api/base/tables` | `{name, columns}` | 201 `{ok, item}` |
| GET | `/api/base/tables/:id` | — | `{ok, item}` con filas |
| DELETE | `/api/base/tables/:id` | — | `{ok, item, deleted:true}` |
| POST | `/api/base/tables/:id/rows` | `{values:{colId:valor}}` | 201 `{ok, item}` |
| PATCH | `/api/base/tables/:id/rows/:rowId` | `{values:{...}}` | `{ok, item}` (merge) |
| DELETE | `/api/base/tables/:id/rows/:rowId` | — | `{ok, item, deleted:true}` |

Reglas:

- `columns` acepta `"Nombre:texto, Fecha:fecha"` o `[{name,type}]`; tipos
  `text|number|date|checkbox`; máximo 12 columnas y nombres únicos.
- Límites: 20 tablas (`BASE_FULL`), 500 filas por tabla (`BASE_ROWS_FULL`),
  nombre de tabla único (`DUPLICATE`).
- Valores: números finitos, fechas `AAAA-MM-DD`, checkbox booleano, texto
  ≤2000. Los IDs de columna desconocidos se ignoran; los inválidos dan 400.
- IDs `TB-0001` / `ROW-0001`; datos en `data.base.tables`.

---

## 32. Traducción (2026-10-28)

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/translate/languages` | — | `{ok, items[{code,name,label}]}` |
| POST | `/api/translate` | `{text, to?, from?}` | `{ok, translation, to, from, provider, model}` |

Reglas:

- `text` 1–4.000 caracteres; `to` ∈ `es,en,pt,fr,de,it` (por defecto `es`).
- Usa el proveedor LLM activo con temperatura 0; el texto se envuelve como dato
  delimitado para reducir prompt-injection.
- Sin proveedor o con error del modelo: 503 `TRANSLATE_UNAVAILABLE` (no hay
  traducción inventada).
- Errores de validación: 400 `REQUIRED`, `TOO_LONG`, `INVALID_VALUE`.

---

## 33. Léxico (Lingo) — pantalla y API (2026-10-28)

La vista **Léxico** consume la API ya existente:

| Método | Ruta | Uso en la pantalla |
|---|---|---|
| GET | `/api/lingo/terms?status=&q=&limit=` | Lista y filtros |
| POST | `/api/lingo/terms` | Crear término en sombra |
| PATCH | `/api/lingo/terms/:id` | Aprobar / sombra / rechazar |
| POST | `/api/lingo/apply` | Probar canonicalización |

- Nuevos términos nacen `shadow`; solo los `approved` se aplican por defecto en
  redacción y voz. `includeShadow:true` sirve para probar.
- Límites: 5.000 términos, 30 variantes, contexto ≤120; variantes únicas entre
  términos (409 `LINGO_CONFLICT`).
- Rechazar conserva el término y registra el cambio en el ledger; no hay borrado
  físico desde la UI.

---

## 34. Auditoría (2026-10-28)

| Método | Ruta | Parámetros | Respuesta |
|---|---|---|---|
| GET | `/api/audit/events` | `actor,action,q,from,to,limit,offset` | `{ok,items,total,ledgerTotal,filters}` |
| GET | `/api/audit/stats` | — | `{ok,total,actors,actions,verification}` |
| GET | `/api/audit/export` | `format=json\|csv` + filtros | JSON o CSV descargable |

Reglas:

- Solo lectura sobre `office.ledger`; no crea, edita ni borra entradas.
- `from`/`to` son fechas reales `AAAA-MM-DD`; invertirlas da 400
  `INVALID_RANGE`. `limit` 1–500 (por defecto 50).
- `q` busca en actor, acción y JSON del payload. `actor` es coincidencia exacta;
  `action` es contiene, sin distinguir mayúsculas.
- CSV con cabecera `seq,ts,actor,action,payload,payloadHash,prevHash,hash` y
  neutralización de fórmulas para hojas de cálculo.
- `verification.ok` refleja `verifyLedger`; si la cadena está rota, la UI lo
  muestra en rojo.

---

## 35. Captura de reunión (2026-10-28)

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/api/meetings/capture` | `{title, transcript, date?, time?, location?, modality?}` | `{ok, title, metadata, extraction, empty, provider, model}` |

- `extraction`: `{summary[], attendees[{name,role}], agenda[], development, agreements[{text,owner,due}], risks[]}`.
- Solo extrae; el acta se crea con `POST /api/docs` (`type:docx`,
  `template:"acta"`, campos `topic/attendees/agenda/body/agreements/summary/annexNotes`).
- Valida título y transcripción (30–20.000); JSON inválido del modelo → 502
  `CAPTURE_BAD_RESPONSE`; sin LLM → 503 `CAPTURE_UNAVAILABLE`.
- Las notas privadas no forman parte de este contrato: se quedan en el navegador
  hasta crear el acta y nunca se envían al modelo.

---

## 36. Identidades multicorreo — pantalla (2026-10-28)

La vista **Identidades** consume la API existente:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/identity/people?q=&limit=` | Lista y búsqueda |
| POST | `/api/identity/contacts` | Crear/fusionar persona y correos |
| POST | `/api/identity/expand` | Probar destinatarios antes de enviar |

- `contacts` acepta `name`, `emails[]` (1–10), `aliases[]` y `note`; mismo nombre
  fusiona. Correo inválido → 400 `INVALID_FORMAT`.
- La UI filtra personas sin correo para no mostrar alias sueltos.
- `expand` devuelve `people`, `recipients`, `duplicatesRemoved` y
  `requiresConfirmation`; el rojo/aviso aparece con ambigüedad o confianza < 0.8.
- No hay borrado de contactos desde la UI; el mapeo manual se conserva.

---

## 37. Loop guard (2026-10-28)

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/api/loop-guard/status` | `{ok, mode, attempts, recorded, blocked, wouldBlock, targets, recent, windowMin, maxIdentical, maxPerTarget}` |
| POST | `/api/loop-guard/reset` | `{ok, reset:true, mode}` |

- `mode` es el del flag `loop_guard` (`off|shadow|on`). En `off` solo observa;
  en `shadow` cuenta `wouldBlock`; en `on` bloquea con 429 `LOOP_GUARD`.
- Estado en memoria del proceso: reiniciar el servidor limpia contadores.
- No envía mensajes; sirve para diagnóstico y para el panel de funciones.

---

## 38. Centro de aprobaciones — composición (2026-10-28)

No añade endpoints: compone vistas existentes.

| Fuente | Uso |
|---|---|
| `GET /api/office/proposals?status=pending|held` | Bandeja de pendientes |
| `GET /api/office/proposals?status=approved` | Aprobadas por ejecutar |
| `POST /api/office/proposals/:id/approve` | Aprobar (`by`,`note`) |
| `POST /api/office/proposals/:id/reject` | Rechazar (`by`,`reason`) |
| `POST /api/office/proposals/:id/execute` | Ejecutar (`code` si N3) |
| `GET /api/mail/quarantine?status=held` | Correo retenido |
| `POST /api/mail/quarantine/:id/release` | Liberar (`compose:false`) |
| `POST /api/mail/quarantine/:id/discard` | Descartar |

- Aprobar no ejecuta; ejecutar es un paso aparte y sigue el gate/ledger actual.
- Liberar cuarentena desde aquí no redacta respuesta (`compose:false`); para
  proponer respuesta se usa la tarjeta de reglas de correo.

---

## 39. Objetivos (OKR) (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/okr/objectives?status=&q=` | Listar/filtrar |
| POST | `/api/okr/objectives` | Crear `{title,owner?,quarter?}` |
| GET | `/api/okr/objectives/:id` | Detalle |
| PATCH | `/api/okr/objectives/:id` | Editar título/responsable/trimestre/estado |
| DELETE | `/api/okr/objectives/:id` | Borrar objetivo |
| POST | `/api/okr/objectives/:id/key-results` | Añadir `{title,target,current?,unit?}` |
| PATCH | `/api/okr/objectives/:id/key-results/:krId` | Actualizar resultado |
| DELETE | `/api/okr/objectives/:id/key-results/:krId` | Borrar resultado |
| GET | `/api/okr/stats` | Totales, avance medio y objetivos en riesgo |

- Progreso calculado en servidor; no se acepta desde el cliente.
- `quarter` `AAAA-Q1..Q4`; estados `active|done|paused`; límites 30/10.
- Mutaciones pasan por `store.mutate` y dejan `okr.change` en el ledger.

---

## 40. Métricas de aprobación (2026-10-28)

| Método | Ruta | Parámetros | Respuesta |
|---|---|---|---|
| GET | `/api/approvals/metrics` | `slaHours` 1–720 (24), `windowDays` 1–90 (7) | métricas calculadas |

Campos principales: `pending`, `held`, `approved`, `executed`, `rejected`,
`oldestPendingHours`, `averagePendingHours`, `slaHours`, `slaBreaches`,
`averageApprovalHours`, `medianApprovalHours`, `averageExecutionHours`,
`recent{approved,rejected,executed}`, `byLevel{N1,N2,N3}`, `quarantine`.

- Solo lectura; no persiste nada. Sin datos, los promedios son `null`.
- SLA por defecto 24 h; una propuesta `pending|held` cuenta como pendiente.

---

## 41. Etiquetas de seguridad en Documentos (2026-10-28)

No se añaden campos al índice de documentos. La clasificación vive en el ACL:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/acl/documents/:docId` | Etiqueta actual (`label`, `effectiveLabel`) |
| PUT | `/api/acl/documents/:docId` | Cambiar etiqueta (`label` ∈ público/interno/reservado) |
| GET | `/api/acl/documents?limit=` | Listado para cruzar con documentos |
| POST | `/api/acl/check` | Previsualizar decisión por canal/destinatarios |

- Documento `reservado` a externos sin `confirmedReserved:true` → `403 ACL_DENIED`
  en la salida de canal; con confirmación exige N3.
- El correo directo de `/api/docs/:id/send-email` está resuelto por el módulo de
  canales (mayor prioridad) y crea propuesta con ACL; no envía directo.
- La UI de Documentos muestra la etiqueta y la permite cambiar; no inventa una
  segunda clasificación en el índice.

---

## 42. Salas físicas (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/rooms?date=AAAA-MM-DD` | Salas y sus reservas del día |
| GET | `/api/rooms/availability?date=` | Disponibilidad y conteo de libres |
| GET | `/api/rooms/stats` | Salas activas, reservas activas, hoy |
| POST | `/api/rooms` | Crear `{name,location?,capacity?,notes?}` |
| PATCH | `/api/rooms/:id` | Editar sala |
| DELETE | `/api/rooms/:id` | Borrar (falla si hay reservas activas) |
| POST | `/api/rooms/:id/reservations` | Reservar `{title,date,start,end,by?}` |
| DELETE | `/api/rooms/reservations/:id` | Cancelar reserva |

- `date` AAAA-MM-DD real; `start`/`end` HH:MM y `start < end`.
- Solape → `409 ROOM_CONFLICT`; el detalle incluye la reserva que choca.
- Límites 20 salas / 1000 reservas; IDs `RM-####` / `RS-####`.
- Mutaciones vía `store.mutate` y ledger `rooms.change`.

---

## 43. Momentos (resumen semanal) (2026-10-28)

| Método | Ruta | Parámetros | Uso |
|---|---|---|---|
| GET | `/api/moments/weekly` | `at` ISO opcional (pruebas) | Resumen de 7 días atrás / 7 adelante |

Respuesta: `from`, `to`, `today`, `counts{eventsPast,eventsNext,tasksCreated,
tasksDone,docsCreated,proposalsApproved,proposalsExecuted,reservationsNext}`,
`needsYou{approvals,overdueTasks,atRisk}`, `wins{tasks,documents,approvals,
okrProgress}`, `next[]`, `reservations[]`, `text`.

- Determinista; no llama al modelo ni escribe datos.
- Los eventos creados por rutinas también cuentan.
- El avance OKR se recalcula desde `current/target` (no confía en un campo
  `progress` persistido).

---

## 44. Jornada (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/attendance?from=&to=` | Turnos y resumen del rango |
| GET | `/api/attendance/summary?from=&to=` | Solo resumen |
| POST | `/api/attendance/clock-in` | Abrir turno (`at` opcional para pruebas) |
| POST | `/api/attendance/clock-out` | Cerrar turno (`at` opcional) |
| POST | `/api/attendance/break` | Sumar pausa `{minutes}` al turno abierto |
| PATCH | `/api/attendance/:id` | Corregir `start/end/breakMinutes/note` |
| DELETE | `/api/attendance/:id` | Borrar turno |

- Minutos = `(end - start) - breakMinutes`, nunca negativo.
- `date` se deriva del inicio local; un turno nocturno queda en el día de inicio.
- IDs `AT-####`; máximo 2000 turnos; ledger `attendance.change`.

---

## 45. Preguntar a la Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/base/ask` | `{question, tableId?}` → respuesta en lenguaje natural |

- Elige tabla por nombre mencionado, por `tableId` o si solo hay una.
- Filtros soportados: `=`, `contiene`, `≠`, `>`, `≥`, `<`, `≤` sobre columnas.
- Devuelve `answer`, `table`, `rows` (máx. 20), `matched`, `total`, `filters`.
- No ejecuta SQL, no llama al modelo y no inventa datos; ante ambigüedad
  devuelve `ambiguous: true`.

---

## 46. Tipos de aprobación y solicitudes (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET/POST | `/api/approval-types` | Listar / crear `{name,level,fields,description?}` |
| DELETE | `/api/approval-types/:id` | Borrar tipo (las solicitudes conservan nombre) |
| GET | `/api/approval-types/stats` | Totales por estado |
| GET | `/api/approval-requests?status=` | Listar solicitudes |
| POST | `/api/approval-requests` | Crear `{typeId,title,values}` |
| POST | `/api/approval-requests/:id/approve` | Aprobar `{by,reason?}` |
| POST | `/api/approval-requests/:id/reject` | Rechazar `{by,reason?}` |

- Niveles permitidos en tipos personalizados: N1 y N2 (N3 queda para el gate de
  la Oficina, que sí exige código).
- Campos obligatorios se validan en servidor; números/fechas/casillas se
  convierten antes de guardar.
- Una solicitud decidida no se puede volver a decidir (`409 ALREADY_DECIDED`).

---

## 47. Copia de seguridad (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/admin/export` | Copia JSON de datos de trabajo |

- Incluye `counts` y `data` con agenda, tareas, recurrencias, documentos
  (metadatos), propuestas/ledger, OKR, salas, jornada, Base, Wiki y aprobaciones.
- Excluye vault, secretos, tokens, conexiones y binarios; solo lectura.
- No hay restauración automática desde este endpoint: es una copia para el
  usuario, no un reemplazo de los backups del servidor.

---

## 48. Historial de versiones de Documentos (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/docs/:id/versions` | Versiones con el mismo título |

- Agrupa por título exacto normalizado (trim + minúsculas), orden descendente por
  `createdAt`; devuelve `{title,count,items[]}` con metadatos y `downloadUrl`.
- Es una vista de los documentos existentes, no un almacén de versiones nuevo.

---

## 49. Marca de agua en documentos (2026-10-28)

- `POST /api/docs` admite `watermark` (texto opcional, máx. 40).
- En DOCX se renderiza en `word/header1.xml` como texto gris centrado; se escapa
  el XML. Excel y PowerPoint aceptan el campo pero no lo dibujan.
- No sustituye etiquetas ACL ni cifrado; es una marca visual de encabezado.

---

## 50. Visibilidad de módulos (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/settings/modules` | Lista `{key,enabled}` |
| PATCH | `/api/settings/modules/:key` | Cambia `{enabled:boolean}` |

- Claves: `approvals`, `okr`, `rooms`, `attendance`, `moments`, `base`, `docs`, `wiki`.
- Solo controla menú y navegación del cliente; las rutas del servidor siguen
  disponibles. No es un sistema de permisos.

---

## 51. Exportar Base a CSV (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/base/tables/:id/export.csv` | Descarga CSV de la tabla |

- UTF-8 con BOM, comillas RFC 4180, `text/csv`.
- Neutraliza fórmulas (`=`, `+`, `-`, `@`, tab, CR) con apóstrofo.
- Casillas `Sí`/`No`; no altera la tabla ni sus filas.

---

## 52. Importar CSV a Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/base/tables/:id/import.csv` | Añade filas desde `{csv}` |

- Cabeceras por nombre de columna; desconocidas → `400 INVALID_CSV`.
- Validación de tipos y límite de 500 filas; si una fila falla no se guarda
  ninguna. Límite de cuerpo CSV: 500 KB.
- No ejecuta fórmulas; solo guarda texto/números/fechas/casillas.

---

## 53. Exportar Base a Excel (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/base/tables/:id/export.xlsx` | Libro Excel de la tabla |

- XLSX real (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`),
  una hoja con cabeceras, tipos, autofiltro y fila superior congelada.
- Solo lectura; no altera la tabla.

---

## 54. Vistas guardadas de Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/base/tables/:id/views` | Lista de vistas |
| POST | `/api/base/tables/:id/views` | Crea `{name, filters}` |
| DELETE | `/api/base/tables/:id/views/:viewId` | Borra vista |

- `filters` es una lista de `{columnId, op, value}`; operadores `contains`, `eq`,
  `neq`, `gt`, `gte`, `lt`, `lte`.
- Máximo 10 vistas por tabla; nombres únicos; máximo 4 filtros por vista.
- No altera filas ni columnas; es una consulta guardada.

- `sort` opcional en `POST /api/base/tables/:id/views`: `{columnId, direction}`.
  La tabla también ordena en cliente al pulsar la cabecera.

### Corrección §49: marca de agua en los tres formatos

- DOCX: encabezado; XLSX: `headerFooter` de impresión; PPTX: forma de texto
  translúcida en cada diapositiva. El campo y límite de 40 caracteres no cambian.

---

## 55. SLA en tipos de aprobación (2026-10-28)

- `POST /api/approval-types` acepta `slaHours` (entero 1–720; por defecto 48).
- `POST /api/approval-requests` calcula `dueAt` a partir del SLA del tipo.
- Las solicitudes incluyen `overdue` y `overdueHours`; `GET /api/approval-types/stats`
  añade `overdue`.
- El SLA es informativo: no escala ni reasigna automáticamente.

### Nota §56: salas y agenda

- «Agendar» es una acción de interfaz: reutiliza `POST /api/agenda` sin endpoint
  nuevo. No modifica la reserva ni crea vínculos; la validación es la de agenda.

### Nota §57: dictado en captura

- El botón de dictado es solo interfaz; no añade endpoints ni guarda audio.
  Usa `SpeechRecognition` del navegador y el motor global de `voice.js`.

### Nota §58: panel de traducción

- El panel consume `GET /api/translate/languages` y `POST /api/translate`.
- No añade endpoints ni persistencia; sin LLM responde 503.

---

## 56. Exportación .ics de agenda (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/agenda/export.ics` | Descarga la agenda activa como iCalendar |

- `content-type: text/calendar; charset=utf-8`; fechas en UTC; no incluye
  canceladas ni eventos sin fecha. Es una copia de solo lectura.

---

## 57. Edición de reservas de sala (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| PATCH | `/api/rooms/reservations/:id` | Edita `title`, `date`, `start`, `end` |

- Solo reservas activas; misma sala; revalida solapamientos; no mueve de sala.
- `PATCH /api/rooms/:id` ya existía para nombre, ubicación, capacidad y notas.

---

## 59. Edición de tipos de aprobación (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| PATCH | `/api/approval-types/:id` | Edita `name`, `description`, `level`, `slaHours` |

- No permite cambiar `fields` ni borrar campos existentes; para otros campos se
  crea otro tipo. Las solicitudes existentes conservan su `typeName` y `values`.

---

## 60. Renombrar tabla de Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| PATCH | `/api/base/tables/:id` | Cambia `name` de la tabla |

- Conserva `id`, columnas, filas y vistas; rechaza duplicados y nombre vacío.

---

## 61. Duplicar documento (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/docs/:id/duplicate` | Crea copia con título «(copia)» |

- Devuelve 201 con el nuevo documento; conserva bytes, tipo y plantilla.
- No copia la etiqueta ACL; la copia nace sin etiqueta propia (hereda la global).

---

## 62. Agregar columna a tabla de Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/base/tables/:id/columns` | Crea `{name, type}` al final |

- Tipos: `text`, `number`, `date`, `checkbox` (acepta alias en español).
- Máximo 12 columnas; nombre único; devuelve `column` y la tabla actualizada.

---

## 63. Renombrar columna de Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| PATCH | `/api/base/tables/:id/columns/:columnId` | Cambia `name` de la columna |

- Conserva id `cN`, filas y vistas; rechaza duplicados y columna inexistente.
- Máximo 60 caracteres para la etiqueta.

---

## 64. Renombrar documento (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| PATCH | `/api/docs/:id` | Cambia `title` y regenera `filename` |

- Conserva id, bytes, `versionKey` y agrupación de versiones.
- Rechaza título vacío (400) y documento inexistente (404).
- La copia creada con `duplicate` usa una clave de versión nueva.

---

## 65. Eliminar columna de Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| DELETE | `/api/base/tables/:id/columns/:columnId` | Borra columna y sus valores |

- Rechaza la última columna (409 `LAST_COLUMN`).
- Elimina vistas que queden sin filtros y devuelve `removedViews`.
- Limpia `sort` si apuntaba a la columna eliminada.

---

## 66. Archivo ZIP de documentos (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/docs/export.zip` | Descarga todos los documentos en ZIP |

- Entradas bajo `documentos/`; nombres únicos.
- No incluye metadatos, etiquetas ACL ni historial de versiones.

---

## 67. Copia completa y restauración (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/backup?secrets=none` | Copia completa sin secretos |
| POST | `/api/backup/restore` | Restaura con `{ confirm: "RESTORE", data }` |

- La copia completa incluye autenticación y ajustes; no incluye vault, tokens ni
  secretos.
- La restauración crea una copia previa `.pre-restore-*.json` cuando existe el
  archivo de datos.

### 67.1 Conservación de secretos al restaurar

- Si `data.secrets` viene vacío o ausente, `store.restore` conserva
  `secrets` y `googleConnections` de la instalación actual y devuelve
  `preservedSecrets: true`.
- Si la copia trae secretos, los reemplaza y devuelve `preservedSecrets: false`.

---

## 68. Duplicar fila de Base (2026-10-28)

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/base/tables/:id/rows/:rowId/duplicate` | Copia una fila |

- Devuelve 201 con la fila nueva; inserta después del original.
- Rechaza fila inexistente (404) y tabla llena (409).

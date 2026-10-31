# LLM y agente de agenda (t3)

Documento del subsistema LLM de **Agenda Copilot P95**: proveedor principal por
API, perfiles por workflow, autocompletado de campos, agente de agenda con
herramientas deterministas, memoria, guardarraíles, control de costo y
degradación garantizada.

> Regla de oro: **la app funciona igual sin LLM**. El proveedor es el cerebro
> preferido, pero todo tiene un camino determinista equivalente.

---

## 1. Resumen

| Pieza | Archivo | Qué hace |
|---|---|---|
| Adaptadores de proveedor | `lib/llm/providers.mjs` | OpenAI-compatible (`/chat/completions`), `openai-responses`, `anthropic`, `ollama`; timeout, 2 reintentos con backoff, health check, latencia y consumo |
| Configuración | `lib/llm/config.mjs` | Lee clave/valores de la **bóveda** de t1 + ajustes no secretos de `store.llm`; valida `POST /api/llm/config` |
| Perfiles | `lib/llm/profiles.mjs` | Modelo, temperatura, máx. tokens y on/off **por workflow** |
| Cliente/cascada | `lib/llm/client.mjs` | API → Ollama → determinista, presupuesto, caché, rate limit, estado y test |
| Uso/costos | `lib/llm/usage.mjs` | Contadores diarios por workflow/proveedor, topes, kill-switch, caché y registro de acciones |
| Trazas | `lib/llm/trace.mjs` | Logs sin contenido sensible y con PII enmascarada |
| Workflows | `lib/llm/workflows.mjs` | Brief, mediodía, cierre, semanal, conflictos, señales, resumen horario, canales, autocompletado, chat |
| Protocolo de intención | `lib/agent/schema.mjs` | Catálogo de acciones, validación estricta del JSON, saneado de campos |
| Prompts | `lib/agent/prompts.mjs` | System prompts en español con reglas P95 y defensa anti prompt-injection |
| Herramientas | `lib/agent/tools.mjs` | 16 herramientas deterministas sobre el motor de t2 |
| Memoria | `lib/agent/memory.mjs` | Últimos 12 mensajes + pendiente, aislados por canal/usuario |
| Agente | `lib/agent/agent.mjs` | Orquesta comandos garantizados → LLM → parser local; confirmaciones |
| Fallback | `lib/agent/fallback.mjs` | Comandos HOY/CAPTURA/HECHO/POSponer/FOCO/CIERRE/SEMANA + parser local |
| Autocompletado | `lib/agent/autocomplete.mjs` | Frase libre → propuesta validada (el usuario confirma antes de guardar) |
| Rutas | `lib/routes/llm.mjs` | Endpoints `/api/llm/*` y `/api/agent/*` |
| Mock + self-test | `lib/llm/mock-server.mjs`, `lib/llm/selftest.mjs` | Prueba end-to-end sin clave real ni Ollama |
| Script de activación | `scripts/llm-setup.ps1` | Configura la bóveda y prueba el proveedor en 2 pasos |

Sin dependencias npm nuevas: solo `node:http`, `node:crypto`, `node:fs` y
`fetch`/`AbortSignal` globales de Node 24.

---

## 2. Configuración en 2 minutos

### Opción A — Centro de integraciones (UI)

1. Abre **Integraciones → LLM**.
2. Pega **proveedor**, **baseUrl** (normalmente termina en `/v1`), **modelo** y
   **clave** (la clave viaja a `PUT /api/secrets/llm.openai.apiKey` y se guarda
   cifrada con AES-256-GCM en la bóveda).
3. Pulsa **Probar** (`POST /api/llm/test`). El estado muestra `reachable=true`
   y el modelo en uso. La UI **nunca** recibe la clave de vuelta: solo
   `configured`, `model` y `baseUrl` saneada.

### Opción B — Script (PowerShell)

```powershell
pwsh -File scripts/llm-setup.ps1
# o sin preguntas:
pwsh -File scripts/llm-setup.ps1 -NonInteractive -Provider openai `
  -BaseUrl 'https://api.mi-proveedor.com/v1' -Model 'mi-modelo' -ApiKey 'sk-...'
```

Hace login si la app exige sesión, guarda los valores en la bóveda, prueba el
proveedor y muestra el estado. La clave se pide como `SecureString` y nunca se
imprime. Opciones útiles: `-ApiVersion`, `-ExtraHeadersJson '{"x-portal":"mi-app"}'`,
`-SkipTest`, `-ClearApiKey`, `-AppUrl`.

### Opción C — curl

```bash
curl -s -X PUT http://127.0.0.1:3000/api/secrets/llm.provider   -H 'content-type: application/json' -d '{"value":"openai"}'
curl -s -X PUT http://127.0.0.1:3000/api/secrets/llm.openai.baseUrl -H 'content-type: application/json' -d '{"value":"https://api.mi-proveedor.com/v1"}'
curl -s -X PUT http://127.0.0.1:3000/api/secrets/llm.openai.model   -H 'content-type: application/json' -d '{"value":"mi-modelo"}'
curl -s -X PUT http://127.0.0.1:3000/api/secrets/llm.openai.apiKey  -H 'content-type: application/json' -d '{"value":"sk-…"}'
curl -s -X POST http://127.0.0.1:3000/api/llm/test -H 'content-type: application/json' -d '{}'
curl -s 'http://127.0.0.1:3000/api/llm/status?probe=1'
```

### Variables de entorno (tienen prioridad sobre la bóveda)

`LLM_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`,
`OLLAMA_URL`, `OLLAMA_MODEL`, `LLM_TIMEOUT_MS`, `LLM_OLLAMA_ENABLED` (flag;
Ollama es **opcional**, nunca un requisito).

### Proveedores soportados

| `provider` | Endpoint | Notas |
|---|---|---|
| `openai` (defecto/auto) | `POST {baseUrl}/chat/completions` | Cualquier API OpenAI-compatible (OpenAI, Groq, DeepSeek, OpenRouter, vLLM, LM Studio, Azure con `apiVersion`…) |
| `openai-responses` | `POST {baseUrl}/responses` | Para APIs que solo exponen el endpoint Responses |
| `anthropic` | `POST {baseUrl}/v1/messages` | Cabeceras `x-api-key` y `anthropic-version`; la clave se guarda igual en `llm.openai.apiKey` |
| `ollama` | `POST {url}/api/chat` | Alternativa offline; se activa con `ollamaEnabled=true` o `provider=ollama` |

Cabeceras extra (`extraHeaders`), `apiVersion` y `maxRetries` se configuran por
`POST /api/llm/config` (no son secretos). La `baseUrl` puede incluir ruta
(`https://host/v1`) y nunca se aceptan esquemas que no sean `http(s)`.

---

## 3. Endpoints

Contrato (`docs/CONTRATO_API.md` §12) y extensiones de esta tarea:

| Método y ruta | Uso |
|---|---|
| `GET /api/llm/status?probe=1` | Estado: `provider`, `model`, `available`, `reachable`, `fallback`, `latencyMs`, `lastError`, `openaiConfigured`, `ollamaUrl`, `mode`, `chain`, `usage`, `profiles` |
| `GET /api/llm/models` | Catálogo del proveedor (o el modelo configurado si el proveedor no lista) |
| `POST /api/llm/chat` | Chat genérico `{messages|text, profile, temperature, maxTokens, requireLlm}` |
| `POST /api/llm/test` | Prueba real (`probe:"chat"` por defecto, admite `"health"`) |
| `POST /api/llm/config` | Ajustes: `provider`, `baseUrl`, `model`, `apiKey`, `apiVersion`, `extraHeaders`, `timeoutMs`, `maxRetries`, `enabled`, `killSwitch`, `ollama*`, `limits`, `profiles`, `memory`, `clearApiKey` |
| `GET /api/llm/usage?days=7` | Consumo diario, por workflow y por proveedor; topes y restantes |
| `POST /api/llm/workflow` | `{workflow, input?, text?}` → ejecuta brief/cierre/semanal/conflictos/… |
| `POST /api/llm/autocomplete` | Alias de `/api/agent/autocomplete` |
| `POST /api/agent/chat` | Mensaje libre del agente (alias: `/api/agent/command`) |
| `POST /api/agent/command` | Alias del anterior (compatibilidad con el contrato) |
| `POST /api/agent/autocomplete` | Frase libre → propuesta de campos validada (no guarda) |
| `POST /api/agent/confirm` | Confirma un pendiente con `{confirmCode}` (o `token`) |
| `GET /api/agent/actions?limit=50` | Registro de acciones ejecutadas por el agente |
| `GET /api/agent/history?channel&userId&limit` | Historial de una conversación |
| `GET /api/agent/conversations` | Lista de conversaciones (resumen) |
| `GET /api/agent/conversations/:key` | Mensajes de una conversación (`web:owner`) |
| `DELETE /api/agent/conversations/:key` | Borra la memoria de esa conversación |

**Autenticación:** todas las rutas de esta sección usan `auth:'default'`
(ninguna es pública, igual que el resto de `/api/*` y que
`docs/CONTRATO_API.md` §12). En **modo local** (`HOST=127.0.0.1` y sin
`APP_AUTH=on`) se consultan sin sesión; con **`HOST≠loopback`** o
`APP_AUTH=on` exigen sesión y responden `401 UNAUTHENTICATED` — incluidas
`GET /api/llm/status`, `POST /api/llm/test` y `GET /api/llm/usage`.

**Nota sobre nombres:** el serializador HTTP de t1 enmascara cualquier propiedad
llamada `*token` (protección contra fugas). Por eso el pendiente publica
`confirmCode` en vez de `token`; para confirmar se envía
`{"confirmCode":"…"}` a `/api/agent/confirm` (también se acepta `token`).

---

## 4. Perfiles por workflow

Cada tarea declara su perfil: modelo opcional, temperatura, máximo de tokens y
encendido/apagado. Se puede sobreescribir por API sin tocar código:

```bash
curl -s -X POST http://127.0.0.1:3000/api/llm/config \
  -H 'content-type: application/json' \
  -d '{"profiles":{"weekly":{"enabled":false},"brief":{"temperature":0.2,"maxTokens":320}}}'
```

| Perfil | Uso | Temp. | Tokens | Caché |
|---|---|---|---|---|
| `chat` | Chat/asistente libre | 0.3 | 800 | no |
| `brief` | Brief diario (scheduler/UI) | 0.4 | 500 | 180 s |
| `midday` | Chequeo de mediodía | 0.4 | 400 | 120 s |
| `close` | Cierre diario | 0.3 | 450 | 120 s |
| `weekly` | Reporte semanal | 0.4 | 900 | 600 s |
| `channel` | Respuesta para WhatsApp/Telegram/correo | 0.2 | 350 | no |
| `conflict` | Explicación de conflictos y alternativas | 0.2 | 400 | 60 s |
| `signals` | Señales → acciones sugeridas | 0.3 | 450 | no |
| `schedule_summary` | Resumen horario en lenguaje natural | 0.3 | 400 | 60 s |
| `autocomplete` | Autocompletado de campos (JSON) | 0.1 | 600 | 60 s |
| `intent` | Intención del agente (JSON) | 0.1 | 700 | no |

Alias en español aceptados en la API: `asistente`, `brief_diario`, `mediodia`,
`cierre`, `semanal`, `canales`, `conflictos`, `senales`, `resumen_horario`,
`autocompletado`, `intencion`.

### Workflows listos para consumir (t5/t6/t8)

`lib/llm/workflows.mjs` exporta:

```js
import {
  dailyBrief, middayCheck, dailyClose, weeklyReview,
  explainConflict, signalsDigest, scheduleSummary, channelReply,
  runWorkflow, WORKFLOW_NAMES
} from './lib/llm/workflows.mjs';

const brief = await dailyBrief({ scope: 'scheduler' });
// { text, provider, model, fallback, cached, latencyMs, usage, error, errorCode, facts }
```

Todos devuelven `text` **siempre** (fallback determinista si el proveedor
falla). El planificador de t8 solo necesita respetar sus propios horarios: este
módulo no programa `setInterval`.

---

## 5. Autocompletado de campos

`POST /api/agent/autocomplete`

```json
{"text":"reunión con Ana mañana 10:00 45 min urgente para revisar la propuesta"}
```

Respuesta (resumida):

```json
{
  "proposal": {
    "title":"Reunión con Ana", "type":"Reunión", "priority":"P1",
    "impact":5, "urgency":5, "energy":"Alta", "context":"Oficina",
    "location":"", "durationMin":45, "reminderMin":10, "notes":"…",
    "deepFocus":false, "date":"2026-10-28", "time":"10:00",
    "start":"2026-10-28T10:00:00-05:00", "end":"2026-10-28T10:45:00-05:00"
  },
  "suggestedRequest": {"title":"Reunión con Ana","type":"Reunión","date":"2026-10-28","time":"10:00","durationMin":45,"priority":"P1"},
  "validated": true, "requiresConfirmation": true, "saved": false,
  "source":"llm", "provider":"openai", "fallback":false, "warnings":[]
}
```

- El LLM propone; `lib/agent/schema.mjs` **valida y acota** todos los campos
  (enumeraciones, 1–5, 5–720 min, 0–40320 min de recordatorio, longitudes).
- El texto del usuario manda sobre el modelo para fecha/hora/duración
  (`dateSource`/`timeSource` en `meta`), evitando fechas inventadas.
- **Nunca guarda**: el usuario confirma con `POST /api/agenda` usando
  `suggestedRequest` (el motor de t2 vuelve a validar y comprueba conflictos).
- Sin LLM funciona igual: propone con pistas deterministas y valores por
  defecto, y lo marca en `warnings`.

---

## 6. Agente de agenda

`POST /api/agent/chat` (alias `/api/agent/command`):

```json
{"text":"agenda reunión con Ana mañana 10:00 45 min","channel":"web","userId":"owner","dryRun":false}
```

```json
{
  "reply":"✅ Agendado AG-0007: Reunión con Ana …",
  "provider":"openai","model":"mi-modelo","fallback":false,"source":"llm",
  "intent":{"action":"crear_cita","args":{…}},
  "actions":[{"type":"create","status":"ok","agendaId":"AG-0007"}],
  "event":{…},"dashboard":{…},"pending":null,
  "conversation":{"key":"web:owner","messages":4}
}
```

### Orden de resolución

1. **Pendiente** de confirmación/elección (se confirma con «sí», con el número
   de opción o con `confirmCode`).
2. **Comandos garantizados** (deterministas, sin red): `HOY`, `CAPTURA …`,
   `HECHO AG-…`, `POSPONER|MOVER AG-… N`, `FOCO N …`, `CIERRE`, `SEMANA`,
   `balance`, respuestas `1/2/3` del asistente clásico.
3. **LLM** (perfil `intent`) con protocolo JSON: `{"action","args","reply","confidence"}`.
   Se tolera markdown y texto alrededor; si el JSON no es válido, se descarta.
4. **Parser local** determinista si el LLM no está disponible o no entiende.
5. Si no hay intención clara: pregunta corta (nunca inventa).

### Herramientas (ejecución determinista)

`crear_cita`, `buscar_huecos`, `mover_cita`, `cancelar_cita`,
`completar_cita`, `capturar`, `convertir_inbox`, `crear_rutina`,
`editar_rutina`, `activar_rutina`, `listar_dia`, `resumen_semana`, `balance`,
`crear_tarea`, `cerrar_tarea`, `reabrir_tarea`, `listar_tareas`, `crear_meet`,
`enviar_correo`, `enviar_whatsapp`, `enviar_telegram`, `enviar_documento`.

Todas usan el motor de t2 (`createAgendaEvent`, `patchAgendaEvent`,
`findSlotsDetailed`, `createRoutine`, …), por lo que heredan validación de
fechas, detección de conflictos, FreeBusy de Google y sincronización.

**Salidas externas (correo, WhatsApp, Telegram y documento):** las cuatro
herramientas **no envían nada**. Crean una propuesta en la Oficina con
`{kind, channel, recipients, subject, body, attachments, meta:{origin:'agent', conversation}}`
y devuelven el id (`OF-…`), el nivel (normalmente N2) y el riesgo. El jefe la
aprueba y ejecuta desde la Oficina. Si `lib/office` no está disponible, el gate
está desactivado (`OFFICE_ENABLED=off`) o falla la creación, el agente
**deniega** con un mensaje claro y nunca cae a un envío directo.
`enviar_documento` resuelve el `docId` con `lib/docs`, expande destinatarios con
el grafo de identidad y adjunta el nombre del documento a la propuesta.

### Lingo en el agente (t47)

Antes de validar/ejecutar una intención, el agente normaliza con el léxico
aprobado de Lingo los campos `title`, `person`, `attendeeNames`, `context`,
`notes` y `owner`:

- `"Reunión con hector fabio riascos"` → `"Reunión con Héctor Fabio Riascos C."`.
- `"predio el retiro"` → `"Predio El Retiro"`; `"lote 12"` se conserva como
  término canónico si está aprobado.
- La normalización también se aplica cuando se llama a `runTool` directamente
  (sin pasar por el LLM).

Si la misma forma exacta pertenece a dos términos (datos heredados), **no se
cambia el texto**: se deja el original y el resultado incluye
`meta.lingoWarning` con `{field, reason:'ambiguous', candidates}`. Sin Lingo
cargado no hay diferencia de comportamiento.

Los documentos generados usan el título canónico para el nombre de archivo:
`lib/docs` aplica `canonicalDocumentTitle()` antes de `buildFilename` (por
ejemplo `hector-fabio-riascos-c-2026-10-28.docx`). `lib/style/lingo.mjs` expone
`canonicalFilename()` para otros generadores.

### Confirmación explícita (acciones destructivas)

Mover, cancelar, completar, editar/activar rutinas y convertir capturas **no se
ejecutan en el primer turno**. El agente responde:

```
⚠️ Vas a moverla a las 15:00 del mismo día: AG-0007 «Reunión con Ana» (actualmente mié 28 oct 10:00).
¿Confirmas? Responde «sí» para ejecutar o «no» para cancelar.
```

y devuelve `pending:{type:"confirm", confirmCode:"…", requiresConfirmation:true}`.
Se confirma con «sí» (siguiente mensaje), con `POST /api/agent/confirm` y
`{"confirmCode":"…"}`, o con `{"confirm":true}` en el mismo endpoint de chat.
El pendiente caduca a los 10 minutos (configurable en `memory.pendingTtlSec`).

Las salidas externas no usan este pendiente: `enviar_correo`,
`enviar_whatsapp`, `enviar_telegram` y `enviar_documento` crean una propuesta
N2 en la Oficina (no envían) y responden, por ejemplo:

```
Preparé el correo «Acta de la reunión» a ana@empresa.com (nivel N2, riesgo 5).
Queda en la Oficina para tu aprobación: OF-0003.
```

La aprobación/ejecución se hace en la Oficina; el agente no tiene ninguna ruta
alternativa a Gmail/WhatsApp/Telegram. Si la Oficina no está disponible:
`No puedo enviar sin el gate de la Oficina; revisa Integraciones/Oficina.`

### Conflictos y alternativas

Si el horario choca (o Google FreeBusy no responde), el agente explica el
choque con el perfil `conflict` (LLM o texto determinista), propone hasta 3
alternativas reales del motor de huecos y deja un pendiente de elección:
«Responde 1, 2 o 3». El flujo de creación nunca escribe hasta que el usuario
elige/confirma.

### Límites

- **3 iteraciones lógicas** (interpretar → ejecutar → resumir).
- **25 s** de presupuesto total por petición (`deadlineMs` ajustable entre 3 s y 25 s).
- **Nunca inventa fechas**: si el texto no menciona fecha, una fecha propuesta
  por el modelo se descarta y se pregunta.
- **Convención de horas**: `HH:MM` en 24 h. «a las 3» = 15:00; «a las 7» =
  07:00; «a las 6 de la tarde» = 18:00; con `am/pm` explícito manda el texto.
  Si la hora no aparece en el mensaje, se pregunta.
- `dryRun:true` devuelve acciones propuestas **sin escribir** ni guardar memoria.
- Memoria: últimos **12 mensajes** + pendiente, aislada por `canal:usuario`;
  máximo 50 conversaciones.

---

## 7. Fallback en cascada

```
API principal ──falla/timeout/401/429/5xx──▶ Ollama (si está activado) ──▶ determinista
        │                                                                          │
        └── kill-switch, presupuesto, perfil apagado o sin clave ──────────────────┘
```

Estados posibles en `/api/llm/status`:

| Situación | `configured` | `reachable` | `available` | `mode` | Comportamiento |
|---|---|---|---|---|---|
| Sin clave | false | false | false | `deterministic` | Agente y workflows responden con reglas |
| Clave y proveedor OK | true | true | true | `api` | LLM primero, fallback si falla |
| Clave pero proveedor caído | true | false | false | `deterministic` | Se reporta `lastError`/`errorCode`; la app sigue |
| Ollama activo y API caída | — | true | true | `ollama` | Usa el local |
| Kill-switch | — | — | false | `deterministic` | Todo apagado hasta desactivarlo |

Cada respuesta del agente/workflow incluye `provider`, `model`, `fallback`,
`error` y `errorCode`, así la UI puede mostrar «modo local» sin ambigüedad.

---

## 8. Control de costo y abuso

`store.llm.limits` (editable por `POST /api/llm/config`):

```json
{
  "limits": {
    "dailyCalls": 500,
    "dailyTokens": 300000,
    "ratePerMin": 30,
    "cacheTtlSec": 300,
    "perWorkflow": {
      "brief": {"calls": 4, "tokens": 4000},
      "weekly": {"calls": 2, "tokens": 4000}
    }
  }
}
```

- **Topes diarios** globales y por workflow; al superarlos se usa el fallback
  (`errorCode: LLM_BUDGET_CALLS | LLM_BUDGET_TOKENS`) sin romper la app.
- **Kill-switch** global: `{"killSwitch":true}` → todo determinista
  (`LLM_KILL_SWITCH`). Apagado general: `{"enabled":false}` (`LLM_DISABLED`).
- **Caché** de respuestas idempotentes por perfil (`cacheTtlSec`), útil para
  brief/cierre/conflictos repetidos.
- **Rate limit** por `canal:usuario` (ventana de 60 s) → `LLM_RATE_LIMITED`.
- **Métricas**: `GET /api/llm/usage` (llamadas, tokens de prompt/completado,
  errores, cacheadas, por workflow y por proveedor, restantes del día).
- **Auditoría**: `GET /api/agent/actions` (máx. 200; incluye `dryRun`, canal,
  usuario, origen `llm|deterministic` y detalle redactado).

---

## 9. Seguridad y guardarraíles

- **La clave vive en la bóveda de t1** (AES-256-GCM). Nunca se escribe en
  código, `.env` del proyecto (opcional por entorno), logs ni respuestas. El
  estado solo expone `configured`, `model` y `baseUrl` saneada.
- **Redacción en capas** de t1 (`registerSecretValue`, patrones `sk-…`, JWT,
  Bearer, etc.) + redacción de **PII** en trazas (correos, teléfonos, tarjetas,
  tokens en URLs) desde `lib/llm/trace.mjs`.
- **Anti prompt-injection**: el texto del usuario viaja como DATO entre
  `<usuario>…</usuario>`; el system prompt ordena no obedecer instrucciones de
  ese bloque. Los delimitadores se eliminan del texto para evitar *break-out*.
- **El LLM no ejecuta nada**: solo propone JSON; `schema.mjs` valida acciones,
  campos y obligatoriedad, y las herramientas deterministas hacen el resto.
- **Sin datos personales innecesarios** en los prompts: los hechos incluyen
  títulos, horas, prioridades e IDs; no se envían correos de asistentes ni
  secretos.
- **Mensajes saneados**: se recortan a 4 000 caracteres (system 8 000), se
  eliminan caracteres de control y se aplica la redacción de secretos antes de
  salir a la red.

---

## 10. Pruebas

### Self-test end-to-end (sin clave real, sin Ollama, sin red externa)

```bash
node lib/llm/selftest.mjs
```

Levanta un **mock OpenAI-compatible** (`lib/llm/mock-server.mjs`), arranca la
app en **modo local** (`HOST=127.0.0.1`, sin sesión) con `DATA_DIR` temporal y
un puerto libre, y verifica 32 comprobaciones:

status sin configurar → guardar clave en bóveda → `/api/llm/test` (incluye un
fallo transitorio y reintento) → `reachable=true` → modelos → cabeceras extra y
`apiVersion` → adaptadores `openai-responses` y `anthropic` → autocompletado
(sin escribir) → crear cita (tipo/prioridad/duración) → mover con confirmación +
`confirmCode` → comandos deterministas → `dryRun` → captura y conversión de
inbox → rutinas crear/pausar → completar cita → brief/cierre con LLM →
caché → consumo → presupuesto por workflow → kill-switch → sin clave (la app
sigue) → parser determinista sin LLM → cascada Ollama → memoria aislada →
validaciones 400 → **cero fugas de la clave** en respuestas y logs.

Salida: JSON con `ok`, `checks` y `failures`; exit code 1 si falla algo.
No toca `data/` real.

### Mock para desarrollo

```js
import { createMockLlmServer } from './lib/llm/mock-server.mjs';
const mock = await createMockLlmServer();      // http://127.0.0.1:<puerto>
// configurar OPENAI_BASE_URL=`${mock.url}/v1`, OPENAI_MODEL='mock-agenda-1'
await mock.close();
```

También implementa `/api/tags` y `/api/chat` (Ollama) para probar la cascada, y
simula fallos transitorios con `failFirst`. Se puede levantar suelto:

```bash
node lib/llm/mock-server.mjs
# imprime: Mock LLM escuchando en http://127.0.0.1:<puerto>
#          OPENAI_BASE_URL=…/v1  OPENAI_MODEL=mock-agenda-1  OPENAI_API_KEY=sk-mock-local
```

---

## 11. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `configured=false` | no hay clave guardada | `PUT /api/secrets/llm.openai.apiKey` o el script |
| `reachable=false`, `LLM_AUTH` | clave inválida o revocada | vuelve a pegar la clave |
| 404 en `/chat/completions` | `baseUrl` sin `/v1` o proveedor no compatible | corrige `baseUrl`; prueba `provider:"openai-responses"` o `"anthropic"` |
| `LLM_TIMEOUT` | red lenta o proveedor saturado | sube `timeoutMs` (1000–120000) o baja `maxRetries` |
| `LLM_RATE_LIMITED` | 30 llamadas/min por usuario | sube `limits.ratePerMin` o espera |
| `LLM_BUDGET_*` | tope diario alcanzado | sube `limits.dailyCalls/dailyTokens`; el consumo está en `/api/llm/usage` |
| `LLM_PROFILE_DISABLED` | perfil apagado | `POST /api/llm/config {"profiles":{"weekly":{"enabled":true}}}` |
| El agente «pregunta» en vez de actuar | falta fecha/hora o hay ambigüedad | responde con fecha/hora o el número de opción |
| `pending` no se confirma | caducó (10 min) o cambió el contexto | repite la instrucción |

---

## 12. Integración con otras tareas

- **t5 (canales)**: usar `handleAgentChat({text, channel, userId})` para el
  mensaje entrante y `channelReply({input:{text, channel}, scope})` para pulir
  la respuesta. El agente aísla la memoria por `canal:usuario`.
- **t6 (señales/workflows)**: `signalsDigest()` y `explainConflict()`; el
  registro de acciones ya está en `/api/agent/actions`.
- **t8 (scheduler)**: importar `dailyBrief`, `middayCheck`, `dailyClose`,
  `weeklyReview` y llamarlos en sus horarios. **No** programar timers aquí:
  el dueño de los intervalos es `lib/workflows/scheduler.mjs`.
- **t1 (contrato)**: `docs/CONTRATO_API.md` §12 ya documenta esta
  implementación (§12.1–§12.15: `reachable`/`mode`/`chain`/`activeProvider`,
  `config`, `usage`, `workflow`, `autocomplete`, `agent/chat|confirm|history|
  conversations` y `pending.confirmCode`, con la misma regla de autenticación).
  Mantener ambos documentos sincronizados al cambiar rutas o envelopes.

### Códigos de error propios

`LLM_NOT_CONFIGURED`, `LLM_AUTH`, `LLM_TIMEOUT`, `LLM_NETWORK`,
`LLM_RATE_LIMITED` (429 upstream), `LLM_UPSTREAM`, `LLM_BAD_REQUEST`,
`LLM_BAD_RESPONSE`, `LLM_CONFIG`, `LLM_DISABLED`, `LLM_KILL_SWITCH`,
`LLM_PROFILE_DISABLED`, `LLM_RATE_LIMITED` (local), `LLM_BUDGET_CALLS`,
`LLM_BUDGET_TOKENS`, `LLM_JSON_INVALID`, `LLM_UNAVAILABLE`, `UNKNOWN_WORKFLOW`.


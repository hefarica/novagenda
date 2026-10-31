# MCP — conector genérico con gate y auditoría

La app puede hablar con servidores **MCP** (Model Context Protocol) por **stdio**
o **HTTP/SSE** para usar herramientas externas: Desktop Commander, Playwright,
Google Drive, microservicios propios, etc.

El conector **no instala nada**: solo guarda la configuración y, cuando el usuario
lanza un `probe` o una llamada, arranca el comando configurado. Las herramientas
con efectos (escribir archivos, ejecutar comandos, navegar, enviar) **no se
ejecutan directas**: pasan por el gate de la Oficina (t13) como propuesta N2 y
requieren aprobación. Si la Oficina no está disponible, se deniegan con
`MCP_GATE_UNAVAILABLE`.

- Código: `lib/mcp/**`, ruta `lib/routes/mcp.mjs` (`priority: 140`, auto-descubierta).
- Mock de pruebas: `scripts/mock-mcp-server.mjs` (stdio, sin dependencias).
- Autocheck: `node lib/mcp/selfcheck.mjs` → `PASS`/`FAIL` con `DATA_DIR` temporal
  y puerto 3260-3285; no toca `data/` real ni la app del puerto 3000.

---

## 1. Arquitectura

```
API /api/mcp/*  ──►  lib/mcp/state.mjs (store, secretos cifrados)
                        │
                        ├── lib/mcp/schema.mjs     validación estricta
                        ├── lib/mcp/tools.mjs      efecto / allowlist
                        ├── lib/mcp/client.mjs     JSON-RPC 2.0 (stdio/HTTP/SSE)
                        └── lib/mcp/gate.mjs       Oficina N2 + ejecutor aprobado
```

### Handshake

1. `initialize` (`protocolVersion`, `capabilities`, `clientInfo`).
2. `notifications/initialized`.
3. `tools/list`.
4. `tools/call` solo si la herramienta es de lectura o si la Oficina aprobó.

Cada operación tiene **timeout de 10 s** por defecto (`timeoutMs` configurable
entre 1 s y 60 s). En stdio los mensajes son **JSON-RPC por líneas**; las líneas
de stdout que no son JSON (logs del servidor) se ignoran. La respuesta está
acotada (`MCP_MAX_RESPONSE_BYTES`, 1 MB por defecto) y el proceso hijo se mata
con `SIGTERM` (y `SIGKILL` de respaldo) al cerrar.

### Transportes

| transport | Configuración | Uso |
|---|---|---|
| `stdio` | `command`, `args`, `env` | Desktop Commander, Playwright MCP, servidores locales |
| `http` | `url`, `headers` | microservicio MCP Streamable HTTP (respuesta JSON o SSE) |
| `sse` | `url`, `headers` | MCP HTTP+SSE legacy (GET stream → evento `endpoint` → POST) |

`stdio` usa `spawn(command, args, { shell: false })`: **nunca** se interpola en
una shell. `http`/`sse` usan `fetch` con `Accept: application/json,
text/event-stream`; las cabeceras personalizadas se envían tal cual (valores
cifrados en el store).

---

## 2. Registro persistente y secretos

`data.mcp` en el store de la app:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "MCP-0001",
      "name": "desktop-commander",
      "transport": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@wonderwhy-er/desktop-commander"],
      "url": null,
      "enabled": true,
      "toolAllowlist": ["read_file", "list_directory"],
      "timeoutMs": 10000,
      "envKeys": ["API_KEY"],
      "headerKeys": [],
      "createdAt": "2026-10-28T…",
      "updatedAt": "2026-10-28T…",
      "lastProbe": {
        "at": "2026-10-28T…", "ok": true, "toolCount": 12,
        "tools": [{"name": "read_file", "effect": false}],
        "serverInfo": {"name": "desktop-commander", "version": "0.x"},
        "protocolVersion": "2024-11-05", "latencyMs": 420, "errorCode": null
      }
    }
  ],
  "secrets": {
    "MCP-0001": {
      "env":     {"API_KEY": "<caja AES-256-GCM>"},
      "headers": {"Authorization": "<caja AES-256-GCM>"}
    }
  },
  "pendingCalls": {
    "<token>": {"box": "<args cifrados>", "serverId": "MCP-0001", "tool": "write_file", "createdAt": "…", "expiresAt": "…"}
  },
  "createdAt": "…", "updatedAt": "…"
}
```

- La API **nunca** devuelve valores de `env`/`headers`: solo `envKeys`,
  `headerKeys` y `secretCount`.
- Los valores se cifran con **AES-256-GCM** usando la clave maestra de la app
  (la misma familia criptográfica que la bóveda de t1). Si cambia la clave
  maestra, hay que volver a introducir los secretos (`MCP_SECRET_ERROR`).
- Los argumentos de una llamada con efectos también se cifran en
  `pendingCalls`; en la propuesta de Oficina solo viaja el **token**, no los
  valores. Al ejecutarse la aprobación se descifran, se llama a la herramienta y
  se borra la llamada pendiente.
- `lastProbe` se guarda sin secretos (nombres de herramientas, `serverInfo`,
  latencia y código de error).
- `data.mcp` sobrevive a los reinicios de la app: servidores, `envKeys`,
  secretos cifrados y llamadas pendientes se conservan; al arrancar de nuevo se
  registra el ejecutor MCP para que las propuestas aprobadas puedan ejecutarse.
- El entorno del hijo **no hereda** `APP_SECRET`, claves de OpenAI ni el resto
  del entorno de la app: solo un allowlist de variables del sistema (`PATH`,
  `SystemRoot`, `TEMP`, `HOME`, `LANG`…) más las variables configuradas en el
  servidor. En Windows hacen falta `PATH`/`SystemRoot` para arrancar procesos.

---

## 3. API

Base: `/api/mcp`. Autenticación normal de la app (`auth:'default'`): en local sin
login no pide sesión; con `HOST≠loopback` o `APP_AUTH=on`, exige cookie.

### `GET /api/mcp/status`

```json
{
  "ok": true,
  "gate": {"available": true, "disabledByEnv": false, "executorRegistered": true},
  "summary": {"servers": 1, "enabled": 1, "pendingCalls": 0},
  "defaults": {"timeoutMs": 10000, "maxResponseBytes": 1000000}
}
```

### `GET /api/mcp/servers`

`200 {ok, items:[…], count, total, gate}`. Cada item es la vista pública del
servidor (sin valores de secretos).

### `POST /api/mcp/servers`

```json
{
  "name": "mock-stdio",
  "transport": "stdio",
  "command": "C:\\\\Program Files\\\\nodejs\\\\node.exe",
  "args": ["C:\\\\ruta\\\\scripts\\\\mock-mcp-server.mjs"],
  "env": {"MOCK_MCP_TMP": "C:\\\\tmp\\\\mcp-sandbox"},
  "headers": {},
  "envKeys": [],
  "headerKeys": [],
  "toolAllowlist": [],
  "enabled": true,
  "timeoutMs": 10000
}
```

- `env`/`headers` son los **únicos** campos con valores; se cifran y no se
  devuelven. En `PATCH`, un valor `null` borra esa entrada.
- `envKeys`/`headerKeys` son metadatos opcionales de solo nombres: permiten
  declarar/referenciar variables sin enviar el valor (los valores reales se
  guardan cifrados vía `env`/`headers`). La API siempre devuelve la lista
  efectiva de nombres.
- `transport: "stdio"` exige `command`; `http`/`sse` exigen `url` http(s) sin
  credenciales embebidas (para tokens usa `headers`).
- `toolAllowlist`: lista exacta de herramientas permitidas, o `["*"]` para todas.
  **Lista vacía = sin restricción explícita**; las herramientas con efectos
  siguen pasando por el gate y nunca se ejecutan directas. Para restringir,
  enumera los nombres permitidos.
- `timeoutMs`: 1000–60000 (10 s por defecto).
- Límites: nombre ≤ 80, args ≤ 50×500, env ≤ 50, headers ≤ 30, allowlist ≤ 100.

`201 {ok, item, id, name, envKeys, headerKeys}`.

### `GET /api/mcp/servers/:id` · `PATCH /api/mcp/servers/:id` · `DELETE /api/mcp/servers/:id`

`PATCH` acepta los mismos campos (sin `id`); `env`/`headers` se fusionan por
clave y `null` borra. `DELETE` elimina el servidor, sus secretos y sus llamadas
pendientes. Errores: `404 MCP_SERVER_NOT_FOUND`, `400 MCP_INVALID_CONFIG`.

### `POST /api/mcp/servers/:id/probe`

Cuerpo opcional `{"timeoutMs": 3000}`. Hace handshake + `tools/list`, actualiza
`lastProbe` y devuelve:

```json
{
  "ok": true,
  "item": { "...servidor público con lastProbe..." },
  "probe": {
    "protocolVersion": "2024-11-05",
    "serverInfo": {"name": "mock-mcp-server", "version": "1.0.0"},
    "capabilities": {"tools": {}},
    "toolCount": 3,
    "latencyMs": 180
  },
  "tools": [
    {"name": "echo", "effect": false, "readOnly": true, "reason": "…", "inputSchema": {}},
    {"name": "add", "effect": false, "readOnly": true, "reason": "…"},
    {"name": "read_file", "effect": false, "readOnly": true, "reason": "…"}
  ],
  "count": 3
}
```

Servidor deshabilitado → `409 MCP_SERVER_DISABLED`. Comando inexistente →
`502 MCP_SPAWN_FAILED`. Timeout → `504 MCP_TIMEOUT`.

### `GET /api/mcp/servers/:id/tools`

Igual que probe pero orientado a la UI: `{ok, item, tools, count, serverInfo, protocolVersion}`.

### `POST /api/mcp/servers/:id/call`

```json
{"tool": "echo", "args": {"text": "hola"}}
```

- Herramienta de **solo lectura** y permitida → `200`:

```json
{
  "ok": true,
  "gated": false,
  "server": {"id": "MCP-0001", "name": "mock-stdio", "…": "…"},
  "tool": {"name": "echo", "effect": false, "readOnly": true, "reason": "…"},
  "result": {
    "content": [{"type": "text", "text": "hola"}],
    "text": "hola",
    "structuredContent": null,
    "isError": false
  }
}
```

- Herramienta **con efectos** y permitida → `202` **gated**; no se llama:

```json
{
  "ok": true,
  "gated": true,
  "status": "pending",
  "executed": false,
  "auto": false,
  "server": {"id": "MCP-0002", "name": "mock-write", "…": "…"},
  "tool": {"name": "write_file", "effect": true, "readOnly": false, "reason": "…"},
  "proposal": {
    "id": "OF-0001", "level": "N2", "status": "pending",
    "policy": {"requiresApproval": true, "requiresCode": false},
    "meta": {"mcp": {"serverId": "MCP-0002", "tool": "write_file", "gateToken": "…"}}
  },
  "gate": {
    "provider": "office",
    "proposalId": "OF-0001",
    "level": "N2",
    "status": "pending",
    "requiresApproval": true,
    "requiresCode": false,
    "mode": "asistido",
    "approvalHint": "Aprueba la propuesta en /api/office/proposals/:id/approve y ejecútala…"
  }
}
```

Para completar la acción:

```http
POST /api/office/proposals/OF-0001/approve   {"by":"owner"}
POST /api/office/proposals/OF-0001/execute   {}
```

La propuesta tiene `channel: "webhook"`, `kind: "mcp"`, adjunto `mcp:<tool>` y
`meta.mcp`. Al ejecutarse, el ejecutor de Oficina recupera los argumentos
cifrados y llama a la herramienta MCP; el resultado queda en
`proposal.execution.result`.

> El conector registra su ejecutor en el canal `webhook` de la Oficina. No
> registres otro ejecutor distinto en ese canal: las propuestas MCP se reconocen
> por `kind:"mcp"` + `meta.mcp`; cualquier otra propuesta de webhook será
> rechazada por ese ejecutor.

Errores de `/call`:

| HTTP | code | Causa |
|---|---|---|
| 403 | `MCP_TOOL_NOT_ALLOWED` | herramienta no listada en una allowlist no vacía |
| 404 | `MCP_TOOL_NOT_FOUND` | la herramienta no existe en el servidor |
| 409 | `MCP_SERVER_DISABLED` | servidor deshabilitado |
| 502 | `MCP_SPAWN_FAILED` | comando no arranca (ENOENT, permisos…) |
| 502 | `MCP_PROCESS_EXITED` | el hijo murió durante la operación |
| 502 | `MCP_RPC_ERROR` | JSON-RPC error del servidor |
| 502 | `MCP_PROTOCOL_ERROR` | respuesta inválida |
| 502 | `MCP_RESPONSE_TOO_LARGE` | supera `MCP_MAX_RESPONSE_BYTES` |
| 503 | `MCP_GATE_UNAVAILABLE` | Oficina no disponible (o `MCP_GATE_DISABLE=1`) |
| 504 | `MCP_TIMEOUT` | operación > timeout |

---

## 4. Clasificación de efectos y allowlist

`lib/mcp/tools.mjs` decide si una herramienta es de solo lectura:

1. `annotations.destructiveHint === true` → efecto.
2. `annotations.readOnlyHint === false` → efecto.
3. Nombre/descripción con verbos de escritura/ejecución (`write`, `create`,
   `delete`, `exec`, `run`, `shell`, `edit`, `move`, `send`, `navigate`…) → efecto.
4. `annotations.readOnlyHint === true` → lectura.
5. Nombre/descripción de consulta (`read`, `get`, `list`, `search`, `echo`,
   `add`, `status`…) → lectura.
6. Sin información → **efecto** (default seguro).

Un servidor puede mentir en sus anotaciones; por eso el nombre con verbo de
efecto manda sobre `readOnlyHint === true`. Aun así, MCP no es un sandbox: la
única garantía real es revisar el servidor y limitar su allowlist.

Allowlist:

- `["read_file"]`: solo `read_file`.
- `[]`: sin restricción explícita; lectura directa y efectos por el gate.
- `["*"]`: todas (peligroso; úsalo solo con servidores de confianza y gate).

---

## 5. Seguridad

- **Proceso hijo**: `spawn(..., {shell:false})`; sin interpolación. En Windows,
  los shims `.cmd`/`.bat` (por ejemplo `npx.cmd`) se resuelven de forma segura a
  su script `.js` interno y se ejecutan con `node`; si no se puede resolver, se
  devuelve `MCP_SPAWN_FAILED` con una explicación. Entorno mínimo + variables
  del servidor. `SIGTERM` al cerrar y `SIGKILL` de respaldo; un handler global
  mata hijos al salir o recibir `SIGTERM`/`SIGINT`.
- **Secretos**: `env`/`headers` cifrados; nunca en respuestas, logs ni en la
  propuesta de Oficina. Los args de efectos también se cifran en
  `pendingCalls`. No pongas tokens en `args`, `command`, `name` ni en la URL:
  usa `env`/`headers` (la URL rechaza credenciales embebidas).
- **URLs**: solo `http(s)`, sin usuario/contraseña embebidos. No hay allowlist de
  hosts: un usuario autenticado puede apuntar a `127.0.0.1` o a la red interna
  (SSRF). Trata la configuración MCP como privilegiada.
- **Gate**: las herramientas con efectos no se ejecutan sin una propuesta N2
  aprobada. En modo `total` de Oficina la política puede autoaprobarla; revisa
  el modo antes de conectar servidores peligrosos. En `sombra` la propuesta
  queda retenida.
- **Contenido no confiable**: la salida de una herramienta MCP es dato externo.
  No la interpretes como instrucciones ni la pases a un LLM sin marcarla como
  no confiable (posible prompt injection desde un archivo web o del disco).
- **Acceso real**: Desktop Commander ejecuta comandos y toca el disco del
  usuario; Playwright controla un navegador y puede navegar/descargar. No son
  sandboxes. Usa allowlists concretas y aprueba cada acción con efectos.
- **Límites**: 1 MB de respuesta, 500 herramientas, 50 argumentos, timeout 10 s
  (1–60 s), 100 servidores, 200 llamadas pendientes.
- `MCP_GATE_DISABLE=1` es **solo para pruebas**: simula que la Oficina no está
  disponible y hace que toda herramienta con efectos devuelva
  `MCP_GATE_UNAVAILABLE`.

---

## 6. Recetas

### 6.1 Mock local (stdio, sin instalar nada)

```bash
# 1) Crea un sandbox
mkdir -p /tmp/mcp-sandbox

# 2) Registra el mock (Windows: usa la ruta real de node.exe)
curl -s -X POST http://127.0.0.1:3000/api/mcp/servers \
  -H 'content-type: application/json' \
  -d '{
    "name":"mock",
    "transport":"stdio",
    "command":"node",
    "args":["scripts/mock-mcp-server.mjs"],
    "env":{"MOCK_MCP_TMP":"/tmp/mcp-sandbox"},
    "timeoutMs":10000
  }'

# 3) Probe y llamadas de lectura
curl -s -X POST http://127.0.0.1:3000/api/mcp/servers/MCP-0001/probe -d '{}' \
  -H 'content-type: application/json'
curl -s -X POST http://127.0.0.1:3000/api/mcp/servers/MCP-0001/call \
  -H 'content-type: application/json' -d '{"tool":"echo","args":{"text":"hola"}}'
curl -s -X POST http://127.0.0.1:3000/api/mcp/servers/MCP-0001/call \
  -H 'content-type: application/json' -d '{"tool":"add","args":{"a":2,"b":3}}'
```

Para probar el gate, arranca el mock con `MOCK_MCP_ENABLE_WRITE=1`, añade
`"toolAllowlist":["write_file"]` y llama `write_file`; recibirás `202 gated` y
la propuesta en `/api/office/proposals`.

### 6.2 Desktop Commander (stdio)

> **Peligro:** Desktop Commander puede ejecutar comandos y leer/escribir
> archivos reales. La app **no lo instala**: el primer `npx` lo descarga si el
> usuario lo ejecuta. Empieza con allowlist de lectura y revisa cada propuesta.

```json
{
  "name": "desktop-commander",
  "transport": "stdio",
  "command": "npx.cmd",
  "args": ["-y", "@wonderwhy-er/desktop-commander"],
  "env": {},
  "toolAllowlist": ["read_file", "list_directory"],
  "timeoutMs": 20000
}
```

- En Linux/macOS usa `"command": "npx"`; en Windows `npx.cmd` (o la ruta
  absoluta de `npx.cmd`). El conector resuelve el shim a `npx-cli.js` y lo
  ejecuta con `node`, sin abrir una shell.
- Verifica el nombre exacto del paquete en la documentación oficial de Desktop
  Commander; si cambia, actualiza `args`.
- No pongas `["*"]` en producción. Las herramientas de escritura/ejecución
  quedarán bloqueadas hasta que las añadas y la Oficina apruebe.

### 6.3 Playwright MCP (stdio)

> **Peligro:** controla un navegador real, navega a URLs, descarga archivos y
> puede usar el perfil del navegador. No uses `["*"]` sin gate y sin revisar.

```json
{
  "name": "playwright",
  "transport": "stdio",
  "command": "npx.cmd",
  "args": ["-y", "@playwright/mcp@latest", "--headless"],
  "env": {},
  "toolAllowlist": ["browser_navigate", "browser_snapshot"],
  "timeoutMs": 30000
}
```

- `--headless` es opcional; quítalo si quieres ver el navegador.
- El primer uso puede necesitar `npx playwright install` **ejecutado por el
  usuario**; la app no instala navegadores.
- `browser_navigate`/clics son efectos: requieren aprobación N2. `snapshot`/
  `screenshot` puede clasificarse como lectura o efecto según nombre; revisa la
  clasificación en `probe`.

### 6.4 Microservicio propio por HTTP

```json
{
  "name": "mi-microservicio",
  "transport": "http",
  "url": "http://127.0.0.1:8787/mcp",
  "headers": {"Authorization": "Bearer <token>"},
  "toolAllowlist": ["consultar_estado"],
  "timeoutMs": 10000
}
```

- El token de `headers` se cifra y nunca se devuelve.
- El servidor debe aceptar JSON-RPC 2.0 por POST; puede responder JSON o SSE
  (`text/event-stream`). Para el modo legacy `sse`, el `url` debe ser el stream
  SSE y el servidor debe emitir `event: endpoint`.
- Si tu microservicio usa SSE legacy, configura `"transport":"sse"`.

### 6.5 Flujo con gate

1. `POST /api/mcp/servers/:id/probe` → revisa `tools[].effect`.
2. Añade a `toolAllowlist` solo las herramientas necesarias (incluidas las de
   efecto que quieras permitir).
3. `POST /api/mcp/servers/:id/call` con una herramienta de efecto → `202 gated`.
4. `POST /api/office/proposals/:id/approve` + `execute`.
5. Consulta `GET /api/office/proposals/:id` (`execution.result`) y
   `GET /api/office/ledger` para la auditoría.

---

## 7. Autocheck

```bash
node lib/mcp/selfcheck.mjs
```

50 comprobaciones con la app real montada en proceso (router aislado, `DATA_DIR`
temporal, puerto 3260-3285):

- CRUD y vista pública sin valores de secretos;
- probe stdio contra el mock: `initialize` + `tools/list` = 3 herramientas;
- `echo`, `add`, `read_file` (sandbox), ruta fuera del sandbox;
- allowlist → 403; servidor deshabilitado → 409;
- timeout simulado → 504; comando inexistente → 502 sin cuelgue;
- transporte HTTP con cabecera secreta;
- gate: `503 MCP_GATE_UNAVAILABLE`, `202 gated`, propuesta N2, archivo no creado
  antes de aprobar, aprobación+ejecución de Oficina escribe el archivo;
- secretos/args fuera del store; procesos hijos limpiados.

Salida: `SELFCHECK PASS (50/50)` o `FAIL` con detalle; exit 1 si falla.

---

## 8. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `MCP_SPAWN_FAILED` | comando/ruta inexistente o sin permisos | revisa `command`/`args`; en Windows usa `.cmd` o ruta absoluta |
| `MCP_TIMEOUT` | servidor lento o colgado | sube `timeoutMs` (máx. 60 s) o revisa el servidor |
| `MCP_GATE_UNAVAILABLE` | Oficina no cargada o `MCP_GATE_DISABLE=1` | arranca la app con `lib/office`; quita el flag de test |
| `MCP_TOOL_NOT_ALLOWED` | allowlist no vacía sin la herramienta | añade el nombre exacto en `toolAllowlist` o vacía la lista |
| `MCP_SERVER_DISABLED` | `enabled:false` | `PATCH {"enabled":true}` |
| `MCP_SECRET_ERROR` | cambió la clave maestra | vuelve a guardar `env`/`headers` |
| Propuesta N2 pendiente | modo `asistido`/`sombra` | apruébala en `/api/office/proposals/:id/approve` |
| `403` al aprobar/ejecutar | payload alterado o TTL | vuelve a aprobar (ver `docs/OFFICE.md`) |

---

## 9. Límites conocidos

- No hay OAuth interactivo; para tokens usa `headers`/`env`.
- La validación de `inputSchema` de cada herramienta no se hace en el conector:
  se reenvía al servidor MCP. El límite de 8 KB de `args` es del conector.
- El modo SSE legacy es básico (endpoint + POST + stream); algunos servidores con
  reconexión/`Last-Event-ID` pueden requerir ajustes.
- No hay UI dedicada todavía; el centro de integraciones puede consumir esta API.
- No se instalan paquetes ni navegadores automáticamente.

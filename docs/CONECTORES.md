# Conectores externos gobernados (t51)

> Capa homogénea para que los agentes consulten herramientas **fuera** de la
> agenda (MCP local, webhooks, GitHub, Google Drive) con permisos, prueba de
> salud y **sin secretos expuestos**. Las lecturas se ejecutan directas; los
> efectos externos **siempre** pasan por el gate de aprobación de la Oficina.

Implementación:

- `lib/studio/connectors.mjs` — registro, validación, salud, adaptador HTTP y gate.
- `lib/routes/connectors.mjs` — API auto-descubierta (`priority: 118`).
- `tests/integration/connectors.test.mjs` — 8 pruebas con fixture local.

---

## 1. Modelo persistente (`data.connectors`)

```json
{
  "version": 1,
  "items": [
    {
      "id": "CON-0001",
      "kind": "github",
      "name": "GitHub del equipo",
      "description": "Consultas de solo lectura",
      "endpoint": "https://api.github.com",
      "authRef": "encrypted:CON-0001",
      "capabilities": ["health", "read"],
      "enabled": true,
      "timeoutMs": 8000,
      "maxBytes": 262144,
      "healthPath": "/rate_limit",
      "createdAt": "…",
      "updatedAt": "…",
      "lastTest": {
        "at": "…", "ok": true, "status": 200, "latencyMs": 120,
        "bytes": 512, "code": null, "error": null, "detail": "HTTP 200", "delegated": false
      }
    }
  ],
  "secrets": {
    "CON-0001": { "box": { "v": 2, "iv": "…", "tag": "…", "data": "…" }, "createdAt": "…" }
  },
  "pendingCalls": {
    "<gateToken>": { "connectorId": "CON-0001", "box": { … }, "createdAt": "…", "expiresAt": "…" }
  }
}
```

- `items` máx. **100**; `pendingCalls` máx. **200** y caducan a las **2 h**.
- Los tokens **nunca** se guardan en claro: `encryptJSON` (AES-256-GCM con la
  clave maestra del store, la misma que la bóveda y MCP).
- La API **nunca** devuelve `secrets` ni `pendingCalls`: solo `authRef`,
  `authKind`, `hasToken` y `lastTest`.
- `lastTest` no incluye cabeceras ni tokens; los errores se redactan.

### `authRef` (referencia, no secreto)

| Valor | Significado |
|---|---|
| `none` | Sin autenticación (GitHub anónimo, webhook abierto, etc.). |
| `encrypted:<connectorId>` | Token enviado en `POST` (campo `token`) y cifrado aquí. |
| `vault:<nombreConocido>` | Secreto existente de la bóveda (`llm.openai.apiKey`, canales…). |
| `google:<connectionId>` | Conexión OAuth de Google existente (Drive). |
| `mcp:<serverId>` | Servidor MCP ya registrado (`data.mcp.servers`). |

El token se envía **solo al crear** (`token`) y es de escritura: no se puede
leer de vuelta. Para rotarlo, elimina el conector y vuelve a crearlo.

---

## 2. Catálogo inicial

| kind | Uso | Endpoint por defecto | Auth | Salud |
|---|---|---|---|---|
| `mcp` | MCP local ya registrado | — (se usa `mcp:<id>`) | `mcp:<serverId>` | HTTP/SSE: probe MCP real; stdio: **delegada** a `/api/mcp` (este conector no ejecuta comandos) |
| `webhook` | Webhook HTTP JSON | obligatorio | `none`, `token`, `vault:` | `GET endpoint+healthPath` (2xx) |
| `github` | API REST GitHub | `https://api.github.com` | `none` o token/vault | `GET /rate_limit` con `Bearer` si hay token |
| `drive` | Google Drive | `https://www.googleapis.com/drive/v3` | `google:<connectionId>` | Referencia OAuth (existe, no requiere reconexión) |

`capabilities` permitidas: `health`, `read`, `write`, `send`, `execute`.
Por defecto: `["health","read"]`. Cualquier capacidad de efecto
(`write/send/execute`) debe **declararse explícitamente**; sin ella, una
llamada de escritura se rechaza con `403 CONNECTOR_CAPABILITY_NOT_ALLOWED`.

---

## 3. API

Todas las rutas exigen la sesión normal de la app y viven bajo `/api/studio`.
Las respuestas siguen el estilo `{ok, …}` del Estudio; los errores son
`{error, code, field, requestId}`.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/studio/connectors` | Lista + catálogo + estado del gate |
| `POST` | `/api/studio/connectors` | Crea conector (`201`) |
| `GET` | `/api/studio/connectors/:id` | Detalle público |
| `DELETE` | `/api/studio/connectors/:id` | Borra conector, token y pendientes |
| `POST` | `/api/studio/connectors/:id/test` | Prueba de salud y guarda `lastTest` |
| `POST` | `/api/studio/connectors/:id/invoke` | Lectura directa (`200`) o efecto → propuesta (`202`) |

### Crear

```bash
curl -s -X POST http://127.0.0.1:3000/api/studio/connectors \
  -H 'content-type: application/json' -d '{
    "kind": "github",
    "name": "GitHub equipo",
    "endpoint": "https://api.github.com",
    "token": "ghp_…",
    "capabilities": ["health", "read"]
  }'
```

`201`:

```json
{
  "ok": true,
  "id": "CON-0001",
  "item": {
    "id": "CON-0001", "kind": "github", "name": "GitHub equipo",
    "endpoint": "https://api.github.com",
    "authRef": "encrypted:CON-0001", "authKind": "token", "hasToken": true,
    "capabilities": ["health", "read"], "effectful": false, "enabled": true,
    "timeoutMs": 8000, "maxBytes": 262144, "healthPath": "/rate_limit",
    "lastTest": null, "createdAt": "…", "updatedAt": "…"
  }
}
```

- El token **no** aparece en la respuesta.
- `kind: drive` exige `authRef: "google:<connectionId>"`.
- `kind: mcp` exige `authRef: "mcp:<serverId>"`; el endpoint puede omitirse.

### Listar

```json
{
  "ok": true,
  "items": [ … ],
  "count": 1,
  "total": 1,
  "catalog": [
    { "kind": "mcp", "label": "MCP local", "auth": ["mcp"], "…": "…" }
  ],
  "gate": { "available": true, "disabledByEnv": false, "module": "lib/office/proposals.mjs", "executorRegistered": true }
}
```

### Probar salud

```bash
curl -s -X POST http://127.0.0.1:3000/api/studio/connectors/CON-0001/test \
  -H 'content-type: application/json' -d '{"timeoutMs":5000}'
```

`200` (aunque el health falle; `test.ok=false` explica por qué):

```json
{
  "ok": true,
  "item": { "…": "…", "lastTest": { "ok": true, "status": 200, "latencyMs": 120 } },
  "test": { "ok": true, "status": 200, "latencyMs": 120, "bytes": 512,
            "code": null, "error": null, "detail": "HTTP 200", "delegated": false }
}
```

- Conector deshabilitado → `409 CONNECTOR_DISABLED`.
- No existe → `404 CONNECTOR_NOT_FOUND`.
- Fallo de red/timeout → `200` con `test.ok=false` y `code`
  `CONNECTOR_NETWORK`/`CONNECTOR_TIMEOUT`.

### Invocar (lectura)

```bash
curl -s -X POST http://127.0.0.1:3000/api/studio/connectors/CON-0001/invoke \
  -H 'content-type: application/json' \
  -d '{"method":"GET","path":"/repos/org/repo/issues?state=open"}'
```

`200`:

```json
{ "ok": true, "read": true, "kind": "github", "status": 200,
  "contentType": "application/json", "bytes": 1234, "latencyMs": 180,
  "data": [ … ] }
```

Reglas:

- `GET/HEAD` con capacidad `read` → directo.
- Cualquier otro método o capacidad de efecto → **nunca** se ejecuta aquí;
  devuelve `202` con una propuesta de la Oficina (ver §5).
- `body` solo para métodos no seguros y ≤ 64 KB.
- `path` debe ser relativo al endpoint (`/...`), sin URL absoluta, `//` ni `..`.

---

## 4. Allowlist y adaptador HTTP

- **HTTPS**: permitido para cualquier host (sin credenciales embebidas).
- **HTTP**: **solo loopback** (`localhost`, `*.localhost`, `127.0.0.1/8`, `::1`).
  Un endpoint `http://example.com` se rechaza con
  `400 CONNECTOR_ENDPOINT_NOT_ALLOWED`.
- Esquemas distintos de `http(s)` → rechazados.
- Credenciales en la URL (`https://user:pass@…`) → rechazadas; usa `token`.
- **Redirecciones 3xx**: bloqueadas (`502 CONNECTOR_REDIRECT_BLOCKED`) para
  evitar saltarse la allowlist vía `Location`.
- **Timeout** por defecto 8 s (1–30 s configurable).
- **Límite de bytes** por defecto 256 KB (1 KB–1 MB configurable); al superarlo
  se aborta la lectura (`502 CONNECTOR_RESPONSE_TOO_LARGE`).
- **Sin comandos**: este módulo no usa `child_process` ni shells. Los MCP stdio
  se delegan al módulo MCP (`/api/mcp/...`), que tiene su propio gate.
- No se envían cookies ni cabeceras del navegador; solo `accept`,
  `user-agent` y `Authorization` si hay token.

Códigos relevantes: `CONNECTOR_TIMEOUT` (504), `CONNECTOR_NETWORK` (502),
`CONNECTOR_REDIRECT_BLOCKED` (502), `CONNECTOR_RESPONSE_TOO_LARGE` (502),
`CONNECTOR_HTTP_ERROR` (502).

---

## 5. Gate de aprobación para efectos externos

**Un conector no puede saltarse la Oficina.** El flujo es:

1. `POST /api/studio/connectors/:id/invoke` con un efecto (`POST/PUT/PATCH/DELETE`
   o capacidad `write/send/execute`).
2. El módulo guarda los argumentos **cifrados** en `pendingCalls` y crea una
   propuesta en la Oficina:
   - `kind: "connector"`, `channel: "connector"`,
   - `attachments: ["connector:<id>"]` (fuerza riesgo y nivel N2),
   - `forceApproval: true` → nunca se auto-ejecuta, ni en modo total,
   - `meta.connector = {connectorId, method, path, capability, gateToken, effect:true}`.
3. Respuesta `202` al cliente:

```json
{
  "ok": true, "pending": true, "status": 202, "approvalRequired": true,
  "level": "N2", "proposalStatus": "pending",
  "proposal": { "id": "OF-0001", "kind": "connector", "channel": "connector",
                "status": "pending", "level": "N2", "meta": { "connector": { … } } }
}
```

4. El Owner **aprueba** y **ejecuta** desde la Oficina (o por API):

```bash
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/approve \
  -H 'content-type: application/json' -d '{"by":"owner"}'
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/execute \
  -H 'content-type: application/json' -d '{}'
```

5. Solo entonces el ejecutor **`connector`** descifra los argumentos, resuelve
   el token y realiza la llamada externa. El resultado queda en
   `proposal.execution` y en el ledger de la Oficina.
6. Un `gateToken` es de un solo uso: se borra tras ejecutar; la Oficina no
   permite ejecutar dos veces (`409 ALREADY_EXECUTED`).

- Sin aprobación: `409 NOT_APPROVED` y **cero** llamadas externas.
- Oficina no disponible o `CONNECTOR_GATE_DISABLE=1` (solo pruebas):
  `503 CONNECTOR_GATE_UNAVAILABLE`.
- MCP: las herramientas clasificadas como lectura pueden ir directas (solo
  transporte HTTP/SSE); las de efecto se propuestas igual que el resto. Los
  servidores MCP stdio **no se ejecutan desde este conector** (usa `/api/mcp`).

---

## 6. Seguridad

- Tokens:
  - cifrados con AES-256-GCM (clave maestra del store),
  - nunca en respuestas, logs, `lastTest`, `catalog` ni `pendingCalls.meta`,
  - las propuestas describen método/ruta pero **no** incluyen cabeceras.
- `Authorization` se construye en memoria justo antes de la petición; no se
  serializa.
- Errores de red se redactan (`redactString`) y no incluyen cabeceras.
- Prueba automatizada: un token de fixture no aparece en ninguna respuesta ni
  en el JSON del store; el fixture comprueba que la petición sí lo llevó.
- Allowlist, redirecciones bloqueadas, timeout, límite de bytes y body máximo.
- Sin ejecución de comandos ni expansión de shells; sin `eval`.

---

## 7. Errores

| Código | HTTP | Cuándo |
|---|---|---|
| `CONNECTOR_NOT_FOUND` | 404 | El conector no existe. |
| `CONNECTOR_DISABLED` | 409 | El conector está deshabilitado. |
| `CONNECTOR_INVALID_CONFIG` | 400 | Configuración/validación inválida. |
| `CONNECTOR_ENDPOINT_NOT_ALLOWED` | 400 | HTTP no loopback, esquema no permitido o credenciales en URL. |
| `CONNECTOR_AUTH_INVALID` | 400 | `authRef`/token inválidos o bóveda desconocida. |
| `CONNECTOR_AUTH_REQUIRED` | 400 | Falta el token/secreto referenciado. |
| `CONNECTOR_AUTH_EXPIRED` | 401 | Access token de Google caducado. |
| `CONNECTOR_CAPABILITY_NOT_ALLOWED` | 403 | Operación fuera de las capacidades declaradas. |
| `CONNECTOR_HTTP_ERROR` | 502 | El endpoint respondió fuera de 2xx en una lectura. |
| `CONNECTOR_NETWORK` / `CONNECTOR_TIMEOUT` | 502/504 | Fallo de red o timeout. |
| `CONNECTOR_REDIRECT_BLOCKED` | 502 | El endpoint intentó redirigir. |
| `CONNECTOR_RESPONSE_TOO_LARGE` | 502 | Respuesta > `maxBytes`. |
| `CONNECTOR_GATE_UNAVAILABLE` | 503 | Oficina no disponible o gate deshabilitado en tests. |
| `CONNECTOR_GATE_FAILED` | 502 | No se pudo crear la propuesta de aprobación. |
| `CONNECTOR_PENDING_CALL_MISSING` | 409 | Token de llamada pendiente ausente o caducado. |
| `CONNECTOR_MCP_STDIO_UNSUPPORTED` | 400 | Invocación directa de un MCP stdio desde este conector. |
| `CONNECTOR_MCP_NOT_FOUND` / `_DISABLED` | 404/409 | Referencia MCP inválida. |
| `CONNECTOR_GOOGLE_NOT_FOUND` / `_RECONNECT` | 400 | Referencia OAuth inválida o reconexión pendiente. |
| `CONNECTOR_LIMIT` | 409 | Más de 100 conectores. |

---

## 8. Variables de entorno

| Variable | Uso |
|---|---|
| `CONNECTOR_GATE_DISABLE=1` | **Solo pruebas**: simula Oficina ausente; los efectos devuelven `503`. |

No hay variables para tokens: se guardan cifrados o se referencian de la bóveda.

---

## 9. Pruebas

```bash
node --test tests/integration/connectors.test.mjs
```

Cubre (8/8):

1. catálogo y allowlist (HTTP externo, `file:`, credenciales, campos extra),
2. token cifrado, `Bearer` correcto en el fixture y ausencia del token en
   respuestas y store,
3. lectura directa, ruta traversal/URL absoluta/body en GET rechazados,
4. gate de Oficina: efecto pendiente, `NOT_APPROVED`, aprobación + ejecución
   única, cuerpo correcto en el fixture,
5. capacidad de efecto no declarada → 403 sin propuesta,
6. `CONNECTOR_GATE_DISABLE=1` → 503 sin llamada externa,
7. fallo de red registrado, borrado de secretos y 404,
8. Drive/MCP delegados sin ejecutar comandos.

Además: `npm run check` y `npm test` (suite completa) deben seguir pasando.

---

## 10. UI (pendiente, frontend-ux)

El frontend puede consumir:

- `GET /api/studio/connectors` → tarjetas + catálogo + `gate.available`,
- `POST` para alta (el input de token es `type=password` y no se vuelve a mostrar),
- `POST /:id/test` para el botón “Probar”,
- `GET /api/studio/connectors/:id` para detalle,
- `DELETE` con confirmación.
- Los avisos de “efecto pendiente” deben enlazar a `/api/office/proposals/:id`
  (la propuesta se ve en la Oficina como `kind: connector`).

No se requiere PATCH: para rotar token o cambiar endpoint, borrar y recrear.

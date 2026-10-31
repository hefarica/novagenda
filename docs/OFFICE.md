# Oficina — aprobación N0-N3, ledger y organigrama

La **Oficina** es el corazón de gobierno de Agenda Copilot P95: recibe
propuestas de los agentes, calcula su riesgo, decide si pueden salir solas o
necesitan al jefe, firma la aprobación, ejecuta una sola vez y deja todo en un
ledger auditable.

> **Invariante:** nada sale hacia fuera sin que la política lo permita y, cuando
> exige aprobación, sin una aprobación firmada (HMAC-SHA256) válida para ese
> payload exacto.

- Módulo: `lib/office/**` (sin dependencias npm, Node 24 nativo).
- Rutas: `lib/routes/office.mjs` (auto-descubiertas, `priority: 130`).
- Autocheck: `node lib/office/selfcheck.mjs` (PASS/FAIL, `DATA_DIR` temporal,
  puerto 3120-3145, no toca `data/` real).
- No programa timers: si el scheduler de t8 quiere generar propuestas
  periódicas, las crea por API o importando `createProposal()`.

---

## 1. Organigrama

`GET /api/office/roster` devuelve los 7 roles declarativos:

| id | Nombre | Puede proponer | Puede ejecutar | Canal de salida |
|---|---|---|---|---|
| `chief_of_staff` | Jefe de Gabinete | sí | sí | interno |
| `agenda` | Agenda | sí | sí | interno |
| `correspondencia` | Correspondencia | sí | sí | email |
| `documentos` | Documentos | sí | sí | documento |
| `research` | Research | sí | no | informe |
| `qa` | QA | no | no | informe |
| `auditoria` | Auditoría | no | no | auditoría |

Cada rol declara `id`, `nombre`, `descripcion`, `capacidades`,
`puede_proponer`, `puede_ejecutar` y `canal_de_salida`.

Las **opiniones** de una propuesta son consultivas: una rúbrica determinista
puntúa a los 7 roles de 0 a 1 (`aprobar` ≥ 0.70, `revisar` ≥ 0.52, `rechazar`
por debajo). La media es la **voz** de la propuesta (`voice`), usada por el modo
autónomo. Si hay una API key LLM en la bóveda se añade una frase breve
(`llmOpinion`) con presupuesto de ~2 s; si falla, se ignora sin bloquear.

---

## 2. Motor de riesgo

`lib/office/risk.mjs` es **determinista, sin red y sin LLM**. Analiza
`kind, channel, recipients[], subject, body, attachments[], meta` y produce un
puntaje 0–10 con flags explicables:

| Flag | Señal | Peso |
|---|---|---|
| `MONEY` | pagos, facturas, montos, presupuestos, `meta.amount > 0` | 3 |
| `LEGAL` | contrato, NDA, confidencialidad, términos legales | 4 |
| `DEADLINE` | urgencia, vencimiento, `meta.deadline` ≤ 72 h | 2 |
| `EXTERNAL_RECIPIENT` | destinatario fuera del dominio propio | 2 |
| `NEW_CONTACT` | destinatario que no está en la libreta | 2 |
| `MANY_RECIPIENTS` | ≥ 4 destinatarios | 2 |
| `ATTACHMENTS` | adjuntos | 1 |
| `EXTERNAL_CHANNEL` | `email` (1), `whatsapp`/`telegram` (2), `webhook` (3) | 1–3 |

Cada flag incluye `{code,label,weight,detail}`. El resultado (`risk`) guarda
`score`, `maxScore`, `flags`, `signals` (incluye `externalRecipients`,
`newContacts`, `recipientCount`, `attachments`, `externalChannel`, `readOnly`) y
`knownContact`.

**Contactos conocidos:** `data.office.contacts` (se aprenden al aprobar
humanamente), asistentes de la agenda y cuentas Google conectadas. **Dominios
propios:** dominios de las cuentas Google, `data.office.ownDomains` y
`OFFICE_OWN_DOMAINS` (coma-separados). Teléfonos/URLs se consideran externos.

---

## 3. Niveles y modos

### Niveles (`lib/office/policy.mjs`)

| Nivel | Significado | Comportamiento |
|---|---|---|
| **N0** | lectura automática | se ejecuta sin aprobación (sin efectos externos) |
| **N1** | borrador automático | se ejecuta y queda **ventana de deshacer** (`undoWindowSec`, 300 s) |
| **N2** | requiere aprobación | envío externo/adjuntos; aprobación humana salvo autonomía |
| **N3** | doble confirmación | dinero/términos legales/riesgo alto: aprobación **+ código de 6** |

Derivación: `readOnly` → N0; `MONEY`/`LEGAL`/puntaje ≥ 7 → N3; canal externo,
destinatario externo/nuevo, adjuntos o puntaje ≥ 4 → N2; resto → N1.

### Modos (persistidos en `store.office.mode`)

| Modo | N0/N1 | N2 | N3 |
|---|---|---|---|
| `sombra` | retenido | retenido | retenido |
| `asistido` (defecto) | automático | **aprobación** | aprobación + código |
| `autonomo` | automático | automático **solo si** riesgo ≤ 3 **y** contacto conocido **y** voz ≥ 0.75; si no, aprobación | aprobación + código |
| `total` | automático | automático con bitácora | aprobación + código |

> N3 es una **puerta dura** en todos los modos (incluido `total`): el código de
> 6 caracteres sigue siendo obligatorio. El modo `total` automatiza N0/N1/N2.

Cambiar de modo **no** reescribe propuestas existentes; sí afecta a las nuevas y
bloquea la ejecución si el modo actual es `sombra`.

---

## 4. Ciclo de vida de una propuesta

Estados: `pending`, `held` (sombra), `approved`, `rejected`, `executing`,
`executed`, `failed`, `reverted`.

```
POST /proposals
   │  riesgo + nivel + opiniones + política
   ├─ N0/N1 (o N2 auto) ──► approved ──► executing ──► executed
   ├─ N2/N3 ──► pending ──► approve ──► approved ──► execute ──► executed
   └─ sombra ──► held (approve permitido; execute bloqueado)
```

- **N1** ejecuta un borrador local (`document` executor) y expone `undoUntil`.
  `POST /proposals/:id/undo` lo revierte dentro de la ventana.
- **N3**: `approve` devuelve **una sola vez** un código de 6 caracteres
  (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`). Se guarda su hash ligado al nonce; se
  consume al ejecutar correctamente. Sin código → `400 CODE_REQUIRED`; código
  incorrecto → `409 INVALID_CODE`.
- **Ejecución única:** el paso a `executing` es atómico; un segundo `execute`
  recibe `409 ALREADY_EXECUTED` (o `EXECUTE_IN_PROGRESS` si coincide en vuelo).
- **Sin ejecutor:** `503 EXECUTOR_UNAVAILABLE` y la propuesta **sigue
  `approved`** (no se marca ejecutada).
- **Payload alterado:** el hash del contenido se firmó al aprobar. Si cambia
  `body`, destinatarios, adjuntos o nivel, `execute` → `409 SIGNATURE_INVALID`.
- **TTL:** la aprobación caduca a los **30 min** (`approvalTtlSec`); después
  `execute` → `409 APPROVAL_EXPIRED`.

### Firma de aprobación

`approve` crea:

```json
{
  "approval": {
    "by": "jefe",
    "at": "2026-10-28T08:00:00.000Z",
    "note": "visto bueno",
    "auto": false,
    "alg": "HMAC-SHA256",
    "nonce": "…",
    "issuedAt": "…",
    "expiresAt": "…",
    "payloadHash": "<sha256 del contenido>",
    "signature": "<hmac-sha256 hex>",
    "token": "<payload base64url>.<firma>",
    "signedPayload": { "v": 1, "aud": "office-approval", "proposalId": "OF-0001", "level": "N2", "by": "jefe", "nonce": "…", "issuedAt": "…", "expiresAt": "…", "payloadHash": "…" }
  }
}
```

El secreto HMAC se toma de `OFFICE_HMAC_SECRET` o `APP_SECRET` (bóveda de t1);
si no hay ninguno se deriva de la clave maestra. Nunca se devuelve ni se loguea.

---

## 5. API

Base: `/api/office`. Todas las rutas usan la autenticación normal de la app
(`auth:'default'`): en modo local sin login no piden sesión; con
`HOST≠loopback` o `APP_AUTH=on` exigen cookie de sesión.

### `GET /api/office/roster`

`200 {ok, items:[7 roles], count:7, roles:[…], mode, levels, modes, voiceThreshold, undoWindowSec, approvalTtlSec}`.

### `GET /api/office/mode` · `POST /api/office/mode`

```json
{"mode": "autonomo", "by": "owner"}
```

`200 {ok, mode, previous, levels, modes, voiceThreshold, undoWindowSec, approvalTtlSec, updatedAt, updatedBy}`.
Alias aceptados: `sombra|shadow`, `asistido|assisted`, `autonomo|autónomo|autonomous`, `total|full`.

### `GET /api/office/status`

Resumen para el panel: modo, conteos por estado, pendientes, aprobadas,
ejecutadas, contactos, cabeza del ledger, ventanas.

### `POST /api/office/proposals`

```json
{
  "kind": "email",
  "channel": "email",
  "recipients": ["cliente@externo.com"],
  "subject": "Propuesta comercial",
  "body": "Adjunto la propuesta…",
  "attachments": ["propuesta.pdf"],
  "meta": {"deadline": "2026-10-29"}
}
```

- `kind`: slug (`^[a-z][a-z0-9_-]{1,39}$`), p. ej. `email`, `document`, `note`,
  `research`, `read`, `webhook`, `task`.
- `channel`: `email|whatsapp|telegram|document|note|read|webhook|none|internal`.
  `email/whatsapp/telegram` exigen ≥ 1 destinatario.
- `recipients`: ≤ 50; `subject` ≤ 300; `body` 1–20000; `attachments` ≤ 10
  (cada uno ≤ 500); `meta` objeto ≤ 4000 bytes serializados.

`201`:

```json
{
  "ok": true,
  "item": {
    "id": "OF-0001", "level": "N2", "status": "pending",
    "risk": {"score": 5, "maxScore": 10, "flags": [...], "signals": {...}},
    "flags": ["EXTERNAL_RECIPIENT", "NEW_CONTACT", "ATTACHMENTS"],
    "opinions": [{"role": "chief_of_staff", "score": 0.85, "verdict": "aprobar", "note": "…", "source": "rubric"}, …],
    "voice": 0.76,
    "policy": {"mode": "asistido", "action": "approve", "requiresApproval": true, "requiresCode": false, "reason": "…"},
    "card": {"title": "N2 · email · OF-0001", "summary": "…", "text": "…", "actions": ["approve", "reject"], …},
    "createdAt": "…", "updatedAt": "…"
  },
  "id": "OF-0001", "level": "N2", "status": "pending",
  "risk": {…}, "flags": […], "card": {…},
  "code": null, "auto": false, "executed": false, "error": null
}
```

En N0/N1 (o N2 automático) la respuesta es `201` con `auto:true`,
`executed:true` y `item.execution` cuando el ejecutor está disponible. Si el
automático no tiene ejecutor, `item.status` queda `approved`, `error.code =
"EXECUTOR_UNAVAILABLE"` y no se ejecuta nada.

Errores de validación: `400` con `{error, code, field, requestId}`
(`UNKNOWN_FIELD`, `REQUIRED`, `INVALID_VALUE`, `INVALID_TYPE`, `TOO_LONG`,
`EMPTY_PATCH`, `INVALID_BODY`).

### `GET /api/office/proposals?status=&limit=&offset=`

`200 {ok, items:[…], count, total, status}`. `status` ∈ estados; inválido →
`400 INVALID_VALUE`. Orden: más recientes primero.

### `GET /api/office/proposals/:id`

`200 {ok, item}`; inexistente → `404 NOT_FOUND`.

### `POST /api/office/proposals/:id/approve`

```json
{"by": "jefe", "note": "visto bueno"}
```

`200 {ok, item, approval:{…}, signature, nonce, expiresAt, token, code, card}`.
`code` solo en N3 (6 caracteres). Errores: `409 ALREADY_APPROVED`,
`ALREADY_EXECUTED`, `EXECUTE_IN_PROGRESS`, `REJECTED`, `REVERTED`,
`INVALID_STATE`; `404` si no existe. `token` es el payload firmado en
base64url + firma (auditoría externa opcional).

### `POST /api/office/proposals/:id/reject`

```json
{"by": "jefe", "reason": "no aplica"}
```

`200 {ok, item(status:"rejected")}`. No se puede rechazar algo ya ejecutado.

### `POST /api/office/proposals/:id/execute`

```json
{"code": "A1B2C3"}
```

`code` solo en N3 (6 caracteres). `200 {ok, item, status:"executed", executed:true, execution:{executor, at, result}}`.

| Situación | HTTP | code |
|---|---|---|
| modo sombra | 409 | `SHADOW_MODE` |
| sin aprobar | 409 | `NOT_APPROVED` |
| payload alterado | 409 | `SIGNATURE_INVALID` |
| aprobación caducada | 409 | `APPROVAL_EXPIRED` |
| N3 sin código | 400 | `CODE_REQUIRED` |
| N3 código incorrecto | 409 | `INVALID_CODE` |
| doble execute | 409 | `ALREADY_EXECUTED` |
| ejecución concurrente | 409 | `EXECUTE_IN_PROGRESS` |
| sin ejecutor | 503 | `EXECUTOR_UNAVAILABLE` (no marca ejecutada) |
| ejecutor lanza error | 502 | `EXECUTOR_FAILED` (queda `failed`) |

### `POST /api/office/proposals/:id/undo`

Solo N1 ejecutado y dentro de `undoUntil`. `200 {ok,item(status:"reverted")}`;
si caducó `409 UNDO_EXPIRED`; si el ejecutor no soporta revertir
`409 UNDO_NOT_SUPPORTED`.

### `POST /api/office/parse`

```json
{"text": "dale"}
```

`200 {ok, decision:"approve"|"reject"|"correct"|"unknown", text, correction, matched, confidence}`.
Reconoce `ok`, `dale`, `sí`, `adelante`, `hazlo`; `no`, `rechaza`, `cancela`;
`corrige: …`, `cambia …`, `ajusta …`.

### `GET /api/office/ledger?limit=100&offset=0`

`200 {ok, items:[entradas más recientes], count, total, head, genesis}`.

### `GET /api/office/ledger/verify`

`200 {ok, entries:<número>, broken:[{seq,reason}], head, genesis}`.
`ok:false` si se manipuló el payload, el `payloadHash`, el `hash` o la cadena.

### `GET /api/office/ledger/export`

Descarga `attachment; filename="office-ledger.json"` con
`{app, document:"office-ledger", exportedAt, mode, genesis, verification, entries:[…]}`.
No incluye cuerpos de propuestas: el payload del ledger está sanitizado.

### `GET /api/office/executors`

`200 {ok, items:[{id,name,available,revert}], count}`. Útil para el centro de
integraciones: muestra si email/WhatsApp/Telegram están listos.

---

## 6. Ledger append-only

Archivo lógico: `store.office.ledger` (persistido en `data/agenda-data.json`
del `DATA_DIR` activo).

Entrada:

```json
{
  "seq": 12,
  "ts": "2026-10-28T08:10:00.000Z",
  "actor": "jefe",
  "action": "proposal.approved",
  "payloadHash": "<sha256(canonical(payload))>",
  "prevHash": "<hash de la entrada 11>",
  "hash": "<sha256(canonical({seq,ts,actor,action,payloadHash,prevHash}))>",
  "payload": {"proposalId": "OF-0001", "level": "N2", "by": "jefe", "mode": "asistido"}
}
```

- Genesis: `prevHash = "000…0"` (64 ceros).
- Acciones: `proposal.created`, `proposal.approved`, `proposal.rejected`,
  `proposal.executed`, `proposal.execution_failed`, `proposal.execution_blocked`,
  `proposal.reverted`, `mode.changed`.
- Verificación (`GET /ledger/verify`) recalcula `payloadHash` desde el payload
  guardado, recalcula `hash`, comprueba `seq` consecutivo y `prevHash`.
- El ledger **no se poda** al hacer `pruneProposals` (solo se limitan las
  propuestas a 2000 para no crecer sin control).
- Export JSON: ideal para archivar/auditar fuera de la app.

---

## 7. Conectar un ejecutor

La ejecución real está desacoplada por un registro inyectable
(`lib/office/executors.mjs`). Interfaz:

```js
import { registerExecutor } from './lib/office/executors.mjs';

registerExecutor('mi-canal', {
  name: 'mi-ejecutor',
  available: async () => true,              // false ⇒ 503 sin marcar ejecutada
  execute: async (proposal, { actor, auto }) => ({
    ok: true,
    detail: 'enviado',
    artifacts: [{ type: 'id', id: '…' }]
  }),
  revert: async (proposal) => ({ ok: true }) // opcional, para N1
});
```

- Resolución: canal → kind → alias (`draft/note → document`,
  `none/internal → read`).
- Ejecutores nativos:
  - `document|draft|note`: escribe `DATA_DIR/office-documents/<id>.md` y
    soporta `revert`.
  - `read|none|internal`: no-op de lectura.
  - `email`: Gmail (`lib/google.mjs`) si hay cuenta Google conectada; si no,
    `available=false`.
  - `whatsapp`/`telegram`: adaptadores de `lib/channels.mjs` si el canal está
    configurado.
- Un ejecutor puede sustituirse/inyectarse en cualquier momento (misma sesión
  de proceso). Si devuelve `ok:false` sin lanzar, se considera ejecutado;
  lanza un error para que quede `failed` y se registre `proposal.execution_failed`.
- **Importante:** la Oficina no importa módulos de envío al cargar; los carga de
  forma perezosa al ejecutar, así un canal roto no impide arrancar la app.

---

## 8. Seguridad y operación

- **HMAC:** `APP_SECRET`/`OFFICE_HMAC_SECRET` o clave maestra; nonce por
  aprobación; firma hex SHA-256; comparación en tiempo constante.
- **Código N3:** 6 caracteres, generado criptográficamente, devuelto una sola
  vez, guardado solo como hash con el nonce, caduca con la aprobación y se
  consume en la ejecución.
- **Redacción:** los errores y payloads del ledger se sanitizan (máx. 500
  caracteres por campo); no se guardan cuerpos completos en el ledger.
- **Modo sombra:** bloquea toda ejecución (incluso N0/N1) hasta cambiar de modo.
- **Contactos:** solo se aprenden al aprobar humanamente una propuesta; la
  autonomía nunca amplía la libreta por sí sola.
- **Almacenamiento:** todo vive en el store (`data.office`), con escritura
  atómica y journal del store de t1. No se tocan archivos de `data/` reales en
  pruebas: el selfcheck usa `DATA_DIR` temporal.
- **Sin timers:** la Oficina no programa `setInterval`; el scheduler de t8 puede
  invocar la API o `createProposal()` cuando corresponda.

---

## 9. Autocheck

```bash
node lib/office/selfcheck.mjs
```

Cubre 53 comprobaciones con la app real montada en proceso (router aislado con
solo las rutas de Oficina, `DATA_DIR` temporal y puerto 3120-3145):

- roster con los 7 roles y campos declarativos;
- niveles N0/N1/N2/N3 y ventana de deshacer N1;
- N2 sin approve no ejecuta; approve firma; execute único; doble execute;
- payload alterado → `SIGNATURE_INVALID`; TTL caducado → `APPROVAL_EXPIRED`;
- N3 sin código / código incorrecto / código correcto;
- sin ejecutor → 503 y estado `approved`;
- rechazo;
- modos `asistido`/`autonomo`/`total`/`sombra` sobre la misma propuesta;
- ejecutor inyectable;
- parseo humano (`dale`, `no`, `corrige:`);
- ledger verify/list/export y detección de manipulación;
- validaciones 400 y 404.

Salida: `SELFCHECK PASS (53/53)` o `FAIL` con el detalle; exit code 1 si falla.

---

## 10. Ejemplos rápidos

```bash
# roster y modo
curl -s http://127.0.0.1:3000/api/office/roster
curl -s -X POST http://127.0.0.1:3000/api/office/mode \
  -H 'content-type: application/json' -d '{"mode":"autonomo","by":"owner"}'

# propuesta N2 (correo externo con adjunto)
curl -s -X POST http://127.0.0.1:3000/api/office/proposals \
  -H 'content-type: application/json' \
  -d '{"kind":"email","channel":"email","recipients":["cliente@externo.com"],
       "subject":"Propuesta","body":"Adjunto propuesta","attachments":["p.pdf"]}'

# aprobar y ejecutar
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/approve \
  -H 'content-type: application/json' -d '{"by":"jefe"}'
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/execute \
  -H 'content-type: application/json' -d '{}'

# N3: el código viene en la respuesta de approve
curl -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0002/execute \
  -H 'content-type: application/json' -d '{"code":"A1B2C3"}'

# auditoría
curl -s http://127.0.0.1:3000/api/office/ledger?limit=20
curl -s http://127.0.0.1:3000/api/office/ledger/verify
curl -s -OJ http://127.0.0.1:3000/api/office/ledger/export
```

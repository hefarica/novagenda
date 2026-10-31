# ACL y etiquetas de seguridad

Un documento o dato de Agenda Copilot P95 puede etiquetarse como **público**,
**interno** o **reservado**. La política ACL decide si puede salir por un canal
a una lista de destinatarios y con qué nivel de aprobación. El objetivo es que
un contenido reservado **nunca** llegue a un tercero sin confirmación explícita.

- Código: `lib/acl/**`
- Rutas: `lib/routes/acl.mjs`
- Autochequeo: `node lib/acl/selfcheck.mjs`
- Integración en canales/documentos/oficina: **follow-up** de los dueños de esos
  módulos; esta tarea deja el guard listo y documentado.

---

## 1. Etiquetas

| Etiqueta | Significado | Salida externa |
|---|---|---|
| `público` | Se puede compartir sin restricción. | Permitida en cualquier canal (N0). |
| `interno` | Solo para la organización. | Permitida con **N2 + aviso/confirmación**. |
| `reservado` | Máxima sensibilidad. | Solo con `confirmedReserved:true`; **siempre N3 (código)**. |

La etiqueta canónica es `público` (con tilde); también se aceptan `publico`,
`public`, `interno`, `internal`, `reservado`, `reserved`, `privado`,
`confidencial` al normalizar.

---

## 2. Modelo persistente (sin migración)

Se crea perezosamente en `data.acl`:

```json
{
  "acl": {
    "documents": {
      "DOC-20261028-abc": {
        "label": "reservado",
        "owner": "Ana",
        "updatedAt": "2026-10-28T15:10:05.343Z",
        "by": "qa-acl"
      }
    },
    "defaults": { "document": "interno", "proposal": "interno" },
    "ledger": []
  }
}
```

- `documents` es un mapa `docId → {label, owner, updatedAt, by}`.
- `defaults.document` y `defaults.proposal` se aplican cuando no hay etiqueta
  explícita.
- `ledger` es la auditoría local propia del ACL.
- Además, cada cambio se replica en el ledger de la oficina
  (`data.office.ledger`) con la acción **`acl.change`**; el alta/cambio de
  defaults usa **`acl.defaults`**.
- `data.acl.ownDomains` e `data.acl.internalContacts` son opcionales para
  configuración; también se leen variables de entorno.

---

## 3. Dominios propios y destinatarios

`classifyRecipient(email)` devuelve `'interno'` o `'externo'`.

Fuentes de **dominio propio**:

1. Cuentas Google conectadas (`data.googleConnections[].email`).
2. `data.office.ownDomains`.
3. `data.acl.ownDomains`.
4. `data.settings.ownDomains`.
5. `OFFICE_OWN_DOMAINS` y `ACL_OWN_DOMAINS` (lista separada por comas).

Fuentes de **contacto interno explícito**:

- `data.acl.internalContacts` y `data.office.internalContacts`;
- `ACL_INTERNAL_CONTACTS` y `OFFICE_INTERNAL_CONTACTS`.

Reglas:

- Un correo del dominio propio es **interno**.
- Un correo de un dominio desconocido es **externo**.
- Teléfonos, URLs y textos son **externos**.
- `data.office.contacts` y los asistentes de agenda son **conocidos**, pero por
  defecto **no** se convierten en internos: un cliente conocido sigue siendo un
  tercero. Para tratarlo como interno hay que declararlo en
  `internalContacts`. Se puede forzar el comportamiento antiguo con
  `data.acl.knownContactsAreInternal:true` (no recomendado).

Ejemplo:

```js
classifyRecipient('ana@empresa.test') // interno si empresa.test es propio
classifyRecipient('cliente@gmail.com') // externo
```

---

## 4. Matriz de decisión

`decide({label, channel, recipients, confirmedReserved})` es determinista y no
muta nada. `label` ausente aplica `defaults`; `kind` puede ser `document` o
`proposal`.

| Etiqueta | Destinatarios | `allowed` | `level` | `requiresConfirmation` | Código |
|---|---|---|---|---|---|
| `público` | cualquiera | `true` | `N0` | `false` | no |
| `interno` | solo internos | `true` | `N1` | `false` | no |
| `interno` | externos o mixto | `true` | `N2` | `true` | no |
| `reservado` | solo internos | `true` | `N2` | `false` | no |
| `reservado` | externos/mixto sin confirmar | **`false`** | `N3` | `true` | sí |
| `reservado` | externos/mixto con `confirmedReserved:true` | `true` | `N3` | `false` | sí |

Notas:

- `allowed:true` con `requiresConfirmation:true` significa “la política lo
  admite, pero el emisor debe pedir aprobación/aviso antes”.
- En **reservado → externo sin confirmar** `allowed` es **siempre `false`**,
  aunque el canal sea interno o el destinatario sea “conocido”.
- `reservado` siempre exige N3 (código) cuando hay externos, incluso con
  confirmación.
- La respuesta incluye además `audience` (`interno`, `externo`, `mixto`,
  `sin_destinatarios`), `internals`, `externals`, `requiresApproval`,
  `requiresCode`, `labelSource` y `policyVersion`.

---

## 5. API

### `GET /api/acl/status`

Devuelve etiquetas, defaults, número de documentos/ledger, dominios propios,
contactos internos y política de reservado.

### `GET /api/acl/documents/:docId`

Devuelve la etiqueta del documento y la efectiva:

```json
{
  "item": {
    "docId": "DOC-1", "label": "reservado",
    "effectiveLabel": "reservado", "source": "document",
    "owner": "Ana", "updatedAt": "…", "by": "qa"
  }
}
```

Si el documento no tiene etiqueta, `label:null` y `effectiveLabel` es el
default. No es un error: el guard necesita poder consultar documentos aún no
clasificados.

### `PUT /api/acl/documents/:docId`

```json
{ "label": "reservado", "owner": "Ana", "by": "api" }
```

Valida la etiqueta, guarda y escribe `acl.change` en los ledgers. Responde 200
con `{item}`.

### `POST /api/acl/check`

```json
{
  "docId": "DOC-1",
  "channel": "email",
  "recipients": ["cliente@gmail.com"],
  "confirmedReserved": false
}
```

También acepta `label` en lugar de `docId`; si se envían ambos, **manda la
etiqueta almacenada del documento** para evitar bypass. Responde la decisión
completa en el nivel superior (`allowed`, `level`, `reason`, …).

### `GET /api/acl/policy`

Reglas efectivas, matriz, defaults vigentes, clasificación y nota de
enforcement (`guardOutbound`).

### `POST /api/acl/defaults`

```json
{ "document": "público", "proposal": "interno" }
```

Se puede cambiar uno o ambos; valida y audita `acl.defaults`.

### Listado auxiliar

`GET /api/acl/documents?limit=200` lista las etiquetas auditadas para una UI de
seguridad.

---

## 6. Guard reutilizable

`lib/acl/index.mjs` exporta:

```js
import { guardOutbound } from './lib/acl/index.mjs';

const acl = guardOutbound({
  docId: 'DOC-1',
  channel: 'email',
  recipients: ['cliente@gmail.com'],
  confirmedReserved: false
});

if (!acl.allowed) {
  // Bloquear: reservado → externo sin confirmación.
  return { error: acl.reason, level: acl.level };
}
if (acl.requiresConfirmation) {
  // Pedir aviso/confirmación humana; luego reintentar con confirmedReserved:true.
}
if (acl.requiresCode) {
  // N3: solicitar código de 6 caracteres (política de oficina).
}
```

- `guardOutbound` no envía ni muta; resuelve etiqueta (documento → default) y
  llama a `decide`.
- Si se pasa `docId`, la etiqueta del documento tiene prioridad sobre un `label`
  explícito.
- `assertOutbound` lanza `403 ACL_BLOCKED` si `allowed:false` (para
  integraciones que prefieren excepción).
- Los dueños de `lib/channel/**`, `lib/docs/**` y `lib/office/**` deben llamarlo
  **antes** de enviar o adjuntar. Esta tarea no modificó esos módulos.

---

## 7. Auditoría

Cada `PUT` añade:

- `data.acl.ledger[]`: `{seq, ts, actor, action:"acl.change", payload:{docId,label,previousLabel,owner,updatedAt}}`.
- `data.office.ledger[]`: entrada encadenada con `action:"acl.change"` y el
  mismo payload sanitizado, para que la auditoría existente de la oficina la
  vea.

`POST /api/acl/defaults` usa `acl.defaults` con `{before,after}`.

---

## 8. Límites y decisiones

- No hay migración: `data.acl` se crea al primer uso; si falta, los defaults son
  `interno`.
- No se inspecciona el contenido del documento: la etiqueta es una declaración
  del dueño; el ACL no detecta PII ni secretos por sí solo.
- No se bloquean canales internos por etiqueta `interno`; la política de canal
  sigue siendo responsabilidad del módulo de canales.
- `reservado` a externos **no** se permite “solo con aviso”: requiere
  `confirmedReserved:true` y N3.
- El guard es una dependencia de seguridad: una integración que no lo llame no
  queda protegida. El follow-up debe cubrir email, WhatsApp, Telegram, webhook,
  documentos y propuestas de oficina.
- Los contactos conocidos externos no se promueven a internos por defecto; es
  una decisión deliberada para evitar fugas.
- Los límites de almacenamiento son 5.000 documentos y 5.000 entradas de ledger
  propio; se podan por antigüedad.

---

## 9. Verificación

```bash
DATA_DIR=$(mktemp -d) node lib/acl/selfcheck.mjs
```

El autochequeo prueba:

- clasificación propio vs externo, contacto interno, conocido externo, teléfono;
- matriz de 10 casos (10/10) y **0 escapes** reservado→externo sin confirmar;
- etiquetado, modelo `data.acl.documents`, `acl.change` en ambos ledgers;
- defaults respetados y documento que conserva su etiqueta;
- `guardOutbound` y `assertOutbound`;
- rutas HTTP con contexto falso.

En la verificación de integración se usa `DATA_DIR` temporal y un puerto
≥ 3312; nunca el 3000 ni el `data/agenda-data.json` real.

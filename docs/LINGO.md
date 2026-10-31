# Lingo — léxico único de la oficina

Lingo es la fuente de verdad de **nombres, predios, entidades y jerga** de la
oficina. Antes cada pieza (ASR, redacción, identidad, ficheros) podía tener su
propia lista; ahora hay un solo léxico versionado en `data.lingo`, con estados,
aprendizaje auditado y una regla explícita de promoción.

```
lib/lingo/store.mjs      modelo + persistencia + conflicto + ledger
lib/lingo/engine.mjs     findTerms / applyCanonical / suggest / hotwords / learn
lib/lingo/selfcheck.mjs  autocheck sin servidor ni LLM
lib/routes/lingo.mjs     API /api/lingo/*
```

No hay migración: si `data.lingo` no existe, se crea vacío al primer uso. No se
tocan `lib/style/**`, `lib/agent/**` ni `lib/channel/**`; la integración es por
import (ver §7).

---

## 1. Modelo de un término

```json
{
  "id": "LG-0001",
  "term": "Héctor Fabio Riascos C.",
  "variants": ["hector fabio riascos", "Héctor Riascos"],
  "context": "actas, predios",
  "sources": ["manual", "asr"],
  "status": "approved",
  "uses": 12,
  "corrections": 3,
  "createdAt": "2026-10-28T15:11:12.609Z",
  "updatedAt": "2026-10-28T15:11:12.609Z"
}
```

- **`term`**: forma canónica; se conserva exactamente (mayúsculas, tildes,
  puntos de iniciales).
- **`variants`**: formas que deben resolverse a `term` (errores de ASR, nombres
  incompletos, alias). No pueden pertenecer a dos términos: eso es un 409.
- **`context`**: etiquetas separadas por comas (`actas, predios`). Vacío o
  `global`/`general` significa que aplica a todos. `?ctx=predios` filtra.
- **`sources`**: de dónde salió (`manual`, `asr`, `chat`, `import`, …).
- **`status`**:
  - `shadow`: aprendido/propuesto, **no se aplica** a texto ni entra en
    hotwords; sirve para revisión y `suggest`.
  - `approved`: se aplica en `applyCanonical` y `hotwords`.
  - `rejected`: veto manual; no se aplica ni se sugiere como conocido.
- **`uses`**: veces que se ha aplicado (se incrementa con `POST /apply`).
- **`corrections`**: correcciones acumuladas por `learn`; a las **3** promueve
  automáticamente a `approved`.

Normalización de comparación: minúsculas, sin diacríticos y sin puntuación.
`Héctor Fabio Riascos C.` → `hector fabio riascos c`. La forma canónica no se
normaliza al guardar.

---

## 2. Estados y promoción

Regla dura: **una corrección nunca aprueba un término**. El flujo es:

1. `learn({original, corrected, source})` busca el término por `corrected`
   (canónico o variante).
2. Si no existe, crea el término en `shadow` con `corrections: 1`.
3. Cada nueva corrección del mismo término suma `corrections`.
4. Al llegar a **3**, el término pasa a `approved` y se escribe
   `lingo.change` con `reason: "promotion"` en el ledger.
5. El jefe puede aprobar/rechazar antes con
   `PATCH /api/lingo/terms/:id` (autoridad humana); eso no depende de las 3.

Detalles:

- Diferencias de caja/tildes cuentan como corrección (`predio el rosario` →
  `Predio El Rosario`). Una llamada con `original === corrected` exactamente
  es un no-op.
- Un término `rejected` **no** se auto-promueve con correcciones; hace falta
  una aprobación manual (PATCH).
- Cada creación/aprobación/rechazo deja `lingo.change` en el ledger de la
  Oficina (`data.office.ledger`), verificable en `GET /api/office/ledger`.
- Los términos nuevos creados por API también nacen en `shadow`.

---

## 3. API

Todas las rutas usan la autenticación normal y se auto-descubren desde
`lib/routes/lingo.mjs` (priority 120).

### Listar y buscar

```bash
curl -s 'http://127.0.0.1:3000/api/lingo/terms?status=approved&ctx=predios&q=rosario'
```

`status` = `shadow|approved|rejected|all` (por defecto `all`), `ctx`, `q`,
`limit` (1–500), `offset`. Respuesta:

```json
{
  "ok": true,
  "items": [ ... ],
  "count": 1,
  "total": 1,
  "statuses": ["shadow", "approved", "rejected"],
  "stats": {"total": 2, "counts": {"shadow": 0, "approved": 2, "rejected": 0}}
}
```

### Crear/actualizar

```bash
curl -s -X POST http://127.0.0.1:3000/api/lingo/terms \
  -H 'content-type: application/json' \
  -d '{
    "term": "Héctor Fabio Riascos C.",
    "variants": ["hector fabio riascos", "Héctor Riascos"],
    "context": "actas, predios",
    "sources": ["manual"]
  }'
```

- Crea en `shadow` (201) o actualiza por forma canónica (200), fusionando
  variantes/fuentes y conservando el estado existente.
- `409 LINGO_CONFLICT` si una variante ya pertenece a otro término; el mensaje
  incluye el término dueño y su `LG-…`.

### Aprobar/rechazar

```bash
curl -s -X PATCH http://127.0.0.1:3000/api/lingo/terms/LG-0001 \
  -H 'content-type: application/json' \
  -d '{"status":"approved","reason":"revisado por el jefe"}'
```

También acepta `{"action":"approve"}` / `{"action":"reject"}`. `status` puede
ser `approved`, `rejected` o `shadow` (reset). Sin cambios reales responde
`changed:false` y no duplica ledger.

### Aprender

```bash
curl -s -X POST http://127.0.0.1:3000/api/lingo/learn \
  -H 'content-type: application/json' \
  -d '{"original":"predio el rosario","corrected":"Predio El Rosario","source":"asr"}'
```

Respuesta: `{ok, term, status, corrections, promoted, created, changed, stats}`.
La tercera llamada devuelve `status:"approved"` y `promoted:true`.

### Aplicar canónico

```bash
curl -s -X POST http://127.0.0.1:3000/api/lingo/apply \
  -H 'content-type: application/json' \
  -d '{"text":"Firmó hector fabio riascos ayer."}'
```

```json
{
  "ok": true,
  "text": "Firmó Héctor Fabio Riascos C. ayer.",
  "changed": true,
  "changes": [{"id":"LG-0001","canonical":"Héctor Fabio Riascos C.","from":"hector fabio riascos","to":"Héctor Fabio Riascos C."}],
  "terms": ["LG-0001"],
  "usesRecorded": true
}
```

Solo aplica términos `approved`; `includeShadow:true` permite probar borradores
sin aprobarlos.

### Sugerir

```bash
curl -s -X POST http://127.0.0.1:3000/api/lingo/suggest \
  -H 'content-type: application/json' \
  -d '{"text":"ACTA DE REUNIÓN. En el predio El Rosario, lote 12, matrícula 040-123, se reunieron Héctor Fabio Riascos C. y Ana María Gómez."}'
```

```json
{
  "ok": true,
  "candidates": [
    {"candidate":"Héctor Fabio Riascos C.","confidence":0.94,"kind":"nombre","known":true,"termId":"LG-0001","occurrences":1},
    {"candidate":"El Rosario","confidence":0.75,"kind":"predio","known":false,"termId":null,"occurrences":1},
    {"candidate":"Ana María Gómez","confidence":0.73,"kind":"nombre","known":false,"termId":null,"occurrences":1}
  ],
  "count": 3
}
```

Detecta secuencias capitalizadas, iniciales, entidades tras “predio/lote/
matrícula” y términos conocidos aunque aparezcan en minúsculas. **No inventa**:
todo candidato es un fragmento literal del texto o un término del léxico.

### Hotwords para ASR

```bash
curl -s 'http://127.0.0.1:3000/api/lingo/hotwords?ctx=predios&maxChars=200'
```

```json
{
  "ok": true,
  "ctx": "predios",
  "maxChars": 200,
  "chars": 45,
  "count": 3,
  "hotwords": ["Predio El Rosario", "Lote 12", "Matrícula 040-123"],
  "truncated": false,
  "eligible": 3
}
```

Solo `approved`; `shadow`/`rejected` quedan fuera. El presupuesto es de
**caracteres** (16–4000, por defecto 400): nunca se corta un término por la
mitad, se omiten los que no caben y `truncated` lo indica.

### Errores de validación

`400 REQUIRED`, `400 INVALID_TYPE`, `400 INVALID_VALUE`, `400 INVALID_FORMAT`,
`400 UNKNOWN_FIELD`, `409 LINGO_CONFLICT`, `404 LINGO_NOT_FOUND`. Mensajes en
español y cuerpo con `field`/`code`.

---

## 4. Integración expuesta (sin tocar otros módulos)

El módulo está listo para que los consumidores lo importen:

```js
// Redacción (lib/style/compose): aplicar después de redactar/corregir.
import { applyCanonical, hotwords } from '../lingo/engine.mjs';

const fixed = applyCanonical(draft);          // usa store actual
// fixed.text, fixed.changes, fixed.terms

const asrVocab = hotwords('predios', 200);    // {hotwords, text, chars, truncated}
```

```js
// Agente (lib/agent): antes de guardar un título/nota o al corregir una captura.
import { applyCanonical, suggest } from '../lingo/engine.mjs';

const canon = applyCanonical(userText).text;
const candidates = suggest(acta);             // para pedir confirmación
```

```js
// Identidad (lib/identity) y ficheros (lib/docs): unificar nombres antes de
// comparar/buscar; `findTerms` devuelve coincidencias con offsets.
import { findTerms } from '../lingo/engine.mjs';
const hits = findTerms(documentText);          // solo approved
```

- **ASR**: `hotwords(ctx, maxChars)` para el vocabulario del reconocedor.
- **Redacción/compose**: `applyCanonical` antes de puntuar/enviar; conserva la
  forma canónica y no toca código/markdown fuera de las coincidencias.
- **Identidad**: `findTerms`/`suggest` para detectar nombres y proponer
  candidatos; no fusiona personas por sí solo.
- **Ficheros/docs**: `applyCanonical` sobre títulos y metadatos; `findTerms`
  para buscar dentro del texto.
- **Agente/channel**: llamar a `applyCanonical` antes de persistir texto libre;
  el agente no debe aprobar términos automáticamente (solo el jefe o las 3
  correcciones).

La integración real se hará en un follow-up; en esta tarea no se modificó
`lib/style/**`, `lib/agent/**` ni `lib/channel/**`.

---

## 5. Ejemplos reales

| Texto de entrada | Salida canónica |
|---|---|
| `firmó hector fabio riascos` | `firmó Héctor Fabio Riascos C.` |
| `predio el rosario` | `Predio El Rosario` |
| `lote doce` | `Lote 12` |
| `matricula 040 123` | `Matrícula 040-123` |

Acta de ejemplo para `suggest`:

> ACTA DE REUNIÓN. En el predio El Rosario, lote 12, matrícula 040-123, se
> reunieron Héctor Fabio Riascos C. y la señora Ana María Gómez. Se acordó
> revisar el lote.

Candidatos: `Héctor Fabio Riascos C.` (conocido, 0.94), `El Rosario`
(predio, 0.75), `Ana María Gómez` (nombre, 0.73).

Conflicto típico:

```
POST /api/lingo/terms
{"term":"Lote 12","variants":["El Rosario"]}
→ 409 LINGO_CONFLICT
   La variante «el rosario» ya pertenece al término «Predio El Rosario» (LG-0001).
```

---

## 6. Ledger y auditoría

Cada alta y cada cambio de estado escribe una entrada encadenada en el ledger
de la Oficina:

```json
{"action":"lingo.change","payload":{"change":"created","termId":"LG-0001","term":"Héctor Fabio Riascos C.","status":"shadow"}}
{"action":"lingo.change","payload":{"change":"approved","termId":"LG-0001","from":"shadow","to":"approved","reason":"revisado por el jefe"}}
```

Se consulta con `GET /api/office/ledger` y se verifica con
`GET /api/office/ledger/verify`.

---

## 7. Límites conocidos

- Sin migración: `data.lingo` nace vacío; los datos previos de otras listas no
  se importan automáticamente.
- Máximo 5 000 términos; 30 variantes por término; `term`/variantes 120
  caracteres; contexto 120; fuentes 20.
- Solo `approved` se aplica/incluye en hotwords. `shadow` es deliberadamente
  inerte para producción; `suggest` sí lo muestra como conocido para revisión.
- La comparación ignora tildes/puntuación; dos términos que solo difieren en
  eso son el mismo término.
- `applyCanonical` no reescribe fuera de las coincidencias y no interpreta
  semántica; no corrige gramática ni inventa entidades.
- `suggest` es heurístico (capitalización + contexto + léxico); no sustituye la
  revisión humana.
- Conflicto de variantes entre términos es 409; no se fusionan términos
  automáticamente.
- `uses` cuenta aplicaciones de la API; no todas las lecturas incrementan.
- Sin LLM: todo es determinista y no hay llamadas de red.

---

## 8. Autocheck

```bash
node lib/lingo/selfcheck.mjs
```

Comprueba creación en shadow, aprobación manual, `applyCanonical`, los tres
pasos de `learn`, presupuesto de hotwords, `suggest` sobre un acta, conflicto
409, ledger y rutas. Salida esperada: `AUTOCHECK PASS 21/21`.

# DOCUMENTOS — DOCX, XLSX y PPTX reales sin dependencias

Agenda Copilot P95 genera archivos **reales** de Word, Excel y PowerPoint
(`.docx`, `.xlsx`, `.pptx`) escritos a mano en OOXML y empaquetados con un
escritor ZIP propio. **No hay ninguna dependencia npm nueva**: solo
`node:zlib`, `node:crypto`, `node:fs`, `node:http` y `fetch` global de Node 24.

Los archivos se guardan en `DATA_DIR/docs` (por defecto `data/docs`), nunca en
`public/` ni en el repositorio. El nombre físico es siempre `<id>.<ext>`; el
nombre visible se envía solo en `Content-Disposition`, de modo que un título no
puede escapar del directorio.

---

## 1. Arquitectura

| Archivo | Responsabilidad |
|---|---|
| `lib/docs/zip.mjs` | Escritor/lector ZIP: CRC32, almacenado y deflate (`node:zlib`), nombres UTF-8, cabeceras locales, directorio central, EOCD. Rechaza rutas con `..`, nombres absolutos y duplicados. |
| `lib/docs/xmlcheck.mjs` | Verificador de XML bien formado: declaración, anidamiento, atributos entre comillas, entidades, CDATA, comentarios, prefijos de espacio de nombres declarados y un único raíz. |
| `lib/docs/ooxml.mjs` | Helpers OOXML: escape XML, `[Content_Types].xml`, `.rels`, `docProps`, marca, fechas, serial de Excel, nombres seguros, `Content-Disposition` y `validateOoxmlPackage` (tipos de contenido, relaciones resolubles, partes obligatorias). |
| `lib/docs/docx.mjs` | WordprocessingML: estilos Título 1/2, Normal, Cita y lista; negrita/cursiva; listas numeradas y con viñetas; tablas con encabezado; saltos de página; encabezado y pie; márgenes; anexo privado. |
| `lib/docs/xlsx.mjs` | SpreadsheetML: varias hojas, cabecera con estilo y congelada, tipos texto/número/fecha/moneda/porcentaje/booleano, fórmulas SUM/AVERAGE/IF con valor en caché, anchos de columna y autofiltro. |
| `lib/docs/pptx.mjs` | PresentationML 16:9: portada, título y contenido con viñetas, tablas, notas del orador, numeración, tema corporativo sobrio, patrón y patrón de notas. |
| `lib/docs/schema.mjs` | Validación/normalización de payloads y límites. Devuelve errores 400 con `field`. |
| `lib/docs/templates.mjs` | Plantillas de marca (`DATA_DIR/docs/templates.json`) y plantilla integrada `acta`. |
| `lib/docs/documents.mjs` | Índice y almacén `DATA_DIR/docs/index.json` + archivos, escrituras atómicas y bloqueo lógico. |
| `lib/docs/index.mjs` | Fachada estable: `createDocument`, `renderDocument`, `readDocument`, `getDocument`, `listDocuments`, `emailDocument`, plantillas. |
| `lib/docs/email.mjs` | MIME `multipart/mixed` con adjunto y envío por Gmail API. |
| `lib/docs/selfcheck.mjs` | Autocomprobación PASS/FAIL de todo lo anterior, incluido un e2e HTTP real. |
| `lib/routes/docs.mjs` | Rutas `/api/docs` (auto-descubiertas por el router). |

Los módulos se montan por auto-descubrimiento en `lib/routes/*.mjs`; no se ha
modificado `server.mjs`.

### 1.1 Contrato para otros módulos (canales, workflows, agente)

`lib/docs/index.mjs` es la fachada estable. Para resolver un `docId` a bytes:

```js
import { readDocument, getDocument, listDocuments, DOC_TYPES } from './lib/docs/index.mjs';

const { id, type, title, filename, mimeType, bytes, buffer } = readDocument(docId);
// buffer: Buffer con el DOCX/XLSX/PPTX real
// filename: nombre visible (apto para Content-Disposition)
// mimeType: application/vnd.openxmlformats-officedocument.…

getDocument(docId);   // metadata pública o null (sin leer el archivo)
listDocuments();      // { items:[metadata], count, total }
DOC_TYPES[type];      // { extension, mime, label }
```

`readDocument` lanza `404 DOC_NOT_FOUND` si el id no existe y `404
DOC_FILE_MISSING` si el índice apunta a un archivo que ya no está. El binario
también se puede obtener por `GET /api/docs/:id/download`. No leas ni escribas
`DATA_DIR/docs` directamente: usa el barrel para respetar el índice y los
bloqueos de escritura.

---

## 2. API

Todas las rutas viven bajo `/api/docs`. Usan el contrato general de la app:

- Autenticación: la misma que el resto de la API. En modo local (`HOST` loopback
  y `APP_AUTH` off) no hay login; con `HOST≠loopback` o `APP_AUTH=on` exige
  cookie de sesión.
- `Cache-Control: no-store`, cabeceras de seguridad globales y `X-Request-Id`.
- Cuerpo JSON máximo **1 000 000 bytes** (por encima, `413 PAYLOAD_TOO_LARGE`).
- Errores con la forma `{error, code, field?, details?, requestId}`.
- Listas con `{items, count, total}`; los objetos puntuales con `{item}`.

### 2.1 `POST /api/docs`

Crea un documento. Por defecto lo registra en `data/docs` y responde `201`.

```jsonc
{
  "type": "docx",                 // obligatorio: docx | xlsx | pptx
  "title": "Acta de reunión",     // obligatorio, 1–200 caracteres
  "register": true,               // opcional; false = solo inline (base64)
  "template": "acta",             // opcional: plantilla de marca o "acta"
  "date": "2026-10-28",           // opcional; ISO-8601 o YYYY-MM-DD real
  "author": "Ana Torres",         // opcional, 80
  "subject": "Comité",            // opcional, 300
  "brand": {                      // opcional: sobrescribe la marca/plantilla
    "font": "Calibri",
    "color": "#1F3864",
    "accent": "#2E74B5",
    "logoText": "Mi empresa",
    "signature": "Firma autorizada",
    "footerText": "Confidencial"
  },
  "sections": [ /* solo docx, ver 3.1 */ ],
  "annex": { /* solo docx, opcional */ },
  "margins": { "top": 1440, "right": 1440, "bottom": 1440, "left": 1440 }
}
```

Respuesta `201`:

```json
{
  "id": "DOC-20261028-6f6a632d",
  "type": "docx",
  "title": "Acta de reunión",
  "filename": "acta-de-reunion-2026-10-28.docx",
  "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "bytes": 6814,
  "sha256": "…",
  "createdAt": "2026-10-28T15:00:00.000Z",
  "template": "acta",
  "registered": true,
  "downloadUrl": "/api/docs/DOC-20261028-6f6a632d/download"
}
```

Con `"register": false` no se escribe nada en disco ni se toca el índice:
responde `200` con `registered:false`, `id` ausente, `filename`, `bytes`,
`mimeType`, `createdAt` y `base64` (el ZIP completo). Es útil para previsualizar.

### 2.2 `GET /api/docs`

```text
GET /api/docs?type=docx&q=acta&limit=50&offset=0
```

`{items, count, total, limit, offset, stats}` con los metadatos públicos
(`id`, `type`, `title`, `filename`, `mimeType`, `bytes`, `sha256`, `createdAt`,
`template`, `downloadUrl`, `missing?`) y estadísticas del almacén.

### 2.3 `GET /api/docs/:id`

`{item, stats}`. `404 NOT_FOUND` si el id no existe o está mal formado.

### 2.4 `GET|HEAD /api/docs/:id/download`

Devuelve el binario real:

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
Content-Disposition: attachment; filename="acta-de-reunion-2026-10-28.docx"; filename*=UTF-8''acta-de-reunion-2026-10-28.docx
Content-Length: 6814
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

`HEAD` devuelve las mismas cabeceras y `Content-Length`, sin cuerpo. Si el
archivo desapareció del disco: `404 DOC_FILE_MISSING`; si el id no existe:
`404 DOC_NOT_FOUND`.

### 2.5 `DELETE /api/docs/:id`

Elimina el archivo y la entrada del índice:

```json
{ "ok": true, "id": "DOC-20261028-6f6a632d", "removed": true, "removedFile": true, "bytesFreed": 6814, "stats": { "…": "…" } }
```

### 2.6 `POST /api/docs/:id/send-email`

Envía el documento como **adjunto MIME real** por Gmail. Ver §6.

### 2.7 Plantillas

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/docs/templates` | Lista plantillas integradas y guardadas (`{items,count,total}`). |
| `POST` | `/api/docs/templates` | Crea/actualiza una plantilla de marca (`201` si es nueva, `200` si actualiza). |
| `DELETE` | `/api/docs/templates/:name` | Elimina una plantilla guardada. |

```jsonc
{
  "name": "Marca Comité",              // se normaliza a minúsculas y guiones: marca-comite
  "type": "docx",                      // docx | xlsx | pptx | any
  "brand": {
    "font": "Georgia",
    "color": "#8B0000",
    "accent": "#B03A2E",
    "logoText": "Comité de producto",
    "signature": "Secretaría del comité",
    "footerText": "Uso interno"
  },
  "description": "Marca para actas y reportes"
}
```

- La plantilla `acta` es **integrada** y no se puede sobrescribir ni eliminar
  (`409 TEMPLATE_RESERVED`).
- Máximo 30 plantillas guardadas (`409 TEMPLATE_LIMIT`).
- Se aplica en la generación con `"template": "nombre"`. La marca inline
  (`brand`) sobrescribe los valores de la plantilla.
- Si la plantilla no existe: `404 TEMPLATE_NOT_FOUND`; si su `type` no coincide
  con el documento: `400 TEMPLATE_TYPE_MISMATCH`.
- La marca se aplica a: fuente y colores de estilos/cabeceras, logotipo textual
  en encabezado y pie, firma al final del documento (DOCX), relleno de
  cabeceras y pestañas (XLSX), tema/títulos/pie (PPTX).

### 2.8 Códigos de error propios

| Código | HTTP | Cuándo |
|---|---|---|
| `VALIDATION` | 400 | Campo inválido; incluye `field`. |
| `INVALID_DATE` | 400 | Fecha imposible o mal formada (`2026-02-31`). |
| `DOC_NOT_FOUND` | 404 | El id no existe. |
| `DOC_FILE_MISSING` | 404 | El índice apunta a un archivo que ya no está. |
| `DOC_TOO_LARGE` | 413 | Documento > 12 MB. |
| `DOC_LIMIT` | 409 | Más de 200 documentos. |
| `DOC_STORAGE_LIMIT` | 409 | Más de 96 MB en total. |
| `TEMPLATE_NOT_FOUND` | 404 | Plantilla inexistente. |
| `TEMPLATE_RESERVED` | 409 | Intentar modificar/borrar `acta`. |
| `TEMPLATE_TYPE_MISMATCH` | 400 | Plantilla de otro tipo. |
| `TEMPLATE_LIMIT` | 409 | Más de 30 plantillas. |
| `EMAIL_NOT_CONFIGURED` | 503 | Gmail no conectado / sin permiso / sin credenciales OAuth. |
| `EMAIL_CONNECTION_NOT_FOUND` | 404 | `connectionId` inexistente. |
| `EMAIL_SEND_FAILED` | 502 | Gmail rechazó el envío o falló la red; el archivo sigue descargable. |

---

## 3. Esquema DOCX

### 3.1 Bloques de `sections`

| Bloque | Forma | Notas |
|---|---|---|
| Título 1/2 | `{"heading":"Texto","level":1}` o `{"h1":"…"}`, `{"h2":"…"}` | Estilos `Título 1` / `Título 2` con color de marca y nivel de esquema. |
| Párrafo | `{"paragraph":"Texto"}` o `{"p":"…"}` | Estilo Normal. Marcado inline abajo. |
| Cita | `{"quote":"Texto"}` o `{"paragraph":"…","style":"Cita"}` | Estilo Cita con borde y fondo suave. |
| Carreras | `{"runs":[{"text":"Hola","bold":true},{"text":" mundo","italic":true}]}` | Control explícito de negrita/cursiva. |
| Lista | `{"list":{"ordered":false,"items":["uno",{"text":"dos","level":1}]}}` | Hasta 200 elementos, 3 niveles. |
| Viñetas / numerada | `{"bullets":["…"]}` / `{"numbered":["…"]}` | Atajos de lista. |
| Tabla | `{"table":{"headers":["A","B"],"rows":[["1","2"]],"widths":[40,60],"caption":"Tabla 1"}}` | Encabezado con fondo de marca, fila repetida, filas alternas, hasta 20 columnas y 500 filas. |
| Salto de página | `{"pageBreak":true}` | Párrafo con `w:br type="page"`. |
| Alineación | `"align":"left|center|right|justify"` | Solo en párrafos. |

Marcado inline en cualquier texto: `**negrita**`, `*cursiva*`, `***ambas***`.

### 3.2 Anexo

```jsonc
"annex": {
  "title": "Anexo privado",
  "private": true,
  "note": "Documento de uso interno",
  "paragraphs": ["Notas que no se distribuyen."],
  "items": ["Punto privado A", "Punto privado B"]
}
```

El anexo **siempre empieza en una página nueva** (salto de página explícito) y,
si `private` no es `false`, muestra «Documento privado — no distribuir.».

### 3.3 Ejemplo DOCX completo

```json
{
  "type": "docx",
  "title": "Informe de validación",
  "subtitle": "Documento de prueba integral",
  "date": "2026-10-28",
  "author": "Ana Torres",
  "reference": "INF-2026-001",
  "template": "marca-comite",
  "sections": [
    { "heading": "Contexto", "level": 1 },
    { "paragraph": "Este párrafo tiene **negrita**, *cursiva* y ***ambas***." },
    { "quote": "Una cita textual breve." },
    { "heading": "Listas", "level": 2 },
    { "list": { "ordered": false, "items": ["Primero", { "text": "Segundo nivel", "level": 1 }] } },
    { "list": { "ordered": true, "items": ["Paso uno", "Paso dos"] } },
    {
      "table": {
        "caption": "Tabla 1. Compromisos",
        "headers": ["Acuerdo", "Responsable", "Fecha"],
        "rows": [["Cerrar bloqueantes", "Ana", "2026-10-30"], ["Publicar", "Luis", "2026-11-01"]]
      }
    },
    { "pageBreak": true },
    { "paragraph": "Contenido después del salto de página." }
  ],
  "annex": {
    "title": "Anexo privado",
    "paragraphs": ["Notas internas que no se distribuyen."]
  }
}
```

### 3.4 Plantilla integrada `acta`

```json
{
  "type": "docx",
  "template": "acta",
  "title": "Reunión de producto",
  "date": "2026-10-28",
  "author": "Ana Torres",
  "attendees": [
    { "name": "Ana Torres", "role": "Producto", "attendance": "Asistió" },
    "Luis Pérez"
  ],
  "agenda": ["Revisar roadmap", "Cerrar bloqueantes"],
  "agreements": [
    { "text": "Publicar el viernes", "owner": "Luis", "due": "2026-10-30", "status": "Pendiente" }
  ],
  "summary": [
    "Línea de resumen uno.",
    "Línea de resumen dos.",
    "Línea de resumen tres.",
    "Línea de resumen cuatro."
  ],
  "annexNotes": ["Nota privada del acta."],
  "body": "Se revisó el estado del producto y los bloqueantes abiertos."
}
```

Compone un acta formal con:

1. Datos de la reunión (tabla asunto/fecha/hora/lugar/modalidad/referencia).
2. Asistentes (tabla nombre/rol/asistencia).
3. Orden del día (lista numerada).
4. Desarrollo (tu `body`, `bodySections` o `sections`; si no hay, texto formal).
5. Acuerdos y compromisos (tabla acuerdo/responsable/fecha/estado).
6. **Resumen ejecutivo con exactamente 4 líneas** (si envías menos, se completan
   con datos del acta; si envías más, se usan las 4 primeras).
7. Firma y anexo privado separado por salto de página.

Campos opcionales del acta: `topic`, `reference`, `time` (`HH:MM`), `location`,
`modality`, `bodySections`, `notasPrivadas`. También acepta `annex` y sus
`paragraphs`/`items` se añaden al anexo privado.

---

## 4. Esquema XLSX

```jsonc
{
  "type": "xlsx",
  "title": "Reporte financiero",
  "currency": "$",
  "author": "Ana Torres",
  "date": "2026-10-28",
  "sheets": [
    {
      "name": "Resumen",
      "columns": [
        { "header": "Concepto", "type": "text", "width": 30 },
        { "header": "Monto", "type": "currency" },
        { "header": "Avance", "type": "percent" },
        { "header": "Fecha", "type": "date" }
      ],
      "rows": [
        ["Consultoría", 1500000, 0.35, "2026-10-01"],
        ["Soporte", 800000, 0.42, "2026-10-05"],
        ["Licencias", 300000, 0.18, "2026-10-09"],
        ["Total", { "formula": "SUM(B2:B4)" }, { "formula": "AVERAGE(C2:C4)" }, null],
        ["Estado", { "formula": "IF(B5>2000000,\"Meta\",\"Revisar\")" }, null, null]
      ],
      "totals": true
    },
    {
      "name": "Detalle",
      "columns": [
        { "header": "Cliente", "type": "text" },
        { "header": "Horas", "type": "number" },
        { "header": "Tarifa", "type": "currency" },
        { "header": "Importe", "type": "currency" }
      ],
      "rows": [
        { "Cliente": "Acme", "Horas": 40, "Tarifa": 50000, "Importe": { "formula": "B2*C2" } },
        { "Cliente": "Globex", "Horas": 25, "Tarifa": 60000, "Importe": { "formula": "B3*C3" } },
        ["Total", { "formula": "SUM(B2:B3)" }, null, { "formula": "SUM(D2:D3)" }]
      ]
    }
  ]
}
```

- **Varias hojas**: 1–12. Nombres saneados (sin `[]:*?/\`, máximo 31, únicos).
- **Encabezado**: fila 1 con negrita, color de marca, bordes y `wrapText`.
- **Congelado**: `state="frozen"` en la fila 1 (`freeze:false` lo desactiva).
- **Tipos**: `text`, `number`, `currency`, `percent`, `date`, `boolean`.
  - Moneda: número sin símbolo en el valor; el formato lo pone (`"$"#,##0.00`).
  - Porcentaje: fracción (`0.35` = 35 %). También acepta `"35%"`.
  - Fecha: `YYYY-MM-DD` o ISO; se guarda como serial de Excel con formato
    `dd/mm/yyyy`.
- **Fórmulas**: `{ "formula": "SUM(B2:B4)" }` (sin `=` o con `=`).
  `SUM`, `AVERAGE`/`PROMEDIO` e `IF` se evalúan para guardar un valor en caché;
  el libro se marca con `fullCalcOnLoad="1"`, de modo que Excel/LibreOffice
  recalculan todo al abrir. Las fórmulas no reconocidas se guardan sin caché y
  Excel las calcula al abrir.
- **Anchos automáticos**: si no se indica `width`, se estima el máximo entre el
  encabezado y el texto que Excel pinta en cada celda (incluido el valor en
  caché de las fórmulas), con margen del **10 % + 2**, clamp **8–60** y mínimos
  por tipo: `currency` **16**, `date` **12**, `percent` **10**, `number` **10**,
  `text` **12**. El formato de moneda es `"$"#,##0.00` (separador de miles y
  2 decimales) y el ancho se calcula con ese mismo texto, de modo que no
  aparece `####`. Un `columns[].width` o `widths[]` explícito **siempre gana**
  (rango admitido 6–80).
- **Filas**: 2 000 como máximo, 30 columnas.
- **`totals:true`**: aplica a la última fila negrita, borde superior y fondo
  suave.
- **`autoFilter:false`** quita el filtro automático del encabezado.

---

## 5. Esquema PPTX

```jsonc
{
  "type": "pptx",
  "title": "Agenda Copilot P95 — Revisión de producto",
  "subtitle": "Comité de producto · 28 de octubre de 2026",
  "date": "2026-10-28",
  "slides": [
    {
      "title": "Contexto",
      "bullets": ["Migrar la demo a una app usable", { "text": "Cerrar bloqueantes P0", "level": 1 }],
      "notes": "Recordar mencionar el alcance del piloto."
    },
    {
      "title": "Métricas clave",
      "table": {
        "headers": ["Métrica", "Valor", "Meta"],
        "rows": [["Índice P95", "92", "≥ 90"], ["Cumplimiento", "87%", "≥ 85%"]]
      },
      "notes": "Datos del último corte semanal."
    },
    {
      "title": "Siguientes pasos",
      "numbered": ["Cerrar autenticación", "Publicar runbook"],
      "notes": "Responsables en el acta."
    }
  ]
}
```

- **Portada**: se antepone automáticamente si la primera diapositiva no es
  `{"layout":"cover"}`. Lleva título, subtítulo, logotipo textual, fecha, barra
  de marca y numeración.
- **16:9**: `12192000 × 6858000 EMU` (`sldSz type="screen16x9"`).
- **Viñetas**: hasta 12 por diapositiva, 3 niveles. `numbered` usa numeración
  automática.
- **Tablas**: hasta 10 columnas y 20 filas de datos, con encabezado de marca,
  filas alternas, bordes y ajuste automático de alto.
- **Notas del orador**: `notes` por diapositiva; se crea un `notesSlide` real
  con su `notesMaster` (visible en la vista de notas de PowerPoint).
- **Numeración**: campo `slidenum` en cada diapositiva.
- **Tema**: colores, fuentes y formato definidos en `ppt/theme/theme1.xml` y
  `theme2.xml` (notas), con la fuente/color de la marca.
- No se puede combinar `bullets`/`numbered` y `table` en la misma diapositiva
  (error 400): usa dos diapositivas.
- `layout`: `cover`, `section`, `content` o `table`; `table` exige `table` y las
  demás exigen viñetas (salvo portada/sección, que pueden ir con subtítulo).

---

## 6. Correo con adjunto

`POST /api/docs/:id/send-email`

```json
{
  "to": ["destino@example.com", "otro@example.com"],
  "subject": "Acta del comité",
  "body": "Adjunto el acta firmada.\nSaludos.",
  "connectionId": "opcional-id-de-conexion-google"
}
```

- Construye un MIME `multipart/mixed` con:
  - texto `text/plain; charset=UTF-8` en base64,
  - adjunto con el `Content-Type` real del documento, `Content-Disposition:
    attachment` y `filename*` RFC 5987.
- Resuelve la cuenta así:
  1. `connectionId` de una conexión Google con permiso `gmail.send` (o
     `gmail.modify` / `mail.google.com`);
  2. si no se indica, la primera conexión Google con permiso de envío;
  3. `connectionId: "email"` fuerza el token del canal de correo
     (`channelState.channels.email.token`).
- Refresca el token con `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` si está
  caducado y lo vuelve a cifrar en el store.
- **Nunca finge un envío**: Solo responde `200 {sent:true, messageId, …}` si
  Gmail devolvió un `id` real.
- Si no hay Gmail conectado: `503 EMAIL_NOT_CONFIGURED`. Si Gmail rechaza:
  `502 EMAIL_SEND_FAILED`. En ambos casos el documento sigue descargable.
- Devuelve `{sent, transport:"gmail", messageId, threadId, from, to, subject,
  sentAt, connectionId, attachment:{filename,mimeType,bytes},
  document:{id,filename,bytes,downloadUrl}}`.

---

## 7. Límites

| Límite | Valor |
|---|---|
| Cuerpo HTTP | 1 000 000 bytes (413 por encima) |
| Documentos guardados | 200 (`DOC_LIMIT`) |
| Tamaño por documento | 12 MB (`DOC_TOO_LARGE`) |
| Almacenamiento total | 96 MB (`DOC_STORAGE_LIMIT`) |
| Plantillas guardadas | 30 (`TEMPLATE_LIMIT`) |
| DOCX: bloques | 200 por sección; tablas 20 columnas × 500 filas; listas 200; párrafo 8 000 caracteres |
| XLSX: hojas | 12; 2 000 filas; 30 columnas; celda 2 000 caracteres |
| PPTX: diapositivas | 60; 12 viñetas; tabla 10 × 20; notas 8 000 caracteres |
| Acta: asistentes | 50; agenda 30; acuerdos 50; resumen 10 (se usan 4) |

Los nombres de archivo visibles se generan como `slug-del-titulo-YYYY-MM-DD.ext`
(sin acentos, en minúsculas, 70 caracteres de slug). Si ya existe uno igual se
añade un sufijo corto del id.

---

## 8. Abrir y validar

### 8.1 Autocomprobación automática

```bash
cd agenda-copilot
node lib/docs/selfcheck.mjs
```

Hace 31 comprobaciones: ZIP/CRC, XML, estructura OPC de los tres formatos,
DOCX con tabla/anexo, acta de 4 líneas, XLSX con fórmulas, formatos y **ancho
automático** (moneda 1e9 incluida), PPTX con notas y numeración, almacén
temporal, API HTTP real (crear/listar/descargar/borrar, validaciones 400,
plantillas, 503 de correo) y MIME con adjunto.

Usa un `DATA_DIR` temporal y un puerto efímero de loopback (> 3124); **no toca
`data/` real ni reinicia la app del puerto 3000**. Salida esperada:

```text
RESULT: PASS (31/31 comprobaciones)
```

Con `--keep` conserva las muestras y el `DATA_DIR` temporal e imprime la ruta:

```bash
node lib/docs/selfcheck.mjs --keep
# Muestras conservadas en: …/muestras/{informe.docx,acta.docx,reporte.xlsx,anchos.xlsx,http-reporte.xlsx,presentacion.pptx}
```

### 8.2 Verificación manual con Microsoft Office (ejecutada)

Con Office instalado se abrieron las muestras generadas con las aplicaciones
reales, sin diálogos de reparación:

```powershell
# Word
$word = New-Object -ComObject Word.Application
$word.Visible = $false; $word.DisplayAlerts = 0
$doc = $word.Documents.Open('…\muestras\informe.docx', [ref]$false, [ref]$true)
$doc.Content.Text.Contains('Informe de validación')   # True
$doc.Tables.Count                                     # 1
$doc.ComputeStatistics(2)                             # 3 páginas
$doc.Sections.Item(1).Headers.Item(1).Range.Text      # incluye "Marca de prueba" y la fecha
$doc.Sections.Item(1).Footers.Item(1).Range.Text      # "Página 1 de 3"
$doc.Close([ref]$false); $word.Quit()

# Excel
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open('…\muestras\reporte.xlsx', 0, $true)
$wb.Worksheets.Count                                  # 2
$wb.Worksheets.Item(1).Range('B5').Formula            # =SUM(B2:B4)
$wb.Worksheets.Item(1).Range('B5').Value2            # 2600000
$wb.Worksheets.Item(1).Range('C5').NumberFormat      # 0,00 %
$excel.ActiveWindow.FreezePanes                       # True
$wb.Close($false); $excel.Quit()

# PowerPoint
$ppt = New-Object -ComObject PowerPoint.Application
$ppt.Visible = -1
$pres = $ppt.Presentations.Open('…\muestras\presentacion.pptx', -1, 0, 0)
$pres.Slides.Count                                    # 4 (portada + 3)
$pres.PageSetup.SlideWidth                            # 960 pt (16:9)
$pres.Slides.Item(3).Shapes | Where-Object { $_.HasTable -eq -1 }  # tabla
$pres.Slides.Item(2).NotesPage.Shapes.Placeholders | ForEach-Object { $_.TextFrame.TextRange.Text }
$pres.Close(); $ppt.Quit()
```

Resultado obtenido en el entorno de entrega (Office 16.0, Windows):

| Archivo | Aplicación | Resultado |
|---|---|---|
| `informe.docx` | Word 16.0 | Abre sin reparar; 1 tabla, 3 páginas, encabezado/pie y anexo correctos. |
| `acta.docx` | Word 16.0 | Abre sin reparar; 3 tablas, 3 páginas, anexo privado y resumen de 4 líneas. |
| `reporte.xlsx` | Excel 16.0 | Abre sin reparar; 2 hojas, `SUM`/`AVERAGE`/`IF` calculadas, moneda/porcentaje/fecha y encabezado congelado. |
| `anchos.xlsx` | Excel 16.0 | Abre sin reparar; **0 celdas en `####`**; moneda 1.000.000, 2.600.000 y 1.000.000.000 visibles, total `$1.003.600.000,00`; anchos XML 12/21/13/10/25/9/16/10. |
| `http-reporte.xlsx` | Excel 16.0 | Descargado con `GET /api/docs/:id/download` y abierto sin reparar; **0 celdas en `####`**; total `$1.003.600.000,00` visible. |
| `presentacion.pptx` | PowerPoint 16.0 | Abre sin reparar; 4 diapositivas 16:9, tabla, notas del orador y numeración. |

Verificación específica de anchos (`t26`, Excel 16.0 COM): se recorrió
`Range.Text` de las filas de datos de `reporte.xlsx`, `anchos.xlsx` y
`http-reporte.xlsx`; **ninguna celda currency/date mostró `####`**. El ancho XML
de la columna monetaria es 17 en `reporte.xlsx` y 21 en las columnas con 1e9
(`ColumnWidth` efectivo 16,22 y 20,22 respectivamente), suficiente para
`$1.000.000.000,00` y `$1.003.600.000,00`.

Además, los archivos de muestra se validaron contra el esquema OOXML con el
Open XML SDK (Office 2019): **0 errores de esquema**, incluidos `anchos.xlsx` y
`http-reporte.xlsx`.

### 8.3 Validación XML independiente (sin Office)

El selfcheck valida las partes con un parser propio. Para una segunda opinión
con .NET, sin abrir Office:

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('…\informe.docx')
foreach ($entry in $zip.Entries) {
  if ($entry.FullName -match '\.(xml|rels)$') {
    $xml = New-Object System.Xml.XmlDocument
    $xml.Load($entry.Open())   # lanza excepción si no es XML bien formado
  }
}
$zip.Dispose()
```

También sirve `validateOoxmlPackage` desde Node:

```js
import { readZip } from './lib/docs/zip.mjs';
import { validateOoxmlPackage } from './lib/docs/ooxml.mjs';
import fs from 'node:fs';
const archive = readZip(fs.readFileSync('informe.docx'));
const result = validateOoxmlPackage(archive, { requiredParts: ['word/document.xml'] });
console.log(result.ok, result.errors);
```

### 8.4 Si Word/Office no está instalado

La autocomprobación y `validateOoxmlPackage` son suficientes para garantizar
que el paquete es un OOXML válido y que todas las partes XML son bien formadas.
La verificación con Office solo añade la confirmación de que la aplicación
concreta no muestra diálogos de reparación.

---

## 9. Seguridad

- **Sin dependencias npm**: no hay `node_modules` nuevos.
- **Sin rutas controladas por el usuario**: el nombre en disco es `<id>.<ext>`
  con id generado (`DOC-AAAAMMDD-xxxxxxxx`); el título solo se usa para el
  nombre visible, saneado (`slugify`) y en `Content-Disposition`.
- **Fuera de `public/`**: nada generado se sirve como estático. La descarga pasa
  por la ruta autenticada.
- **Fuera de git**: `DATA_DIR/docs` es datos de ejecución; añade `data/docs/` a
  `.gitignore` si el repositorio versiona el directorio `data/`. Los archivos
  generados nunca se sirven desde `public/` ni se incluyen en el paquete de la
  aplicación.
- **CSRF/Origin**: las rutas POST/DELETE usan el check de `Origin` global de la
  app (no son webhooks).
- **Correo**: nunca se registra el token; el MIME no incluye credenciales. Si no
  hay conexión, error explícito 503.
- **Redacción**: los errores pasan por la redacción global de secretos.

---

## 10. Solución de problemas

| Síntoma | Causa / solución |
|---|---|
| `400 VALIDATION` con `field:"sections"` | Falta contenido o un bloque no tiene una clave reconocida. Revisa §3.1. |
| `400 INVALID_DATE` | Fecha imposible (`2026-02-31`) o formato no ISO. Usa `YYYY-MM-DD`. |
| `404 TEMPLATE_NOT_FOUND` | El nombre no existe. `GET /api/docs/templates` para ver los disponibles. |
| `400 TEMPLATE_TYPE_MISMATCH` | La plantilla es de otro tipo; usa una `any` o la correcta. |
| `409 DOC_LIMIT` / `DOC_STORAGE_LIMIT` | Borra documentos antiguos con `DELETE /api/docs/:id`. |
| `503 EMAIL_NOT_CONFIGURED` | Conecta Gmail (`/api/channels/email/oauth/start` o Google con `gmail.send`) o configura `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. |
| `502 EMAIL_SEND_FAILED` | Gmail rechazó el envío; revisa `details.status` y la conexión. El documento sigue descargable. |
| Office muestra «reparar» | No debería ocurrir: pasa `selfcheck` y `validateOoxmlPackage`; si persiste, adjunta el `id` y el XML señalado. |
| La descarga da 404 pero el listado lo muestra | El archivo se borró del disco: `DOC_FILE_MISSING`; vuelve a generarlo. |

---

## 11. Ejemplos rápidos con `curl.exe` (Windows)

```powershell
# Crear un acta
$body = @{
  type = 'docx'; template = 'acta'; title = 'Reunión de producto'
  date = '2026-10-28'; attendees = @('Ana Torres','Luis Pérez')
  agenda = @('Roadmap','Bloqueantes')
  agreements = @(@{ text = 'Publicar el viernes'; owner = 'Luis'; due = '2026-10-30' })
  summary = @('Línea uno.','Línea dos.','Línea tres.','Línea cuatro.')
} | ConvertTo-Json -Depth 6
$created = curl.exe -s -X POST http://127.0.0.1:3000/api/docs -H "Content-Type: application/json" --data-binary $body | ConvertFrom-Json
$created | Format-List id, filename, bytes

# Descargar
curl.exe -s -D - -o acta.docx "http://127.0.0.1:3000/api/docs/$($created.id)/download"

# Listar y borrar
curl.exe -s http://127.0.0.1:3000/api/docs
curl.exe -s -X DELETE "http://127.0.0.1:3000/api/docs/$($created.id)"

# Plantilla de marca
curl.exe -s -X POST http://127.0.0.1:3000/api/docs/templates -H "Content-Type: application/json" --data-binary '{"name":"Marca Comité","type":"docx","brand":{"font":"Georgia","color":"#8B0000","logoText":"Comité"}}'
```

En modo sesión (`HOST≠loopback`), añade la cookie `ac_sid` obtenida en
`POST /api/auth/login`.

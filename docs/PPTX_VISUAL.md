# PPTX visual — presets, portada abstracta y contrato del Estudio

Este documento describe la capa visual del generador PPTX de Agenda Copilot
P95. No usa APIs de diseño externas ni activos propietarios: los cuatro presets
cambian de verdad la paleta, la tipografía, la composición de la portada y la
estructura de las secciones, y la portada incorpora un PNG abstracto generado
localmente.

- Generador: [`lib/docs/pptx.mjs`](../lib/docs/pptx.mjs)
- Presets y arte: [`lib/studio/visuals.mjs`](../lib/studio/visuals.mjs)
- Integración del Estudio: [`lib/studio/presentation.mjs`](../lib/studio/presentation.mjs)
- Capacidad del contrato: `POST /api/docs` con `type:"pptx"` y `preset`.

El PPTX sigue siendo 16:9 (`12192000 × 6858000` EMU), con notas del orador,
tablas, numeración y los mismos límites de seguridad (`60` diapositivas, `12`
viñetas, tablas `10×20`). Sin `preset`, el resultado conserva el diseño clásico
anterior y no incluye imágenes.

---

## 1. Presets

Identificadores internos (sin tilde): `ejecutivo`, `creativo`, `datos`,
`academico`. Se aceptan alias como `académico`, `data`, `kpi`, `creative`,
`academic` o `executive`; un valor desconocido no rompe la generación: se genera
el PPTX sin preset visual.

| id | Etiqueta | Tipografía (título / cuerpo) | Paleta principal | Portada | Sección |
|---|---|---|---|---|---|
| `ejecutivo` | Ejecutivo | Calibri Light / Calibri | azul marino `#1F3864`, azul `#2E74B5` | barra lateral fina, antetítulo «INFORME EJECUTIVO», regla corta | barra lateral, antetítulo de sección y regla |
| `creativo` | Creativo | Trebuchet MS / Calibri | naranja `#C2410C`, verde azulado `#0F766E`, amarillo `#EAB308` | arte orgánico a sangre, bloque de antetítulo y barra verde | bloque naranja a la derecha, número gigante en blanco |
| `datos` | Datos y KPIs | Consolas / Segoe UI | azul petróleo `#0B3B4A`, ámbar `#E0A100` | arte oscuro con rejilla y curva, chips «EVIDENCIA / DECISIÓN / IMPACTO» | rejilla horizontal, número grande y etiqueta «SECCIÓN / DATOS» |
| `academico` | Académico | Georgia / Cambria | burdeos `#6B1D2A`, oro `#B08D3F` | arte de arcos, reglas dobles, composición centrada | numeral romano, reglas dobles y composición centrada |

Cada preset aplica además su `palette` al tema OOXML (`ppt/theme/theme1.xml` y
`theme2.xml` para notas), sus fuentes al `fontScheme` y sus colores a las
tramas, títulos, reglas y tablas. Las diapositivas de contenido cambian de
tipografía y color con el preset, aunque mantienen la estructura de contenido
para no romper el guion.

### Precedencia de marca

1. Si el payload **no** envía `brand`, el preset decide tipografía/paleta.
2. Si el payload envía `brand` explícito, la marca manda en tipografía, color
   primario y acento; el preset conserva la composición y el arte de portada.
3. `logoText`, firma, pie y creador se conservan de la marca base.

El schema ([`lib/docs/schema.mjs`](../lib/docs/schema.mjs)) transporta
`preset` y `brandExplicit` hasta el generador.

---

## 2. Portada abstracta (PNG local)

`lib/studio/visuals.mjs` pinta un PNG RGBA de `1280 × 720` con Node puro:

- `node:zlib` para comprimir los scanlines (`deflate`).
- CRC32 reutilizado de [`lib/docs/zip.mjs`](../lib/docs/zip.mjs).
- Cuatro estilos de arte deterministas: `waves`, `blobs`, `grid`, `arcs`.
- Sin red, sin fuentes externas, sin imágenes de terceros y sin `Math.random`:
  dos ejecuciones con el mismo preset producen el mismo PNG.

### Partes que se añaden al PPTX cuando hay preset

```text
[Content_Types].xml                    ← Default Extension="png" ContentType="image/png"
ppt/media/cover-<preset>.png           ← PNG real 1280×720
ppt/slides/slide1.xml                  ← <p:pic> a sangre completa
ppt/slides/_rels/slide1.xml.rels       ← Relationship Id="rId3" Type="…/image"
                                       Target="../media/cover-<preset>.png"
```

El `p:pic` ocupa toda la diapositiva (`0,0` a `12192000×6858000`) y queda
detrás del texto. El PNG se genera una vez por presentación y se reutiliza; no
hay partes huérfanas porque el paquete se construye completo en cada render.
Cuando no hay preset no se escribe `ppt/media`, no se declara `png` y no se
añade la relación de imagen: el PPTX clásico queda byte a byte en su estructura
anterior (los `rId` de layout y notas no cambian).

### Limpieza

- `pptxParts()` construye las partes desde cero para cada render; no recicla
  ZIPs ni deja medios antiguos.
- El medio solo se añade si `preset` resuelve y hay portada (el generador
  garantiza portada con `normalizeSlides`).
- Si un `preset` no existe, `resolvePreset()` devuelve `null` y no se añade
  imagen ni relación.

---

## 3. Uso desde la API

`POST /api/docs`:

```json
{
  "type": "pptx",
  "title": "Plan trimestral",
  "subtitle": "Comité de producto · 30 de octubre de 2026",
  "preset": "datos",
  "date": "2026-10-30",
  "slides": [
    { "layout": "cover", "title": "Plan trimestral", "subtitle": "Decisiones y hoja de ruta" },
    { "layout": "section", "title": "Contexto", "subtitle": "Dónde estamos" },
    { "title": "El reto", "bullets": ["Tres frentes abiertos", "Una decisión por frente"], "notes": "Explicar el contexto." },
    { "title": "Hoja de ruta", "table": { "headers": ["Fase", "Entregable"], "rows": [["1. Diagnóstico", "Línea base"]] } }
  ]
}
```

`preset` solo se aplica a `pptx`; en DOCX/XLSX se ignora. Los alias con tilde
(`académico`) se normalizan. No es obligatorio enviar `layout:"cover"` en la
primera diapositiva: el generador la antepone para que el arte tenga siempre
dónde ir y la portada sea la primera.

### Estudio de presentaciones

El formulario del Estudio envía `style` con uno de los cuatro valores del
selector (`ejecutivo`, `creativo`, `datos`, `académico`). `presentation.mjs`:

1. normaliza el valor a un preset;
2. pide al LLM un guion con tono/composición del preset (o usa el fallback
   determinista si no hay proveedor);
3. garantiza una portada explícita en el guion (para que la vista previa tenga
   el mismo número de diapositivas que el PPTX);
4. llama a `createDocument({type:'pptx', preset, slides})`;
5. devuelve `preset`, `visual`, `preview` y `slides` con metadatos visuales.

La cola del Estudio (t49) reenvía al artefacto del job:

```json
{
  "kind": "presentation",
  "preset": "datos",
  "visual": { "id": "datos", "label": "Datos y KPIs", "palette": {}, "fonts": {}, "cover": {}, "section": {}, "art": {} },
  "preview": {
    "kind": "pptx-cover",
    "preset": "datos",
    "label": "Datos y KPIs",
    "width": 320,
    "height": 180,
    "mimeType": "image/png",
    "dataUrl": "data:image/png;base64,…",
    "palette": {},
    "fonts": {},
    "title": "Plan trimestral",
    "subtitle": "Decisiones y hoja de ruta"
  },
  "slides": [{ "layout": "cover", "title": "…", "preset": "datos", "visual": {} }],
  "docId": "DOC-…",
  "filename": "plan-trimestral-2026-10-30.pptx",
  "downloadUrl": "/api/docs/DOC-…/download"
}
```

`preview.dataUrl` es una miniatura de 320×180 coherente con la portada, no el
PNG completo; el PPTX lleva el arte a 1280×720. La vista previa del frontend
sigue usando `slides` (no se modificó `public/` en esta tarea); el campo
`preview` queda disponible para una futura miniatura.

---

## 4. Compatibilidad

| Elemento | Comportamiento |
|---|---|
| PPTX sin `preset` | Diseño clásico anterior, sin `ppt/media` ni `p:pic`; DOCX/XLSX intactos. |
| Notas del orador | Se mantienen (`notesSlide` + `notesMaster`). |
| Tablas | Se mantienen y adoptan el color del preset. |
| 16:9 | Invariante `sldSz` 12192000×6858000. |
| Numeración | Campo `slidenum` en portada, secciones y contenido. |
| Marca explícita | Precede en tipografía/color al preset; el arte sigue el preset. |
| `watermark` | Se sigue añadiendo al final (marcas de agua de ACL). |
| Límites | Los del schema: 60 diapositivas, 12 viñetas, tabla 10×20, notas 8000. |
| Desconocido | Preset no resuelto → PPTX clásico, sin error de generación. |

### Tamaño y limpieza

El PNG de portada ocupa típicamente 70–450 KB según el preset (el creativo es el
más pesado por los degradados). El PPTX completo queda muy por debajo del
límite de 12 MB de documentos. No se guarda ningún PNG fuera del ZIP: el PNG
vive en `DATA_DIR/docs/<DOC-id>.pptx` como parte del paquete OOXML.

---

## 5. Verificación

```bash
cd agenda-copilot
node --check lib/docs/pptx.mjs lib/studio/presentation.mjs lib/studio/visuals.mjs lib/docs/schema.mjs
npm test
```

Prueba de los cuatro presets (script temporal con `DATA_DIR` fuera de `data/`):

```js
import { renderPptx } from './lib/docs/pptx.mjs';
import { readZip } from './lib/docs/zip.mjs';
import { validateOoxmlPackage } from './lib/docs/ooxml.mjs';

for (const preset of ['ejecutivo', 'creativo', 'datos', 'academico']) {
  const buffer = renderPptx({
    preset,
    title: `Prueba ${preset}`,
    slides: [
      { layout: 'cover', title: 'Portada', subtitle: 'Sub' },
      { layout: 'section', title: 'Contexto', subtitle: 'Por qué' },
      { title: 'Contenido', bullets: ['Uno', 'Dos'], notes: 'Nota' },
      { title: 'Tabla', table: { headers: ['A'], rows: [['1']] } }
    ]
  });
  const archive = readZip(buffer);
  const validation = validateOoxmlPackage(archive, {
    requiredParts: ['ppt/slides/slide1.xml', `ppt/media/cover-${preset}.png`]
  });
  console.log(preset, buffer.length, validation.ok, archive.entries.filter((e) => e.name.startsWith('ppt/media/')));
}
```

Comprobaciones mínimas de aceptación:

1. Los cuatro ZIP se descomprimen y `validateOoxmlPackage` da `ok:true`.
2. `ppt/slides/slide1.xml` contiene `<p:pic>` y `r:embed="rId3"`.
3. `ppt/slides/_rels/slide1.xml.rels` contiene una relación `/image` a
   `../media/cover-<preset>.png`.
4. `[Content_Types].xml` declara `Default Extension="png"`.
5. El PNG existe en `ppt/media`, empieza por la firma PNG y su IHDR mide
   1280×720.
6. Los hashes de `theme1.xml`, `slide1.xml`, `slide2.xml` (sección) y del PNG
   son distintos para los cuatro presets.
7. Sin preset, el ZIP no contiene `ppt/media` ni `<p:pic>`.
8. PowerPoint abre los cuatro archivos sin reparaciones (verificado con Excel/
   PowerPoint COM en el entorno de entrega).

---

## 6. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| La portada no lleva arte | `preset` desconocido o PPTX generado sin preset | Usa uno de los cuatro IDs; el fallback sin preset es intencional. |
| El arte no aparece en PowerPoint | Falta `Default Extension="png"` o la relación de imagen | Regenera; `validateOoxmlPackage` detecta relaciones huérfanas. |
| El título queda sobre una zona oscura | Preset `datos` y texto de marca oscuro | Usa `brand` solo si controlas el contraste; el preset ya usa texto claro. |
| Una marca explícita cambia de color inesperadamente | `brand` tiene prioridad sobre el preset | Omite `brand` para respetar la paleta del preset. |
| `preview` no aparece en el job | La cola no reenvía `generated.preview` | El contrato de `presentation.mjs` lo expone; la integración de jobs debe reenviarlo (t49). |
| DOCX/XLSX afectados | No debería ocurrir | El preset solo se aplica a `pptx`; los generadores DOCX/XLSX no importan `visuals`. |

---

## 7. Archivos implicados

| Archivo | Cambio |
|---|---|
| `lib/studio/visuals.mjs` | Nuevo: catálogo de presets, PNG local (`zlib` + CRC32), preview y resumen. |
| `lib/docs/pptx.mjs` | Presets en tema, layouts, portada, secciones, contenido; `p:pic` y relaciones de imagen. |
| `lib/docs/schema.mjs` | Transporta `preset` y `brandExplicit` para PPTX. |
| `lib/studio/presentation.mjs` | Mapea `style` a preset, garantiza portada, devuelve `preset`/`visual`/`preview`/`slides`. |
| `lib/studio/jobs.mjs` | (t49, fuera de este scope) reenvía `preset`, `preview` y `visual` al artefacto. |

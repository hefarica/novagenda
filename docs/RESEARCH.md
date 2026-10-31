# Research web con fuentes citadas (t25)

La oficina puede consultar páginas HTTP(S) y producir un informe con fuentes
citadas **sin navegador**, **sin dependencias npm** y **sin abrir SSRF**. Todo
funciona en local; Google Distance Matrix no interviene.

- Código: `lib/research/**`
- Rutas: `lib/routes/research.mjs`
- Mock de pruebas: `scripts/mock-web-server.mjs`
- Autochequeo: `node lib/research/selfcheck.mjs`

---

## 1. Por qué no hay buscador por defecto

No se consulta Google/Bing ni se scrapea un buscador. El usuario (o el agente)
aporta **URLs explícitas**, o se conecta un proveedor de búsqueda en una tarea
posterior. Así:

- no dependemos de una API de pago ni de un navegador;
- el informe es auditable: cada afirmación procede de una URL concreta;
- no se amplía la superficie de red de la app sin control.

`GET /api/research/status` devuelve `searchProvider:null` y lo explica.

---

## 2. Fetch seguro (SSRF)

`lib/research/fetchSafe.mjs` aplica capas independientes:

| Capa | Regla |
|---|---|
| Protocolo | Solo `http:` y `https:`. `file:`, `data:`, `gopher:`, `ftp:`… → `UNSUPPORTED_PROTOCOL`. |
| Credenciales | URL con `user:pass@` → `INVALID_URL`. |
| Longitud | URL > 2048 caracteres → `INVALID_URL`. |
| Hostname | `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.*`, `metadata.google.internal`, `instance-data`… → `SSRF_BLOCKED`. |
| IPv4 | `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, multicast y reservadas. |
| IPv6 | `::1`, `::`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, IPv4-mapped (`::ffff:127.0.0.1`, `::ffff:7f00:1`) y 6to4 con IPv4 privada. |
| DNS | Se resuelve el hostname y se comprueban **todas** las direcciones; si una es privada/reservada → `SSRF_BLOCKED`. Error DNS → `DNS_ERROR`. |
| Redirecciones | Manuales, máximo **3**; cada `Location` se revalida con las mismas reglas (protocolo, host, DNS). Una redirección a `127.0.0.1`, `10.x` o `file:` se bloquea. |
| Timeout | **8 s** por petición (`AbortController`). |
| Tamaño | **2 MB** máximo; se comprueba `Content-Length` y se corta el stream si miente. |
| Content-Type | `text/html`, `text/plain`, `text/markdown`, `text/*`, `application/json`, `+json`, `application/xml`, `text/xml`, `+xml`, RSS/Atom. Otros → `UNSUPPORTED_CONTENT_TYPE`. |
| User-Agent | `AgendaCopilot-P95/1.1 (research; local)` identificable. |

La resolución DNS y el transporte HTTP son **inyectables** para tests:
`setResearchDnsResolver(fn)` y `setResearchTransport(fn)`. En producción se usan
`node:dns/promises` y `fetch` global.

> Nota de endurecimiento: se valida DNS antes de cada petición y en cada
> redirección. Para exponer la app a Internet se recomienda además una política
> de egreso (allowlist/proxy) y, si se quiere cerrar el DNS rebinding al 100 %,
> resolver y conectar a la IP validada (pinning). El mock de loopback demuestra
> el bloqueo.

---

## 3. Extracción

`lib/research/extract.mjs` no usa DOM ni navegador:

- **Título**: `<title>`, `og:title`, `twitter:title`, `h1` o nombre del path.
- **Autor**: `meta[name=author]`, `article:author`, `citation_author`.
- **Fecha**: `article:published_time`, `meta[name=date]`, `pubdate`,
  `citation_publication_date`, `<time datetime>`.
- **Idioma**: `<html lang>`, `content-language`, `og:locale`; si falta, detección
  heurística ES/EN.
- **Texto principal**: prefiere `<article>`/`<main>`/`<body>`; elimina
  `script`, `style`, `noscript`, `nav`, `footer`, `header`, `aside`, formularios,
  plantillas, SVG/iframe y comentarios. Convierte bloques a líneas y limpia
  espacios. **Límite 40.000 caracteres**.
- **Enlaces**: `<a href>` resueltos a absolutos (solo http/https, sin
  `javascript:`, `mailto:`, `tel:`, `data:`, `#`), deduplicados, máximo 100.
- **JSON/XML**: se conserva el contenido formateado/limpio y se extrae título.

Respuesta de extracción:

```json
{
  "title": "…", "author": "…", "publishedAt": "…", "language": "es",
  "siteName": "…", "text": "…", "excerpt": "…",
  "links": [{"url": "https://…", "text": "…"}],
  "length": 1234, "wordCount": 210
}
```

---

## 4. Informe y citas

`POST /api/research/report`

```json
{
  "question": "¿Cómo proteger una agenda de investigación?",
  "urls": ["https://ejemplo.com/articulo", "https://ejemplo.org/informe"],
  "maxSources": 5,
  "useLlm": true,
  "attachDocument": true,
  "emailTo": "destino@example.com"
}
```

Respuesta:

```json
{
  "reportId": "RP-…",
  "question": "…",
  "answer": "# Informe… [1] … [2] …",
  "markdown": "# Informe…",
  "citations": [1, 2, 1],
  "citationCount": 3,
  "usedLlm": false,
  "sources": [{"id":"RS-0001","url":"…","title":"…","retrievedAt":"…","excerpt":"…"}],
  "sourceCount": 2,
  "errors": [],
  "document": {"id":"DOC-…","filename":"…docx","downloadUrl":"/api/docs/…/download"},
  "proposal": {"id":"OF-…","level":"N2","status":"pending","channel":"email"},
  "downloadUrl": "/api/research/reports/RP-…/markdown"
}
```

### Sin LLM (siempre disponible)

- Se extraen frases literales de las fuentes (hasta 3).
- La respuesta lleva `[1]`, `[2]`, etc.; `citations` es el orden de aparición
  (puede repetir: `[1,2,1]` para 3 citas con 2 fuentes).
- Sección `## Fuentes` con título, URL y fecha de consulta.
- `usedLlm:false`.

### Con LLM (opcional)

- Usa el perfil `chat` de `lib/llm` (proveedor configurado por t3) con prompt
  que prohíbe inventar y exige `[n]` de fuentes existentes.
- **Validación posterior**: si no hay citas o alguna cita está fuera de rango
  (`[9]` con 2 fuentes), el texto del LLM se descarta y se devuelve el informe
  determinista (`llmError` explica el motivo).
- `usedLlm:true` solo cuando se usó texto real del proveedor.
- Sin proveedor/clave, el LLM devuelve fallback y el informe sigue siendo
  determinista (`usedLlm:false`).

### Persistencia

En `data.research` (creado perezosamente, sin migración):

- `sources`: hasta **200** fuentes; `{id,url,finalUrl,title,author,publishedAt,language,siteName,excerpt,links,contentType,bytes,retrievedAt}`.
- `reports`: hasta **50** informes; `{id,question,answer,markdown,sources,citations,usedLlm,documentId,proposalId,errors,createdAt}`.
- No se guarda el texto completo de las fuentes (solo extracto), para no inflar
  el JSON.

`POST /api/research/fetch` guarda la fuente por defecto; `save:false` evita
persistir. `DELETE /api/research/sources/:id` la elimina.

---

## 5. Integración con la oficina

Si t17 (documentos) está disponible:

- se crea un **DOCX** con la pregunta, el informe y las fuentes;
- se devuelve `document.downloadUrl` (`/api/docs/:id/download`) y el adjunto.

Si además se pasa `emailTo`/`recipients`:

- se crea una **propuesta N2 por correo** (`channel:"email"`, adjunto DOCX) con
  `attachments` y `meta.source="research"`;
- **no se envía automáticamente**: queda pendiente de aprobación humana (N2)
  según la política de la oficina;
- `proposal.level` debe ser `N2` (con adjunto + canal email); si el riesgo
  elevara a N3, se devuelve tal cual y el humano decide.

Si t17/oficina no están disponibles (o falla), el informe sigue teniendo
`markdown` y una descarga:

```http
GET /api/research/reports/:id/markdown
Content-Type: text/markdown; charset=utf-8
Content-Disposition: attachment; filename="informe-RP-….md"
```

---

## 6. Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/research/fetch` | `{url, save?}` → texto extraído + fuente |
| POST | `/api/research/report` | `{question, urls[], maxSources?, useLlm?, attachDocument?, emailTo?}` |
| GET | `/api/research/sources?limit=50` | `{items,count,total}` |
| DELETE | `/api/research/sources/:id` | `{ok,item}` |
| GET | `/api/research/reports?limit=20` | informes persistidos |
| GET | `/api/research/reports/:id` | metadatos del informe |
| GET | `/api/research/reports/:id/markdown` | descarga markdown |
| GET | `/api/research/status` | límites, provider, contadores |

Errores típicos: `400 VALIDATION/INVALID_URL`, `403 SSRF_BLOCKED`,
`413 TOO_LARGE`, `415 UNSUPPORTED_CONTENT_TYPE`, `422 NO_SOURCES`,
`502 DNS_ERROR/TOO_MANY_REDIRECTS/HTTP_ERROR`, `504 TIMEOUT`.

---

## 7. Mock web server y pruebas

```bash
node scripts/mock-web-server.mjs --port 3261
# MOCK_WEB_URL=http://127.0.0.1:3261
```

Páginas: `/`, `/article`, `/json`, `/xml`, `/binary`, `/large`,
`/redirect-ok`, `/redirect-private`, `/redirect-file`, `/redirect-loop`,
`/slow`, `/echo`.

El mock escucha en **127.0.0.1** a propósito: `fetchSafe` debe rechazarlo
(`SSRF_BLOCKED`). Para probar una página “permitida” sin abrir tráfico local:

```js
import { setResearchDnsResolver, setResearchTransport, fetchSafe } from './lib/research/fetchSafe.mjs';
setResearchDnsResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
setResearchTransport(async (url) => new Response('<html>…</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
await fetchSafe('https://research.test/article');
```

Autochequeo (siempre con `DATA_DIR` temporal):

```bash
DATA_DIR=$(mktemp -d) node lib/research/selfcheck.mjs
```

Cubre: bloqueo de loopback/10.x/169.254/::1/file/data/gopher, DNS privado,
redirección privada/file, límite de 2 MB, content-type, extracción limpia,
informe de 2 fuentes con 3 citas, persistencia/borrado, DOCX + propuesta N2 y
las rutas HTTP con contexto falso.

---

## 8. Límites de configuración

Constantes actuales (`RESEARCH_LIMITS` / `REPORT_LIMITS`):

| Límite | Valor |
|---|---|
| Tamaño por descarga | 2 MB |
| Redirecciones | 3 |
| Timeout | 8 s |
| Texto por fuente | 40 000 caracteres |
| Fuentes por informe | 8 (5 por defecto) |
| URLs por informe | 10 |
| Fuentes persistidas | 200 |
| Informes persistidos | 50 |
| Extracto persistido | 1 200 caracteres |

No hay variables de entorno obligatorias. El LLM es opcional y se configura con
el resto de la app (`docs/LLM.md`).

---

## 9. Decisiones y límites conocidos

- No se ejecuta JavaScript de las páginas: se analiza el HTML servido. Una SPA
  sin contenido en el HTML puede devolver poco texto.
- La extracción es heurística; para artículos muy maquetados puede incluir
  algún bloque extra, pero nunca `script/style/nav/footer`.
- El informe determinista cita frases literales; no razona ni infiere. El LLM
  solo redacta con las fuentes y sus citas se validan.
- No se inventan URLs ni fuentes: la lista `## Fuentes` se genera del fetch real.
- La app no usa puerto 3000 para estas pruebas: usa `DATA_DIR` temporal y un
  puerto ≥ 3261.

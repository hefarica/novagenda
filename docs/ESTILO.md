# Estilo propio («como yo») e identidad multicorreo

Este documento cubre dos piezas de Agenda Copilot P95:

1. **Perfil de voz**: aprender cómo escribe Héctor (saludo, ritmo, firma,
   formalidad, muletillas) y redactar borradores que suenen a él, no a una
   máquina.
2. **Identidad multicorreo**: saber que dos o más correos pertenecen a la misma
   persona, con evidencia y confianza, para no escribir dos veces a la misma
   persona ni equivocarse de destinatario.

Todo es **local y determinista** salvo `compose`, que puede pedir **una** mejora
opcional al proveedor LLM configurado. Sin proveedor, `compose` funciona igual.
Sin dependencias npm nuevas.

Archivos:

```
lib/style/features.mjs    análisis de muestras (rasgos)
lib/style/profile.mjs     perfiles por registro + persistencia en el store
lib/style/score.mjs       puntuación 0..1 con explicación (why[])
lib/style/variation.mjs   anti-repetición por contacto/tipo (7 días)
lib/style/compose.mjs     borrador determinista + alternativa LLM opcional
lib/identity/resolve.mjs  grafo de personas con evidencia/confianza
lib/routes/style.mjs      /api/style/*
lib/routes/identity.mjs   /api/identity/*
```

Los datos viven en el store JSON de la app (`DATA_DIR/agenda-data.json`):

```json
{
  "style": {
    "samples": {"colega": [{"text": "...", "at": "..."}]},
    "profiles": {"global": {...}, "colega": {...}},
    "variations": [{"at": "...", "contact": "ana@empresa.com", "type": "apertura", "text": "Hola Ana:"}]
  },
  "identity": {
    "contacts": [{"name": "Andrés Mendoza", "emails": ["andres.m@empresa.com"], "aliases": []}],
    "metadata": [{"name": "...", "emails": ["..."], "source": "importado"}],
    "gmailMessages": [{"from": {"name": "...", "email": "..."}, "to": [{"name": "...", "email": "..."}], "subject": "..."}]
  }
}
```

---

## 1. Importar muestras reales

### Regla de oro

- **Mínimo 10 muestras por registro** para que el perfil del registro se use.
  Si hay menos, se usa el **perfil global** (todas las muestras). Si no hay
  ninguna, un perfil neutro por defecto.
- Registros válidos: `cliente`, `proveedor`, `entidad`, `colega`, `familiar`.
- Las muestras deben ser **correos completos** (saludo, cuerpo, despedida y
  firma), no fragmentos. Mínimo 20 caracteres, máximo 8 000 por muestra.

### Desde Gmail

1. Google Takeout → selecciona **Correo** → exporta `.mbox` (o usa la API de
   Gmail desde un script propio).
2. Abre el `.mbox` con tu cliente y copia el **cuerpo** de 10–20 correos
   representativos por registro (evita newsletters y correos automáticos).
3. Pégalos en el centro de integraciones o envíalos por API (abajo).

### Desde Outlook

1. Archivo → Abrir y exportar → Importar/Exportar → **Exportar a un archivo** →
   valores separados por comas (CSV) con las columnas `Asunto`, `Cuerpo`,
   `Para`, `De`, `Fecha`.
2. Filtra por destinatario/registro y copia la columna `Cuerpo` de 10–20
   correos por registro.

### Vía API

```bash
curl -s -X POST http://127.0.0.1:3000/api/style/samples \
  -H 'content-type: application/json' \
  -d '{
    "register": "colega",
    "samples": [
      "Hola Andrés:\n\nGracias por la propuesta...\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial",
      "Hola Lucía:\n\nTe comparto el detalle...\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial"
    ]
  }'
```

Respuesta: `{ok, register, added, skipped, samples, totalSamples, source, profile}`.
Se recalculan el perfil del registro y el global. Las muestras repetidas se
ignoran (`skipped`). Máximo 50 por petición y 200 por registro (se descartan las
más antiguas).

```bash
curl -s http://127.0.0.1:3000/api/style/profiles
curl -s -X DELETE http://127.0.0.1:3000/api/style/profiles/colega
```

`GET /api/style/profiles` devuelve, por registro: `samples`, `source`
(`register` | `global`) y el perfil (`greeting`, `closing`, `signature`,
`sentenceMean/Std`, `paragraphs`, `formality`, `emojiRate`, `questionRate`,
`bulletRate`, `hedges`, `blacklistHits`).

---

## 2. Qué aprende el perfil

`lib/style/features.mjs` analiza cada muestra sin LLM:

| Rasgo | Cómo se detecta |
|---|---|
| Saludo | primera línea con `Hola/Buen día/Buenos días/Estimado/…`; se guarda plantilla (`Hola {nombre}:`) |
| Despedida | última línea corta tipo `Un abrazo,` / `Saludos,` / `Gracias,` |
| Firma | líneas después de la despedida (nombre, cargo, contacto), hasta 4 |
| Longitud de frase | media y desviación de palabras por frase del cuerpo |
| Párrafos | bloques separados por línea en blanco (sin saludo/despedida/firma) |
| Formalidad | proporción usted (`usted`, `le`, `su`) vs tú (`te`, `tu`, `podemos`) |
| Emojis | pictogramas Unicode por 100 palabras |
| Preguntas | `?` por frase |
| Matices | `quizá`, `me parece`, `podría`, `si te parece`, `cuando puedas`… |
| Viñetas | líneas `-`, `*`, `•` o `1.` |
| Frases delatoras de IA | lista negra: «en el mundo actual», «es importante destacar», «cabe destacar», «no dudes en contactarme», «en resumen», etc. |

El perfil por registro usa la **moda** (saludo/despedida/firma más frecuentes) y
la **media** del resto. Se recalcula en cada lectura a partir de las muestras
guardadas.

---

## 3. Cómo se puntúa (`POST /api/style/score`)

```bash
curl -s -X POST http://127.0.0.1:3000/api/style/score \
  -H 'content-type: application/json' \
  -d '{"register":"colega","text":"Hola Andrés:\n\n...\n\nUn abrazo,\nHéctor Ramírez\nGerente Comercial"}'
```

```json
{"register":"colega","profileSource":"register","score":0.993,
 "why":["firma idéntica a la muestra","saludo igual al perfil", "..."],
 "components":{"signature":1,"greeting":1,"closing":1,"sentence":0.97,...},
 "penalties":{"blacklist":0,"markdown":0,"artificialList":0}}
```

Pesos (suman 1): firma .22 · saludo .14 · despedida .14 · longitud de frase .14
· palabras .05 · párrafos .06 · formalidad .09 · emojis .05 · preguntas .05 ·
viñetas .06.

Penalizaciones: cada **frase delatora** resta 0.25 (tope 0.6), el markdown
resta 0.05 y una lista de viñetas que el perfil no usa anula el componente de
viñetas. Por eso un texto correcto con «en el mundo actual» baja de ~0.99 a
~0.4–0.7.

Si el registro no tiene 10 muestras, puntúa contra el **perfil global**
(`profileSource:"global"`); si no hay ninguna, contra el neutro
(`profileSource:"default"`).

---

## 4. Redactar (`POST /api/style/compose`)

```bash
curl -s -X POST http://127.0.0.1:3000/api/style/compose \
  -H 'content-type: application/json' \
  -d '{
    "register": "colega",
    "intent": "Cerrar el alcance del piloto y revisar el calendario",
    "facts": {"proyecto": "Piloto Andrés", "entrega": "jueves 30"},
    "recipient": {"name": "Andrés M.", "email": "andres.m@empresa.com"},
    "thread": ["Andrés: te paso la propuesta el lunes."],
    "opening": "opcional, fuerza una apertura concreta"
  }'
```

Respuesta:

```json
{
  "draft": "Hola Andrés:\n\n...\n\nUn abrazo,\n\nHéctor Ramírez\nGerente Comercial",
  "score": 0.99,
  "why": ["firma idéntica a la muestra", "saludo igual al perfil", "..."],
  "register": "colega",
  "profileSource": "register",
  "samplesUsed": 3,
  "engine": "deterministic",
  "variation": {"contact": "andres.m@empresa.com", "opening": "Hola Andrés:", "closing": "Un abrazo,", "recorded": [...]}
}
```

Cómo compone:

1. Toma el perfil del registro (o global/default).
2. Elige apertura y cierre que **no se hayan usado con ese contacto en 7 días**
   (`lib/style/variation.mjs`).
3. Genera un borrador determinista con el saludo, ritmo de frase, párrafos,
   formalidad y firma del perfil; aplica `facts` como frases (o viñetas si el
   perfil las usa) y limpia frases delatoras.
4. Si hay proveedor LLM configurado, pide **una** alternativa con **3 muestras
   reales** del registro y prohibiciones explícitas (las mismas frases de la
   lista negra, markdown y listas artificiales). Solo la usa si mejora el score
   y conserva la firma exacta del perfil.
5. Registra apertura/cierre (y «acuse» si la intención lo menciona) en
   `style.variations`.

Sin muestras del registro, usa el global; sin ninguna, el perfil neutro. Nunca
falla por falta de datos.

### 4.1 Lingo en la redacción

Antes de construir el borrador o el prompt, `composeEmail` pasa por el léxico
aprobado de Lingo (`lib/lingo`):

- **Intención** (`intent`): si trae una variante conocida, se usa la forma
  canónica.
- **Hechos** (`facts`): se recorren strings, arrays y valores de objetos; las
  claves y los números no cambian.
- **Destinatario**: se normaliza `recipient.name`; los correos no se tocan.
- **Hilo** (`thread`): se normalizan sus textos para que el contexto no mezcle
  variantes.

Reglas:

1. Solo se aplican términos **approved**; `shadow`/`rejected` no alteran la
   redacción.
2. Si Lingo está vacío o falla, el texto/flujo es **idéntico** al de antes; no
   se inventan correcciones.
3. La firma del perfil no se toca (debe seguir igual a las muestras).
4. Los nombres de archivo de documentos se generan con el título canónico:
   `lib/docs` usa `canonicalDocumentTitle()` antes de `buildFilename`; también
   está disponible `canonicalFilename()` en `lib/style/lingo.mjs` para cualquier
   generador.

Ejemplos:

| Entrada | Salida canónica |
|---|---|
| `lote 12` | `Lote 12` |
| `predio El Retiro` | `Predio El Retiro` |
| `hector fabio riascos` | `Héctor Fabio Riascos C.` |

Si un término no existe en Lingo, el texto se deja tal cual: la redacción no
inventa nombres ni entidades.

---

## 5. Anti-repetición (7 días por contacto y tipo)

- Clave de contacto: email en minúsculas o nombre normalizado.
- Tipos: `apertura`, `cierre`, `acuse`.
- Ventana: **7 días**; persistido en `data.style.variations`.
- Si todas las candidatas están usadas, se sintetiza una variante determinista
  (p. ej. `Hola Andrés, retomo el hilo:`) para no repetir nunca la misma
  fórmula. El resultado indica `variation.openingReplaced` /
  `openingSynthesized` y se añade una línea a `why`.
- `opening` explícito: si ya se usó con ese contacto, se sustituye por la
  siguiente variante libre (se avisa en `why`).

---

## 6. Identidad multicorreo

### Fuentes (locales primero)

1. `data.identity.contacts` (mapeos manuales): peso **0.9**.
2. `data.identity.metadata` (importaciones): peso **0.85**.
3. **Gmail** solo si hay una cuenta conectada: cuenta conectada (0.35) y, si el
   importador dejó `data.identity.gmailMessages`, cabeceras De/Para (0.55).
   Este módulo **no lee cuerpos ni llama a Gmail**.
4. **Agenda**: título «Reunión con …» + `attendees` (0.6 si hay un solo
   attendee), notas con `Nombre <email>` (0.6), attendees sueltos (0.3).
5. **Inbox**: texto con `Nombre <email>` (0.6) y coaparición de 2+ correos con
   un solo nombre (0.35).
6. **Reuniones/rutinas/OKR**: menciones (0.45) y nombres de owner.
7. **Firma** de las muestras de estilo (0.2 nombre; 0.5 si incluye correo).
8. **Dominio** compartido: evidencia débil (0.05), no fusiona por sí sola.

### Confianza

Cada vínculo nombre↔correo aporta peso. La confianza combina
`1 − Π(1 − peso)`; con dos menciones explícitas de 0.6 → **0.84**. Si
`confianza < 0.8` o hay dos personas con confianza parecida, la respuesta marca
`requiresConfirmation: true`.

### Consultas

```bash
curl -s 'http://127.0.0.1:3000/api/identity/people?q=Andr%C3%A9s'
curl -s -X POST http://127.0.0.1:3000/api/identity/resolve \
  -H 'content-type: application/json' -d '{"name":"Andrés M."}'
curl -s -X POST http://127.0.0.1:3000/api/identity/resolve \
  -H 'content-type: application/json' -d '{"email":"a.mendoza@empresa.com"}'
```

```json
{"query":{"name":"Andrés M.","email":null},
 "candidates":[{"name":"Andrés Mendoza",
   "emails":["andres.m@empresa.com","a.mendoza@empresa.com"],
   "confidence":0.848,"requiresConfirmation":false,
   "evidence":[{"type":"agenda_attendee","detail":"AG-0006 «Reunión con Andrés Mendoza»","weight":0.6},
               {"type":"inbox_text","detail":"IN-0002: Andrés Mendoza <a.mendoza@empresa.com>","weight":0.6}]}],
 "requiresConfirmation":false}
```

`Andrés M.` casa con `Andrés Mendoza` porque las iniciales se aceptan como
coincidencia de apellido.

### Multi-destinatario

```bash
curl -s -X POST http://127.0.0.1:3000/api/identity/expand \
  -H 'content-type: application/json' -d '{"query":"Andrés M."}'
```

```json
{"people":[{"name":"Andrés Mendoza","emails":["andres.m@empresa.com","a.mendoza@empresa.com"],"confidence":0.848}],
 "recipients":["andres.m@empresa.com","a.mendoza@empresa.com"],
 "duplicatesRemoved":0,"requiresConfirmation":false}
```

«Envía a Andrés M.» produce sus **dos** correos, deduplicados entre personas. Si
la confianza es baja o hay ambigüedad, `requiresConfirmation:true` y el emisor
debe confirmar antes de enviar.

### Contacto manual

```bash
curl -s -X POST http://127.0.0.1:3000/api/identity/contacts \
  -H 'content-type: application/json' \
  -d '{"name":"Andrés Mendoza","emails":["andres@tercero.com"],"aliases":["Andrés M."],"note":"cuenta personal"}'
```

Se persiste en `data.identity.contacts` con la máxima confianza y aparece en
`people`/`resolve` al instante.

---

## 7. Privacidad y seguridad

- Todo se guarda en el store local (escritura atómica de t1). No hay llamadas de
  red salvo la opción LLM de `compose`.
- `compose` envía al proveedor **solo** la intención, los hechos y 3 muestras
  del registro, nunca secretos ni correos de terceros no relacionados.
- Para un flujo 100 % local: no configures proveedor LLM o usa Ollama local.
- La lista negra y la puntuación son deterministas y auditables (`why[]`).
- La confianza y la evidencia quedan visibles para no enviar a ciegas.

---

## 8. Pruebas rápidas

```bash
# 1) cargar 12 muestras (ejemplo con un archivo samples.json)
curl -s -X POST http://127.0.0.1:3000/api/style/samples \
  -H 'content-type: application/json' \
  -d "{\"register\":\"colega\",\"samples\":$(cat samples.json)}"

# 2) perfiles
curl -s http://127.0.0.1:3000/api/style/profiles

# 3) puntuar
curl -s -X POST http://127.0.0.1:3000/api/style/score \
  -H 'content-type: application/json' -d '{"register":"colega","text":"Hola Andrés: ..."}'

# 4) componer dos veces al mismo contacto y comprobar que cambia la apertura
curl -s -X POST http://127.0.0.1:3000/api/style/compose \
  -H 'content-type: application/json' \
  -d '{"register":"colega","intent":"Cerrar el alcance","recipient":{"name":"Andrés M.","email":"andres@empresa.com"}}'

# 5) identidad
curl -s 'http://127.0.0.1:3000/api/identity/people?q=Andr%C3%A9s'
curl -s -X POST http://127.0.0.1:3000/api/identity/expand \
  -H 'content-type: application/json' -d '{"query":"Andrés M."}'
```

Para pruebas automatizadas usa siempre `DATA_DIR` temporal y un puerto propio
(≥3121); no reinicies la instancia de producción del puerto 3000.

---

## 9. Limitaciones conocidas

- Gmail: este módulo no lista ni descarga mensajes (no amplía scopes de Google).
  Usa la exportación/importación de metadatos (`identity.gmailMessages`) o el
  contacto manual.
- La confianza es una heurística de evidencia local; no sustituye una
  verificación humana cuando `requiresConfirmation` es `true`.
- El perfil de voz aprende de las muestras que le des: si mezclas registros en
  el mismo saco, el perfil global pierde precisión.
- `compose` hace como máximo una llamada LLM por petición (y ninguna si no hay
  proveedor). No hay reintentos masivos.

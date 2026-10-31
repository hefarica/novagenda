# Organización y Estudio

## Qué se integró

- **24 perfiles** del ADN de OrgDNA, organizados en 4 equipos:
  Dirección (4), Ingeniería (10), Calidad y evidencia (7) y Operaciones (3).
- **Jerarquía declarativa** con `reportsTo`, misión, capacidades y herramientas.
- **Edición completa** desde la app: crear/editar/eliminar equipos y agentes.
- **Importación OrgDNA**: acepta el JSON con `agents` y `squads` sin modificar
  la app de 8765.
- **Estudio**: encargos de presentación (PPTX), documento (DOCX) y proyecto de
  código (ZIP), con vista previa del guion y descarga real.
- **Camila** recibe el resumen real de la organización y puede explicar los
  equipos y roles desde cualquier canal.

## Cómo se usa

### Organización

Menú **☰ → Organización**. Allí puede:

1. Crear un equipo con “＋ Equipo”.
2. Crear un agente con “＋ Agente”.
3. Editar capacidades, misión y jefe directo.
4. Importar el JSON de OrgDNA con “Importar OrgDNA”.

Los permisos reales no se conceden por declarar capacidades: toda salida
externa sigue pasando por el gate N0–N3 y la aprobación del Owner.

### Estudio

Menú **☰ → Estudio**.

1. Escriba el brief: objetivo, audiencia, restricciones y entregable.
2. Elija Presentación, Documento o Código.
3. Elija equipo y estilo.
4. Pulse **Generar encargo**.
5. El encargo queda en cola; la UI consulta `GET /api/studio/jobs` hasta que
   esté `done` y entonces muestra/descarga el artefacto.
6. Revise la vista previa y descargue el archivo.

- Presentación: PPTX 16:9 con portada, secciones, contenido, tablas y notas del
  orador. Si el generador devuelve `preset`/`visual`/`preview`, el artefacto los
  conserva.
- Documento: DOCX con secciones ejecutivas.
- Código: ZIP con archivos fuente, README y pruebas; **no se ejecuta** y se
  marca como borrador si el LLM no completó todos los archivos.

## Cola de encargos (t49)

`POST /api/studio/jobs` **no bloquea la petición ni genera el artefacto**:
valida, persiste el encargo en `store.organization.jobs` y responde **202** con
el job en estado `queued`. El worker del proceso lo ejecuta en segundo plano.

Estados:

| estado | significado |
|---|---|
| `queued` | persistido, pendiente de worker |
| `running` | reclamado por el worker y en generación |
| `retrying` | falló un intento; espera `nextAttemptAt` |
| `done` | artefacto generado y guardado |
| `failed` | agotó los 3 intentos (o el worker lo recuperó sin intentos) |

Campos del job: `attempts`, `nextAttemptAt`, `lastError`, `startedAt`,
`finishedAt`, `artifact`, `provider`, `model`, `fallback`.

- **Máximo 3 intentos.** El intento se incrementa al reclamar el job, antes de
  generar.
- **Backoff exponencial acotado** (1 s, 2 s, 4 s… máx. 30 s) en
  `nextAttemptAt`; el worker solo toma jobs cuyo `nextAttemptAt` ya venció.
- **No duplica artefactos:** el job solo pasa a `done` con un artefacto; el
  código escribe una carpeta/ZIP fijo por `job.id`, y las transiciones
  `queued→running→done` están serializadas en el store. Un job no se ejecuta
  dos veces a la vez.
- **Persistencia:** cada transición se espera con `store.mutate` (flush del
  store). Un reinicio conserva `queued`, `retrying`, `running`, `done` y
  `failed`.
- **Recuperación al arrancar:** el worker relee `queued` y convierte `running`
  (proceso interrumpido) en `retrying` con `nextAttemptAt=now`; si ya tenía 3
  intentos, lo marca `failed`. Los `retrying` sin fecha se reprograman.
- **Worker en el proceso:** vive mientras el servidor está encendido (timer
  `unref`, no impide el cierre limpio). No hay daemon externo. Si la app está
  apagada, los jobs `queued` esperan al siguiente arranque. `STUDIO_WORKER=off`
  desactiva el worker (pruebas/scripts que lo controlan a mano).
- **Sin ejecución de código ni shell:** solo llama a los generadores existentes
  (`generatePresentation`, `generateDocument`, `generateCode`). El ZIP es un
  borrador revisable; no se compila, ejecuta ni instala.
- El worker no toca la app de 8765 ni usa credenciales de Genspark.

`GET /api/studio/jobs` devuelve `{items,organization,worker}`; `worker` incluye
`running`, `intervalMs`, `startedAt`, `lastTickAt`, `lastError`, `tickInFlight`.

## Límites actuales

- Genspark Slides bloquea el acceso público sin sesión con HTTP 403. No se
  usaron credenciales de Google ni se accedió a contenido privado. El Estudio es
  una implementación propia basada en el patrón brief → guion → PPTX.
- El código generado no se compila ni ejecuta automáticamente.
- Las cifras que no estén en el brief se marcan como “[dato por confirmar]”.
- La generación usa el LLM configurado; si no está disponible, hay respuesta
  determinista.
- La cola tiene un máximo de 200 jobs retenidos en `organization.jobs`; los más
  antiguos se descartan al superar ese límite (no se borran artefactos de disco
  desde la cola).

## API

```
GET    /api/studio/org
PUT    /api/studio/org
POST   /api/studio/members
DELETE /api/studio/members/:id
POST   /api/studio/teams
DELETE /api/studio/teams/:id
POST   /api/studio/import
GET    /api/studio/jobs              → {items,organization,worker}
POST   /api/studio/jobs              → 202 {ok:true,job,queued:true,worker}
GET    /api/studio/jobs/:id/download
```

Errores de cola/validación: `400 STUDIO_BAD_TYPE`, `400
STUDIO_BRIEF_REQUIRED`, `404 STUDIO_JOB_NOT_FOUND`, `400
STUDIO_NOT_FILE_JOB`, `404 STUDIO_ARTIFACT_MISSING`.

## Verificación

```powershell
node --check lib/studio/jobs.mjs lib/routes/studio.mjs start.mjs scripts/verify-studio-queue.mjs
node scripts/verify-studio-queue.mjs   # cola, done, reintentos, recuperación
npm test
npm run verify:studio                 # UI Organización/Estudio (Chrome)
```

El script de cola usa `DATA_DIR` temporal y puerto ≥3310; nunca usa 3000 ni el
`data/` real. `npm run verify:studio` sigue siendo la verificación de UI; el
worker de la cola se prueba con `scripts/verify-studio-queue.mjs`.

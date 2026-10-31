# Agenda Copilot P95

App web/PWA de agenda inteligente basada en el modelo **Agenda P95 2026** (índice de 7 componentes,
score de prioridad, rutinas con excepciones, métricas diarias, OKR, Google Calendar/Gmail, canales
interactivos y agente LLM opcional). Node 24 nativo, ES modules y **cero dependencias npm**.

## Arranque rápido

```bash
cp .env.example .env      # define APP_SECRET (clave larga y aleatoria)
node start.mjs            # elige puerto libre (3000 o siguiente) y abre el navegador
```

- `npm start` = `node start.mjs`; `npm run dev` recarga al cambiar archivos.
- Windows: `START_WINDOWS.bat` (instala Node si falta) o `powershell -File scripts/setup.ps1`.
- Requisitos: **Node.js 24 LTS+**. No hace falta `npm install`.
- Si el 3000 está ocupado, el lanzador usa el siguiente puerto libre e imprime la URL exacta.
- Cierre limpio con `Ctrl+C`/SIGTERM (flush del journal antes de salir).

## Qué incluye

- **Dashboard P95**: Top 3 por score, ejecución de agenda, foco profundo, vencidas, efectividad, OKR y revisión semanal.
- **Agenda editable**: crear/editar/posponer/completar/cancelar, vista semanal, búsqueda y filtros.
- **Inbox**: captura rápida y conversión a cita validada (nunca agenda a ciegas si Google falla).
- **Rutinas**: frecuencia diaria/laborables/semanal/mensual/trimestral, festivos, excepciones por fecha,
  preview de próximas apariciones y materialización idempotente con backfill.
- **Métricas**: exactamente los 14 campos del modelo + reportes semanal/mensual.
- **Asistente determinista** en español: `HOY`, `CAPTURA`, `HECHO`, `POSPONER`, `FOCO`, `CIERRE`, `SEMANA`, `balance`.
- **Agente LLM opcional**: API OpenAI-compatible (OpenAI, DeepSeek, …) u Ollama local; sin clave, la app
  funciona igual con el parser determinista. Herramientas de agenda con guardarraíles, confirmación de
  acciones destructivas, memoria por canal/usuario, presupuesto y kill-switch.
- **Canales**: simulador local, Telegram (long-polling/webhook), WhatsApp Cloud API (HMAC), correo Gmail
  (entrada/salida) y webhook genérico. Idempotencia por `message.id`/`update_id`.
- **Workflows y señales**: brief, mediodía, cierre, semanal, recordatorios, reconciliación Google, resumen
  nocturno/horario; señales con umbral, ventana y cooldown.
- **Oficina (niveles N0-N3)**: propuestas con riesgo, opiniones rubricadas por rol, gate de aprobación
  (N2 humano, N3 con código de 6 caracteres), ejecución única con ledger SHA-256 auditable y modos
  sombra/asistido/autónomo/total.
- **Aprobaciones por canal**: tarjeta de la Oficina por WhatsApp/Telegram/correo/simulador, respuestas
  `1/ok`, `2/no`, `3/corrige:` con lista blanca de dueños y auditoría de intentos no autorizados.
- **Documentos reales**: DOCX/XLSX/PPTX generados sin dependencias (OOXML + ZIP propios), plantillas de
  marca, descarga y envío como adjunto por los canales.
- **Agenda física**: catálogo de lugares, ETA offline/Google Distance Matrix, planificador con alternativas
  («Cali 16:00 → Palmira 16:30 no es viable»), `travelWarning` en citas, Meet real o sala local y tareas.
- **Estilo propio, identidad y voz**: perfiles por registro, puntuación 0..1 con motivos, variación
  anti-repetición, redacción «como yo» y grafo de personas multicorreo con confianza.
- **Avisos inteligentes**: detección de vencidas/huecos/foco/aprobaciones, priorización, anti-spam con
  cooldown, silencio nocturno, límites por hora/día y feed con descartes.
- **Features con flags (Wave 0)**: 12 capacidades con estados `off/shadow/on`, pausa individual/global,
  kill switch por entorno y auditoría `feature.change`; `/api/features` y resumen en `/api/health`.
- **Lingo (léxico único)**: términos canónicos con variantes, aprendizaje por correcciones y promoción
  automática a las 3, integrado en redacción, títulos, nombres de archivo y herramientas del agente.
- **ACL por etiquetas**: `público`/`interno`/`reservado` con matriz N0-N3, bloqueo reservado→externo sin
  confirmación, N3 forzado al confirmar y auditoría `acl.enforced` en cada envío.
- **Set dorado (60 casos)**: aprobaciones, documentos, agenda/rutinas, estilo/identidad, lingo y ACL en
  `tests/golden/`, con umbrales de no regresión documentados en `RUNBOOK.md` §23.
- **Seguridad**: bóveda AES-256-GCM, sesión HMAC + scrypt, escritura atómica con backups y journal,
  bind por defecto `127.0.0.1`, autenticación obligatoria si `HOST≠loopback` o `APP_AUTH=on`.

## Calidad y verificación

```bash
npm run check        # node --check de todo el código (210 archivos)
npm test             # 73 tests node --test + set dorado 60/60 + autocheques (agenda 35, canales 211,
                     # LLM 32, viajes 35, documentos 31, oficina 53, avisos 18, hilos, MCP, research,
                     # lingo 21, acl 37, features 11) + guardia del dato
node scripts/golden.mjs          # solo el set dorado: 60 casos, resumen por categoría y exit code
npm run smoke        # 17 flujos críticos contra el servidor real en puerto y DATA_DIR temporales
node scripts/check-secrets.mjs   # escaneo de secretos (también en CI)
node scripts/theme-check.mjs --base=<url> --cdp=<chrome-cdp>   # tema claro/oscuro y contraste AA
```

Todas las pruebas usan `DATA_DIR` temporal. La guardia de integridad es **antes/después** (snapshot al
empezar y comparación al terminar): falla si la suite altera el dato real o si aparecen fixtures, y acepta
como actividad legítima los cambios que hace el usuario con la app en marcha. Sin constantes históricas de
hash ni seed. Ver `RUNBOOK.md` §4 y §18.

## Configuración (.env)

```env
PORT=3000
APP_URL=http://localhost:3000
APP_SECRET=clave-larga-aleatoria
DATA_DIR=./data
TIMEZONE=America/Bogota

# Opcionales
GOOGLE_CLIENT_ID=...          # o se guarda cifrado en Integraciones → Google
GOOGLE_CLIENT_SECRET=...
WA_PHONE_NUMBER_ID=...        # WhatsApp Cloud API
WA_ACCESS_TOKEN=...
WA_APP_SECRET=...
TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...            # o provider/baseUrl/model en Integraciones → LLM
OPENAI_MODEL=...
```

Google es **opcional**. Si el proyecto OAuth está en estado *Testing*: añade tu cuenta como **Test user**,
autoriza `http://localhost:3000/api/auth/google/callback` y `http://127.0.0.1:3000/api/auth/google/callback`,
y ten en cuenta que el refresh token caduca a los 7 días (reconecta) o publica la app. Detalle en
`RUNBOOK.md` §6.

## Estructura

```text
server.mjs              servidor HTTP (apagado limpio, sin timers)
start.mjs               lanzador: .env, puerto libre, navegador
lib/agenda/**           motor P95: fechas, score, rutinas, conflictos, eventos, métricas
lib/google.mjs          OAuth, FreeBusy, syncToken, Gmail (transporte inyectable para tests)
lib/llm/**, lib/agent/** proveedores, router por perfiles, agente y herramientas
lib/channel/**          adaptadores de canales + pipeline con dedupe
lib/workflows/**, lib/signals/**  scheduler, workflows, reglas y cooldown
lib/office/**           Oficina N0-N3: propuestas, gate, ledger, ejecutores, roster
lib/docs/**             DOCX/XLSX/PPTX propios (ZIP+OOXML), plantillas y adjuntos
lib/style/**, lib/identity/**     estilo propio, variación y grafo multicorreo
lib/travel/**           lugares, ETA, planificador, Meet y tareas
lib/nudges/**           avisos priorizados con anti-spam y silencio
lib/thread/**, lib/research/**, lib/mcp/**  hilos, investigación y utilidades MCP
lib/features/**         Wave 0: catálogo de flags, shadow, pausas y kill switch
lib/lingo/**            léxico único: términos, variantes, promoción y hotwords
lib/acl/**              etiquetas público/interno/reservado, matriz y guardOutbound
lib/routes/**           API auto-descubierta (19 módulos, 236 rutas)
lib/store.mjs           persistencia atómica, backups, journal, migraciones
public/**               PWA (onboarding, agenda, rutinas, asistente, oficina, docs, estilo, avisos) + tema claro
tests/**, scripts/**    suite node --test, set dorado, smoke, tema y utilidades de operación
docs/                   CONTRATO_API, CANALES, LLM, WORKFLOWS, OFFICE, DOCUMENTOS, VIAJES, AVISOS, ESTILO,
                        FEATURES, LINGO, ACL, CONTRATOS_CONGELADOS, ESQUEMA, MAPA_CAPACIDADES…
```

## Docker

```bash
docker compose up --build      # requiere APP_SECRET (y APP_SETUP_TOKEN para el primer usuario)
```

Imagen `node:24-alpine`, usuario no-root, `HEALTHCHECK` y volumen `/app/data`. Dentro del contenedor el
bind es `0.0.0.0`, por lo que la sesión es obligatoria. Detalle en `RUNBOOK.md` §9.

## Documentación

- `RUNBOOK.md` — operación, backups, Google OAuth personal, canales, oficina/aprobaciones, documentos,
  estilo, avisos, keep-alive, guardia de datos (antes/después), Docker, troubleshooting y checklist.
- `docs/CONTRATO_API.md` — contrato definitivo de la API.
- `docs/CANALES.md`, `docs/LLM.md`, `docs/WORKFLOWS.md`, `docs/OFFICE.md`, `docs/DOCUMENTOS.md`,
  `docs/VIAJES.md`, `docs/AVISOS.md`, `docs/ESTILO.md`, `docs/HILOS.md`, `docs/MCP.md`, `docs/RESEARCH.md`.
- `docs/FEATURES.md` — catálogo de flags, shadow, pausas, kill switch y auditoría.
- `docs/LINGO.md` — léxico único, estados, promoción a las 3 correcciones e integración.
- `docs/ACL.md` — etiquetas, matriz N0-N3, bloqueo reservado→externo y guardOutbound.
- `docs/CONTRATOS_CONGELADOS.md` — firmas que no se tocan y reglas de cambio aditivo.
- `docs/ESQUEMA.md` — esquema visual (Mermaid) de la oficina, ciclo de una petición, roles y módulos.
- `docs/MAPA_CAPACIDADES.md` — capacidades estilo Lark con estado honesto (existe / parcial / falta) y ola.
- `lib/agenda/README.md` — modelo P95 y pruebas del motor.

## Tema de la interfaz

La interfaz tiene **tema oscuro (original) y tema claro blanco con acentos azules y controles LED**.
Se elige con el selector **Oscuro / Claro / Sistema** de la barra superior o del menú; la elección se
guarda por navegador y `Sistema` sigue la preferencia del dispositivo. El tema claro vive en
`public/theme-light.css` y solo se activa con `html[data-theme="light"]`, por lo que no altera el oscuro.
Verificación automática en Chrome headless: `node scripts/theme-check.mjs --base=<url> --cdp=<chrome-cdp>`
(9 vistas × 2 temas sin errores de consola, persistencia, modo Sistema y **12 combinaciones de contraste
≥4.5:1** en claro). Capturas en `docs/capturas/tema-claro-*.png` y `tema-oscuro-*.png`.

## Límites conocidos

Persistencia en un JSON de un solo proceso (sin multi-instancia); una agenda/instalación; los mensajes
proactivos de WhatsApp requieren plantilla aprobada; el correo entrante depende de OAuth de Gmail; las
features de Google y LLM degradan sin configuración, nunca bloquean la app.


# RUNBOOK — Agenda Copilot P95 (operación local verificada)

> Regla de oro del proyecto: **nunca se importa el store ni se prueba contra el dato real; `DATA_DIR` primero.**
> Toda prueba (`npm test`, `npm run smoke`, selfchecks) fija un `DATA_DIR` temporal antes de importar cualquier módulo.

## 1. Requisitos

- **Node.js 24 LTS** o superior (`node -v`). Sin dependencias npm: no hace falta `npm install`.
- 300 MB de disco y cualquier sistema con Windows/macOS/Linux.
- Opcionales: cuenta Google (Calendar/Gmail), bot de Telegram, WhatsApp Cloud API, proveedor LLM/Ollama.

## 2. Instalación y arranque

```bash
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
# edita APP_SECRET (clave larga y aleatoria) y lo que quieras activar
node start.mjs           # elige puerto libre (3000 o siguiente), abre el navegador
```

En Windows también puedes usar `START_WINDOWS.bat` (o `scripts/setup.ps1` para preparar `.env` y `APP_SECRET`).

- `node start.mjs --no-open` no abre el navegador. `PORT=3100 node start.mjs` intenta 3100 primero.
- `npm start` equivale a `node start.mjs`. `npm run dev` recarga al cambiar archivos.
- La URL exacta se imprime al arrancar. Si el 3000 está ocupado por otra instancia, el lanzador usa el siguiente libre.
- Cierre limpio: `Ctrl+C` (SIGINT) o SIGTERM; el servidor hace flush del journal antes de salir.

## 3. Uso diario

- **Dashboard**: Top 3 por score de prioridad P95, ejecución, foco, vencidas, conflictos y OKR.
- **Asistente** (español): `HOY`, `CAPTURA …`, `HECHO …`, `POSPONER …`, `FOCO …`, `CIERRE`, `SEMANA`, `balance`.
  Con LLM configurado acepta lenguaje natural (“agenda reunión con Ana mañana a las 10 por 45 min”).
- **Inbox**: capturar → convertir en cita (valida conflictos y Google antes de agendar).
- **Rutinas**: crear/editar/pausar/saltar un día, ver las próximas apariciones y materializar el rango.
- **Agenda**: editar, posponer, completar con minutos reales, cancelar/borrar (soft delete del histórico).
- **Métricas**: 14 campos diarios (06_METRICAS_DIARIAS) + reportes semanal/mensual.
- **Integraciones**: Google, WhatsApp, Telegram, correo, simulador y webhooks.
- **Workflows/señales**: brief 06:30, mediodía 12:00, cierre 17:30, semanal viernes 17:45, recordatorios,
  reconciliación Google, resumen nocturno y resumen horario; señales con cooldown (choques, vencidas, foco, hueco, etc.).

## 4. Calidad: qué ejecutar antes de tocar producción

```bash
npm run check        # node --check de TODO lib/**, server.mjs, start.mjs, scripts/**, tests/** (210 archivos)
node scripts/check-secrets.mjs   # escaneo de secretos (también corre en CI)
npm test             # 73 tests node --test + set dorado 60/60 + autocheques (agenda 35, canales 211, LLM 32,
                     # viajes 35, documentos 31, oficina 53, avisos 18, hilos, MCP, research, lingo 21,
                     # acl 37, features 11) + guardia del dato
node scripts/golden.mjs          # solo el set dorado (60 casos, resumen por categoría, exit code)
npm run smoke        # servidor real con DATA_DIR/puerto temporales: 17 flujos críticos PASS/FAIL
node scripts/theme-check.mjs --base=<url> --cdp=<chrome-cdp>   # tema claro/oscuro y contraste AA
```

La guardia de integridad de `npm test` es **antes/después, NO contra un valor fijo**: al empezar captura un
snapshot del `data/` real (hash, conteos, ids, títulos y listado) y al terminar compara contra ESE snapshot.
Falla solo si la suite misma alteró el archivo (fixtures de prueba, pérdida neta de contenido sin activity de
borrado, cambio sin entrada nueva en el journal o archivos inesperados en `data/`). Los cambios hechos por el
usuario mientras la app está en marcha (crear/editar/borrar citas, materialización de rutinas, señales, workflow
runs) se aceptan como actividad legítima y se listan como aviso. No hay constantes históricas de hash ni de seed
en el código de test.

## 5. Dato real, backups y restauración

- Archivo: `data/agenda-data.json` (atómico: temporal + fsync + rename; backups `.bak`, `.bak.1`, `.bak.2`; journal `journal.jsonl`).
- **Nunca** edites el JSON a mano con la app corriendo.
- Backup por UI/API: `GET /api/backup` (descarga JSON) y `POST /api/backup/restore` con `{ "confirm": "RESTORE", "data": … }`.
- Copia manual antes de tocar algo: `data/backups/pre-lanzamiento-<fecha>/agenda-data.json`.
- Baseline canónico del seed (2026-10-27): `agenda=5` (AG-0001..AG-0005), `inbox=1`, `recurrences=6`, `meetings=4`, `okrs=2`;
  versión 2, 11.316 B, sha256 `70BC9737F0FFE7D51538D865CF372E2E6EBD605D928B62777ACF89E2F07F10C0`.
  Los backups `agenda-data.json.bak` y `agenda-data.json.pre-v1-2026-10-27_18-13-43.json` son el rollback a v1.
- Si el JSON se corrompe, la app arranca en **solo lectura**, conserva el archivo como `.corrupt` y lo reporta en `/api/health`.

## 6. Google OAuth en uso personal (leer antes de conectar)

Google es **opcional**: agenda, rutinas, LLM, canales y workflows funcionan sin conectarlo.

1. **Error 403 `access_denied`** (“la app no ha completado el proceso de verificación”): NO es un fallo de la app.
   El proyecto OAuth está en estado **Testing** y solo entran usuarios de prueba. Fix:
   Google Cloud Console → *APIs & Services* → *OAuth consent screen* (Google Auth Platform → Audience) →
   **Test users → Add users** → añade tu cuenta → Save.
2. **Redirect URIs** autorizadas en *Credentials → OAuth Client → Authorized redirect URIs* (ambas):
   - `http://localhost:3000/api/auth/google/callback`
   - `http://127.0.0.1:3000/api/auth/google/callback`

   La app arma el redirect con `APP_URL` (hoy `http://localhost:3000`). Si falta la URI exacta, Google devuelve
   `redirect_uri_mismatch`. Si cambias de puerto, ajusta `APP_URL` y añade la URI correspondiente.
3. **Refresh tokens en Testing caducan a los 7 días**: reconecta la cuenta semanalmente, o publica la app
   (verificación; con `gmail.send` exige CASA), o quita el scope de Gmail y deja solo Calendar.
4. **Client secret**: no está en el `.env` del proyecto (la instancia antigua lo tenía solo en memoria).
   Configúralo en **Integraciones → Google** (bóveda cifrada AES-256-GCM) o en `.env` como `GOOGLE_CLIENT_SECRET`.
   Sin él la app sigue funcionando en local sin Google.
5. Los webhooks de Google (si algún día se usan) deben ir por HTTPS/túnel; en local se usa OAuth + reconciliación periódica.

## 7. Canales

- **Simulador** (siempre disponible): `POST /api/channels/simulate` o panel de Integraciones; sirve para probar sin tokens.
- **Telegram**: token de @BotFather; modo long-polling (sin HTTPS) o webhook (`TELEGRAM_WEBHOOK_SECRET`).
  Ruta para limpiar webhook: `POST /api/channels/telegram/delete-webhook`.
- **WhatsApp Cloud API**: `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_VERIFY_TOKEN` y **`WA_APP_SECRET` obligatorio**
  (valida `X-Hub-Signature-256`). Webhook: `POST /api/whatsapp/webhook`. Fuera de la ventana de 24 h se requiere plantilla.
- **Correo (Gmail)**: salida con `sendGmail`; entrada por OAuth propio (polling de no leídos) con allowlist y anti-bucle.
- **Webhook genérico**: crea instancia en `POST /api/channels/webhook:<nombre>/config` (devuelve el token UNA vez);
  entrada en `POST /api/channels/inbound/webhook:<nombre>` con `Authorization: Bearer <token>`; salida HTTP con presets.
- **Idempotencia**: un mismo `message.id`/`update_id`/`id` procesa UNA sola vez; el reintento queda como `duplicate`.

## 8. LLM: API vs Ollama y sin LLM

- **API OpenAI-compatible** (OpenAI, DeepSeek, etc.): Integraciones → LLM (bóveda) o `POST /api/llm/config`
  con `{ provider, baseUrl, model, apiKey }`. La clave nunca se escribe en logs ni se devuelve.
- **Ollama local**: instala Ollama, define `OLLAMA_HOST` (p. ej. `http://127.0.0.1:11434`) y usa un modelo pequeño (3B/1.5B).
- **Sin LLM**: la app funciona igual con el parser determinista en español. `GET /api/llm/status` lo reporta.
- Coste/abuso: topes diarios y por workflow (`store.llm.limits`), rate limit, caché y **kill-switch** (`{"killSwitch":true}`).
  Todo se degrada a determinista sin romper la app. Consumo: `GET /api/llm/usage?days=7`.

## 9. Docker (opcional)

```bash
# .env con APP_SECRET (obligatorio) y APP_SETUP_TOKEN para el primer usuario
docker compose up --build
# o:
docker build -t agenda-copilot-p95:local .
docker run -d --name agenda -p 127.0.0.1:3000:3000 \
  -e APP_SECRET=... -e APP_SETUP_TOKEN=... -v "$PWD/data:/app/data" agenda-copilot-p95:local
```

La imagen usa `node:24-alpine`, usuario **no-root** (`node`), `HEALTHCHECK` contra `/api/health` y
volumen `/app/data`. Dentro del contenedor el bind es `0.0.0.0`, por lo que **la sesión es obligatoria**:
crea el primer usuario con el `APP_SETUP_TOKEN` configurado.

## 10. Seguridad y límites

- Bind por defecto `127.0.0.1`. Si `HOST`/`APP_HOST` no es loopback (o `APP_AUTH=on`), **toda escritura exige sesión**
  (cookie HMAC, scrypt para contraseñas, epoch de revocación).
- `APP_SECRET` cifra bóveda de secretos y sesiones: cámbialo por una cadena larga y **consérvalo** (si lo pierdes,
  los secretos guardados no se descifran; la app arranca y lo reporta).
- Webhooks: firma HMAC de WhatsApp, secreto de Telegram y token de webhook genérico; en producción sin secreto → 503.
- Límites conocidos: persistencia en JSON de un solo proceso (no multi-instancia); un usuario/agenda por instalación;
  el correo entrante depende de OAuth de Gmail; los mensajes proactivos de WhatsApp requieren plantilla aprobada.

## 11. Solución de problemas

| Síntoma | Causa probable | Acción |
|---|---|---|
| `El puerto 3000 está ocupado` | instancia antigua | `node start.mjs` elige el siguiente libre; o `PORT=3100 node start.mjs` |
| `ERR_CONNECTION_REFUSED` | app no arrancó | revisa la ventana/consola; `npm run check`; `DIAGNOSTICO_WINDOWS.bat` |
| `/api/health` muestra `readOnly: true` | JSON corrupto o versión superior | conserva `.corrupt`; restaura backup con `POST /api/backup/restore` |
| 401 en todas las escrituras | `APP_AUTH=on` o HOST≠loopback | inicia sesión (o crea el primer usuario con `APP_SETUP_TOKEN`) |
| Google 403 `access_denied` | proyecto OAuth en Testing | añade tu cuenta como Test user (sección 6) |
| Google `redirect_uri_mismatch` | URI no autorizada | autoriza `localhost` y `127.0.0.1` (sección 6) |
| Google deja de sincronizar a los 7 días | refresh token de Testing caducó | reconecta la cuenta (sección 6) |
| WhatsApp webhook 401/503 | firma inválida o falta `WA_APP_SECRET` | configura el App Secret en Integraciones |
| Telegram no responde | polling detenido o webhook mal configurado | revisa Integraciones; `POST /api/channels/telegram/delete-webhook` |
| LLM no responde | clave inválida, cuota o sin red | la app degrada a determinista; revisa `/api/llm/status` y `/api/llm/usage` |
| Workflows no disparan | `WORKFLOWS_AUTOSTART=0` o `NODE_ENV=test` | quita la variable y reinicia; estado en `GET /api/workflows/status` |

## 12. Checklist de lanzamiento local

1. `npm run check` y `npm test` en verde (incluye guardia del dato real antes/después).
2. `npm run smoke` 17/17 PASS.
3. `node start.mjs` → URL impresa, `/api/health` 200, PWA instalable.
4. Crear 3 rutinas desde onboarding; crear/mover/cancelar una cita con confirmación.
5. Backup descargado y restore probado sobre una copia (nunca sobre el dato real sin copia).
6. Con `APP_AUTH=on` (o HOST≠loopback): sin sesión no se puede escribir.
7. Un workflow por señales dispara y respeta cooldown; el kill-switch del LLM detiene el consumo.
8. Al cerrar con Ctrl+C no quedan escrituras pendientes (`journal` consistente).

## 13. Oficina y aprobaciones (t13/t18)

- La Oficina trabaja con niveles **N0** (lectura automática), **N1** (borrador interno automático),
  **N2** (aprobación humana) y **N3** (aprobación + código de 6 caracteres). Modos: `sombra`, `asistido`,
  `autonomo`, `total`; el modo sombra retiene todo.
- Flujo: crear propuesta (`POST /api/office/proposals`) → si es N2/N3 queda `pending` → aprobar
  (`POST /api/office/proposals/:id/approve`) → ejecutar (`POST /api/office/proposals/:id/execute`).
  N3 exige el `code` devuelto una sola vez al aprobar. La ejecución es única (`409 ALREADY_EXECUTED`).
- Sin ejecutor disponible (p. ej. correo sin Gmail) la respuesta es `503 EXECUTOR_UNAVAILABLE` y la
  propuesta **sigue aprobada** (no se marca ejecutada ni se registra ejecución en el ledger).
- Aprobación por canal: configura `POST /api/channels/approvals/config`
  (`preferredChannel`, `owners.<canal>`, `simulatorTarget`), envía la tarjeta con
  `POST /api/channels/approvals/:proposalId/send {channel}` y responde desde el canal con `1/ok` (aprobar),
  `2/no` (rechazar), `3/corrige:` (corrección) o `ver OF-xxxx`. Un remitente fuera de la lista blanca recibe
  «no autorizado» y queda auditado (`proposal.approval_denied`) sin cambiar el estado.
- La tarjeta incluye riesgo /10, señales, destinatarios, extracto, enlace y acciones. Aprobar/rechazar
  **no ejecuta**: la ejecución sigue en `/execute`.
- Ledger: `GET /api/office/ledger`, `GET /api/office/ledger/verify` (cadena SHA-256),
  `GET /api/office/ledger/export`; cualquier manipulación se detecta como cadena inválida.

### Flujo propuesta → aprobación → ejecución (salidas externas, t30/t32)

Ninguna ruta envía a terceros directamente: todas crean una propuesta que hay que **aprobar y ejecutar**.

1. `POST /api/gmail/send {to, subject, body}` → **202** `{status:"pending_approval", proposal:{id,level,risk,flags}, message, approvalUrl}`.
   No envía nada. `direct:true` solo se admite si `settings.office.allowDirectSend === true`; si no → **403
   `APPROVAL_REQUIRED`**. En modo `total`/`autonomo` la propuesta **también nace pending**. Si la Oficina no
   está disponible → **503 `OFFICE_UNAVAILABLE`**. El override directo deja `email.direct_override` en el ledger
   **antes** de intentar el envío.
2. `POST /api/channels/:id/send {to|recipients, body, subject?, attachments?}` y
   `POST /api/channels/send-document {docId, channel, to?}` → **202** propuesta pending (N2; el gate puede
   elevarla a N3). No envían. Al aprobar y ejecutar (`/api/office/proposals/:id/approve` + `/execute`) se
   produce **exactamente un envío** (adjuntos incluidos); un segundo execute → **409 `ALREADY_EXECUTED`**.
   Sin ejecutor (p. ej. correo sin Gmail) → **503 `EXECUTOR_UNAVAILABLE`** y la propuesta sigue `approved`.
3. `POST /api/channels/:id/test` es solo para el **dueño** configurado o el simulador; un destinatario tercero
   → **403 `NOT_OWNER`** con `details.listField` (no se llama al proveedor). Las rutas heredadas
   `/api/whatsapp/test` y `/api/telegram/test` aplican la misma regla.
4. Herramientas del agente (`enviar_correo`, `enviar_whatsapp`, `enviar_telegram`, `enviar_documento`) crean
   propuesta pending y **nunca envían**; con la Oficina desactivada (`OFFICE_ENABLED=off`) devuelven
   `OFFICE_GATE_UNAVAILABLE`.
5. El ledger registra `proposal.created`, `proposal.approved`, `proposal.executed` (y `email.direct_override`
   si se usa el override). `npm test` incluye un **test anti-bypass** que falla si aparece `sendGmail`,
   `sendWhatsApp` o `sendTelegram` en un módulo no autorizado (agente, rutas nuevas, etc.).

### Autonomía de salida (opt-in, t35)

- Por defecto **nada sale sin aprobación**, incluso en modo `total`/`autonomo`: `/send`, `send-document` y
  `/docs/:id/send-email` crean la propuesta con `forceApproval:true` y responden **202 pending**.
- La autonomía es un **opt-in explícito**: `settings.office.allowAutonomousOutbound` (default `false`), editable
  con `POST /api/channels/approvals/config {allowAutonomousOutbound:true}` y visible en
  `GET /api/channels/approvals/status`. Solo auto-ejecuta si se cumple **todo**: flag activo + modo
  `total`/`autonomo` + `risk.score <= 2` + contacto conocido + nivel ≠ N3. Antes del envío escribe
  `outbound.autonomous` en el ledger; la respuesta es `{status:"executed",auto:true,executed:true,approvalRequired:false}`.
- **N3 nunca se auto-ejecuta**: sigue exigiendo aprobación + código de 6 caracteres. Con el flag activo pero
  modo `asistido`, la propuesta sigue pending.
- Verificado en el relanzamiento v3: total sin flag → 202 pending/0 envíos; total+flag+conocido+riesgo≤2 →
  executed con **1** mensaje y `outbound.autonomous`; N3 con adjunto → pending, código y **1** archivo tras
  ejecutar. La configuración se restaura a `mode=asistido`, `allowAutonomousOutbound=false`, `allowDirectSend=false`.
- **Dos vías de cambio, ambas auditadas (t37/t39)**: `POST /api/settings {office:{allowAutonomousOutbound}}`
  y `POST /api/channels/approvals/config {allowAutonomousOutbound}`. Cada cambio real escribe una entrada
  `office.settings` en el ledger (la vía de canales añade `source:"channels.approvals.config"`); si la
  auditoría falla → **503** y el flag no cambia. Tipos inválidos y `enforceOutbound` → **400**.
- Los tres flags se consultan en `GET /api/health`, `GET /api/office/status` y `GET /api/bootstrap`
  (`office:{enforceOutbound,allowDirectSend,allowAutonomousOutbound}`); en la UI el interruptor
  «Permitir autonomía de salida» está en Integraciones → Aprobaciones y autonomía (apagado por defecto).
- Verificado en el relanzamiento v4: settings y approvals/config dejan `office.settings` con changes true/false
  y owners/preferred intactos; UI con toggle, aviso «Enviado automáticamente por autonomía» (sin botón de
  aprobar) y «Ir a la Oficina» para pending; estado final restaurado.

## 14. Documentos (t17)

- `POST /api/docs {type:"docx"|"xlsx"|"pptx", title, …}` genera un archivo OOXML real (ZIP con
  `[Content_Types].xml`, estilos, tablas, hojas con fórmulas o diapositivas 16:9).
- `GET /api/docs/:id/download` descarga el binario; `DELETE /api/docs/:id` lo borra y deja de listarse.
- `POST /api/channels/send-document {docId, channel, to?}` ya **no envía**: crea una propuesta **202** con el
  adjunto (se envía al aprobar/ejecutar en la Oficina; sin Gmail el execute responde 503 y el documento no se pierde).
- Plantillas de marca: `GET/POST /api/docs/templates`, `DELETE /api/docs/templates/:name`.

### Propuestas de prueba QA en el store real (t33/t36)

Las verificaciones de lanzamiento crearon propuestas en la Oficina real que **se conservan como evidencia**
(no se borran a mano: el ledger es la auditoría). No existe endpoint de archivado/etiquetado (`meta.qa`) en
`/api/office/*`; si se añade más adelante, estas deberían marcarse y quedar fuera de la bandeja por defecto.

| Propuesta | Estado | Origen |
|---|---|---|
| OF-0001 | rejected | t33 bypass Gmail (202 pending, nunca se envió) |
| OF-0002 | executed | t33 approve+execute de canal simulator (1 envío a tercero simulado) |
| OF-0003 | rejected | t33 chat del agente «envía un correo a …» (pending, 0 envíos) |
| OF-0004, OF-0005, OF-0007 | rejected | t36 autonomía: asistido / total sin flag / flag con asistido (0 envíos) |
| OF-0006 | rejected | t36 autonomía: primer intento con contacto nuevo (riesgo 4, pending) |
| OF-0008 | executed | t36 N3 con adjunto: approve + código → 1 documento por simulador |
| OF-0009 | executed | t36 autonomía opt-in: total+flag+conocido+riesgo 2 → 1 mensaje y `outbound.autonomous` |
| OF-0010, OF-0011, OF-0012 | rejected | t36 re-verificación de bypass (Gmail, canal a tercero, agente) |
| OF-0013 | executed | t40 N3 con adjunto: pending + código → 1 documento por simulador |
| OF-0014, OF-0015, OF-0016 | rejected | t40 re-verificación de bypass (Gmail, canal a tercero, agente) |

Todas las propuestas pendientes de QA se rechazaron con motivo «Prueba QA…», de modo que ninguna queda
accionable en la bandeja. El detalle completo está en `data/journal.jsonl` y en el ledger de la Oficina.

## 15. Estilo propio, identidad y voz (t14)

- Importa muestras por registro con `POST /api/style/samples {register, samples:[{text}]}` (mínimo 10 para
  perfil propio; si no, se usa el respaldo global/neutro).
- `GET /api/style/profiles` muestra métricas; `POST /api/style/score {register, text}` puntúa 0..1 con
  motivos; `POST /api/style/compose {register, intent, recipient}` redacta con variación anti-repetición
  (7 días por contacto/tipo por contacto).
- Identidad multicorreo: `POST /api/identity/contacts {name, emails[]}` agrupa correos de una persona;
  `POST /api/identity/resolve {email|name}` devuelve candidatos con confianza y `requiresConfirmation`
  si <0.8; `POST /api/identity/expand {query}` expande a todos sus correos.

## 16. Avisos inteligentes (t16)

- Configuración: `GET/POST /api/nudges/config` (activar, cadencia, `maxPerHour`, `maxPerDay`,
  `cooldownMin`, silencio `silence.from/to`, canales, umbrales, reporte de cierre y LLM opcional).
- `POST /api/nudges/evaluate` es **dry-run por defecto**; `{dryRun:false}` envía y escribe feed.
  `GET /api/nudges/feed`, `GET /api/nudges/status`, `GET /api/nudges/report`,
  `POST /api/nudges/:id/dismiss`.
- Reglas anti-spam: cooldown por tipo, silencio nocturno (21:30–07:00 por defecto), máximo 2 avisos/hora y
  8/día, dedupe por huella y descarte por asunto. Sin canales configurados no se intenta enviar
  (`attempted:false/no-channels`).
- Enganche al scheduler de workflows mediante `registerTickHandler` (idempotente, timeout 5 s; un handler
  que lanza no rompe el tick y `dryRun` no envía). No hay timers propios fuera del scheduler.

## 17. Keep-alive y estabilidad HTTP

- `server.mjs` usa `keepAliveTimeout=65 s`, `headersTimeout=66 s` y `requestTimeout=120 s` (Node exige
  `headersTimeout > keepAliveTimeout`). Con eso, un POST/DELETE después de 10 s de inactividad reutiliza la
  conexión sin `ERR_EMPTY_RESPONSE` (verificado en el relanzamiento de t20).
- Si un cliente intermedio corta la conexión, `api.js` reintenta la petición de forma segura (t21).

## 18. Cambios hechos por el usuario durante la construcción (no son pérdidas)

Durante la construcción el jefe usó la app real. Quedan auditados en `activity`/journal y **se conservan**:

1. Borrado intencional de **AG-0001** «Plan diario + Top 3» el 2026-10-28 08:21:47Z
   («Cita eliminada: Plan diario + Top 3»).
2. Borrado de la rutina **R-005** («Rutina eliminada: R-005», 2026-10-28 07:13Z).
3. Captura en Inbox «Realizar informe al Dr. Rodrigo» (2026-10-28 08:23Z).
4. Creación de la rutina **R-0007** «Revisión semanal P95» (2026-10-28 08:25Z).

Esto es uso legítimo: la guardia de datos no exige un seed inmutable. Los backups
`data/backups/pre-lanzamiento-2026-10-27_16-05-25/` y `data/backups/pre-relanzamiento-t20-2026-10-28_04-55-54/`
se conservan como red de seguridad.

## 19. Features (Wave 0): flags, shadow y kill switch (t42)

- Catálogo de **12 features** en `lib/features/registry.mjs`, todas **off por defecto**. Estado en
  `settings.features` (sin migración; si falta se asume `off`). Helpers: `getMode/isOn/isShadow/assertOn`.
- API: `GET /api/features`, `GET /api/features/status`, `POST /api/features/:id {mode:"off|shadow|on"}`,
  `POST /api/features/:id/pause|resume`, `POST /api/features/pause-all|resume-all`. Cada cambio escribe
  `feature.change`/`feature.paused` en el ledger **antes** de persistir (si falla → 503 sin cambio).
- Precedencia: `FEATURES_KILLSWITCH=all` > `FEATURE_<ID>=on|off|shadow` > estado persistido. `shadow` ejecuta
  `runShadow` sin store ni envíos y guarda diff en `shadowLog`.
- `/api/health` conserva su forma y añade `features:{count,on,shadow,off,paused,globalPaused}`. El wrapper de
  features sube el contador de rutas de health (conflicto informado en el contrato).
- Flujo obligatorio: **off → shadow → on**, con rollback por flag. Ver `docs/FEATURES.md`.

## 20. Lingo: léxico único y promoción (t43/t47)

- Términos canónicos en `data.lingo.terms` (estados `shadow|approved|rejected`), variantes normalizadas
  (minúsculas, sin diacríticos ni puntuación) y contexto. API: `GET/POST/PATCH /api/lingo/terms`,
  `POST /api/lingo/learn|apply|suggest`, `GET /api/lingo/hotwords`.
- Una corrección deja el término en `shadow`; a las **3 correcciones** se promueve a `approved` (auditado en
  `lingo.change`). Los términos `shadow` no se aplican ni entran en hotwords.
- Integrado en redacción (`composeEmail`), títulos/nombres de archivo y herramientas del agente; si el léxico
  está vacío o falla, devuelve el texto original (sin regresión). Ver `docs/LINGO.md`.

## 21. ACL: etiquetas público/interno/reservado (t44/t46)

- Etiquetas canónicas `público`, `interno`, `reservado` (alias sin tilde) por documento (`data.acl.documents`)
  y defaults `{document:"interno", proposal:"interno"}`. API: `GET /api/acl/status|policy`,
  `GET|PUT /api/acl/documents/:docId`, `POST /api/acl/check`, `POST /api/acl/defaults`.
- Matriz: público N0; interno N1 (interno) / N2 con aviso (externo); reservado N2 (interno) / N3 (externo).
  **Reservado → externo sin `confirmedReserved:true` se bloquea (403 ACL_DENIED) y no crea propuesta**; con
  confirmación nace N3 forzado (código obligatorio). `docId` manda sobre un `label` explícito (anti-bypass).
- Integrado en `/api/channels/:id/send`, `/send-document` y `/docs/:id/send-email`; cada decisión deja
  `acl.enforced` en el ledger de la Oficina. Si ACL no está disponible → 503 `ACL_UNAVAILABLE`. Ver `docs/ACL.md`.

## 22. Tema claro, oscuro y sistema (t38/t48)

- Selector en la barra superior y en el menú con **Oscuro / Claro / Sistema**; persiste en
  `localStorage["agenda-p95.theme.v1"]` y aplica `data-theme`/`data-theme-choice` en `<html>`. Sin elección
  respeta `prefers-color-scheme`; el modo Sistema se actualiza al cambiar la preferencia del SO.
- El tema claro vive en `public/theme-light.css` y **solo** actúa con `html[data-theme="light"]`; el oscuro
  no se toca (verificado por igualdad del DOM de estilos de 6 elementos clave).
- Verificación headless (`scripts/theme-check.mjs`): 8/8 PASS, 9 vistas × 2 temas sin errores de consola,
  **12 combinaciones de texto/fondo ≥4.5:1** en claro (mínimo medido 5.27). El botón primario usa degradado
  (blanco sobre azul; peor parada 3.89:1) — estilo previo, no introducido por el tema claro; anotado para una
  futura mejora de contraste.
- Capturas para revisión: `docs/capturas/tema-claro-{home,agenda,office}.png` y `tema-oscuro-*.png`.

## 23. Set dorado y umbrales de no regresión (t48)

- `tests/golden/` contiene **60 casos** en 6 categorías (10 cada una): aprobaciones (N2/N3, 409/400, ejecución
  única, ledger), documentos (DOCX/XLSX/PPTX válidos, XML, anchos), agenda/rutinas (CRUD, conflictos, clamp,
  viajes Cali→Palmira), estilo/identidad (perfil, score, multicorreo), lingo (canónico, promoción, conflictos)
  y ACL (matriz sin fugas). Se ejecutan aislados con su propio `DATA_DIR`.
- Runner: `node scripts/golden.mjs` (resumen PASS/FAIL por categoría y exit code). Integrado en `npm test`.
- **Umbrales de no regresión** (todos deben cumplirse en cada entrega):
  1. **0 envíos sin aprobación** (gmail/canales/documentos nacen `pending`; ejecución única).
  2. **`ledger verify` íntegro** (cadena SHA-256 sin manipulación) y acciones `proposal.created/approved/executed`.
  3. **0 fugas ACL** (reservado→externo bloqueado sin confirmación; `docId` manda sobre `label`).
  4. **Suite y smoke verdes**: `npm test` (73 tests + 60 golden + autocheques + integridad) y `npm run smoke` 17/17.
  5. **Contraste AA en tema claro**: 12 combinaciones ≥4.5:1.
- **Lanzamiento v5 verificado** (2026-10-28): `http://127.0.0.1:3000`, 236 rutas, 19 módulos
  (16 + features + lingo + acl), features off, `mode=asistido`, `allowAutonomousOutbound=false`,
  `allowDirectSend=false`. Endpoints nuevos 200 (`/api/features*`, `/api/lingo*`, `/api/acl/*`). Datos intactos
  (12 citas, 2 inbox, 6 rutinas, 4 reuniones, 2 OKR; títulos 12/12; sin fixtures). Backup:
  `data/backups/pre-relanzamiento-v5-2026-10-28_10-45-21/`.


## 25. Laboratorio de funciones y patrón visual único (2026-10-28)

- **Dónde**: Integraciones → *Laboratorio de funciones*. Lista las 12 funciones con su estado
  (apagada / sombra / activa), selector `off|shadow|on`, botón **Pausar/Reanudar** y acciones
  globales **Pausar todas / Reanudar todas / Actualizar**. Cada cambio se audita en el ledger.
- **Código**: `public/js/features.js` (módulo ES; se inicializa en `main.js`), estilos `.feature-row`
  al final de `public/styles.css`, tarjeta `#featuresCard` en `public/index.html`, precacheado en
  `public/sw.js` (SHELL).
- **Prueba**: `node scripts/verify-features.mjs http://127.0.0.1:3308` sobre instancia temporal
  (`DATA_DIR` aparte) → **9/9 PASS** (12 filas, cambio a sombra persiste, fila se actualiza,
  pausa/reanudación y consola limpia).
- **Patrón visual único de panel** (tema claro): sin borde, `background: rgba(255,255,255,.74)`,
  `backdrop-filter: blur(16px) saturate(120%)`, `box-shadow: 0 10px 30px rgba(2,20,50,.08)`.
  Aplica a tarjetas, filas, drawer, modal, toasts y burbujas. Fondo `#FFFFFF` puro.
  Capturas: `docs/capturas/tema-claro.png`, `docs/capturas/vista-features-light.png`.
- **Service worker**: `2026-10-28.12`.

## 26. Destinatarios multicorreo: 2 personas × 2 correos → 4 destinos (2026-10-28)

- **Dónde**: canal de correo (`createSendProposal` / `createDocumentProposal` en
  `lib/channel/outbound.mjs`). Si `to` trae un **nombre**, se resuelve con
  `expandRecipients` (identidad con evidencia) y se envían **todos** sus correos,
  sin duplicados. Los correos literales pasan tal cual.
- **Seguridad**: si el nombre es ambiguo o la confianza < 0,8 se responde
  **409 `IDENTITY_CONFIRMATION_REQUIRED`** con los candidatos; no se adivina.
  WhatsApp/Telegram no expanden (usan teléfono o chat id).
- **Aprobación**: la expansión ocurre **antes** de crear la propuesta, así que la
  tarjeta de aprobación muestra las 4 direcciones reales; sigue siendo N2/N3 y
  no se envía nada sin aprobación.
- **Prueba**: `node scripts/probe-identity4.mjs` (incluida en `npm test` como
  «identidad multicorreo (2×2 → 4 destinos)»): propuesta pending con 4 correos
  únicos, nombre ambiguo → 409, WhatsApp intacto.

## 27. Tema claro blanco + verde (2026-10-28)

- **Fondo**: `#FFFFFF` puro. Sin canvas gris.
- **Acento**: verde `#176b59` (reemplaza el azul); líneas `rgba(23,107,89,.22)` y
  `rgba(23,107,89,.12)`; sombras con tinte verde `rgba(24,54,42,.06)`.
- **Tarjetas**: mismo patrón que la barra inferior: `background:var(--glass)` (.58),
  `border:1px solid var(--line)`, `box-shadow:var(--shadow)`, `backdrop-filter:blur(16px)`.
- **Tipografía**: `Inter, ui-sans-serif, -apple-system, "Segoe UI", sans-serif`,
  14 px, línea 1.55.
- **Main**: `max-width:1650px`, `margin:0 auto`, padding `28px 42px` (18/18 en tablet,
  12 en móvil) + espacio para la barra inferior.
- **Pendiente opcional**: el tema oscuro conserva el azul; si se quiere, se replica el verde.
- Service worker: `2026-10-28.15`.

## 28. Vista Tareas y compromisos (2026-10-28)

- **Dónde**: menú lateral → *☑ Tareas*. Lista con filtros (Todas/Abiertas/Hechas/Canceladas),
  búsqueda por título/persona/nota y contador de abiertas.
- **Acciones**: crear (título, vence, prioridad P1–P4, responsable, notas), editar inline
  (título, fecha, prioridad, responsable), **Cerrar/Reabrir** y **Eliminar** con confirmación.
- **Código**: `public/js/tasks.js` (módulo ES), sección `#view-tasks` en `index.html`,
  estilos `.task-row`/`.task-edit` en `styles.css` + patrón de panel en `theme-light.css`,
  precacheado en `sw.js` (SHELL) y enrutado en `main.js`.
- **API**: `GET/POST /api/tasks`, `PATCH/DELETE /api/tasks/:id`, `POST /api/tasks/:id/close|reopen`
  (ya existían; ahora tienen interfaz).
- **Prueba**: `node scripts/verify-tasks.mjs http://127.0.0.1:3310` sobre instancia temporal →
  **9/9 PASS** (crear, editar, cerrar, reabrir, filtrar, eliminar, consola limpia).
- Captura: `docs/capturas/vista-tareas-light.png`. Service worker `2026-10-28.17`.

## 29. Acta → tareas/compromisos (2026-10-28)

- Al crear un **acta** (`POST /api/docs` con `template:"acta"`), cada acuerdo genera
  una tarea con `origin:"acta"`, dueño y fecha si vienen en el acuerdo; las notas
  llevan el id del acta para trazabilidad. La respuesta incluye `tasks[]`.
- Idempotente por acta: no duplica tareas con el mismo título y el mismo id en notas.
- La UI de Documentos avisa «N tareas creadas desde los acuerdos»; aparecen en
  **☑ Tareas** con filtro por origen/estado.
- Código: `createAgreementTasks` en `lib/docs/index.mjs`.
- Prueba: `node scripts/probe-acta-tasks.mjs` (en `npm test` como «acta → tareas»):
  acta con 2 acuerdos → 2 tareas, dueño/fecha conservados y notas con el id.

## 30. Conectores MCP desde la interfaz (2026-10-28)

- **Dónde**: Integraciones → *Conectores MCP*. Añade cualquier microservicio que hable
  MCP por **HTTP, SSE o stdio**, con URL/comando, timeout y headers opcionales
  (se cifran en el servidor; nunca vuelven al navegador).
- **Acciones**: **Probar** (handshake + latencia + nº de herramientas), **Herramientas**
  (lista con nombre y efecto), **Pausar/Activar** y **Eliminar**.
- Las herramientas con efectos externos siguen pasando por el **gate de la Oficina**
  (aprobación); el panel no las ejecuta sin aprobación.
- **Código**: `public/js/mcp.js`, tarjeta `#mcpCard`, estilos `.mcp-row` en `styles.css`,
  precacheado en `sw.js` y enrutado en `main.js`.
- **Prueba**: `node scripts/verify-mcp.mjs http://127.0.0.1:3311` con un servidor MCP
  simulado (JSON-RPC) → **8/8 PASS** (añadir, probar, listar `echo`, pausar/activar,
  eliminar, consola limpia). Captura: `docs/capturas/vista-mcp-light.png`.
- Service worker: `2026-10-28.19`.

## 31. Avisos proactivos en el navegador (2026-10-28)

- **Dónde**: Avisos → configuración → *Avisarme en el navegador (este equipo)*.
- Al activarlo pide permiso de notificaciones, guarda `agenda-p95.notify.v1` en
  `localStorage`, marca como vistos los avisos ya existentes (sin spam histórico) y
  empieza a vigilar: comprueba el feed cada **2 minutos**, al volver a la pestaña y
  al arrancar la app.
- Cada aviso nuevo se muestra como **notificación del navegador** (con icono) si la
  pestaña está en segundo plano, o como *toast* si está visible. Respeta el silencio
  nocturno configurado. Los vistos se guardan (máx. 300) para no repetir.
- **Código**: `public/js/nudges.js` (`startNudgeWatcher`, `checkNudgesNotify`),
  interruptor `#nudgeNotifyToggle` en `index.html`, arranque en `main.js`.
- **Prueba**: `node scripts/verify-notify.mjs http://127.0.0.1:3312` con permiso
  concedido por CDP → **7/7 PASS** (activar, persistir, consultar el feed, desactivar).
- Service worker: `2026-10-28.20`.

## 32. Avisos de tareas y compromisos (2026-10-28)

- El motor de avisos ahora detecta también **tareas** (`data.tasks`, solo `status:"open"`):
  - `task_overdue` (impacto 94): tarea con `due` anterior a hoy, con días de retraso.
  - `task_due` (impacto 86): tarea que vence hoy.
  - Se excluyen cerradas, canceladas y sin fecha; se conservan dueño y fecha.
- Se suman a los avisos existentes (citas vencidas, aprobaciones, reuniones sin lugar,
  mensajes sin responder, cierre diario, etc.) y por tanto llegan al feed, a la
  notificación del navegador y a los canales configurados.
- Código: `detectTasks` en `lib/nudges/detect.mjs`; tipos e impactos en
  `lib/nudges/config.mjs` (`NUDGE_TYPES`).
- Prueba: `node scripts/probe-nudges-tasks.mjs` (en `npm test` como
  «avisos → tareas vencidas/hoy») → **6/6 PASS**.

## 33. De reunión a acta en un clic (2026-10-28)

- En **Rutinas → filtro Reuniones**, cada reunión tiene un botón **Acta**.
- Genera un DOCX real con plantilla `acta` precargada: título, participantes,
  propósito/resultado esperado como orden del día y la fecha de hoy; autor
  “Héctor Fabio Riascos C.”. Si la reunión tiene acuerdos, se convierten en tareas
  (ver §29). Al terminar abre **Documentos** y avisa cuántas tareas se crearon.
- Código: botón en `public/js/routines.js` (`data-act="meeting-acta"`) y
  `createMeetingActa`/`buildActaPayload`.
- Prueba: `node scripts/verify-meeting-acta.mjs http://127.0.0.1:3313` →
  **6/6 PASS** (botón visible, DOCX creado, nombre correcto, +1 documento, abre
  Documentos, consola limpia). Captura: `docs/capturas/vista-acta-reunion.png`.
- Service worker: `2026-10-28.21`.

## 34. Videollamadas honestas: Meet real o Jitsi real (2026-10-28)

- **Problema corregido:** sin Google conectado, el servidor fabricaba un enlace
  `https://meet.google.com/xxx-yyyy-zzz` que **no existía** y lo presentaba como
  “sala de Meet”. Eso era una mentira operativa: quien lo recibiera no podría entrar.
- **Ahora**, `ensureMeetLink`:
  - Con Google: crea el evento con `conferenceData` y devuelve el `hangoutLink`
    real (`provider:"google"`, `generated:false`).
  - Sin Google: entrega una sala **Jitsi real y pública**
    `https://meet.jit.si/AgendaP95-<12 hex>` (`provider:"jitsi"`,
    `generated:false`, `fallback:true`) con la nota
    “Sala Jitsi real; Google Meet requiere conectar Google”.
  - Un enlace local viejo con formato `meet.google.com` se regenera como Jitsi.
- El agente y la UI dicen la verdad: “Google Meet no está conectado, te dejo una
  sala Jitsi que sí funciona; cuando conectes Google la cambio por Meet”.
  La agenda muestra el enlace como **Jitsi ↗** o **Meet ↗** según proveedor.
- Jitsi es público: cualquiera con el enlace entra. Se comparte con el mismo
  cuidado que un Meet.
- Pruebas: travel selfcheck **35/35** (Jitsi real, sin `meet.google.com`, idempotente)
  y API real en puerto temporal: `JITSI_REAL=True · SIN_MEET_FALSO=True`.
- Service worker: `2026-10-28.23`.

## 35. Correo real sin Google: cuentas SMTP propias (2026-10-28)

- **Integraciones → Cuentas de correo (SMTP)** permite enviar correo real desde
  cualquier cuenta (Gmail con clave de aplicación, Outlook, Zoho, dominio propio)
  sin OAuth de Google.
- Campos: nombre visible, correo remitente, nombre en el «De», servidor, puerto,
  seguridad (TLS 465 / STARTTLS 587), usuario y contraseña o clave de aplicación.
- Seguridad: la contraseña se cifra con el vault (AES-256-GCM) y **nunca** se
  devuelve al navegador; `allowInsecure` solo se acepta contra localhost (pruebas).
  El envío usa TLS implícito o STARTTLS obligatorio; AUTH PLAIN/LOGIN.
- **Integración**: con una cuenta activa, el adaptador de correo envía por SMTP
  los mensajes y documentos aprobados (antes solo Gmail). Si el envío falla, el
  error se ve; no se cambia de canal en silencio.
- Adjuntos: MIME con nombre y tipo (mismo constructor que Gmail).
- Límite: 5 cuentas. La **lectura** de correo entrante sigue siendo Gmail; SMTP
  solo cubre salida. Recibir de cualquier proveedor (IMAP) queda pendiente.
- Pruebas:
  - `node scripts/verify-smtp.mjs` → **10/10 PASS** contra un servidor SMTP local:
    alta, lista sin contraseña, envío de prueba, From con nombre, AUTH, Date/Message-ID,
    adjunto, adaptador por SMTP, borrado y validación.
  - `node scripts/verify-smtp-ui.mjs` → **6/6 PASS** (alta desde la UI, prueba real,
    último envío, sin errores). Captura: `docs/capturas/vista-smtp-light.png`.
- Service worker: `2026-10-28.24`.

## 36. Entrada de correo sin Google: bandejas IMAP (2026-10-28)

- **Integraciones → Bandejas IMAP (entrada)**: lee el correo de cualquier cuenta
  (Gmail con clave de aplicación, Outlook, Zoho, dominio propio) sin Google.
- **Solo lectura y sin marcar leído**: usa `UID FETCH (UID BODY.PEEK[])`; no borra,
  no mueve y no cambia el estado del mensaje en el servidor.
- TLS obligatorio (993). La contraseña se cifra con el vault y nunca se devuelve.
- Parser MIME propio: multipart, `text/plain` preferido sobre HTML, base64,
  quoted-printable, asuntos RFC 2047 y UTF-8/Latin-1/Windows-1252.
- Acciones en la UI: **Probar** (cuenta mensajes y último asunto), **Ver últimos**
  (5 mensajes con remitente y extracto) y **Crear tarea** (`Responder: …`,
  origen `correo`, prioridad P2).
- Código: `lib/channel/imap.mjs`, `lib/routes/imap-accounts.mjs` (5 rutas),
  `public/js/imap-accounts.js`, tarjeta `#imapAccountsCard`.
- Pruebas: `node scripts/verify-imap.mjs` → **18/18 PASS** contra un servidor IMAP
  TLS local con certificado de prueba (`scripts/fixtures/imap-test.*`, no secreto):
  alta sin fuga de contraseña, conexión, último asunto, orden, remitente,
  multipart sin duplicar texto, quoted-printable/UTF-8, BODY.PEEK, tarjeta,
  «Ver últimos», «Crear tarea» y borrado. Captura: `docs/capturas/vista-imap-light.png`.
- Límite: entrada de solo lectura. No hay respuesta automática desde IMAP ni
  marcado de leído; para responder se usa una cuenta SMTP o Gmail.
- Service worker: `2026-10-28.26`.

## 37. Responder un correo IMAP con aprobación (2026-10-28)

- En **Bandejas IMAP → Ver últimos**, cada mensaje tiene **Proponer respuesta**.
- Se abre un diálogo opcional de instrucciones; el servidor:
  1. lee el mensaje (solo lectura, BODY.PEEK),
  2. redacta con el **perfil de estilo** (`lib/style/compose.mjs`; LLM si hay
     proveedor, determinista si no),
  3. fuerza firma completa **«Héctor Fabio Riascos C.»**,
  4. crea una **propuesta N2** en la Oficina (nada se envía todavía).
- La UI muestra el borrador con sujeto `Re: …`, destinatario y botón
  **Revisar y aprobar en Oficina**. Al aprobar y ejecutar, el correo sale por
  **SMTP** (o Gmail si esa es la configuración).
- Corrección incluida: el ejecutor de correo de la Oficina ahora considera
  disponible el canal si hay cuentas SMTP, no solo Google. Antes respondía
  `EXECUTOR_UNAVAILABLE` con SMTP configurado.
- Código: `lib/channel/imap-reply.mjs`, ruta
  `POST /api/imap/accounts/:id/messages/:uid/reply-proposal`,
  botones `data-imap-reply` / `data-imap-office`, estilo `.draft-body`.
- Prueba: `node scripts/verify-imap.mjs` → **27/27 PASS** contra IMAP TLS y SMTP
  locales: lectura, propuesta 202, asunto Re, firma, destinatario, aprobar +
  ejecutar, salida SMTP con firma, UI del borrador N2 y «Crear tarea».
- Service worker: `2026-10-28.27`.



## 38. Aviso de correo nuevo en bandejas IMAP (2026-10-28)

- **Sondeo periódico**: `lib/channel/imap-watch.mjs` revisa cada bandeja cada
  **5 min** (configurable con `IMAP_POLL_MIN`; `IMAP_POLL_MS` solo pruebas).
  Solo actualiza `lastUid`, `newCount` y `lastCheckAt`: no lee cuerpos, no marca
  leído, no responde y no envía nada.
- **Aviso**: el motor de nudges incorpora el tipo `imap_new` (impacto 93) con el
  contador y la bandeja. Por tanto llega al feed, a la **notificación del
  navegador** y a los canales configurados.
- **Reconocer**: `GET /api/imap/accounts/:id/messages` pone `newCount` a 0 y
  avanza `lastUid`; «Ver últimos» en la UI hace lo mismo. Botón **Buscar nuevos**
  y ruta `POST /api/imap/accounts/:id/check` para comprobar al momento.
- **Apagado**: `IMAP_WATCH=off` o `CHANNELS_AUTOSTART=off`. Nunca impide arrancar.
- Pruebas:
  - `node scripts/probe-imap-nudge.mjs` → **5/5 PASS** (detecta, nombra la
    bandeja, conserva cuenta, sin falsos avisos). En `npm test`.
  - `node scripts/verify-imap.mjs` → **34/34 PASS**, incluido: correo nuevo
    detectado sin leerlo, contador visible, «Ver últimos» lo reconoce y lo pone a 0.
- Service worker: `2026-10-28.29`.

## 39. Borrador editable antes de la propuesta (2026-10-28)

- **Proponer respuesta** ya no crea la propuesta directamente: pide la
  previsualización (`preview:true`) y muestra **asunto** y **cuerpo** en campos
  editables, con la firma completa ya puesta.
- El jefe corrige el texto y pulsa **Crear propuesta para aprobación**; solo
  entonces se crea la propuesta N2 en la Oficina, con el texto final (`engine:
  "editado"`). **Descartar** no crea nada.
- Si el cuerpo editado no trae la firma, se añade «Héctor Fabio Riascos C.».
- La aprobación juzga el texto final, no el generado: el gate no cambia y el
  envío sigue saliendo por SMTP/Gmail según configuración.
- Código: `buildReplyProposal({preview, body, subject})` en
  `lib/channel/imap-reply.mjs`, ruta con `preview/body/subject`, y panel
  `#imapReplyBody`/`#imapReplySubject` + `[data-imap-create]` en la UI.
- Pruebas: `node scripts/verify-imap.mjs` → **38/38 PASS**, incluido:
  previsualización sin propuesta, borrador editable con firma, propuesta con el
  texto corregido y llegada a la Oficina. Captura:
  `docs/capturas/vista-imap-borrador.png`.
- Service worker: `2026-10-28.31`.

## 40. Auto-borrador de respuestas (2026-10-28)

- Por bandeja, casilla **Auto-borrador**. Al activarla, cada vez que la
  vigilancia detecta correo nuevo, la oficina **redacta una propuesta de
  respuesta** y la deja en la Oficina. **Nunca envía sola**: es N2 y requiere
  aprobación.
- Límites: máximo **3 correos por pasada**; omite remitentes automáticos
  (`no-reply`, `mailer-daemon`, `postmaster`, `bounce`) y boletines
  (`newsletter`, `unsubscribe`). Cada UID se marca y no se repite.
- Botón **Redactar nuevos** ejecuta la pasada al momento
  (`POST /api/imap/accounts/:id/auto-draft`); `PATCH /api/imap/accounts/:id`
  con `{autoDraft:true|false}` la activa o desactiva.
- Los UIDs nuevos detectados quedan en `pendingUids` de la cuenta hasta que se
  redactan o se leen; así “Buscar nuevos” y “Redactar nuevos” no se pisan.
- Pruebas: `node scripts/verify-imap.mjs` → **46/46 PASS**, incluido:
  activar/validar auto-borrador, propuesta automática firmada en la Oficina,
  sin duplicados, omisión de remitentes automáticos y casilla en la UI.
- Service worker: `2026-10-28.32`.

## 41. Edición de propuestas en la Oficina (2026-10-28)

- Botón **Editar** en propuestas `pending`/`held`: abre un diálogo con asunto y
  cuerpo. Al guardar se llama `POST /api/office/proposals/:id/revise`.
- La revisión **recalcula riesgo y nivel** con el texto nuevo (puede pasar de N2
  a N3), guarda el historial en `revisions` y en el ledger
  (`propuesta.revisada`). La propuesta sigue **pendiente**: hay que aprobarla de
  nuevo. Nunca se envía sola.
- Una propuesta **aprobada o ejecutada no se puede editar** (409); hay que crear
  otra. Los cambios invalidan cualquier aprobación previa por el hash firmado.
- UI: `#dlg-proposal-edit` + `editProposal`/`saveProposalEdit` en
  `public/js/office.js`; ruta en `lib/routes/office.mjs`; lógica
  `reviseProposal` en `lib/office/proposals.mjs`.
- Pruebas:
  - `node scripts/probe-proposal-revise.mjs` → **9/9 PASS** (riesgo 5→10,
    N2→N3, historial, ledger, vacío rechazado, aprobada inmutable).
  - `node scripts/verify-imap.mjs` → **51/51 PASS**, incluido revisar la
    propuesta automática, aprobar/ejecutar la versión revisada, comprobar que
    sale el texto revisado y editar desde la UI de la Oficina.
  - Captura: `docs/capturas/vista-oficina-revision.png`.
- Service worker: `2026-10-28.33`.

## 42. Aviso consolidado de aprobaciones (2026-10-28)

- Antes el motor generaba un aviso por propuesta (hasta 5). Ahora genera **uno
  solo** con el total, la propuesta **más antigua primero**, su antigüedad
  (`ageHours`), `daysOverdue` para priorización y un resumen de las 3 primeras.
- El mensaje incluye «desde hace X horas/días» y la Oficina muestra la etiqueta
  **Esperando X h** en cada propuesta pendiente.
- `fingerprint = approvals:<count>:<oldestId>`: si cambia el número o la más
  antigua, el aviso puede volver a sonar; si no, respeta el dedupe.
- Pruebas: `node scripts/probe-nudges-approvals.mjs` → **7/7 PASS** (consolida,
  cuenta, ordena por antigüedad, calcula edad, sin pendientes, una sola). En
  `npm test`.
- Service worker: `2026-10-28.34`.

## 43. Wiki interna (2026-10-28)

- Módulo opcional que ya está desarrollado: **memoria escrita de la oficina** con
  búsqueda por título, contenido y etiquetas.
- Vistas: menú **❏ Wiki**. Lista a la izquierda con buscador; editor a la derecha
  con título, etiquetas y contenido; botones Guardar, Borrar y Cancelar.
- API:
  - `GET /api/wiki/pages?q=&tag=&limit=&offset=` (no devuelve el cuerpo, solo
    `bodyPreview`)
  - `POST /api/wiki/pages` `{title, body, tags?}`
  - `GET /api/wiki/pages/:id` (cuerpo completo)
  - `PATCH /api/wiki/pages/:id` `{title?, body?, tags?}`
  - `DELETE /api/wiki/pages/:id`
  - `GET /api/wiki/stats`
- Datos en `data.wiki.pages` (viaja en backup/restore). IDs `WK-0001`, máximo 500
  páginas, cuerpo 50.000 caracteres, 12 etiquetas. Todo se escapa en la UI.
- Pruebas:
  - `node scripts/probe-wiki.mjs` → **15/15 PASS** (crear, listar, buscar, filtrar,
    editar, validaciones, borrar, persistencia). En `npm test`.
  - `node scripts/verify-wiki.mjs` → **12/12 PASS** con API y Chrome real:
    crear/editar/borrar desde la UI, búsqueda y captura
    `docs/capturas/vista-wiki-light.png`.
- Service worker: `2026-10-28.35`.

## 44. Reglas de correo y cuarentena (2026-10-28)

- **Reglas** en `data.mailRules.rules`: campo `from|subject`, condición
  `contains|equals|domain`, texto y acción `quarantine|skip`. Se evalúan **antes**
  de que el auto-borrador redacte una respuesta.
- **Cuarentena** en `data.quarantine.items` (`held` → `released|discarded`).
  Retener **no responde ni envía nada**: solo aparta el mensaje y lo muestra en
  Integraciones → «Reglas de correo y cuarentena».
- Desde la cuarentena:
  - **Redactar** libera el mensaje y compone una propuesta N2 firmada en la
    Oficina (sigue necesitando tu aprobación).
  - **Descartar** lo archiva sin redactar.
- API: `GET/POST /api/mail/rules`, `DELETE /api/mail/rules/:id`,
  `GET /api/mail/quarantine`, `POST /api/mail/quarantine/:id/release`,
  `POST /api/mail/quarantine/:id/discard`.
- Pruebas:
  - `node scripts/probe-mail-guard.mjs` → **15/15 PASS** (dominio con
    subdominios, omisión por asunto, dedupe, liberar, descartar, persistencia).
    En `npm test`.
  - `node scripts/verify-imap.mjs` → **59/59 PASS**, incluido: la regla evita
    redactar al spam, queda en cuarentena, liberar crea propuesta firmada y la
    tarjeta crea/quita reglas desde la UI.
  - Captura: `docs/capturas/vista-reglas-correo.png`.
- Service worker: `2026-10-28.36`.

## 45. Tema visual azul y herencia de paneles (2026-10-28)

- **Acento único azul** en los tres temas (`claro`, `oscuro`, `sistema`):
  botones, chips activos, navegación, enlaces, foco, tags positivos y toggles
  LED. Se eliminó el verde del tema claro y del oscuro (el éxito también es
  azul/cian). El rojo queda para peligro y el ámbar para advertencia.
- **Paneles heredados**: claro y oscuro comparten el mismo diseño de tarjeta
  (fondo traslúcido, borde, radio, sombra y blur 16 px) mediante tokens
  `--panel`, `--panel-2`, `--panel-soft`, `--panel-strong` y `--accent-soft`.
  El oscuro usa fondo plano `#061426` sin halos ni degradados de fondo; el claro
  sigue en blanco puro. Ambos usan el mismo ancho de contenido (máx. 1650 px),
  el mismo padding y la misma tipografía Inter 14 px.
- Tokens del claro: `--blue/--cyan #1f6feb`, líneas `rgba(31,111,235,.22)`,
  LED `#2f9bff`. Tokens del oscuro: acento `#4c9dff`, LED `#37d1ff`, texto
  `#eef5ff`.
- `theme-color` del manifiesto y de la barra del navegador en azul
  (`#1f6feb`); el oscuro usa `#061426`.
- Pruebas:
  - `node scripts/verify-theme.mjs` → **26/26 PASS** (contrastes AA, selector,
    sistema, móvil, sin desbordamiento, sin errores).
  - Capturas: `docs/capturas/tema-light-azul.png`,
    `tema-dark-azul.png`, `tema-*-integraciones.png`.
- Service worker: `2026-10-28.37`.

## 46. Base de tablas (2026-10-28)

- Vista **▦ Base**: tablas con columnas tipadas (`texto`, `número`, `fecha`,
  `casilla`), filas editables y borrado con confirmación.
- Crear tabla: nombre + columnas en formato `Nombre:texto, Fecha:fecha,
  Valor:número, Pagado:casilla` (o array `[{name,type}]` por API).
- Filas: añadir, editar (rellena el formulario y guarda con PATCH) y borrar.
  Validación: número finito, fecha `AAAA-MM-DD`, checkbox booleano, texto ≤2000.
- Límites: 20 tablas, 500 filas por tabla, 12 columnas, nombres únicos.
- API: `GET/POST /api/base/tables`, `GET/DELETE /api/base/tables/:id`,
  `POST /api/base/tables/:id/rows`, `PATCH/DELETE .../rows/:rowId`.
- Datos en `data.base.tables`; IDs `TB-0001` y `ROW-0001`; incluido en
  backup/restore.
- Pruebas:
  - `node scripts/probe-base.mjs` → **14/14 PASS** (tipos, validaciones,
    actualización parcial, duplicados, borrado, persistencia). En `npm test`.
  - `node scripts/verify-base.mjs` → **11/11 PASS** con Chrome real: crear
    tabla, añadir/editar/borrar fila y borrar tabla desde la UI.
  - Captura: `docs/capturas/vista-base-light.png`.
- Service worker: `2026-10-28.38`.

## 47. Gmail: responder en el hilo real (2026-10-28)

- Cuando una respuesta sale por la **API de Gmail** y el mensaje llegó por IMAP
  (sin `threadId` de Gmail), se busca el hilo con
  `GET /users/me/messages?q=rfc822msgid:<Message-ID>` y se envía con ese
  `threadId` más `In-Reply-To`/`References`. Así la respuesta aparece en el
  mismo hilo también desde Gmail.
- Si la búsqueda falla o no hay coincidencia, el envío continúa **sin**
  `threadId` (no se bloquea el correo); queda el aviso en el resultado.
- Función: `gmailThreadIdForMessage(accessToken, messageIdHeader)` en
  `lib/channel/email.mjs`. Se usa en las dos rutas de envío ricas y simples.
- Pruebas: `node scripts/probe-gmail-thread.mjs` → **6/6 PASS** contra un Gmail
  API local (consulta `rfc822msgid`, token, sin ID, sin token, sin resultados,
  error 500 explícito). En `npm test`.
- Service worker: `2026-10-28.39`.

## 48. Traducción de correos (2026-10-28)

- Botón **Traducir** en cada mensaje de «Ver últimos» de las bandejas IMAP.
  Pide idioma destino (`es, en, pt, fr, de, it`) y muestra la traducción en la
  misma tarjeta.
- `POST /api/translate {text, to, from?}` usa el LLM configurado en
  Integraciones con temperatura 0. El texto va delimitado como dato
  (`<usuario>…</usuario>`) y el sistema prohíbe obedecer instrucciones internas.
- Sin proveedor LLM responde **503 `TRANSLATE_UNAVAILABLE`**; nunca inventa una
  traducción ni usa un fallback determinista.
- Límites: 4.000 caracteres, idiomas de la lista. `GET /api/translate/languages`.
- Pruebas: `node scripts/probe-translate.mjs` → **8/8 PASS** con el LLM simulado
  (idiomas, traducción, proveedor, envoltura anti-inyección, idioma inválido,
  texto vacío y excesivo). En `npm test`.
- Service worker: `2026-10-28.40`.

## 49. Léxico / Lingo con pantalla (2026-10-28)

- Nueva vista **◇ Léxico** (entre Base y Estilo):
  - Crear término canónico + variantes + contexto. Todo entra en `shadow`.
  - Aprobar / devolver a sombra / rechazar por término; el rechazo pide
    confirmación y conserva el término.
  - Buscar por nombre o variante y filtrar por estado.
  - Probar canonicalización sobre un texto libre, incluyendo sombra, y ver los
    cambios `variante → canónica`.
- API existente: `GET/POST /api/lingo/terms`, `PATCH /api/lingo/terms/:id`,
  `POST /api/lingo/apply`, `/learn`, `/suggest`, `GET /hotwords`.
- Reglas: máximo 5.000 términos y 30 variantes; las variantes no pueden
  pertenecer a dos términos (409); cada cambio queda en el ledger de la Oficina
  como `lingo.change`.
- Pruebas: `node scripts/verify-lingo.mjs` → **14/14 PASS** con Chrome real
  (sombra no aplica por defecto, aprobar sí, crear/aprobar/rechazar/filtrar y
  probar desde la UI). `npm test` incluye `selfcheck lingo`.
- Captura: `docs/capturas/vista-lingo-light.png`.
- Service worker: `2026-10-28.41`.

## 50. Auditoría consultable (2026-10-28)

- Nueva vista **◎ Auditoría** (junto a Avisos): resumen del ledger, filtros por
  actor/acción/texto/fechas, tabla con huella y payload desplegable, verificación
  de cadena y exportación JSON/CSV con los filtros aplicados.
- API de solo lectura:
  - `GET /api/audit/events?actor=&action=&q=&from=&to=&limit=&offset=`
  - `GET /api/audit/stats`
  - `GET /api/audit/export?format=json|csv&<filtros>`
- Fechas reales `AAAA-MM-DD` (rechaza 2026-02-31) y rango coherente; límite 500
  por consulta. El CSV neutraliza fórmulas (`=`, `+`, `-`, `@`) para que una
  hoja de cálculo no las ejecute.
- El ledger no se modifica: la vista solo lee y verifica. La exportación JSON
  incluye el resultado de la verificación.
- Pruebas:
  - `node scripts/probe-audit.mjs` → **7/7 PASS** (orden, filtros, fechas,
    estadísticas, CSV con fórmula neutralizada). En `npm test`.
  - `node scripts/verify-audit.mjs` → **15/15 PASS** con Chrome real (API y UI:
    abrir, filtrar, limpiar, verificar cadena, exportaciones).
- Captura: `docs/capturas/vista-auditoria-light.png`.
- Service worker: `2026-10-28.42`.

## 51. Captura de reunión → acta (2026-10-28)

- En **Documentos** hay una tarjeta «Captura de reunión → acta»: pega la
  transcripción, pon título/fecha/hora/lugar y pulsa **Extraer acuerdos**.
- `POST /api/meetings/capture` envía la transcripción al LLM con JSON estricto y
  devuelve resumen (máx. 4 líneas), asistentes, orden del día, desarrollo,
  acuerdos y riesgos. No inventa: lo que no aparece queda vacío.
- **Notas privadas** no se envían al modelo; se adjuntan como anexo privado del
  acta. El cuerpo del acta y el resumen no las incluyen.
- Tras revisar la extracción, **Crear acta y tareas** llama a `/api/docs` con la
  plantilla `acta`; el DOCX se guarda y cada acuerdo se convierte en tarea
  (origen acta).
- Límites: transcripción 30–20.000 caracteres; 20 asistentes/acuerdos; sin LLM
  responde 503 y no inventa un acta.
- Pruebas:
  - `node scripts/probe-meeting-capture.mjs` → **9/9 PASS** (extracción,
    metadatos, envoltura anti-inyección, notas privadas fuera del prompt,
    validaciones, DOCX y tarea). En `npm test`.
  - `node scripts/verify-meeting-capture.mjs` → **9/9 PASS** con Chrome real:
    extraer, previsualizar, crear acta, tarea y descargar DOCX.
- Captura: `docs/capturas/vista-captura-reunion-light.png`.
- Service worker: `2026-10-28.43`.

## 52. Identidades multicorreo con pantalla (2026-10-28)

- Nueva vista **◉ Identidades**: une una persona con hasta 10 correos y alias,
  y comprueba exactamente a cuántas direcciones se enviaría antes de redactar.
- **Añadir o fusionar**: si el nombre ya existe, suma correos/alias sin duplicar
  la persona. El motor (`/api/identity/contacts`, prioridad 120) ya existía.
- **Probar destinatarios**: usa el mismo resolvedor que la redacción; muestra
  personas, correos, duplicados eliminados y avisa si hay ambigüedad o
  confianza < 80 %.
- La lista oculta los alias sin correo (son pistas del grafo, no personas).
- Caso 2×2: dos personas «Andrés M.» y «Andrés P.» con dos correos cada una →
  expandir «Andrés» devuelve **4 destinatarios** y exige confirmación.
- Pruebas:
  - `node scripts/verify-identity.mjs` → **13/13 PASS** (API y Chrome real:
    crear, fusionar, 4 destinos, ambigüedad, búsqueda y sin errores).
  - `npm test` ya incluye `probe-identity4` (2×2 → 4).
- Captura: `docs/capturas/vista-identidades-light.png`.
- Service worker: `2026-10-28.44`.

## 53. Verificación visual de las vistas nuevas en oscuro (2026-10-28)

- `node scripts/verify-dark-views.mjs` → **11/11 PASS** con Chrome real:
  fondo `rgb(6,20,38)` plano, paneles con `blur(16px)` y radio 22, shell 1650 px,
  Inter 14 px, sin desbordamiento horizontal y las cinco vistas nuevas
  (Base, Léxico, Identidades, Auditoría, Documentos/Captura) con contenido y
  sin errores de consola.
- Capturas: `docs/capturas/dark-base.png`, `dark-lingo.png`,
  `dark-identity.png`, `dark-audit.png`, `dark-docs.png`.
- El tema oscuro hereda el diseño del claro (misma retícula, tarjetas y anchos);
  solo cambian color de fondo y tokens, como se pidió.

## 54. Loop guard (2026-10-28)

- Protección contra bucles de mensajes, detrás del flag `loop_guard` de
  **Funciones**. Modos: `off` (solo observa), `shadow` (detecta y cuenta, no
  bloquea) y `on` (bloquea).
- Reglas: **3 mensajes idénticos** al mismo destino en **10 minutos**, o
  **20 mensajes** al mismo destino en 10 minutos. El cuerpo se normaliza
  (espacios, mayúsculas y prefijos `Re:/Fw:`), así que una respuesta repetida con
  otro prefijo también se detecta.
- Se integra envolviendo los adaptadores de canal (`email`, WhatsApp, Telegram,
  webhook genérico); el simulador queda fuera. Un envío fallido o `skipped` no
  cuenta; el bloqueo no se registra como enviado.
- Al bloquear lanza `LOOP_GUARD` (429) con el motivo; el llamador no debe
  reintentar automáticamente.
- Pruebas: `node scripts/probe-loop-guard.mjs` → **10/10 PASS** (modos,
  duplicado, destino distinto, fallo/omitido no registrados, límite por destino
  y error explicativo). En `npm test`.
- El flag está apagado por defecto: no cambia el comportamiento actual hasta
  que lo actives en **Ajustes → Funciones**. Recomendado empezar en `shadow`.
- Service worker: `2026-10-28.45`.

- Diagnóstico: `GET /api/loop-guard/status` (modo y contadores en memoria) y
  `POST /api/loop-guard/reset` (limpia contadores). No envía mensajes.

## 55. Centro de aprobaciones (2026-10-28)

- Nueva vista **✓ Aprobaciones** (entre Oficina y Documentos): reúne propuestas
  `pending`/`held`, propuestas `approved` pendientes de ejecutar y correo en
  cuarentena. Muestra antigüedad de la más vieja y cuántas exigen código N3.
- Acciones: aprobar (con confirmación), rechazar (con motivo opcional), ejecutar
  (pide código N3 si no se guardó), liberar o descartar cuarentena.
- Reutiliza las APIs existentes de Oficina y reglas de correo; no duplica datos ni
  crea un segundo ledger. La propuesta ejecutada desaparece de “por ejecutar”.
- Si el ejecutor no está conectado, la aprobación queda hecha y se avisa; no se
  marca como ejecutada.
- Pruebas: `node scripts/verify-approvals.mjs` → **10/10 PASS** con Chrome real
  (tres pendientes, aprobar, rechazar, mover a por ejecutar, ofrecer ejecución,
  cuarentena vacía, consola limpia).
- Captura: `docs/capturas/vista-aprobaciones-light.png`.
- Service worker: `2026-10-28.46`.

## 56. Objetivos (OKR) (2026-10-28)

- Nueva vista **◎ Objetivos** (junto a Tareas): crea objetivos con responsable y
  trimestre, añade resultados clave medibles y actualiza el avance.
- Progreso por resultado = `current / target` acotado a 100 %; progreso del
  objetivo = media de sus resultados. Estados: `active`, `done`, `paused`.
- Acciones: crear objetivo, añadir resultado, guardar avance, borrar resultado,
  completar/pausar/reactivar, borrar objetivo (con confirmación).
- Límites: 30 objetivos, 10 resultados por objetivo, meta > 0, avance ≥ 0;
  IDs `OK-0001` / `KR-0001`. Cada cambio queda en el ledger como `okr.change`.
- API: `GET/POST /api/okr/objectives`, `GET/PATCH/DELETE /api/okr/objectives/:id`,
  `POST .../:id/key-results`, `PATCH/DELETE .../:id/key-results/:krId`,
  `GET /api/okr/stats`.
- Pruebas:
  - `node scripts/probe-okr.mjs` → **9/9 PASS** (cálculo, estados, filtros,
    validación, borrado). En `npm test`.
  - `node scripts/verify-okr.mjs` → **13/13 PASS** con Chrome real (crear,
    añadir resultado, avanzar, completar y consola limpia).
- Captura: `docs/capturas/vista-objetivos-light.png`.
- Service worker: `2026-10-28.47`.

## 57. Métricas de aprobación (2026-10-28)

- El Centro de aprobaciones muestra ahora **tiempo medio** hasta aprobar,
  **pendiente más antigua**, **fuera de SLA**, **aprobadas en la ventana**,
  **ejecutadas** y **cuarentena**.
- `GET /api/approvals/metrics?slaHours=24&windowDays=7` calcula sobre
  `office.proposals` y `quarantine`; solo lectura, sin datos nuevos.
- Tiempo de aprobación = `approvedAt - createdAt`; tiempo de ejecución =
  `executedAt - approvedAt`. Se promedian solo valores válidos; sin datos
  devuelve `null`, no cero inventado.
- SLA por defecto 24 h; ventana por defecto 7 días. Una propuesta `pending` o
  `held` cuenta como pendiente; las `executed` con `approvedAt` cuentan también
  en actividad de aprobación.
- Pruebas:
  - `node scripts/probe-approval-metrics.mjs` → **7/7 PASS** (estados, SLA,
    tiempos, actividad, niveles/cuarentena, sin datos). En `npm test`.
  - `scripts/verify-approvals.mjs` actualizado → **11/11 PASS** con métricas en
    la UI.
- Captura actualizada: `docs/capturas/vista-aprobaciones-light.png`.
- Service worker: `2026-10-28.48`.

## 58. Etiquetas de seguridad en Documentos (2026-10-28)

- Cada documento muestra su etiqueta ACL (`público`, `interno`, `reservado`) y
  permite cambiarla desde la lista con `PUT /api/acl/documents/:docId`.
- Un documento **reservado** no sale por correo directo: la ruta
  `/api/docs/:id/send-email` la gana el módulo de canales, que crea una propuesta
  y aplica ACL/N3. El envío de reservado a externos exige confirmación explícita
  y código N3; sin eso responde `403 ACL_DENIED`.
- El diálogo de envío avisa en rojo si el documento es reservado y recuerda usar
  un canal de la Oficina para el gate N3.
- No se duplicó la etiqueta en el índice de documentos: la fuente de verdad es
  `lib/acl`; el índice solo guarda el archivo. Al borrar un documento su registro
  ACL puede quedar huérfano (no afecta; no se muestra porque la lista se cruza
  con documentos existentes).
- Pruebas: `node scripts/verify-doc-labels.mjs` → **10/10 PASS** con Chrome real
  (nace interno, reservado bloquea, público permite, cambio desde UI, aviso,
  consola limpia). Captura: `docs/capturas/vista-documentos-etiquetas-light.png`.
- Service worker: `2026-10-28.49`.

## 59. Salas físicas (2026-10-28)

- Nueva vista **▣ Salas**: alta de salas (nombre, ubicación, capacidad, notas),
  disponibilidad por día y reservas con control de cruces.
- Regla de choque: misma sala, misma fecha y rangos que se solapan
  (`inicio < otro.fin && otro.inicio < fin`) → `409 ROOM_CONFLICT` con la reserva
  que choca en `details`. Reservas contiguas (10:00–11:00 tras 09:00–10:00) sí
  se permiten.
- Cancelar una reserva la deja `cancelled` y libera el horario; borrar una sala
  con reservas activas responde `409 ROOM_HAS_RESERVATIONS`.
- IDs `RM-0001` / `RS-0001`; límites 20 salas y 1000 reservas. Cada cambio deja
  `rooms.change` en el ledger.
- API: `GET /api/rooms?date=`, `GET /api/rooms/availability?date=`,
  `GET /api/rooms/stats`, `POST /api/rooms`, `PATCH/DELETE /api/rooms/:id`,
  `POST /api/rooms/:id/reservations`, `DELETE /api/rooms/reservations/:id`.
- Pruebas:
  - `node scripts/probe-rooms.mjs` → **13/13 PASS** (alta, choque, contiguas,
    disponibilidad, cancelación, borrado bloqueado, fecha irreal). En `npm test`.
  - `node scripts/verify-rooms.mjs` → **10/10 PASS** con Chrome real (API, UI,
    reserva, cancelación, borrado, consola limpia).
- Captura: `docs/capturas/vista-salas-light.png`.
- Service worker: `2026-10-28.50`.

## 60. Momentos: resumen semanal (2026-10-28)

- Nueva vista **✦ Momentos**: resumen determinista de los últimos 7 días y los
  próximos 7, sin modelo y sin escrituras.
- Cruza agenda, tareas, documentos, propuestas de Oficina, OKR y reservas de
  salas. Devuelve contadores, **Te espera** (aprobaciones pendientes, tareas
  vencidas, OKR en riesgo), **Lo que avanzó** (tareas cerradas, documentos,
  ejecuciones, avance OKR), próximos eventos y salas reservadas.
- Botón **Copiar resumen** con texto corto listo para pegar en un chat o correo.
- API: `GET /api/moments/weekly?at=ISO` (`at` opcional para pruebas). Solo
  lectura; no hay tabla ni ledger nuevos.
- Pruebas:
  - `node scripts/probe-moments.mjs` → **8/8 PASS** (ventana, tareas, prioridades,
    OKR, eventos, salas, texto). En `npm test`.
  - `node scripts/verify-moments.mjs` → **12/12 PASS** con Chrome real (evento,
    tarea vencida, propuesta, sala, UI y consola).
- Captura: `docs/capturas/vista-momentos-light.png`.
- Service worker: `2026-10-28.51`.

## 61. Jornada (2026-10-28)

- Nueva vista **◷ Jornada**: entrada, salida y pausas con historial por rango
  (desde/hasta) y resumen de horas, días, promedio y turnos.
- Un solo turno abierto a la vez (`409 ALREADY_OPEN`); cerrar sin jornada abierta
  da `409 NOT_OPEN`; la pausa resta minutos al total (1–480 por registro).
- IDs `AT-0001`; máximo 2000 turnos. `PATCH /api/attendance/:id` permite corregir
  entrada/salida/pausa/nota; `DELETE` borra el turno. Cada cambio deja
  `attendance.change` en el ledger.
- API: `GET /api/attendance?from=&to=`, `GET /api/attendance/summary`,
  `POST /api/attendance/clock-in`, `/clock-out`, `/break`, `PATCH/DELETE /:id`.
- Pruebas:
  - `node scripts/probe-attendance.mjs` → **10/10 PASS** (apertura, duplicado,
    pausa, cierre, resumen, corrección, errores, borrado). En `npm test`.
  - `node scripts/verify-attendance.mjs` → **9/9 PASS** con Chrome real (entrada,
    pausa, salida, resumen, borrado, consola).
- Captura: `docs/capturas/vista-jornada-light.png`.
- Service worker: `2026-10-28.52`.

## 62. Preguntar a la Base (2026-10-28)

- La vista **Base** incluye un cuadro **Preguntar a la base**: lenguaje natural
  sobre tablas reales, sin SQL y sin modelo generativo.
- Entiende conteos (`¿cuántos…?`) y filtros simples por columna:
  `columna = valor`, `contiene`, `no es`, `mayor que`, `menor que`, `≥`, `≤`.
  Si hay varias tablas y no se nombra ninguna, dice la ambigüedad; si no hay
  filtro, avisa y muestra el conteo.
- Respuesta: frase + tabla de filas coincidentes (máx. 20) + filtros aplicados.
  No inventa filas ni columnas.
- API: `POST /api/base/ask {question, tableId?}`. Solo lectura.
- Pruebas:
  - `node scripts/probe-ask-base.mjs` → **7/7 PASS** (texto, número, contiene,
    conteo, ambigüedad, otra tabla, pregunta vacía). En `npm test`.
  - `node scripts/verify-ask-base.mjs` → **7/7 PASS** con Chrome real (API + UI,
    filas reales, consola limpia).
- Captura: `docs/capturas/vista-base-preguntar-light.png`.
- Service worker: `2026-10-28.53`.

## 63. Módulos de oficina en Ajustes (2026-10-28)

- La vista **Integraciones y ajustes** incluye el panel **Módulos de oficina**:
  Aprobaciones, Objetivos, Salas, Jornada, Momentos, Base, Documentos y Wiki,
  cada uno con su contador real y botón **Abrir**.
- No introduce un segundo sistema de permisos ni oculta módulos: es un catálogo
  de descubrimiento sobre los módulos ya existentes. Los contadores se leen de
  las APIs actuales; si una falla, muestra «—» sin romper el panel.
- Prueba: `node scripts/verify-modules-panel.mjs` → **4/4 PASS** con Chrome real
  (8 módulos, contadores, navegación y consola limpia).
- Captura: `docs/capturas/vista-modulos-ajustes-light.png`.
- Service worker: `2026-10-28.54`.

## 64. Tipos de aprobación y solicitudes (2026-10-28)

- El Centro de aprobaciones incluye **Tipos de solicitud**: nombre, nivel N1/N2,
  campos (`Etiqueta:texto|número|fecha|casilla`) y descripción. Sin código.
- Con un tipo se crea una **solicitud** con sus campos; queda pendiente y se
  aprueba o rechaza (con motivo). Todo deja `approval.change` en el ledger.
- IDs `APT-####` (tipos) y `APR-####` (solicitudes); límites 20 tipos / 1000
  solicitudes. No ejecuta envíos ni sustituye al gate de la Oficina.
- Pruebas:
  - `node scripts/probe-approval-types.mjs` → **10/10 PASS** (campos, solicitud,
    obligatorios, aprobar, doble decisión, rechazar, listas, stats, nivel, borrar).
  - `node scripts/verify-approval-types.mjs` → **4/4 PASS** con Chrome real (tipo,
    campos dinámicos, solicitud, aprobar, consola).
- Captura: `docs/capturas/vista-tipos-aprobacion-light.png`.
- Service worker: `2026-10-28.55`.

## 65. Copia de seguridad descargable (2026-10-28)

- Ajustes incluye **Copia de seguridad**: descarga un JSON con agenda, tareas,
  rutinas, documentos (solo metadatos), propuestas/ledger de Oficina, OKR, salas,
  jornada, Base, Wiki y tipos/solicitudes de aprobación.
- Excluye deliberadamente vault, contraseñas, tokens, conexiones y binarios de
  documentos. El archivo se genera en memoria; no escribe ni altera datos.
- API: `GET /api/admin/export`. Estructura `{format, version, generatedAt,
  counts, notice, data}`.
- Pruebas:
  - `node scripts/probe-backup.mjs` → **6/6 PASS** (formato, conteos, oficina,
    sin secretos, aviso, metadatos). En `npm test`.
  - `node scripts/verify-backup.mjs` → **5/5 PASS** con Chrome real (API, sin
    secretos, botón, contadores, consola).
- Captura: `docs/capturas/vista-copia-seguridad-light.png`.
- Service worker: `2026-10-28.56`.

## 66. Historial de versiones de Documentos (2026-10-28)

- Cada documento tiene **Versiones**: agrupa los documentos existentes con el
  mismo título (sin distinguir mayúsculas) y los muestra del más nuevo al más
  viejo, con fecha, nombre de archivo y descarga.
- No duplica ni guarda historial aparte: es una vista de los documentos ya
  generados. Si borras una versión, desaparece del grupo.
- API: `GET /api/docs/:id/versions`.
- Pruebas:
  - `node scripts/probe-doc-versions.mjs` → **5/5 PASS** (agrupa, ordena, no mezcla,
    título único, refleja borrado). En `npm test`.
  - `node scripts/verify-doc-versions.mjs` → **6/6 PASS** con Chrome real (API,
    lista, panel, descargas, consola).
- Captura: `docs/capturas/vista-versiones-documento-light.png`.
- Service worker: `2026-10-28.57`.

## 67. Marca de agua en documentos Word (2026-10-28)

- El formulario de Documentos acepta **Marca de agua** (máx. 40 caracteres).
  En DOCX se imprime en gris dentro del encabezado, en cada página.
- El texto se escapa como XML; no se inyecta marcado. En Excel/PowerPoint el
  campo se acepta pero no se dibuja (limitación explícita).
- No es una marca diagonal de fondo ni un sello criptográfico: es una línea de
  encabezado; no protege contra copia, solo identifica el documento.
- Pruebas:
  - `node scripts/probe-watermark.mjs` → **5/5 PASS** (encabezado, sin marca,
    escape, límite). En `npm test`.
  - `node scripts/verify-watermark.mjs` → **4/4 PASS** con Chrome real (campo,
    creación, marca dentro del DOCX, consola).
- Captura: `docs/capturas/vista-marca-agua-documento-light.png`.
- Service worker: `2026-10-28.58`.

## 68. Visibilidad de módulos opcionales (2026-10-28)

- Ajustes → **Módulos de oficina** ahora tiene un toggle **Visible/Oculto** por
  módulo (Aprobaciones, Objetivos, Salas, Jornada, Momentos, Base, Documentos,
  Wiki). Se guarda en `data.settings.modules` y deja `settings.change` en el ledger.
- Ocultar un módulo lo quita del menú, deshabilita su botón «Abrir» y bloquea la
  navegación desde la interfaz. **No borra datos ni apaga su API**: es visibilidad,
  no un permisos ni un kill switch.
- API: `GET /api/settings/modules` · `PATCH /api/settings/modules/:key {enabled}`.
- Pruebas:
  - `node scripts/probe-module-visibility.mjs` → **7/7 PASS** (defaults, ocultar,
    ledger, restaurar, key inválida, valor inválido, no toca otros). En `npm test`.
  - `node scripts/verify-module-visibility.mjs` → **7/7 PASS** con Chrome real
    (toggles, menú, Abrir, navegación bloqueada, consola).
- Captura: `docs/capturas/vista-modulos-visibilidad-light.png`.
- Service worker: `2026-10-28.59`.

## 69. Exportar tablas de Base a CSV (2026-10-28)

- Cada tabla abierta en **Base** tiene **Exportar CSV**: descarga UTF-8 con BOM,
  comillas RFC 4180 y una fila por registro.
- Las celdas que empiezan por `=`, `+`, `-`, `@`, tabulación o retorno se
  neutralizan con un apóstrofo para evitar inyección de fórmulas al abrir el CSV
  en Excel/LibreOffice.
- Casillas → `Sí`/`No`; números sin formato local; fechas `AAAA-MM-DD`.
- API: `GET /api/base/tables/:id/export.csv` (solo lectura).
- Pruebas:
  - `node scripts/probe-base-csv.mjs` → **7/7 PASS** (BOM, filas, comillas,
    casillas, fórmula, salto, nombre). En `npm test`.
  - `node scripts/verify-base-csv.mjs` → **5/5 PASS** con Chrome real (API,
    neutralización, botón, descarga, consola).
- Service worker: `2026-10-28.60`.

## 70. Importar CSV a Base (2026-10-28)

- Cada tabla abierta en **Base** tiene **Importar CSV**: lee el archivo en el
  navegador, lo envía como texto y el servidor lo valida antes de guardar.
- Cabeceras por nombre de columna (sin distinguir mayúsculas); columnas
  desconocidas se rechazan. Casillas aceptan `Sí/No`, `true/false`, `1/0`, `x`.
- La importación es atómica: si una fila falla, no se guarda ninguna. Respeta el
  máximo de 500 filas y 500 KB por archivo.
- No ejecuta fórmulas; si el CSV viene de nuestra exportación, quita el
  apóstrofo protector de las celdas que empiezan por `=`, `+`, `-`, `@`.
- API: `POST /api/base/tables/:id/import.csv` con `{csv}`.
- Pruebas:
  - `node scripts/probe-base-import.mjs` → **8/8 PASS** (parser, mapeo, IDs,
    tipos, fórmula, columna, número, atomicidad). En `npm test`.
  - `node scripts/verify-base-import.mjs` → **4/4 PASS** con Chrome real (tabla,
    botón, archivo real, filas en UI, consola).
- Captura: `docs/capturas/vista-base-importar-light.png`.
- Service worker: `2026-10-28.61`.

## 71. Exportar Base a Excel nativo (2026-10-28)

- Cada tabla abierta en **Base** tiene **Exportar Excel**: genera un `.xlsx`
  real con una hoja, cabeceras, tipos (texto/número/fecha/casilla), anchos,
  autofiltro y primera fila congelada.
- Usa el generador OOXML propio; no instala Excel ni depende de programas
  externos. El archivo se descarga y se abre en Excel/LibreOffice.
- API: `GET /api/base/tables/:id/export.xlsx` (solo lectura).
- Pruebas:
  - `node scripts/probe-base-xlsx.mjs` → **7/7 PASS** (ZIP, partes, textos,
    números/fechas, hoja, nombre, tabla vacía). En `npm test`.
  - `node scripts/verify-base-xlsx.mjs` → **5/5 PASS** con Chrome real (API,
    tipo Excel, botón, descarga real, consola).
- Captura: `docs/capturas/vista-base-excel-light.png`.
- Service worker: `2026-10-28.62`.

## 72. Vistas guardadas de Base (2026-10-28)

- Base permite filtrar por columna y guardar el filtro como **vista** con nombre.
  Las vistas se muestran como chips; al pulsarlas se reaplica el filtro y se
  pueden borrar sin tocar las filas.
- Operadores: contiene, igual, distinto, mayor/menor (y variantes ≥/≤).
  Hasta 10 vistas por tabla y 4 filtros por vista.
- API:
  - `GET /api/base/tables/:id/views`
  - `POST /api/base/tables/:id/views` `{name, filters}`
  - `DELETE /api/base/tables/:id/views/:viewId`
- Las vistas son filtros guardados, no permisos ni columnas calculadas.
- Pruebas:
  - `node scripts/probe-base-views.mjs` → **7/7 PASS** (crear, incluir, duplicado,
    columna inválida, sin filtros, segunda, borrar). En `npm test`.
  - `node scripts/verify-base-views.mjs` → **5/5 PASS** con Chrome real (filtrar,
    conteo, guardar, limpiar, reaplicar, consola).
- Captura: `docs/capturas/vista-base-vistas-guardadas-light.png`.
- Service worker: `2026-10-28.63`.

### Ordenación en vistas (ampliación §72)

- La tabla permite ordenar por cualquier columna pulsando su cabecera;
  segundo clic invierte la dirección. La vista guarda también ese orden.
- `sort` es opcional en la API: `{columnId, direction:'asc'|'desc'}`.
- Prueba E2E de vistas: **6/6 PASS** (filtro, orden asc/desc, guardar, reaplicar).
- Service worker: `2026-10-28.64`.

## 73. Marca de agua en Word, Excel y PowerPoint (2026-10-28)

- Se amplía la marca de agua a los tres formatos:
  - **Word**: texto gris centrado en `word/header1.xml`.
  - **Excel**: `headerFooter` con `oddHeader` gris; se ve al imprimir/vista previa.
  - **PowerPoint**: cuadro de texto gris con transparencia en cada diapositiva.
- El texto se escapa (XML y `&` de Excel); sigue limitado a 40 caracteres.
- No es una marca diagonal de fondo ni un sello criptográfico.
- Prueba: `node scripts/probe-watermark.mjs` → **7/7 PASS** (Word, Excel,
  PowerPoint, escape, límite). La E2E de Word sigue en 4/4.
- Service worker: `2026-10-28.65`.

## 74. SLA en tipos de aprobación (2026-10-28)

- Cada tipo puede definir **SLA en horas** (1–720; 48 por defecto). Al crear una
  solicitud se calcula `dueAt` y, si sigue pendiente pasado el plazo, la lista la
  marca como **vencida** con las horas de retraso.
- El formulario de tipos incluye el campo SLA; cada tipo muestra su plazo y cada
  solicitud su vencimiento. `approvalsStats` incluye `overdue`.
- No hay escalado automático ni reasignación: el SLA es informativo y de control.
- Prueba: `node scripts/probe-approval-types.mjs` → **13/13 PASS** (incluye SLA,
  vencida y fuera de rango). E2E de tipos: **4/4 PASS**.
- Service worker: `2026-10-28.66`.

## 75. De reserva de sala a cita en agenda (2026-10-28)

- Cada reserva activa muestra **Agendar**: abre el diálogo de cita con título,
  fecha, hora, tipo «Reunión», ubicación y nota de la reserva ya puestos.
- Al guardar, la cita pasa por las mismas validaciones que cualquier otra:
  choques de horario, campos y verificación de Google/trayecto.
- No se crea automáticamente: el jefe revisa y guarda. Cancelar la reserva no
  cancela la cita, ni al contrario; no hay vínculo persistente entre ambas.
- Prueba: `node scripts/verify-rooms.mjs` → **11/11 PASS** (incluye prellenado).
- Service worker: `2026-10-28.67`.

## 76. Dictado en la captura de reuniones (2026-10-28)

- Botón **🎙 Dictar transcripción** en la captura: enfoca el campo y arranca
  el mismo motor de voz global (`startListening`). Si el navegador no soporta
  dictado o se niega el micrófono, se explica con el aviso existente.
- El botón flotante sigue funcionando en cualquier campo; este solo hace visible
  la acción en el flujo de actas.
- No graba audio ni lo guarda: usa el reconocimiento del navegador y escribe
  texto en la transcripción. Requiere Chrome/Edge y permiso de micrófono.
- Prueba: `node scripts/verify-meeting-capture.mjs` → **10/10 PASS** (incluye
  el botón de dictado).
- Service worker: `2026-10-28.68`.

## 77. Panel de traducción en Documentos (2026-10-28)

- Documentos incluye **Traducción**: texto de hasta 4.000 caracteres, seis
  idiomas (es, en, pt, fr, de, it), resultado copiable y botón Limpiar.
- Usa `POST /api/translate` y el modelo configurado. Sin modelo responde 503 y
  no inventa la traducción. El texto se envía envuelto como dato; no se guarda.
- Prueba: `node scripts/verify-meeting-capture.mjs` → **12/12 PASS** (incluye
  traducir desde la interfaz y mostrar proveedor/modelo). El probe del backend
  sigue en 6/6.
- Captura: `docs/capturas/vista-traduccion-light.png`.
- Service worker: `2026-10-28.69`.

## 78. Exportar la agenda a .ics (2026-10-28)

- Botón **Exportar ICS** en Agenda: descarga `hector-fabio-riascos-c-AAAA-MM-DD.ics`
  para importar en Google Calendar, Outlook o Apple Calendario.
- `GET /api/agenda/export.ics` genera RFC 5545 en UTC: UID estable por cita,
  título, lugar, contexto/resultado, categoría, prioridad y estado. Omite
  canceladas y citas sin fecha. Escapa comas, puntos y comas y saltos; pliega
  líneas a 75 octetos.
- Es una **copia**, no sincronización: no crea ni modifica eventos en Google.
- Prueba: `node scripts/probe-agenda-ics.mjs` → **9/9 PASS**.
- Service worker: `2026-10-28.70`.

## 79. Editar salas y reservas (2026-10-28)

- **Editar** en cada sala carga el formulario con nombre, ubicación, capacidad y
  notas; **Guardar sala** hace `PATCH /api/rooms/:id`. Cancelar edición restaura
  el formulario de creación.
- **Editar** en cada reserva carga motivo, fecha, inicio y fin; **Guardar reserva**
  hace `PATCH /api/rooms/reservations/:id`. Mantiene la misma sala (no se muda),
  revalida cruces y rechaza reservas canceladas. Cancelar edición restaura el
  formulario de reserva.
- No se edita la sala de una reserva existente: para moverla hay que cancelar y
  reservar de nuevo. Las reservas canceladas no se editan.
- Pruebas: `node scripts/probe-rooms.mjs` → **16/16 PASS**;
  `node scripts/verify-rooms.mjs` → **13/13 PASS**.
- Service worker: `2026-10-28.71`.

## 80. Editar tipos de aprobación (2026-10-28)

- **Editar** en un tipo carga nombre, nivel, SLA y descripción; **Guardar tipo**
  hace `PATCH /api/approval-types/:id`. Los campos dinámicos no se editan: los
  tipos existentes conservan sus campos para no invalidar solicitudes.
- Cancelar edición restaura el formulario de creación y vuelve a habilitar campos.
- Prueba: `node scripts/probe-approval-types.mjs` → **15/15 PASS**;
  `node scripts/verify-approval-types.mjs` → **5/5 PASS**.
- Service worker: `2026-10-28.72`.

## 81. Renombrar tablas de Base (2026-10-28)

- Botón **Renombrar** en la barra de la tabla: pide el nuevo nombre y hace
  `PATCH /api/base/tables/:id`. Conserva columnas, filas y vistas.
- Valida nombre (2–80), duplicados y tabla existente. No renombra el identificador
  `TB-####` ni los archivos ni las vistas.
- Prueba: `node scripts/probe-base-rename.mjs` → **7/7 PASS**;
  `node scripts/verify-base-views.mjs` → **7/7 PASS** (incluye renombrar).
- Service worker: `2026-10-28.73`.

## 82. Duplicar documentos (2026-10-28)

- Botón **Duplicar** en cada documento: crea una copia real con id nuevo,
  archivo nuevo en disco, título «… (copia)» y mismo contenido/sha256.
- Conserva tipo, plantilla y bytes; no altera el original. Respeta límites de
  cantidad, tamaño y almacenamiento. No copia etiquetas ACL ni firmas de envío.
- Prueba: `node scripts/probe-doc-duplicate.mjs` → **7/7 PASS**;
  `node scripts/verify-doc-versions.mjs` → **7/7 PASS** (incluye duplicar).
- Service worker: `2026-10-28.74`.

## 83. Agregar columnas a una tabla de Base (2026-10-28)

- Botón **Añadir columna**: pide nombre y tipo (texto, número, fecha, casilla),
  hace `POST /api/base/tables/:id/columns` y conserva las filas existentes.
- El id se calcula como el siguiente `cN`; no reutiliza ids ni rompe vistas.
  Valida duplicados, tipo inválido y máximo de 12 columnas.
- Las filas existentes quedan con el campo vacío (casilla en falso).
- Prueba: `node scripts/probe-base-column.mjs` → **7/7 PASS**;
  `node scripts/verify-base-views.mjs` → **8/8 PASS** (incluye agregar columna).
- Service worker: `2026-10-28.75`.

## 84. Renombrar columnas de Base (2026-10-28)

- **Renombrar columna** pide el nombre actual y el nuevo; hace
  `PATCH /api/base/tables/:id/columns/:columnId`. Conserva el id `cN`, las filas
  y las vistas guardadas (que referencian el id, no la etiqueta).
- Valida duplicados, columna inexistente y nombre vacío.
- Se corrigió el componente `promptDialog`: dos prompts seguidos podían
  cerrarse por el evento `close` del anterior; ahora resuelve tras drenar el
  cierre. Afecta a cualquier flujo con diálogos encadenados.
- Pruebas: `node scripts/probe-base-column.mjs` → **10/10 PASS**;
  `node scripts/verify-base-views.mjs` → **9/9 PASS**.
- Service worker: `2026-10-28.76`.

## 85. Renombrar documentos (2026-10-28)

- Botón **Renombrar** en Documentos. `PATCH /api/docs/:id` cambia el título y
  regenera el nombre de archivo; no toca los bytes ni los envíos.
- Cada documento guarda una `versionKey` estable (derivada del título al
  crearlo). Renombrar conserva esa clave, así que las versiones anteriores
  siguen agrupadas. Los documentos viejos sin clave usan el título como
  respaldo.
- Duplicar genera una clave nueva: la copia no se mezcla con las versiones.
- Pruebas: `node scripts/probe-doc-rename.mjs` → **8/8 PASS**;
  `node scripts/verify-doc-versions.mjs` → **8/8 PASS**.
- Service worker: `2026-10-28.77`.

## 86. Captura en vivo de reuniones (2026-10-28)

- Botón **● Captura en vivo** en la tarjeta de reunión: dictado continuo al
  campo de transcripción, con texto interino y contador de palabras.
- Usa Web Speech API del navegador (Chrome/Edge). **No guarda audio**: solo
  escribe texto. Requiere micrófono y conexión; el navegador puede enviar el
  audio a su servicio de reconocimiento.
- Se detiene al pulsar de nuevo, al extraer acuerdos o al cerrar la pestaña.
  Si el navegador corta la sesión, se reanuda mientras siga activa.
- Prueba: `node scripts/verify-meeting-capture.mjs` → **13/13 PASS** (incluye
  presencia del botón; el micrófono real no se automatiza).
- Service worker: `2026-10-28.78`.

## 87. Captura en vivo: apagado seguro (2026-10-28)

- Al cambiar de vista, `navigate()` emite `agenda:view`; la captura se detiene
  si la vista destino no es Documentos.
- También se detiene al ocultar la pestaña (`visibilitychange`) y al cerrar
  (`beforeunload`). El botón vuelve a «● Captura en vivo».
- Prueba con reconocimiento simulado:
  `node scripts/verify-live-capture.mjs` → **7/7 PASS**.
- Service worker: `2026-10-28.79`.

## 88. Idioma de la captura en vivo (2026-10-28)

- Selector junto a **● Captura en vivo**: Español (CO), English (US),
  Português (BR), Français (FR). Se pasa a `startLiveDictation({lang})`.
- Se ignoran callbacks tardíos de una sesión ya detenida (`onstart`/`onresult`),
  para que el estado no vuelva a «activa» después de apagar el micrófono.
- Prueba: `node scripts/verify-live-capture.mjs` → **9/9 PASS** (incluye
  español por defecto, inglés elegido y apagado al navegar).
- Service worker: `2026-10-28.80`.

## 89. Guardar transcripción de la reunión (2026-10-28)

- Botón **Guardar transcripción** en la captura: crea un DOCX real con
  «Datos de la reunión» (fecha, hora, lugar) y la transcripción completa.
  No usa LLM; no requiere modelo configurado.
- Parte el texto en párrafos de hasta 1.200 caracteres; máximo 80 bloques.
  Detiene la captura en vivo antes de guardar para no perder texto pendiente.
- Se prueba en `node scripts/verify-meeting-capture.mjs` → **14/14 PASS**.
- Service worker: `2026-10-28.81`.

## 90. Editar turnos de jornada (2026-10-28)

- Botón **Editar** en cada turno: formulario en línea con entrada, salida
  (vacío = abierta), pausa y nota. Usa `PATCH /api/attendance/:id`, que ya
  existía; no se añadió ruta nueva.
- Si la hora mostrada no se modifica, se conserva el ISO original con sus
  segundos. Así, un turno de menos de un minuto no falla al editar solo la nota
  por quedad entrada y salida en el mismo minuto.
- Prueba: `node scripts/verify-attendance.mjs` → **10/10 PASS**.
- Service worker: `2026-10-28.82`.

## 91. Pasada de regresión visual e interacción (2026-10-28)

- `node scripts/verify-theme.mjs` → **26/26 PASS** (claro, oscuro, móvil,
  contraste, sin desbordamiento).
- `node scripts/verify-dark-views.mjs` → **PASS** (lingo, identity, audit,
  docs y auditoría legible en oscuro).
- `node scripts/verify-voice.mjs` → **PASS** (botón, API de reconocimiento,
  reacción al permiso denegado, sin errores).
- `node scripts/verify-tasks.mjs` → **9/9 PASS**, pero **requiere una app en
  `http://127.0.0.1:3310`**. Se levantó con `DATA_DIR` temporal, `PORT=3310`,
  `CHANNELS_AUTOSTART=off` y se apagó al terminar. No apuntar ese script a
  producción: crea, edita y borra tareas reales.
- Producción intacta: PID 38852, 332 rutas, datos sin cambios.

## 92. Editar objetivos y resultados clave (2026-10-28)

- Botón **Editar** en objetivos y en cada resultado clave. Usa los PATCH de
  OKR que ya existían; no se añadieron rutas.
- Objetivo: cambia el título. Resultado: cambia título y meta; conserva el
  avance actual, la unidad, el dueño y el trimestre.
- Validación: título de 3–160 caracteres, meta numérica mayor que cero.
- Prueba: `node scripts/verify-okr.mjs` → **15/15 PASS**.
- Service worker: `2026-10-28.83`.

## 93. Regresión de aprobaciones, salas y Base (2026-10-28)

- `node scripts/verify-approvals.mjs` → **PASS** (bandeja, aprobar, ejecutar,
  cuarentena, consola).
- `node scripts/verify-rooms.mjs` → **PASS** (editar sala, editar reserva,
  cancelar, borrar, cita prellenada, consola).
- `node scripts/verify-base.mjs` → **PASS** (crear tabla/fila/columna, editar,
  borrar fila, borrar tabla, consola).
- Estos E2E levantan su propia app temporal; no tocan producción.
- Producción: PID 37100, 332 rutas; datos sin cambios.

## 94. Eliminar columnas de Base (2026-10-28)

- Botón **Eliminar columna**: pide el nombre y confirma con aviso de pérdida.
- Borra los valores de esa columna en todas las filas. Conserva las demás
  columnas y filas.
- Las vistas que usan la columna pierden ese filtro; si se quedan sin filtros,
  se eliminan y se informa cuántas. El orden por esa columna se limpia.
- Rechaza eliminar la última columna (la tabla necesita al menos una) y
  columnas inexistentes.
- Pruebas: `node scripts/probe-base-column-delete.mjs` → **7/7 PASS**;
  `node scripts/verify-base-views.mjs` → **10/10 PASS**.
- Service worker: `2026-10-28.84`.

## 95. Descargar todos los documentos (2026-10-28)

- Botón **Descargar todo (.zip)** en Documentos y ruta
  `GET /api/docs/export.zip`.
- Empaqueta los binarios reales bajo `documentos/`, con nombres únicos; conserva
  el nombre visible y añade el id si hay colisión.
- Omite archivos cuyo binario falta y reporta `missing` internamente; el ZIP no
  incluye metadatos ni etiquetas ACL.
- Pruebas: `node scripts/probe-doc-archive.mjs` → **6/6 PASS**;
  `node scripts/verify-doc-versions.mjs` → **10/10 PASS**.
- Service worker: `2026-10-28.85`.

## 96. Copia completa y restauración desde Ajustes (2026-10-28)

- **Copia completa**: `GET /api/backup?secrets=none`; incluye datos, ajustes y
  autenticación local; excluye vault, tokens y secretos.
- **Restaurar copia…**: carga un JSON, exige confirmación y la palabra
  `RESTAURAR`, y llama a `POST /api/backup/restore` con `confirm: "RESTORE"`.
  Antes de restaurar, el store guarda una copia `.pre-restore-*.json`.
- No se puede deshacer desde la interfaz. Al terminar, la página se recarga.
- Pruebas: `node scripts/probe-backup-restore.mjs` → **7/7 PASS**;
  `node scripts/verify-backup.mjs` → **10/10 PASS**.
- Service worker: `2026-10-28.86`.

## 97. Restauración sin borrar secretos (2026-10-28)

- Corrección: una copia completa descargada con `?secrets=none` no trae vault
  ni tokens. Al restaurarla, el store conserva los secretos y las conexiones
  Google **actuales** en lugar de borrarlos.
- Una copia que sí trae secretos los reemplaza; el resultado incluye
  `preservedSecrets: true|false`.
- La interfaz avisa que los secretos actuales se conservan.
- Prueba: `node scripts/probe-backup-restore.mjs` → **10/10 PASS**.
- Service worker: `2026-10-28.87`.

## 98. Duplicar filas de Base (2026-10-28)

- Botón **Duplicar** en cada fila. Copia los valores, crea un id nuevo e
  inserta la copia justo después del original.
- No copia historial ni referencias externas; las vistas y filtros se aplican
  igual sobre la copia.
- Rechaza filas inexistentes y el máximo de filas.
- Pruebas: `node scripts/probe-base-duplicate-row.mjs` → **5/5 PASS**;
  `node scripts/verify-base.mjs` → **PASS**.
- Service worker: `2026-10-28.88`.

## 99. Duplicar cita desde la agenda (2026-10-28)

- Botón **Duplicar** en cada cita: abre el formulario como **Nueva cita** con
  título, fecha, hora, prioridad, energía, recordatorio, impacto, urgencia,
  contexto, ubicación, asistentes y notas del original.
- No guarda sola: permite ajustar la fecha antes de crear. La cita original no
  se modifica.
- No duplica el vínculo de Google (`google`/`htmlLink`) para que la copia sea
  local; el enlace Meet se mantiene como texto si existía.
- Prueba: `node scripts/verify-agenda-duplicate.mjs` → **7/7 PASS** (Chrome).
- Service worker: `2026-10-28.89`.

## 100. Imprimir o guardar la agenda como PDF (2026-10-28)

- Botón **Imprimir / PDF** en Agenda. Abre el diálogo de impresión del
  navegador; desde ahí se elige «Guardar como PDF».
- Hoja A4, fondo blanco puro, sin menú lateral, barra superior, filtros ni
  botones. Incluye membrete con nombre y fecha/hora de generación.
- Las filas no se cortan entre páginas. El tema oscuro no contamina la hoja.
- Prueba: `node scripts/verify-agenda-print.mjs` → **7/7 PASS**, con PDF real
  generado por Chrome (64 KB).
- Service worker: `2026-10-28.90`.

## 101. Grabar audio de la reunión (local) (2026-10-28)

- Botón **Grabar audio** en la captura de reunión. Graba con MediaRecorder,
  pide permiso de micrófono y al detener descarga el archivo en este equipo.
- No sube el audio al servidor, no lo guarda en `DATA_DIR` y no lo transcribe:
  la transcripción sigue siendo la captura en vivo o el texto pegado.
- Formatos: WebM/Opus cuando el navegador lo permite; si no, WebM u OGG.
- Se detiene al salir de Documentos o al ocultar la pestaña, y libera el
  micrófono. Si se inicia la captura en vivo, se detiene la grabación.
- Prueba: `node scripts/verify-meeting-recording.mjs` → **8/8 PASS** con
  MediaRecorder simulado; el permiso real de micrófono no se automatiza.
- Service worker: `2026-10-28.91`.

## 102. Imprimir o guardar una tabla de Base como PDF (2026-10-28)

- Botón **Imprimir / PDF** en Base. Exige una tabla seleccionada.
- Hoja A4 limpia: oculta preguntas, lista de tablas, filtros, formulario y
  botones; imprime la tabla y sus filas con membrete de tabla y fecha.
- Oculta la columna de acciones; conserva encabezados y orden actual.
- Prueba: `node scripts/verify-base-print.mjs` → **7/7 PASS**, con PDF real de
  Chrome (104 KB).
- Service worker: `2026-10-28.92`.

## 103. Imprimir o guardar la lista de tareas como PDF (2026-10-28)

- Botón **Imprimir / PDF** en Tareas.
- Hoja A4 limpia: oculta formulario, filtros, búsqueda y acciones por tarea.
- Imprime la lista con título, prioridad, estado, vencimiento, responsable y
  notas; incluye membrete con número de tareas abiertas y fecha.
- Respeta el filtro y la búsqueda activos, porque imprime lo que está en
  pantalla.
- Prueba: `node scripts/verify-task-print.mjs` → **7/7 PASS**, PDF real de
  129 KB.
- Service worker: `2026-10-28.93`.

## 104. Duplicar rutina (2026-10-28)

- Botón **Duplicar** en cada rutina: abre el formulario como **Nueva rutina**
  con título, hora, duración, prioridad, impacto, urgencia, frecuencia, días,
  fechas, recordatorio, propósito, resultado, notas, rol y banderas.
- La copia nace activa y no modifica la original. No se guarda sola: hay que
  revisar y confirmar.
- Prueba: `node scripts/verify-routine-duplicate.mjs` → **6/6 PASS** (Chrome).
- Service worker: `2026-10-28.94`.

## 105. Impresión de Agenda desde Semana o Viajes (2026-10-28)

- Corrección: si la Agenda estaba en modo **Semana** o **Viajes**, el botón
  Imprimir dejaba la hoja sin la lista porque `#agendaList` estaba oculto.
- La hoja de impresión fuerza la lista de compromisos y sigue ocultando la
  rejilla semanal y los viajes. `CHROME` genera el PDF con las filas.
- Prueba: `node scripts/verify-agenda-print.mjs` → **8/8 PASS**, incluido el
  caso «imprime la lista aunque esté en Semana».
- Service worker: `2026-10-28.95`.

## 106. Imprimir o guardar el listado de rutinas como PDF (2026-10-28)

- Botón **Imprimir / PDF** en Rutinas.
- Hoja A4 limpia: oculta el intérprete de lenguaje natural, filtros, busqueda,
  switches y acciones por rutina.
- Imprime las tarjetas con frecuencia, horario, propósito, resultado, rol y
  etiquetas; incluye membrete con rutinas activas y fecha.
- Prueba: `node scripts/verify-routine-print.mjs` → **7/7 PASS**, PDF real de
  291 KB.
- Service worker: `2026-10-28.96`.

## 107. Duplicar tarea y restaurar exportación de Tareas (2026-10-28)

- Botón **Duplicar** en cada tarea: crea una copia abierta con título
  «(copia)», prioridad, responsable, vencimiento y notas. La original no cambia.
- Corrección: al insertar la duplicación se perdió `export` de `renderTasks`,
  lo que rompía la vista Tareas con «does not provide an export named
  renderTasks». Se restauró y se verificó la navegación completa.
- Prueba: `node scripts/verify-task-duplicate.mjs` → **5/5 PASS**.
- Service worker: `2026-10-28.97`.

## 108. Regresión E2E en un solo comando (2026-10-28)

- `npm run e2e:regression` ejecuta en secuencia las 9 pruebas de Chrome de
  las funciones recientes: impresión de Agenda, Base, Tareas y Rutinas;
  grabación local de reunión; duplicar cita, rutina y tarea; copia de
  seguridad.
- Cada prueba levanta app temporal y Chrome headless, y no toca producción.
- Si una falla, el comando sigue con las demás y muestra el detalle al final.
  `E2E_TIMEOUT_MS` ajusta el límite por prueba (240 s por defecto).
- Resultado de hoy: **9/9 PASS en 37.9 s**.
- Además se endureció la prueba de duplicar rutina esperando la vista activa,
  para evitar la carrera de arranque que la hizo fallar una vez.
- Service worker: `2026-10-28.98`.

## 109. Selfchecks de los 11 subsistemas (2026-10-28)

- Antes `npm run selfchecks` solo ejecutaba Agenda, Canales y LLM. Había
  selfchecks de ACL, Documentos, Lingo, MCP, Nudges, Oficina, Research,
  Hilos y Viajes que nunca corrían.
- Ahora `npm run selfchecks` descubre y ejecuta los **11** y resume el
  resultado. El comando anterior queda como `npm run selfchecks:core`.
- Resultado de hoy: **11/11 PASS en 28.3 s**, 560 comprobaciones internas.
- Cada módulo usa su DATA_DIR temporal; no toca producción.
- `SELFCHECK_TIMEOUT_MS` ajusta el límite por módulo (180 s por defecto).
- Service worker: `2026-10-28.99`.

## 110. Imprimir o guardar Jornada como PDF (2026-10-28)

- Botón **Imprimir / PDF** en Jornada.
- Genera un reporte del rango elegido: membrete con fechas, horas totales,
  número de turnos y fecha de emisión; lista limpia de turnos con entrada,
  salida, pausas y nota.
- Oculta el reloj de fichaje, los botones de acción y los controles de edición.
- Prueba: `node scripts/verify-attendance-print.mjs` → **6/6 PASS**, PDF real.
- La regresión E2E pasa a **10 pruebas** (`npm run e2e:regression`).
- Service worker: `2026-10-28.100`.

## 111. Imprimir o guardar Objetivos (OKR) como PDF (2026-10-28)

- Botón **Imprimir / PDF** en Objetivos.
- Reporte con objetivos, responsable, trimestre, estado, avance, y cada
  resultado clave con meta, avance y unidad. Membrete con totales y fecha.
- Oculta los formularios de creación y todos los botones de edición/avance.
- Mantiene la barra de avance en azul al imprimir con colores.
- Prueba: `node scripts/verify-okr-print.mjs` → **6/6 PASS**, PDF real.
- La regresión E2E pasa a **11 pruebas** (`npm run e2e:regression`).
- Service worker: `2026-10-28.101`.

## 112. Búsqueda global Ctrl K (2026-10-28)

- Botón de lupa y **Ctrl/Cmd + K** abren un buscador único.
- Busca en agenda, tareas, rutinas, documentos, wiki y tablas; agrupa por
  sección, ignora tildes y mayúsculas, y salta a la vista al elegir.
- API nueva: `GET /api/search?q=texto&limit=8`. Devuelve solo títulos,
  subtítulos cortos y metadatos; no cuerpos completos ni secretos.
- Enter abre el primer resultado; Esc cierra; mínimo 2 letras.
- Prueba: `node scripts/verify-global-search.mjs` → **9/9 PASS** (Chrome).
- La regresión E2E pasa a **12 pruebas**.
- Service worker: `2026-10-28.102`.
- Reinicio local necesario para que el proceso cargara la ruta nueva: PID
  anterior 16528 → PID 41380, 336 rutas, datos intactos.

## 113. Filtros y teclado en la búsqueda global (2026-10-28)

- Chips **Todo / Agenda / Tareas / Rutinas / Documentos / Wiki / Tablas**
  filtran los resultados ya cargados sin repetir la consulta.
- **Flechas arriba/abajo** mueven el foco por los resultados; **Enter** abre
  el enfocado; **Esc** cierra. El contador muestra visibles frente al total.
- Al reabrir, la búsqueda vuelve a «Todo» y limpia el texto.
- Prueba: `node scripts/verify-global-search.mjs` → **11/11 PASS**.
- Service worker: `2026-10-28.103`.

## 114. Resaltado del ítem buscado (2026-10-28)

- Al elegir un resultado, además de navegar, la app resalta el ítem exacto
  con borde azul y lo centra en la lista. El resaltado se apaga a los 4 s.
- Agenda y Documentos ahora llevan `data-id` en su fila; Tareas ya lo tenía.
  Rutinas se localizan por `data-routine-id`.
- Prueba: `node scripts/verify-global-search.mjs` → **12/12 PASS**.
- Service worker: `2026-10-28.104`.

## 115. Personas en la búsqueda global (2026-10-28)

- Nuevo grupo **Personas**: busca por nombre, alias o cualquiera de sus correos.
- Reutiliza el grafo de identidades (`listPeople`), así que muestra personas con
  varios correos, su confianza y permite saltar a Identidades.
- Chip **Personas** en el filtro; la fila de Identidades lleva `data-id`, por lo
  que el resaltado azul también funciona ahí.
- Prueba: `node scripts/verify-global-search.mjs` → **15/15 PASS**.
- Requiere reinicio del proceso para cargar el cambio de la ruta.
- Service worker: `2026-10-28.105`.
- Reinicio aplicado: PID 41380 → PID 38460, 336 rutas, datos intactos.

## 116. Exportar Jornada a CSV (2026-10-28)

- Botón **Exportar CSV** en Jornada; usa el mismo rango Desde/Hasta del reporte.
- Endpoint nuevo: `GET /api/attendance/export.csv?from=&to=`.
- Columnas: ID, Fecha, Entrada, Salida, Pausa (min), Horas, Nota, Estado.
- UTF-8 con BOM para Excel; neutraliza notas que empiezan con =,+,-,@.
- Prueba: `node scripts/verify-attendance-print.mjs` → **7/7 PASS**.
- Service worker: `2026-10-28.106`.

## 117. Exportar Objetivos (OKR) a CSV (2026-10-28)

- Botón **Exportar CSV** en Objetivos.
- Endpoint nuevo: `GET /api/okr/export.csv`.
- Una fila por resultado clave; si un objetivo no tiene resultados, sale una
  fila con el objetivo y columnas de KR vacías.
- Columnas: ID, Objetivo, Responsable, Trimestre, Estado, Avance objetivo %,
  Resultado clave, Meta, Actual, Unidad, Avance KR %.
- UTF-8 con BOM; neutraliza textos que empiezan con =,+,-,@.
- Prueba: `node scripts/verify-okr-print.mjs` → **7/7 PASS**.
- Service worker: `2026-10-28.107`.

## 118. Aprobaciones en la búsqueda global (2026-10-28)

- Nuevo grupo **Aprobaciones**: busca en asunto, cuerpo, canal, estado y
  destinatarios de las propuestas de la Oficina.
- Chip **Aprobaciones** en el filtro; al elegir una propuesta salta a la
  bandeja de Aprobaciones y resalta la fila (las filas llevan `data-id`).
- No expone códigos ni firmas: usa la copia pública de la propuesta.
- Service worker: `2026-10-28.108`.

## 119. Exportar Tareas a CSV (2026-10-28)

- Botón **Exportar CSV** en Tareas; respeta filtro de estado y búsqueda.
- Endpoint nuevo: `GET /api/tasks/export.csv?status=&q=&owner=&origin=&due=&eventId=`.
- Columnas: ID, Título, Estado, Prioridad, Responsable, Vence, Origen,
  Persona, Notas, Resultado, Creada, Cerrada.
- UTF-8 con BOM; neutraliza textos que empiezan con =,+,-,@.
- Prueba: `node scripts/verify-task-print.mjs` → **8/8 PASS**.
- Service worker: `2026-10-28.109`.

## 120. Inicio: bordes alineados y separación uniforme (2026-10-29)

- Las filas de tarjetas de Inicio se tocaban en vertical (0 px) y la fila
  superior usaba columnas 1.05fr/1fr, distinta de las filas siguientes.
- Ahora `.hero-grid` y `.two-col` comparten `repeat(2,minmax(0,1fr))`:
  todos los bordes verticales coinciden.
- `--grid-gap:16px` gobierna el hueco interno; `.view > .grid + .grid`
  añade 16 px entre bloques. El apilado (<=960 px) conserva 16 px dentro
  y entre tarjetas.
- Prueba: `node scripts/verify-theme.mjs` → **33/33 PASS**, con checks de
  columnas alineadas, huecos 16/16, bordes 1 px del mismo color, radio 22 px,
  relleno 16 px y cero desbordamiento a 1335/960 px.
- Capturas: `docs/capturas/home-grid-dark-1335.png` y
  `home-grid-light-1335.png`.
- Service worker: `2026-10-29.110`.

## 121. Puesta en marcha asistida (2026-10-29)

- Nueva vista **Puesta en marcha** (`#view-setup`) accesible desde el menú ⚡,
  el botón del Inicio y Ajustes.
- `GET /api/setup/overview`: estado real de LLM, correo, Google, Telegram,
  WhatsApp, MCP, estilo y avisos; progreso; equipo; presets y redirect URIs.
- `POST /api/setup/assist`: Camila responde con el estado (LLM si está
  configurado, guion determinista si no). No recibe secretos.
- Presets: Gmail/Outlook/Yahoo/iCloud/Zoho, DeepSeek/OpenAI/Ollama y
  Desktop Commander/Playwright. El correo detecta el proveedor por dominio y
  rellena SMTP/IMAP/puertos.
- La UI usa las APIs existentes para guardar y probar; no inventa conexiones.
- Guía: `docs/GUIA_PUESTA_EN_MARCHA.md`.
- Prueba: `node scripts/verify-setup.mjs` → **13/13 PASS**.
- Service worker: `2026-10-29.111`.

## 122. Pruebas que dependían del calendario (2026-10-29)

- `probe-base-csv.mjs` y `probe-base-xlsx.mjs` esperaban la fecha fija
  2026-10-28; ahora usan la fecha actual.
- `lib/llm/selftest.mjs` movía la cita de prueba a las 16:00, que choca con
  la revisión semanal del viernes; ahora usa las 18:00, un hueco libre.
- No cambia el comportamiento de la app; solo elimina falsos fallos por día.




## 123. Google OAuth conectado (2026-10-29)

- Proyecto: `agenda-copilot-p95` (número 193663472640).
- APIs habilitadas: Calendar, Gmail, Drive.
- Cliente OAuth web: **Agenda Copilot P95 Web**.
- URIs de retorno: `http://127.0.0.1:3000/api/auth/google/callback` y
  `http://localhost:3000/api/auth/google/callback`.
- Pantalla de consentimiento en **Prueba** con el usuario
  `beticosa1@gmail.com`; permisos `calendar`, `gmail.send`,
  `userinfo.email`.
- Cuenta conectada: `beticosa1@gmail.com` (Calendar + envío Gmail).
- `lib/google.mjs` ahora prefiere las credenciales de la bóveda
  (`google.clientId`/`google.clientSecret`) y cae a `.env`; las credenciales
  nuevas también quedaron en `.env` para el arranque.
- Estado de puesta en marcha: **44 %**, siguiente paso **Telegram**.
- La bandeja de entrada sigue pendiente: el permiso actual es solo envío
  (`gmail.send`); para leer correo hay que usar IMAP o ampliar el permiso.

## 124. Telegram conectado (2026-10-29)

- Token y chat ID guardados; `channels.telegram.enabled=true`.
- Prueba real `POST /api/telegram/test` → OK.
- Corregido `setup.js`: ya no intenta guardar `channels.telegram.mode`
  como secreto (no está en el registro de la bóveda). El modo por defecto
  sigue siendo `polling`.
- Puesta en marcha: **56 %**; siguiente paso **WhatsApp**.
- Service worker: `2026-10-29.115`.

## 125. Notas de voz, audio y video en Telegram (2026-10-29)

- Motor local: `ffmpeg` + `faster-whisper`; el modelo por defecto es `base`
  (rápido). `small` queda disponible con `STT_MODEL=small` si se prioriza
  precisión sobre velocidad. No se envía audio a APIs externas.
- `scripts/transcribe-server.py`: worker persistente que carga el modelo una
  sola vez; el arranque de la app lo precalienta. Evita pagar ~6 s de carga en
  cada nota.
- `lib/channel/transcribe.mjs`: descarga, normaliza a WAV 16 kHz mono con
  `loudnorm` + `highpass`, transcribe y borra el temporal. Si el worker falla,
  usa el modo de una sola ejecución.
- `lib/channel/telegram.mjs` acepta `voice`, `audio`, `video_note`, `video` y
  documentos con MIME de audio/video; agrega `meta.voice` y
  `meta.transcription`; el texto sigue el pipeline normal.
- Límites: 20 MB y 5 minutos. Si no hay voz, avisa sin inventar texto.
- Prueba: `npm run verify:voice` → 10/10 PASS. E2E real:
  nota de voz → 6.8 s totales / 2.9 s de transcripción;
  video → 6.7 s totales / 3.5 s de transcripción.
- Instalación: `python -m pip install -r requirements-voice.txt`.
- Service worker: `2026-10-29.116`.

## 126. Agente conversacional en canales (2026-10-29)

- El pipeline de Telegram/WhatsApp/correo ya no usa el contestador de menú
  `handleAssistant` para lenguaje libre: usa `handleAgentChat`, el mismo agente
  con persona de **Chief of Staff** de Héctor Fabio Riascos C.
- Los comandos históricos (`HOY`, `CAPTURA`, `SEMANA`, etc.) siguen entrando
  por la vía determinista y no dependen del LLM.
- Saludos y charla natural usan `naturalReply` del agente, con hechos reales
  del día y cierre en una propuesta concreta.
- Las notas de voz pasan `voice: true`; el prompt pide confirmar lo entendido
  con calidez y terminar con una acción útil, sin mencionar la transcripción.
- Prueba real: «Hola, buenas tardes, ¿cómo estás?» por voz →
  «Te escuché saludando… ¿Quieres que aproveche este espacio libre…?».
- `HOY` sigue respondiendo con el resumen determinista. `npm test` PASS.
- PID 10756, 341 rutas; sin cambio de service worker.

## 127. Camila en Inicio, dictado local y fondo 3D (2026-10-30)

- **Micrófono:** la causa del `not-allowed` era `Permissions-Policy:
  microphone=()`. Ahora el servidor envía `microphone=(self)`. Sin ese cambio,
  ningún permiso del navegador podía habilitar la grabación.
- **Panel Camila:** ocupa la columna derecha del hero de Inicio, en la misma
  fila que el Índice P95; `Top 3 de hoy` queda como detalle desplegable dentro
  del panel. Usa `POST /api/agent/command` y el mismo agente de Chief of Staff.
- **Dictado local:** `MediaRecorder` → `POST /api/voice/transcribe` →
  `faster-whisper` worker. No depende de `SpeechRecognition`; el navegador solo
  pide permiso de micrófono. Límite 60 s por nota en el panel.
- **Fondo:** `public/js/ambient.js` dibuja un wireframe 3D distinto por vista
  (20 presets) sobre ondas fluidas azules; lee los tokens del tema y respeta
  `prefers-reduced-motion`. Sin librerías, DPR limitado y pausa al ocultar.
- **Superficies:** `motion.css` quita el borde de tarjetas/paneles y les da una
  capa de vidrio uniforme, sin costuras entre el chat y la tarjeta vecina.
- Verificación: `npm run verify:motion` → 19/19 PASS (incluye voz pregrabada
  real: grabación → transcripción → respuesta). `npm test` PASS.
- PID 2544, 342 rutas, service worker `2026-10-30.121`.



## 128. Organización 24 y Estudio de entregables (2026-10-30)

- Se importó el ADN de **24 perfiles** de OrgDNA (solo lectura del backup; la
  app de 8765 no se modificó) en `lib/studio/org-seed.json`.
- Organización persistida en `store.organization`: 4 equipos, jerarquía,
  misiones, capacidades y herramientas. CRUD por API y vista **Organización**.
- **Estudio** (`/api/studio/jobs`):
  - presentación: LLM → guion → PPTX real (8–12 diapositivas, notas, tablas).
  - documento: LLM → DOCX con secciones.
  - código: plan → archivos → ZIP; no se ejecuta. Si falta un archivo se marca
    como borrador parcial.
- Camila recibe `organizationSummary()` en sus hechos y responde por los
  equipos/roles desde cualquier canal.
- Genspark público respondió **403** sin sesión; no se usaron credenciales.
  La implementación es propia, basada en el patrón brief → guion → PPTX.
- Pruebas: presentación real 8 slides/33 KB, documento DOCX, código ZIP de 6
  archivos; UI Organización/Estudio 10/10.
- PID 27472, 352 rutas, service worker `2026-10-30.123`.


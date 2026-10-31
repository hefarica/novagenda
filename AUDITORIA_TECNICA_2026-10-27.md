# Auditoría técnica — Agenda Copilot P95 v1.1

**Fecha:** 27 de octubre de 2026
**Alcance:** `agenda-copilot/` completo (28 archivos) + modelo canónico `docs/Agenda_P95_Modelo_Canonico_2026.xlsx` (14 hojas)
**Método:** lectura integral del código, arranque real del servidor en puerto aislado, pruebas funcionales de la API y del asistente, pruebas de seguridad/robustez, extracción y comparación de fórmulas del Excel, y verificación estática de la PWA.
**Modo:** solo lectura sobre el proyecto. Las pruebas se ejecutaron con `DATA_DIR` temporal para no tocar `data/agenda-data.json`.

---

## 1. Veredicto

La aplicación **no es un prototipo vacío**: tiene un núcleo real, coherente y funcional (agenda local, asistente en español, detección de choques, recurrencias, PWA). Funciona de punta a punta sin dependencias externas y sin instalar nada más que Node.

Pero **no está lista para producción ni para venderse como producto**. Hoy es una **app personal mono-usuario, sin autenticación, con un crash reproducible y varias funciones anunciadas que no existen**. No es cuestión de "pulir": faltan capas completas de seguridad, validación, persistencia, integración y operación.

| Dimensión | Nota /10 | Comentario |
|---|---|---|
| Núcleo funcional local | 7 | Agenda, asistente, conflictos, recurrencias y reportes funcionan. |
| Fidelidad al modelo Excel | 6 | El **Índice P95 y el Score de prioridad están mal implementados**; métricas parciales. |
| Integración Google | 5 | Crea eventos y consulta FreeBusy. **No edita, no borra, no sincroniza cambios.** |
| WhatsApp / Telegram | 5 | Webhooks operativos, pero sin idempotencia y **abiertos si falta el secreto**. |
| Seguridad | 2 | **Cero autenticación**, webhooks abiertos, `reset-demo` abierto, secreto por defecto. |
| Robustez | 3 | **Crash reproducible en 60 s**, cero validación de entrada, cero tests. |
| PWA / móvil | 6 | Instalable de verdad, pero **sin offline real y sin push**. |
| Operación / DevOps | 3 | Sin CI, sin backups, sin logs, Docker como root, sin migraciones. |
| Multi-usuario | 1 | Un solo inquilino global en un archivo JSON. |
| Documentación | 8 | Buena, aunque describe comportamientos que el código no cumple al 100 %. |

**Estimación de avance real hacia "100 % productivo": ~45 %.**
El camino cómodo es "demo local". El camino a producto exige cerrar los P0, refactorizar persistencia e integraciones, y añadir tests. Estimación de ingeniería para llegar a 100 %: **25–35 días** + trámites externos (Google, Meta) que no dependen solo del código.

---

## 2. Lo que sí funciona (verificado en vivo)

- `GET /api/health` responde 200 con versión y hora.
- `GET /api/bootstrap` entrega estado completo (settings, agenda, inbox, recurrencias, reuniones, OKR, actividad, canales).
- Asistente en español: `HOY`, `balance`, `CAPTURA`, `FOCO`, `SEMANA`, `CIERRE`, `HECHO`, `POSPONER` → los 7 comandos del modelo responden correctamente.
- Lenguaje natural: *"Agenda reunión con Juan mañana a las 10 AM por 45 min"* → crea `AG-0006` con hora y duración correctas.
- Conflicto + 3 alternativas: *"…mañana a las 9:30"* → detecta choque con `AG-0005` y ofrece 3 franjas; responder `2` confirma y crea.
- Recurrencias se materializan al arranque y cada minuto; reuniones recurrentes también.
- Reporte semanal/mensual y snapshot de métricas existen en backend.
- PWA: manifest + service worker + iconos 192/512 válidos; instalable en Android/iOS por HTTPS.
- Cero dependencias npm: superficie de supply-chain nula (esto es una virtud, conviene conservarla).

---

## 3. P0 — Bloqueantes (hay que arreglarlos antes de exponer la app a internet)

### P0-1. Cierre en cascada por una fecha inválida (crash reproducido)

- **Dónde:** [server.mjs:117](server.mjs#L117) (motor de recordatorios).
- **Qué pasa:** el endpoint `POST /api/agenda` acepta `start` arbitrario (probado con `"no-es-fecha"` → HTTP 201). Al siguiente tick (≤60 s), `new Date(e.start).toISOString()` lanza `RangeError: Invalid time value` dentro de un `setInterval` **sin try/catch** → Node termina el proceso.
- **Evidencia:** el log de la prueba muestra el proceso muerto con `RangeError` en la línea 117 y `Node.js v24.12.0`. Reproducible 100 %.
- **Impacto:** **cualquier persona sin autenticarse puede apagar la agenda** con una petición y 60 s de espera; además pierde recordatorios y automatizaciones hasta que alguien lo reinicie a mano.
- **Fix:** validar fechas (ISO estricto) en todas las escrituras + try/catch por evento en los dos intervalos + `unhandledRejection`/`uncaughtException` con log y salida limpia.

### P0-2. No hay autenticación de ningún tipo

- **Dónde:** [server.mjs:61-104](server.mjs#L61) — `routeApi` no comprueba sesión ni usuario.
- **Evidencia:** `GET /api/bootstrap` **sin cookies** devuelve toda la agenda, ajustes y OKR (HTTP 200). La cookie `sid` se emite pero **solo sirve para separar `pendingActions`**, no para autorizar.
- **Impacto:** si se despliega en un VPS (como recomienda el README), **la agenda personal queda pública**: cualquiera puede leer, crear, modificar, cancelar y borrar. También puede gastar tus canales (`/api/telegram/test`, `/api/gmail/send`).
- **Fix:** autenticación real (login propio con email+contraseña o passkey; o proxy con Basic Auth + lista de IPs como mínimo), sesión firmada (HMAC) y guardas en cada ruta. Sin esto, nada más importa.

### P0-3. Webhooks abiertos si faltan los secretos

- **Dónde:** [channels.mjs:27-31](lib/channels.mjs#L27) (`verifyWhatsAppSignature` devuelve `true` si `WA_APP_SECRET` está vacío) y [server.mjs:97-98](server.mjs#L97) (Telegram solo valida si `TELEGRAM_WEBHOOK_SECRET` existe).
- **Evidencia:** `POST /api/whatsapp/webhook` y `POST /api/telegram/webhook` con payload falsificado → **HTTP 200** y el asistente ejecutó la instrucción (`CAPTURA inyeccion via webhook`).
- **Impacto:** inyección remota de comandos en tu agenda: crear/cerrar/mover eventos, llenar el Inbox. Y si `WA_APP_SECRET` no se configura, es un endpoint público de escritura.
- **Fix:** exigir secreto en producción (fallar al arrancar si `NODE_ENV=production` y falta), comparación en tiempo constante, y deduplicación por `message.id`/`update_id`.

### P0-4. `POST /api/reset-demo` borra todo sin autenticación

- **Dónde:** [server.mjs:102](server.mjs#L102). Solo se bloquea si `NODE_ENV=production`.
- **Evidencia:** HTTP 200 y estado reiniciado durante la prueba.
- **Impacto:** pérdida total de la agenda (el seed retorna por `store.reset()`), a un clic/cURL de cualquiera.
- **Fix:** eliminarlo del build de producción (o detrás de auth + flag explícito), y separar "datos demo" de "datos reales".

### P0-5. `PATCH /api/agenda/:id` sobrescribe cualquier campo

- **Dónde:** [server.mjs:72](server.mjs#L72) → `Object.assign(ev, x)` sin lista blanca.
- **Evidencia:** se cambió el `id` de `AG-0002` a `HACKEADO` (HTTP 200) y se inyectó un `google.eventId` falso.
- **Impacto:** corrupción de identidad (rompe recordatorios, logs, vínculos Google) y escalada: permite fijar `status`, `google`, `score`, `due`… de cualquier evento.
- **Fix:** DTO con campos permitidos, validación de tipos/fechas, y `PATCH` que además **sincronice con Google**.

### P0-6. XSS almacenado por atributos sin escapar

- **Dónde:** [app.js:17](public/app.js#L17) (`<span class="badge ${o.priority}">`) y [app.js:16](public/app.js#L16) (`class="badge ${pr}"`), alimentados por `priority` libre.
- **Evidencia:** `PATCH /api/agenda/AG-0001` con `priority: P3" onmouseover="alert(1)` quedó guardado y se renderiza dentro del atributo `class`.
- **Impacto:** ejecución de script en la sesión del usuario. Sin CSP, el daño es mayor.
- **Fix:** escapar SIEMPRE con `esc()` incluso en atributos, clases derivadas por mapa (no por dato), y añadir CSP.

### P0-7. Sin validación de datos en la API

- **Dónde:** [server.mjs:69-70](server.mjs#L69) y [server.mjs:80](server.mjs#L80) (settings).
- **Evidencia:**
  - `start:"no-es-fecha"` → 201, `due:"no-es-fech"`, `plannedMin:null`.
  - `end < start` → 201 con `plannedMin:-60`.
  - `"31 de febrero"` → guarda `2026-02-31T10:00:00-05:00` (fecha inexistente) y muestra "3 de mar".
  - `POST /api/settings` acepta `timezone:"UTC"`, `defaultGoogle` inventado y cualquier clave nueva.
- **Impacto:** datos corruptos que rompen métricas, reportes, sync con Google y el motor de recordatorios (ver P0-1).
- **Fix:** esquema de validación (Zod o validador propio sin dependencias), normalización de fechas en zona horaria del servidor, y rechazo con 400 explicativo.

---

## 4. P1 — Faltantes de fidelidad al modelo canónico

El Excel es la especificación. Estas son las divergencias comprobadas.

### P1-1. El Índice P95 no es el del modelo (y siempre es optimista)

El modelo (`08_DASHBOARD!A4`) calcula **7 componentes ponderados** con pesos de `12_CONFIG`:

| # | Componente | Meta | Peso |
|---|---|---|---|
| 1 | Ejecución de agenda | 85 % | 0,25 |
| 2 | Foco profundo diario | 120 min | 0,20 |
| 3 | Vencidas abiertas (inverso: `1 − vencidas/meta`) | ≤ 2 | 0,15 |
| 4 | Efectividad de reuniones | ≥ 4/5 | 0,10 |
| 5 | Progreso OKR | ≥ 70 % | 0,15 |
| 6 | Ejecución semanal | ≥ 80 % | 0,10 |
| 7 | Revisión semanal | 100 % | 0,05 |

La app ([assistant.mjs:22](lib/assistant.mjs#L22)) implementa **4 componentes + 25 puntos fijos** y, peor, **invierte la fórmula de vencidas**:

```js
Math.min(p.overdueOpen / Math.max(overdue, 1), 1) * .15
```

Con `overdueOpen = 2`, el término vale **siempre 1** mientras haya ≤ 2 vencidas → **nunca penaliza**. Y el `+ .25` constante regala el 25 % del índice.

**Prueba numérica con los mismos datos:** la app mostró **62/100**; aplicando la fórmula del modelo con esos datos sale **≈ 44/100**. Diferencia: 18 puntos de autoengaño.

**Fix:** portar literalmente los 7 componentes y leer metas/pesos de `settings.p95` (que ya existen, pero falta añadir pesos y los 3 componentes ausentes).

### P1-2. El Score de prioridad no se calcula → el "Top 3" no prioriza

- Modelo (`02_AGENDA!Y4`): `ROUND((Impacto*4 + Urgencia*3 + Prioridad*2 + FocoProfundo)*2, 0)` → escala 0–100.
- App: `score` llega como **65 fijo** en [assistant.mjs:122](lib/assistant.mjs#L122) y en [server.mjs:70](server.mjs#L70) solo se acepta si el cliente lo manda (la UI nunca lo manda).
- **Consecuencia:** `top3` ordena por `score` ([assistant.mjs:23](lib/assistant.mjs#L23)) → **todos empatan** y el Top 3 es simplemente el orden de inserción. Es la función estrella del sistema P95 y está inerte.
- Además, el formulario no captura `impacto`/`urgencia`/`energía`, y elegir tipo "Foco" **no activa `deepFocus`** ([index.html:64](public/index.html#L64) + [app.js:32](public/app.js#L32)) → los bloques de foco creados desde la UI no cuentan como foco profundo en ninguna métrica.

### P1-3. Cancelar en la app no cancela en Google; editar no sincroniza

- [server.mjs:73](server.mjs#L73): `DELETE` solo pone `status='Cancelada'`. **No llama a Google Calendar** → la reunión sigue viva en Google y sigue bloqueando.
- [server.mjs:72](server.mjs#L72): `PATCH` no sincroniza nada, aunque `updateGoogleEvent` ya existe ([google.mjs:148](lib/google.mjs#L148)) y solo se usa desde el asistente.
- El modelo pide `syncAgendaToCalendar` **cada hora** (`10_AUTOMATIZACION!A21`); la app solo sincroniza al crear. Si Google estaba caído o desconectado, ese evento **nunca** se sincroniza.

### P1-4. Detección de choques incompleta

- **No considera plantillas de recurrencias futuras.** Prueba real: pidió cita el miércoles 9:15 → ofreció 7:00 / **7:30** / 8:00. Pero `R-002` (foco, LABORABLES, 07:30, 90 min) se materializará ese mismo día a las 07:30 → **doble reserva garantizada**.
- **Ignora eventos de todo el día** de Google: `freebusy` no los devuelve y no se consultan como `allDay` → un viaje o día completo no bloquea nada.
- **Los errores de FreeBusy se silencian** ([google.mjs:133](lib/google.mjs#L133)): si Google falla, se asume "libre" → choque silencioso.
- **No conoce fines de semana ni festivos** al proponer alternativas (ofrece sábados y domingos).
- Desde la **UI** no hay alternativas: el modal solo muestra *"Usa el Asistente"* ([app.js:32](public/app.js#L32)) → contradice la regla canónica "propone hasta 3 alternativas".

### P1-5. Métricas diarias a medias

`snapshotDailyMetrics` ([assistant.mjs:55](lib/assistant.mjs#L55)) guarda `interruptions: 0`, `energyAM: null`, `energyPM: null`, `improvement: null`, `comments: ''` **para siempre**. El modelo tiene 14 columnas (`06_METRICAS_DIARIAS`) y la app solo rellena 9, varias en cero. No hay UI para capturar energía, interrupciones ni la mejora del 1 %, y **no hay pantalla de métricas**: los datos existen y nadie los ve.

Además `planDaily/closeDaily/weeklyReview` dependen de IDs **hardcodeados** (`R-001`, `R-004`, `R-005`): si el usuario borra o renombra esas recurrencias, las métricas mienten.

### P1-6. Recurrencias frágiles

- Solo se materializa **el día actual**: si el servidor estuvo apagado el lunes, ese día se pierde para siempre (sin backfill).
- `MENSUAL` con día 31 no se ajusta a fin de mes → **no ocurre en febrero/abril**.
- No hay excepciones ("hoy no"), ni "editar solo esta instancia", ni reasignar.
- `LABORABLES` no excluye festivos.
- **No se pueden crear** recurrencias, reuniones ni OKR desde la UI: solo activar/desactivar los 6/4/2 sembrados. El modelo los trata como configurables.

### P1-7. Recordatorios no respetan los flags del modelo

El motor ([server.mjs:117](server.mjs#L117)) llama a `notifyChannels` **ignorando `e.whatsapp` y `e.calendar`**, aunque el modelo dice explícitamente *"Solo WhatsApp = Sí"*. Un recordatorio marcado como "no enviar" se envía igual.

### P1-8. Inbox sin conversión

`01_INBOX` tiene columnas "¿Acción?" y "Agenda ID"; la app solo marca `processed: true|false` ([app.js:41](public/app.js#L41)). **No existe "convertir captura en cita"**, que es el corazón del flujo GTD del modelo. Tampoco delegación ni vencimiento editable.

---

## 5. P2 — Faltantes de producto (lo que separa "app personal" de "producto")

1. **Multi-usuario / multi-tenant**: hoy un único JSON global; `userId` solo sirve para `pendingActions`. Un producto necesita cuentas, aislamiento, invitados y roles.
2. **Base de datos**: JSON en memoria + reescritura completa del archivo en cada mutación. No escala, no soporta concurrencia real, no permite consultas ni índices. Migrar a SQLite/Postgres con migraciones versionadas.
3. **Copias de seguridad y exportación**: no hay backup automático, ni export/import JSON, ni export `.ics`, ni restaurar. Con un JSON local, un disco dañado = agenda perdida (y `store.read()` **restaura el seed en silencio** si el archivo está corrupto, [store.mjs:111](lib/store.mjs#L111) → pérdida definitiva sin aviso).
4. **Notificaciones reales**: el botón "Activar notificaciones" pide permiso y **nunca muestra nada**; no existe Web Push (VAPID) ni centro de notificaciones; el icono de campana de la cabecera **no tiene handler**. En móvil, sin push, la app no avisa.
5. **Modo offline real**: la PWA cachea el shell, pero `load()` depende de `/api/bootstrap`; sin red la app queda vacía. Faltan cola de capturas offline + sincronización.
6. **Búsqueda**: el botón de lupa **no tiene handler**; no se puede buscar una cita, un OKR o una captura.
7. **Vistas de calendario**: solo listas. No hay semana/mes, ni arrastrar-y-soltar, ni editar/eliminar desde la UI (no hay botón de borrar ni de editar; solo ✓ y +30).
8. **Buscador de huecos en la UI** y reprogramación con un clic (existe en el asistente, no en la agenda).
9. **Importación `.ics`** (Google exporta; sin esto no hay migración).
10. **OKR editables**: `PATCH /api/okrs` existe, pero la UI no lo usa; no hay historial de progreso ni KRs múltiples.
11. **Zona horaria configurable de verdad**: `settings.timezone` es editable por API pero `store` y `isoAtLocal` usan la constante de entorno; `America/Bogota` está hardcodeada como `-05:00` ([store.mjs:27](lib/store.mjs#L27)). Cambiar zona rompe el día operativo.
12. **Accesibilidad e i18n**: iconos sin `aria-label`, sin foco visible gestionado, textos solo en español, sin `lang` dinámico.
13. **Onboarding y estados vacíos**: no hay primer uso guiado ni "borrar datos demo".
14. **Rendimiento**: se renderizan todas las filas sin paginar ni virtualizar; `activity` y `notificationLog` crecen sin límite claro (`notificationLog` nunca se poda).

---

## 6. Faltantes de ingeniería y operación

| Área | Estado actual | Qué falta |
|---|---|---|
| Tests | **0 tests** | Unitarios de parser/asistente/fórmulas + integración de API + e2e del flujo 1/2/3. `package.json` solo tiene `check` de sintaxis. |
| CI/CD | ninguno | GitHub Actions: `npm test`, `node --check`, build Docker, escaneo de secretos. |
| Docker | `node:22-alpine`, **root**, sin `.dockerignore`, `COPY . .` mete `data/` y `.env` en la imagen, sin `HEALTHCHECK`, sin usuario no-root, base sin pin | Endurecer y usar volumen externo. |
| Backups | ninguno | Snapshot diario + `pg_dump`/copia del JSON, retención, restore probado. |
| Observabilidad | solo `console.error` | Logs estructurados con request-id, `/metrics`, alertas de caída, Sentry/alternativa. |
| Rate limiting | ninguno | Límite por IP y por canal (webhooks), y cuotas de IA. |
| CSRF / CORS | no aplica porque no hay auth | Al añadir auth: `SameSite=Strict`, token CSRF, `Origin` check. |
| Cookies | `HttpOnly; SameSite=Lax` **sin `Secure`** | Añadir `Secure` y `__Host-` en producción. |
| Cabeceras de seguridad | **todas ausentes** | CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS. |
| Métodos HTTP | `HEAD` → **404**, `OPTIONS` → 404 | `HEAD` correcto (monitorización/proxies), preflight si se abre a otros clientes. |
| Compresión | ninguna | gzip/brotli para HTML/JS/CSS (móvil). |
| Apagado limpio | no existe | `SIGTERM`/`SIGINT`: cerrar servidor, vaciar `persist`, no perder la última escritura. |
| Recuperación | `read()` resetea en silencio si el JSON se corrompe | Validar esquema, conservar `.bak`, avisar y **no** sobrescribir. |
| Secretos | `APP_SECRET` por defecto `dev-only-change-me` cifra los tokens OAuth ([store.mjs:139](lib/store.mjs#L139)) | Fallar al arrancar si está por defecto en producción. |
| Migraciones | campo `version:1` **no se usa** | Versionar esquema y migrar al leer. |

---

## 7. Cumplimiento externo (bloquea el uso "real" y la publicación)

- **Google**: se piden scopes sensibles/restringidos (`calendar` completo y `gmail.send`). Para uso propio con "usuarios de prueba" funciona; **para terceros exige verificación de Google** y, con `gmail.send`, evaluación de seguridad (CASA). Además falta: política de privacidad, revocación de tokens al desconectar (`oauth2/revoke` no se llama), y pantalla de consentimiento verificada.
- **WhatsApp**: los recordatorios proactivos **fuera de la ventana de 24 h requieren plantilla aprobada**. El código lo soporta solo si configuras `WA_TEMPLATE_NAME`; si no, el envío lo rechaza Meta y el fallo queda silenciado. Falta manejo del estado de la ventana y de los `statuses` del webhook.
- **Telegram**: correcto en lo básico; falta validar siempre el `secret_token` y usar botones inline para 1/2/3 en vez de pedir texto.
- **Datos personales**: la agenda guarda nombres, correos y notas **en claro** (solo se cifran los tokens). Sin política de privacidad, sin borrado de datos, sin exportación del interesado. Si se comercializa en Colombia/UE, hay obligaciones (Ley 1581 / RGPD).
- **WhatsApp Business**: requiere número verificado, cuenta de negocio y plantillas; es un trámite aparte del código.
- **Licencia**: el paquete no tiene `LICENSE`; si se distribuye, hay que definir titularidad.

---

## 8. Matriz modelo Excel → app (estado real)

| Hoja | Declarado | Estado real |
|---|---|---|
| `00_HOME` | Dashboard, Top 3, ejecución, foco, vencidas, OKR | ✅ visual; ⚠️ Top 3 sin priorización real (P1-2) |
| `01_INBOX` | Captura multicanal y estado | ⚠️ captura ✅, **conversión a cita ❌** |
| `02_AGENDA` | CRUD + prioridad + sync Google | ⚠️ crear ✅, editar/cancelar **sin sync** ❌, sin campos Objetivo/OKR ni Delegable ❌, score ❌ |
| `03_RECURRENCIAS` | Materialización diaria/semanal/mensual/trimestral/laborables | ⚠️ solo hoy, sin festivos, sin excepciones, sin alta desde UI |
| `04_REUNIONES` | Cadencias y efectividad | ⚠️ toggle ✅, efectividad **nunca se captura** |
| `05_OKR` | Progreso, confianza, próxima acción | ⚠️ lectura ✅, edición ❌ |
| `06_METRICAS_DIARIAS` | 14 campos | ❌ 9 rellenados, 5 fijos/nulos, sin pantalla |
| `07_REPORTES` | Semanal y mensual | ✅ backend y botón en UI |
| `08_DASHBOARD` | Índice P95 de 7 componentes | ❌ fórmula distinta (P1-1) |
| `09_MOBILE` | 7 comandos + lenguaje natural | ✅ completo |
| `10_AUTOMATIZACION` | 5 triggers | ⚠️ 3 de 5 (falta sync horaria y alertas 15 min como tales) |
| `11_APPS_SCRIPT` | Reemplazado por backend Node | ✅ |
| `12_CONFIG` | Estándares editables | ⚠️ metas editables, **pesos no**; UI solo jornada/duración/recordatorio |
| `13_DOCUMENTACION` | README y seguridad | ✅ buena, con afirmaciones optimistas |

---

## 9. Plan de cierre propuesto

### Fase 0 — Contención (1–2 días) · obligatorio antes de exponer
1. Validación de entrada en todas las escrituras (fechas ISO, `end > start`, listas blancas en `PATCH`, settings).
2. `try/catch` por evento en los intervalos + manejadores globales; el proceso no debe morir por un dato.
3. Autenticación mínima (login con sesión firmada o Basic Auth tras proxy) en **todas** las rutas `/api/*`.
4. Exigir `WA_APP_SECRET` y `TELEGRAM_WEBHOOK_SECRET` cuando `NODE_ENV=production`; rechazar si faltan.
5. Deshabilitar `reset-demo` en producción y protegerlo con auth.
6. `esc()` en atributos + CSP + cabeceras de seguridad + cookie `Secure`.
7. Migrar `read()` corrupto a modo seguro (`.bak` + error visible).

**Criterio de aceptación:** `nmap`/curl anónimo no obtiene datos ni efectos; un evento con fecha inválida no tumba el proceso; `npm run check` verde y `curl -I` (HEAD) responde 200.

### Fase 1 — Fidelidad al modelo (3–5 días)
8. Índice P95 con los 7 componentes y pesos de `12_CONFIG`.
9. Score de prioridad calculado (`impacto*4 + urgencia*3 + prioridad*2 + foco*…`)*2 y usado por Top 3.
10. Captura de impacto, urgencia, energía y foco profundo en el formulario; `tipo=Foco ⇒ deepFocus`.
11. Sincronización Google en `PATCH`/`DELETE`, job horario de reconciliación y `syncToken` para cambios externos.
12. Choques completos: plantillas de recurrencias futuras, eventos de día completo, festivos, fines de semana, y errores de FreeBusy visibles.
13. Métricas completas (energía AM/PM, interrupciones, mejora, comentarios) + pantalla de métricas.
14. Inbox → cita con un clic; excepciones de recurrencias y alta de recurrencias/reuniones/OKR desde la UI.

**Criterio de aceptación:** el índice de la app coincide con el del Excel (±1) para los mismos datos; el Top 3 cambia al cambiar impacto/urgencia; cancelar en la app cancela en Google; agendar sobre una recurrencia futura avisa.

### Fase 2 — Producto (8–12 días)
15. Persistencia SQLite/Postgres con migraciones y backup automático.
16. Multi-usuario con aislamiento por cuenta.
17. Web Push (VAPID) + centro de notificaciones + botón de campana funcional.
18. Offline real: cola de capturas y sincronización.
19. Vistas semana/mes, búsqueda global, editar/eliminar desde la UI, drag & drop.
20. Import/export `.ics` y export JSON.
21. Zona horaria configurable y coherente en todo el backend.

### Fase 3 — Calidad y operación (3–5 días)
22. Tests unitarios (parser, índice, score, slots), integración de API y e2e del flujo 1/2/3.
23. CI/CD con tests, lint de sintaxis, build Docker y escaneo de secretos.
24. Docker no-root con `.dockerignore`, `HEALTHCHECK`, volumen y compose.
25. Logs estructurados, `/metrics`, alerta de caída, rate limiting, apagado limpio.
26. Documento de operación: backups, restore, rotación de secretos, runbook de incidentes.

### Fase 4 — Cumplimiento y comercialización (externo, 2–6 semanas)
27. Verificación Google (Calendar) y evaluación CASA (Gmail) si se abre a terceros.
28. WhatsApp Business: número, cuenta, plantillas aprobadas, ventana de 24 h.
29. Política de privacidad, términos, retención y borrado; licencia.

### Definición de "100 %" (12 puertas)
1. Ninguna ruta devuelve datos sin autenticación.
2. Ningún dato inválido entra ni tumba el proceso.
3. Índice P95 y Score idénticos al Excel.
4. Crear/editar/cancelar sincroniza Google en ambos sentidos.
5. Conflictos contemplan recurrencias futuras, todo el día y festivos.
6. Métricas completas y visibles.
7. Inbox convertible y recurrencias administrables.
8. Funciona offline y notifica por push.
9. Suite de tests en verde en CI.
10. Docker endurecido + backups verificados + restore probado.
11. Cabeceras, CSP, rate limit y secretos obligatorios en producción.
12. Privacy/terms/licencia y verificaciones externas aprobadas.

---

## 10. Anexo — Evidencias de las pruebas ejecutadas

Servidor arrancado con `DATA_DIR` temporal, puerto aislado, `TIMEZONE=America/Bogota`.

| Prueba | Resultado |
|---|---|
| `GET /api/bootstrap` sin cookie | 200 con agenda/settings/OKR completos |
| `POST /api/assistant` "Agenda reunión con Juan mañana 10:00 45 min" | 200, crea `AG-0006` correcto |
| `POST /api/assistant` "…mañana 9:30 30 min" | 200, detecta choque y ofrece 3 alternativas |
| Responder `2` con la misma cookie | 200, crea en la franja 2 |
| `HOY`, `balance`, `CAPTURA`, `FOCO`, `SEMANA`, `CIERRE`, `HECHO` | 200, respuestas correctas |
| `POST /api/agenda` con `start:"no-es-fecha"` | **201** (debería 400) |
| Tick de recordatorios a los 60 s | **proceso muerto: `RangeError: Invalid time value`** |
| `POST /api/whatsapp/webhook` sin firma | **200** y asistente ejecutado |
| `POST /api/telegram/webhook` sin secret | **200** y asistente ejecutado |
| `POST /api/reset-demo` | **200**, datos reiniciados |
| `PATCH /api/agenda/:id` con `id` nuevo | **200**, identidad sobrescrita |
| `PATCH priority` con `"` | guardado y renderizado en atributo → XSS |
| `end < start` | **201** con `plannedMin:-60` |
| `"31 de febrero"` | guarda fecha inexistente `2026-02-31` |
| `POST /api/settings` con `timezone:"UTC"` | **200**, aceptado |
| `HEAD /api/bootstrap` | **404** (debería 200) |
| `GET /static traversal` (`..%2f`, `..%5c`, `%2e%2e`) | 403/404 — **correctamente bloqueado** |
| Cabeceras CSP/HSTS/XFO/XCTO | **ausentes** |
| `Set-Cookie` | `HttpOnly; SameSite=Lax` — **sin `Secure`** |
| `/api/telegram/test`, `/api/gmail/send` sin auth | alcanzables (fallan solo por configuración) |

**Código revisado:** [server.mjs](server.mjs), [start.mjs](start.mjs), [lib/assistant.mjs](lib/assistant.mjs), [lib/store.mjs](lib/store.mjs), [lib/google.mjs](lib/google.mjs), [lib/channels.mjs](lib/channels.mjs), [public/app.js](public/app.js), [public/index.html](public/index.html), [public/sw.js](public/sw.js), [public/manifest.webmanifest](public/manifest.webmanifest), [Dockerfile](Dockerfile), [package.json](package.json), [START_WINDOWS.bat](START_WINDOWS.bat), [RUN_SERVER_WINDOWS.bat](RUN_SERVER_WINDOWS.bat), [DIAGNOSTICO_WINDOWS.bat](DIAGNOSTICO_WINDOWS.bat), [START_MAC_LINUX.sh](START_MAC_LINUX.sh), [docs/ACTIVACION_RAPIDA.md](docs/ACTIVACION_RAPIDA.md), [docs/SOLUCION_ERR_CONNECTION_REFUSED.md](docs/SOLUCION_ERR_CONNECTION_REFUSED.md), [FUNCTIONAL_MATRIX.md](FUNCTIONAL_MATRIX.md), [README.md](README.md).

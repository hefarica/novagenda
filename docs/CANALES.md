# CANALES — WhatsApp, Telegram, correo, simulador y webhook genérico

**Estado:** implementado y verificado para Agenda Copilot P95 `1.1.0` / `apiVersion: 1`.
**Módulo:** `lib/routes/channels.mjs` (prioridad 200) + `lib/channels.mjs` + `lib/channel/**`.
**Autocheck:** `node lib/channel/selfcheck.mjs` → 211 comprobaciones con proveedores simulados (incluye aprobaciones, adjuntos, bypass, autonomía y ACL).
**Regla de oro:** todo se puede probar **sin credenciales** con el simulador local. La app
funciona igual si no configuras ningún canal.

---

## Índice

1. [Arquitectura en 30 segundos](#1-arquitectura-en-30-segundos)
2. [Prueba en 2 minutos con el simulador](#2-prueba-en-2-minutos-con-el-simulador)
3. [Modelo de mensaje y pipeline](#3-modelo-de-mensaje-y-pipeline)
4. [Contrato de adaptador](#4-contrato-de-adaptador)
5. [Telegram (long polling y webhook)](#5-telegram-long-polling-y-webhook)
6. [WhatsApp Cloud API](#6-whatsapp-cloud-api)
7. [Correo (Gmail entrada y salida)](#7-correo-gmail-entrada-y-salida)
8. [Webhook genérico (Slack, Discord, n8n, Zapier)](#8-webhook-genérico-slack-discord-n8n-zapier)
8-bis. [Aprobaciones y entregables de la Oficina](#8-bis-aprobaciones-y-entregables-de-la-oficina)
9. [Añadir un canal nuevo en 30 líneas](#9-añadir-un-canal-nuevo-en-30-líneas)
10. [API de canales](#10-api-de-canales)
11. [Seguridad](#11-seguridad)
12. [Costos y tiempos de aprobación](#12-costos-y-tiempos-de-aprobación)
13. [Solución de problemas](#13-solución-de-problemas)
14. [Autocheck y variables de prueba](#14-autocheck-y-variables-de-prueba)
14-bis. [Integración con el scheduler (t8)](#14-bis-integración-con-el-scheduler-t8)
15. [Checklist de aceptación](#15-checklist-de-aceptación)
16. [Limitaciones conocidas](#16-limitaciones-conocidas)

---

## 1. Arquitectura en 30 segundos

```
WhatsApp Cloud API ─┐
Telegram (polling) ─┤                         ┌─ dedupe (7 días)
Correo Gmail ───────┼─▶ adaptadores ─▶ pipeline ─┼─ rate limit
Webhook genérico ───┤   (lib/channel/*)         ├─ asistente determinista (handleAssistant)
Simulador local ────┘                          ├─ respuesta por el mismo canal
                                               └─ bandeja + auditoría + lastError
```

- **Adaptadores** (`lib/channel/*.mjs`): hablan con cada proveedor. Resuelven sus secretos,
  validan credenciales, envían, reciben y calculan estado/instrucciones para la UI.
- **Pipeline** (`lib/channel/pipeline.mjs`): una sola ruta para todos. Valida, aplica rate
  limit, reserva la clave idempotente, llama al asistente real (los comandos históricos
  `HOY`, `CAPTURA …`, `HECHO`, `POSPONER`, `FOCO`, `CIERRE`, `SEMANA`, `balance`, `1/2/3`
  funcionan igual) y responde por el canal de origen.
- **Estado** (`store.channelState`): mensajes (300), dedupe (7 días / 3 000 claves), ventanas
  de conversación, offsets de Telegram, tokens cifrados de instancias, auditoría (150).
- **Rutas**: `lib/routes/channels.mjs` se auto-descubre al arrancar. No se edita `server.mjs`.

Nada de esto programa intervalos en `server.mjs`: el long polling de Telegram y el watchdog
de Gmail son `setTimeout` con `unref()` que arrancan al montar el módulo de rutas y se pueden
desactivar con `CHANNELS_AUTOSTART=off`.

---

## 2. Prueba en 2 minutos con el simulador

No necesitas WhatsApp, Telegram, Gmail ni Internet.

1. Arranca la app:
   ```powershell
   cd agenda-copilot
   node start.mjs        # o START_WINDOWS.bat
   ```
2. Abre la app, ve al **Centro de integraciones** y elige **Simulador local**. También puedes
   ir directo por API:
   ```powershell
   curl.exe -s -X POST http://127.0.0.1:3000/api/channels/simulate ^
     -H "Content-Type: application/json" ^
     -d "{\"text\":\"HOY\"}"
   ```
   Respuesta real del asistente (resumida):
   ```json
   {
     "ok": true,
     "reply": "📌 AGENDA COPILOT — 2026-10-27\nPendientes: 3 · Foco: 0 min...",
     "outbound": [{"channel":"simulator","ok":true,"id":"SIM-…"}],
     "channel": "simulator",
     "duplicate": false
   }
   ```
3. Prueba una captura y compruébala:
   ```powershell
   curl.exe -s -X POST http://127.0.0.1:3000/api/channels/simulate -H "Content-Type: application/json" -d "{\"text\":\"CAPTURA llamar a Juan\"}"
   curl.exe -s -X POST http://127.0.0.1:3000/api/channels/simulate -H "Content-Type: application/json" -d "{\"text\":\"HOY\"}"
   ```
4. Mira la conversación completa en la bandeja local:
   ```powershell
   curl.exe -s "http://127.0.0.1:3000/api/channels/inbox?limit=20"
   ```
5. Comprueba el estado de todos los canales (sin secretos, con instrucciones):
   ```powershell
   curl.exe -s http://127.0.0.1:3000/api/channels
   ```

Si `HOST≠127.0.0.1` o `APP_AUTH=on`, inicia sesión primero: el simulador y el resto de
`/api/channels/*` son rutas autenticadas.

> **Sin credenciales, Telegram/WhatsApp/correo quedan «no configurados»** y devuelven
> `instructions[]` con los pasos. Eso es correcto: la UI debe mostrarlos así.

---

## 3. Modelo de mensaje y pipeline

Cada mensaje que entra o sale se normaliza a:

```json
{
  "id": "MSG-… | wa:<id> | tg:<update_id>",
  "channel": "telegram | whatsapp | email | simulator | generic",
  "direction": "inbound | outbound",
  "userId": "573001112233 | 123456789 | persona@ejemplo.com | demo",
  "text": "HOY",
  "timestamp": "2026-10-27T18:00:00.000Z",
  "dedupeKey": "telegram:update:9001",
  "status": "received | sent | failed | skipped | duplicate",
  "replyTo": null,
  "meta": { "…": "datos no sensibles del canal" },
  "error": null
}
```

### Reglas del pipeline

1. **Validación**: texto obligatorio (máx. 4 000 caracteres).
2. **Rate limit** (ventana deslizante en memoria):
   | Ámbito | Límite |
   |---|---|
   | Simulador por IP | 60/min |
   | Entrada por canal | 180/min |
   | Entrada por usuario | 30/min |
   | Salida por canal | 120/min |
   | Webhooks por IP | 120/min |
   Superarlo → `429 TOO_MANY_REQUESTS` con `retryAfterSec`.
3. **Idempotencia**: antes de llamar al asistente se reserva `dedupeKey` en el store.
   - WhatsApp → `msg:<message.id>`
   - Telegram → `update:<update_id>` (y `callback:<id>` para botones)
   - Gmail → `gmail:<messageId>` (+ lista `seen` persistente)
   - Webhook → `<instancia>:<id del payload>`
   - Simulador → clave única (nunca deduplica)
   Si la clave ya existe (últimos 7 días) se responde/registra como **duplicate** y **no se
   ejecuta el asistente**: un mensaje repetido no duplica citas ni capturas.
4. **“Escribiendo…”**: si el adaptador lo soporta (Telegram), se envía antes de responder.
4-bis. **Aprobaciones**: si el mensaje es una respuesta de aprobación (`ok`, `no`, `corrige:`, `1/2/3`, botón de la tarjeta), lo resuelve el gate de la Oficina antes del asistente (ver §8-bis).
5. **Asistente**: `handleAssistant(text, {channel, userId})`. Los contextos de alternativas
   (`1/2/3`) quedan separados por canal+usuario.
6. **Respuesta**: por el mismo canal. Si la respuesta ofrece alternativas numeradas y el
   adaptador soporta botones, se muestran como botones inline (Telegram).
7. **Registro**: bandeja local, `stats`, `lastError` y auditoría. Los secretos se redactan.

### Reintentos y backoff

- Peticiones idempotentes (GET): hasta 2 reintentos ante `408/425/429/500/502/503/504`.
- Envíos POST: solo se reintentan `429` y `503` (el proveedor no procesó el mensaje) y los
  fallos de conexión previos al envío. Un `timeout` de un POST **no** se reintenta para no
  arriesgar duplicados.
- Backoff exponencial con jitter: `400 ms → 800 ms → 1.6 s → …` (máx. 4 s) y respeto de
  `Retry-After`. El polling de Telegram usa `1 s → 30 s`; token inválido espera 120 s.

---

## 4. Contrato de adaptador

Un adaptador es un objeto con este contrato mínimo (ver `lib/channel/registry.mjs`):

| Miembro | Obligatorio | Descripción |
|---|---|---|
| `id`, `label`, `kind` | sí | Identidad (`id` minúsculas, `:` para instancias). |
| `alwaysAvailable` | sí | `true` solo para el simulador. |
| `capabilities` | sí | `{inbound,outbound,proactive,buttons,typing,threads,templates}`. |
| `configFields` | sí | Metadatos para la UI (nunca valores secretos). |
| `instructions` | sí | Pasos en español para configurarlo. |
| `status()` | sí | Estado público + `config[]` enmascarada + `runtime` + `stats`. |
| `configure(body)` | sí | Valida y guarda credenciales/ajustes en caliente. |
| `test(body)` | sí | Prueba real de credenciales (no solo «guardado»). |
| `send({to,text,meta,message})` | sí | Saliente (respuesta o proactivo). |
| `typing(to)` | no | Indicador de escritura. |
| `start({onMessage})` / `stop()` | no | Bucles de recepción. |
| `processWebhook(payload)` | no | Entrada por webhook del proveedor. |

`onMessage` es el **único** acoplamiento con el pipeline:
`onMessage({channel,userId,text,dedupeKey,id,timestamp,meta,source}) → Promise<resultado>`.
Así los adaptadores no importan el pipeline y no hay ciclos ESM.

### Campos de configuración (`configFields`)

```js
{ key, label, type: 'string'|'secret'|'boolean'|'number'|'enum'|'list'|'url',
  vault: 'channels.telegram.botToken', // opcional: secreto en bóveda AES-256-GCM
  required, default, min, max, maxLength, options, help, placeholder }
```

`GET /api/channels/:id` devuelve cada campo ya resuelto para pintar el formulario:

```json
{
  "key": "botToken", "label": "Token del bot", "type": "secret", "secret": true,
  "required": true, "configured": true, "hint": "••••XyZ1", "source": "store",
  "value": null, "updatedAt": "2026-10-27T18:00:00.000Z", "help": "…"
}
```

Reglas al guardar:
- campo ausente o `""` en secretos → **no cambiar**;
- `null` → **borrar** el valor guardado;
- un secreto solo devuelve `hint` (últimos 4) y nunca el valor;
- la configuración no requiere reiniciar: los adaptadores leen los secretos en cada uso.

---

## 5. Telegram (long polling y webhook)

### 5.1 Crear el bot (2 minutos)

1. En Telegram abre **@BotFather** → `/newbot` → nombre visible → usuario terminado en `bot`.
2. Copia el token (`123456789:AA…`). Trátalo como una contraseña.
3. En la app: **Centro de integraciones → Telegram → Token del bot** → pega y **Probar**.
   - La app llama a `getMe` **antes de guardar**; si el token es inválido devuelve
     `502 TELEGRAM_INVALID_TOKEN` y **no** persiste nada.
   - Si es válido, guarda el token cifrado, el `botUsername` y deja el canal «configurado».
4. Escríbele algo al bot (`HOY`). En la bandeja verás el mensaje y su `chat.id`, o mira
   `runtime.polling.persistedOffset`.
5. Guarda **Chat ID por defecto** (avisos proactivos y pruebas), **Chats autorizados**
   (lista blanca recomendada) y activa el canal.

### 5.2 Long polling (por defecto, funciona en local sin HTTPS)

- La app llama a `getUpdates` con `timeout=25 s` y procesa los updates en orden.
- **Offset persistido** en `channelState.channels.telegram.offset` (último `update_id + 1`).
- Si el proceso muere antes de guardar el offset, la reentrega se neutraliza por
  `dedupeKey = telegram:update:<id>`.
- No necesitas túnel, dominio ni certificado. Es el modo recomendado en local.
- Cambiar de modo: `POST /api/channels/telegram/config {"mode":"polling"}` → la app borra el
  webhook registrado (`deleteWebhook`) para que `getUpdates` no devuelva `409`.

### 5.3 Webhook opcional (HTTPS)

1. `pwsh -File scripts/tunnel.ps1` → copia la URL `https://….trycloudflare.com`.
2. En la app: **modo webhook** + **URL pública** y guardar. La app registra
   `…/api/telegram/webhook` con `secret_token` si configuraste **Secreto del webhook**.
3. Telegram enviará `x-telegram-bot-api-secret-token`; la ruta compara en tiempo constante.
   - Secreto inválido → `401 WEBHOOK_SIGNATURE_INVALID`.
   - Sin secreto en local → se acepta con advertencia; en producción/auth → `503`.
4. Si necesitas limpiar un webhook conflictivo:
   `POST /api/channels/telegram/delete-webhook`.

### 5.4 Comportamiento

- «escribiendo…» (`sendChatAction=typing`) antes de contestar.
- **Botones inline 1/2/3** cuando el asistente ofrece alternativas; al pulsar, el callback se
  procesa como si hubieras escrito el número (`answerCallbackQuery` + edición del teclado).
- Mensajes no textuales: el bot responde «solo entiendo mensajes de texto» (no se llama al
  asistente).
- `allowedChatIds` + `defaultChatId` forman la lista blanca. Sin lista, **cualquiera** que
  encuentre el bot puede escribir a tu agenda: el estado lo advierte.
- Los mensajes de chats no autorizados se registran como `skipped` (no se responden).

### 5.5 Ejemplos API

```powershell
# Configurar y activar (polling)
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/telegram/config ^
  -H "Content-Type: application/json" ^
  -d "{\"botToken\":\"123456:AA...\",\"defaultChatId\":\"123456789\",\"webhookSecret\":\"cadena-larga-aleatoria\",\"mode\":\"polling\",\"enabled\":true}"

# Probar (valida getMe y envía un mensaje si hay chat)
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/telegram/test -H "Content-Type: application/json" -d "{\"text\":\"Prueba Agenda\"}"

# Diagnóstico: una pasada manual de getUpdates
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/telegram/poll -H "Content-Type: application/json" -d "{\"timeoutSec\":2}"
```

---

## 6. WhatsApp Cloud API

### 6.1 Requisitos en Meta

1. Cuenta de **Meta for Developers** → crear app tipo **Business**.
2. Añadir el producto **WhatsApp** → obtener un número de prueba o registrar el tuyo.
3. En **WhatsApp → API Setup**:
   - **Phone Number ID** (numérico, no es el teléfono);
   - **Access Token**: para producción, crea un **System User** con token permanente; el token
     temporal de la consola caduca en 24 h.
4. En **App settings → Basic**: copia **App Secret** (firma HMAC).
5. Inventa un **Verify Token** (cadena aleatoria larga) y guárdalo también en Meta.

### 6.2 Configurar en la app

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/whatsapp/config ^
  -H "Content-Type: application/json" ^
  -d "{\"phoneNumberId\":\"111222333\",\"accessToken\":\"EAAB...\",\"appSecret\":\"...\",\"verifyToken\":\"...\",\"defaultTo\":\"573001112233\",\"templateName\":\"recordatorio\",\"templateLanguage\":\"es_CO\",\"enabled\":true}"
```

- Al enviar `accessToken`/`phoneNumberId` nuevos, la app **valida antes de guardar** con
  `GET /{phoneNumberId}` (no envía mensajes). Credenciales inválidas → error y **no se
  persiste nada** (config atómica).
- `POST /api/channels/whatsapp/test` valida credenciales y, si hay destinatario, envía una
  prueba (texto libre dentro de ventana o plantilla fuera de ella).

### 6.3 Webhook

1. Arranca el túnel: `pwsh -File scripts/tunnel.ps1`.
2. En Meta → **WhatsApp → Configuration → Webhook**:
   - **Callback URL**: `https://TU-TUNEL/api/whatsapp/webhook`
   - **Verify Token**: el mismo que guardaste en la app.
   - Suscribe el campo **messages**.
3. Handshake `GET /api/whatsapp/webhook`:
   - token correcto → `200 text/plain` con `hub.challenge`;
   - token incorrecto → `403 VERIFY_TOKEN_INVALID`;
   - sin Verify Token: local → `403`; producción/auth → `503 WEBHOOK_SECRET_MISSING`.
4. `POST /api/whatsapp/webhook`:
   - `x-hub-signature-256` se verifica con HMAC-SHA256 del **cuerpo crudo** y el App Secret;
     firma inválida → **`401 WEBHOOK_SIGNATURE_INVALID`**;
   - sin App Secret: local → se procesa con advertencia; producción/auth → `503`;
   - responde `200 {"received":true}` de inmediato y procesa en segundo plano;
   - **idempotencia por `message.id`**: la reentrega de Meta no vuelve a ejecutar el asistente.

### 6.4 Ventana de 24 h y plantillas

Meta solo permite **texto libre** dentro de las 24 h siguientes al último mensaje del usuario.
La app mantiene esa ventana (`channelState.windows`) y:

- dentro de la ventana → `type:"text"` normal;
- fuera de la ventana → si hay `templateName`, envía `type:"template"` con un parámetro de
  cuerpo (`{{1}}` = texto, máx. 900 caracteres). Si no hay plantilla →
  `409 WA_TEMPLATE_MISSING` con instrucciones;
- los avisos proactivos del scheduler usan plantilla automáticamente.

Crea la plantilla en **Meta → WhatsApp → Message Templates**, categoría *Utility*, con una
variable en el cuerpo. La revisión suele tardar entre minutos y 48 h.

### 6.5 Estados, tipos y marcas

- `statuses[]` del webhook (`sent`, `delivered`, `read`, `failed`) se guardan por `message.id`
  en `channelState.channels.whatsapp.statuses` (máx. 200) y `lastError` se actualiza si falla.
- Solo se procesan mensajes con texto (texto, respuesta de botón o interactivo). Imágenes,
  audio, etc. se registran como ignorados (no se responde para evitar bucles).
- La app marca el mensaje como leído (`status:"read"`) best-effort.

---

### 6.6 Probar el webhook sin credenciales de Meta

Puedes ejercitar la ruta real (firma HMAC, idempotencia, bandeja, estados) sin número ni
token de WhatsApp: guarda solo **App Secret** y **Verify Token**, arranca la app y firma un
payload de prueba.

```js
// node --input-type=module
import crypto from 'node:crypto';
const APP_SECRET = 'el-mismo-que-guardaste-en-la-app';
const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{
  from: '573001112233', id: 'wamid.PRUEBA',
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'text', text: { body: 'HOY' }
}] } }] }] });
const signature = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
await fetch('http://127.0.0.1:3000/api/whatsapp/webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  body
});
```

- Firma distinta → `401`; mismo `message.id` repetido → aparece como `duplicate` en la
  bandeja y **no** se ejecuta otra vez el asistente.
- Sin Access Token el envío de la respuesta fallará (`lastError` visible), pero el resto del
  flujo (dedupe, bandeja, estados) es el real. El **simulador** sigue siendo la vía más rápida
  para conversar sin nada configurado.

## 7. Correo (Gmail entrada y salida)

### 7.1 Salida

- Si ya hay una **cuenta Google conectada** (Integraciones → Google), la salida usa el
  `sendGmail` existente (`gmail.send`).
- Si no, se usa el token de lectura del canal (incluye `gmail.send`).

### 7.2 Entrada por polling (requiere permiso de lectura)

La app necesita un consentimiento OAuth propio con **`gmail.modify` + `gmail.send`**:

1. En **Google Cloud Console** crea/reutiliza un proyecto y habilita **Gmail API**.
2. Crea credenciales **OAuth Client ID → Aplicación web**.
3. Añade el redirect URI:
   - local: `http://127.0.0.1:3000/api/channels/email/oauth/callback`
   - túnel fijo: `https://TU-DOMINIO/api/channels/email/oauth/callback`
   > El túnel rápido de Cloudflare cambia de URL: para Gmail usa un túnel/dominio fijo y
   > arranca la app con `APP_URL=https://TU-DOMINIO`.
4. Guarda `google.clientId` y `google.clientSecret` en la app (Centro de integraciones →
   Secretos, grupo Google; o `PUT /api/secrets/google.clientId`).
5. En **Correo (Gmail)** pulsa **Conectar Gmail (lectura y envío)** → se abre el
   consentimiento → el token queda **cifrado** en `channelState.channels.email.token`.
6. Configura **Correo de notificaciones**, **Remitentes autorizados**, frecuencia y activa:
   ```powershell
   curl.exe -s -X POST http://127.0.0.1:3000/api/channels/email/config ^
     -H "Content-Type: application/json" ^
     -d "{\"enabled\":true,\"to\":\"yo@ejemplo.com\",\"allowFrom\":[\"yo@ejemplo.com\"],\"pollIntervalMin\":5,\"maxPerPoll\":5,\"replyEnabled\":true,\"markRead\":true}"
   ```
7. Revisión manual (diagnóstico): `POST /api/channels/email/poll`.

### 7.3 Cómo procesa el correo

- `users.messages.list?q=is:unread -in:spam -in:trash&maxResults=N` y
  `users.messages.get?format=full` por cada no leído (máx. 10 por pasada).
- **Solo remitentes autorizados** (`allowFrom`; por defecto el correo de notificaciones).
  Otros se registran como ignorados: un buzón público no debe poder mover tu agenda.
- Se descarta la parte citada del hilo (`>` y «On … wrote:») antes de pasarla al asistente.
- **Respuesta en el mismo hilo**: `threadId` + `In-Reply-To` + `References` + `Subject: Re: …`.
- **Anti-bucle**: las respuestas del canal llevan `X-Agenda-Copilot: auto-reply`; el polling
  ignora cualquier mensaje con esa cabecera, además de autorespondedores (`Auto-Submitted`,
  `Precedence: bulk|list`, asuntos «fuera de la oficina»). También se marca como leído el
  propio envío cuando llega a la misma cuenta.
- Idempotencia doble: `channelState.channels.email.seen` + `dedupeKey = gmail:<id>`.
- Si hay permiso, se marca como leído (`removeLabelIds:["UNREAD"]`); si no, la lista de
  vistos evita reprocesar.

### 7.4 Límites y modo de prueba de Google

- Gmail API es gratuita con cuotas holgadas para uso personal; consulta los límites vigentes.
- Con la app OAuth en modo **Testing**, añade tu cuenta como *test user* (máx. 100) y ten en
  cuenta que Google puede caducar el refresh token a los ~7 días. Para uso continuado publica
  la app; `gmail.modify` es un *scope* sensible y puede requerir verificación de Google.
- Si el token caduca, el estado muestra `GOOGLE_RECONNECT` y hay que volver a conectar.

---

## 8. Webhook genérico (Slack, Discord, n8n, Zapier)

### 8.1 Crear una instancia

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/webhook:n8n/config ^
  -H "Content-Type: application/json" ^
  -d "{\"label\":\"n8n producción\",\"outboundUrl\":\"https://n8n.ejemplo.com/webhook/agenda\",\"preset\":\"n8n\"}"
```

Respuesta (el token se muestra **una sola vez**; guárdalo):

```json
{
  "ok": true, "created": true, "instance": "webhook:n8n", "tokenRotated": true,
  "generatedToken": "b0f1…48 caracteres hex…",
  "detail": "Webhook creado. Guarda el token: no se volverá a mostrar.",
  "item": { "id": "webhook:n8n", "configured": true, "…": "…" }
}
```

- Instancias: `generic` + cualquier `webhook:<nombre>` (`a-z0-9_-`, 2–31 caracteres).
- `generic` usa la bóveda (`webhooks.generic.secret`); las demás guardan su token cifrado en
  `channelState.channels['webhook:<nombre>'].token`.
- Rotar token: `POST …/config {"token":"nuevo-token-largo"}`. Borrarlo: `{"token":null}` →
  la instancia queda **cerrada** (`503 WEBHOOK_SECRET_MISSING`) hasta que se genere otro token,
  incluso en modo local. `generic` es la única excepción local heredada del contrato.
- Deshabilitar: `{"enabled":false}` → `403 CHANNEL_DISABLED` al entrar.

### 8.2 Entrada

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/inbound/webhook:n8n ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer b0f1…" ^
  -d "{\"text\":\"HOY\",\"id\":\"evt-123\",\"user\":\"yo\"}"
```

- Token aceptado en `Authorization: Bearer`, `X-Webhook-Secret`, `X-Channel-Token` o `?token=`.
  Comparación en tiempo constante.
- Sin token en **modo local** → se acepta con advertencia (compatibilidad con el contrato);
  en **producción/auth** → `503 WEBHOOK_SECRET_MISSING`. Token inválido → `401`.
- El cuerpo es JSON libre; se busca texto en `text`, `message`, `content`, `body`… y un
  identificador en `id`, `messageId`, `event_id`, `uuid`… para deduplicar.
- Sin texto → `400 EMPTY_MESSAGE` (campo `text`).
- Respuesta: `200 {received, channel, duplicate, accepted, reply, userId, outbound[]}`.
  Si hay `outboundUrl`, la respuesta también se envía allí.
- Alias compatible con el contrato: `POST /api/webhooks/generic` → `{received, signal}`.

### 8.3 Salida HTTP configurable

| Campo | Valores | Uso |
|---|---|---|
| `outboundUrl` | URL http(s) | Destino de la respuesta (si falta, solo viaja en el HTTP de entrada). |
| `method` | `POST` (def.) / `PUT` | Método. |
| `preset` | `generic` / `slack` / `discord` / `n8n` / `zapier` | Forma del cuerpo. |
| `outboundHeaders` | lista `Nombre: valor` | Cabeceras extra (Host/Content-Length prohibidos). |
| `outboundTokenHeader` | `Authorization` (def.) u otra | Si es Authorization se envía `Bearer …`. |
| `outboundToken` | secreto | Token hacia la herramienta externa (cifrado). |

Cuerpos:

```json
// generic / n8n / zapier
{ "event":"agenda.message", "channel":"webhook", "instance":"n8n",
  "id":"MSG-…", "user":"n8n:yo", "text":"HOY", "reply":"📌…", "replyAt":"…", "timestamp":"…" }

// slack
{ "text": "📌…" }

// discord
{ "content": "📌…" }
```

Ejemplos:
- **Slack**: crea un *Incoming Webhook* y pega su URL en `outboundUrl`, preset `slack`.
- **Discord**: *Webhook → Copy URL*, preset `discord`.
- **n8n**: nodo *Webhook* con método POST, preset `n8n`; en n8n puedes usar
  `{{$json.reply}}` para responder.
- **Zapier**: *Catch Hook*, preset `zapier`.

> Los envíos de salida se reintentan con backoff ante `429/503`; si la URL cae, el error queda
> en `lastError` y la respuesta sigue disponible en el HTTP de entrada y en la bandeja.

---

## 8-bis. Aprobaciones y entregables de la Oficina

> Puente entre el gate N0-N3 de `lib/office/**` (t13), los documentos de
> `lib/docs/**` (t17) y los canales. **Aprobar por WhatsApp/Telegram/correo no
> ejecuta**: mueve el gate (pending → approved/rejected) y la ejecución sigue
> siendo el paso único de `/api/office/proposals/:id/execute`.

### Flujo completo

```
Propuesta N2/N3 (Oficina) ──► tarjeta por canal preferido ──► dueño responde
      │                              │                          │
      │                              │                    ok / 1 / botón ✅
      │                              │                    no / 2 / botón ❌
      │                              │                    corrige: … / 3
      │                              ▼                          ▼
      └──────────── recordatorio 15 min (máx. 2) ─────► gate approve/reject/corrección
                                                              │
                                                     ledger append-only + aviso al dueño
```

### Endpoints

| Método | Ruta | Cuerpo / query | Respuesta |
|---|---|---|---|
| GET | `/api/channels/approvals/pending` | — | `{items[],count,total,preferred,config}` con propuestas `pending/held`, tarjetas enviadas y recordatorios |
| GET | `/api/channels/approvals/status` | — | config, dueños resueltos, watcher, baseline, stats y `lastError` |
| POST | `/api/channels/approvals/config` | `{preferredChannel?, notifyOnCreate?, reminderMinutes?, maxReminders?, simulatorTarget?, owners?, allowAutonomousOutbound?}` | config validada + estado |
| POST | `/api/channels/approvals/:id/send` | `{channel, to?}` | `{ok,proposalId,channel,to,messageId,card,context}` |
| POST | `/api/channels/approvals/:id/remind` | `{channel?, to?, force?}` | `{ok,reminders,messageId,context}` |
| POST | `/api/channels/:id/send` | `{to \| recipients, body, subject?, attachments?}` | **202** `{status,approvalRequired,message,approvalUrl,proposal:{id,level,risk,flags,…},auto,executed}`; por defecto NO envía |
| POST | `/api/channels/send-document` | `{docId, channel, to?, caption?, subject?}` | **202** misma forma + `doc:{id,filename,mimeType,size}`; por defecto NO envía. Sin `docId` → 400 REQUIRED |
| GET | `/api/channels/documents/status` | — | almacén detectado y límites |
| GET | `/api/channels/documents/:docId` | — | metadatos del documento resuelto |

Todas son autenticadas (en modo local sin login, abiertas). `:id` es el id de la
propuesta (`OF-0001`). La tarjeta solo se envía si la propuesta sigue `pending` o
`held`; si ya se decidió → `409 ALREADY_DECIDED` («esa gestión ya se decidió»).

### Tarjeta por canal

La tarjeta incluye **nivel, riesgo/10, señales, destinatarios, asunto, motivo,
voz del equipo, extracto del contenido, enlace a la Oficina e instrucciones**.

| Canal | Presentación | Respuesta esperada |
|---|---|---|
| **Telegram** | Mensaje + botones inline «✅ Aprobar / ❌ Rechazar / 📄 Ver» (`callback_data` `ap:OF-xxxx:approve|reject|view`) | Botón, o texto `ok OF-xxxx`, `no OF-xxxx`, `corrige: …` |
| **WhatsApp** | Texto compacto con `1 = aprobar · 2 = rechazar · 3 = corregir` | `1`, `2`, `3` (y luego `corrige: …`), o `ok OF-xxxx` |
| **Correo** | HTML mínimo + `Reply-To` al buzón vigilado + asunto ASCII `[OF-xxxx] Aprobacion N2 - …` | Responder con `OK`, `NO` o `CORRIGE: <texto>` conservando el asunto (requiere Gmail con lectura, no solo envío) |
| **Simulador** | Mismo texto que WhatsApp, en la bandeja local | `1/2/3`, `ok`, `no`, `corrige: …` |

En WhatsApp, fuera de la ventana de 24 h la tarjeta se envía con la **plantilla**
configurada (el texto completo va como parámetro `{{1}}`); si no hay plantilla →
`409 WA_TEMPLATE_MISSING`. En Telegram los botones usan `callback_data` cortos y
el adaptador los reenvía al gate con la identidad del chat.

### Configuración de dueño y canal preferido

La lista blanca es **configurable** y se compone de:

1. `approvals.owners.<canal>` (lista explícita en la configuración del gate), y
2. la lista ya existente del canal: Telegram `allowedChatIds` + `defaultChatId`;
   WhatsApp `allowedNumbers` + `defaultTo`; correo `allowFrom` + `email.to`.

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/approvals/config ^
  -H "Content-Type: application/json" ^
  -d "{\"preferredChannel\":\"telegram\",\"notifyOnCreate\":true,\"reminderMinutes\":15,\"maxReminders\":2,\"owners\":{\"telegram\":[\"123456789\"],\"email\":[\"yo@ejemplo.com\"]}}"
```

- **Simulador**: si `owners.simulator` está vacío se acepta cualquier `userId`
  local (es la vía de prueba). Si se configura, solo esos ids deciden.
- La API muestra los dueños de canales reales **enmascarados** (`••••1234`) y el
  conteo en `ownerCounts`, para no exponer destinos que viven en la bóveda.
  Para cambiar una lista se envía esa lista completa en `owners`; las listas de
  los demás canales se conservan (merge por canal).
- **Canal real sin lista blanca**: no se puede enviar tarjeta (`403 OWNER_NOT_CONFIGURED`)
  y cualquier intento de decisión se rechaza.
- **Remitente no autorizado**: recibe «⛔ No autorizado…», **no** se aplica nada y
  el intento queda en el ledger del gate como `proposal.approval_denied`
  (payload: propuesta, canal, identidad y decisión). También en WhatsApp,
  Telegram y correo: el adaptador deja pasar únicamente mensajes que *parecen*
  una respuesta de aprobación para poder auditarlos; el resto sigue ignorado.
- El **canal preferido** por defecto se resuelve en orden Telegram → WhatsApp →
  correo → simulador, usando el primero activo/configurado con destino. Se puede
  fijar con `preferredChannel`.

### Autonomía de salida (opt-in, t35)

Por defecto **todo envío a terceros queda pending**, incluso en modo `total` o
`autónomo`: las rutas de canal crean la propuesta con `forceApproval`, igual que
`/api/gmail/send`. La única excepción es una autonomía explícita:

| Requisito | Valor |
|---|---|
| Flag | `settings.office.allowAutonomousOutbound === true` (default `false`) |
| Modo | `total` o `autonomo` |
| Riesgo | `proposal.risk.score <= 2` |
| Contacto | `proposal.knownContact === true` (todos los destinatarios conocidos) |
| Nivel | nunca `N3` (aunque cumpla lo anterior) |

Se puede activar desde **Ajustes** (`settings.office.allowAutonomousOutbound`) o desde la
configuración de aprobaciones; ambas vías escriben el flag y dejan rastro en el
ledger (`office.settings`). La vía de canales usa `source:"channels.approvals.config"`
y es un patch parcial (no toca owners/preferred/recordatorios):

```powershell
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/approvals/config ^
  -H "Content-Type: application/json" ^
  -d "{\"allowAutonomousOutbound\":true}"
```

La entrada `office.settings` se escribe **antes** de persistir el flag; si el
ledger falla, la petición responde `503 OFFICE_UNAVAILABLE` y el flag **no**
cambia. Un cambio real = una entrada; si el valor ya era el mismo no se duplica.

Si se cumple todo, el adaptador **aprueba y ejecuta** la propuesta en la misma
petición: escribe `outbound.autonomous` en el ledger **antes** del envío, y
responde `status:'executed'`, `auto:true`, `executed:true`,
`approvalRequired:false`. Si no se cumple, la respuesta es `pending_approval` y
nada sale hasta aprobar/ejecutar. En N3 el código de 6 sigue siendo obligatorio.

### ACL de documentos (t46)

Antes de crear la propuesta, `/api/channels/:id/send`, `/api/channels/send-document`
y la ruta efectiva `/api/docs/:id/send-email` consultan `guardOutbound` de
`lib/acl` con la etiqueta del documento (`docId` manda sobre `label`) y los
destinatarios. Si `lib/acl` no está disponible → **503 ACL_UNAVAILABLE**: nunca
se crea una propuesta sin control.

| Etiqueta / audiencia | Resultado |
|---|---|
| `público` | Se crea la propuesta normal (`202 pending_approval`) con `meta.acl`. |
| `interno` → internos | Normal; `meta.acl` con nivel N1. |
| `interno` → externos/mixto | **202 N2 con aviso** (`acl.requiresConfirmation:true` en la respuesta y en `meta.acl`); no se auto-ejecuta ni con autonomía. |
| `reservado` → internos | Normal N2; `meta.acl` reservado. |
| `reservado` → externos sin confirmar | **403 ACL_DENIED** con `{reason,level,label}`; no se crea propuesta. |
| `reservado` → externos con `confirmedReserved:true` | **202 N3 forzado**; `risk.score >= 7`, flag `ACL_RESERVED`, código obligatorio al ejecutar. |

La propuesta creada lleva `meta.acl = {label, level, reason, requiresConfirmation, confirmedReserved, docIds}`.
Cada salida restringida (bloqueo, aviso o reservado confirmado) deja
`acl.enforced` en el ledger encadenado de la Oficina antes de crear/denegar; el
payload incluye canal, documento(s), etiqueta, nivel, motivo, `allowed`,
`requiresConfirmation` y destinatarios (conteo). Las tarjetas internas al dueño
y el simulador hacia el dueño no cambian.

`CHANNELS_TEST_DISABLE_ACL=1` es solo para pruebas: simula ACL ausente y debe
devolver 503 sin propuesta.

### Respuestas humanas y ambigüedad

| Texto | Acción |
|---|---|
| `ok`, `dale`, `sí`, `adelante`, `1` | `approve` en el gate |
| `no`, `cancela`, `rechaza`, `2` | `reject` |
| `corrige: <texto>`, `cambia …`, `3` | registra la corrección y **rechaza** la propuesta para ajustarla (`rejectReason = "corrección vía …: …"` + `proposal.correction` en el ledger) |
| `ver OF-xxxx`, `detalle` | devuelve la tarjeta sin decidir |
| `ok OF-0002` / `no OF-0002` | actúa sobre esa propuesta aunque haya varias pendientes |

- Sin id explícito y **una sola** propuesta pendiente para ese usuario → actúa.
- Sin id y **varias** pendientes → pide el id (`Tienes N propuestas pendientes…`);
  no adivina.
- Si la propuesta **ya no está pendiente** → responde «esa gestión ya se decidió
  (estado)» y no vuelve a aprobar/rechazar ni ejecuta nada.
- **N3**: al aprobar se devuelve **una sola vez** el código de 6 caracteres en la
  respuesta al dueño; hace falta para `/api/office/proposals/:id/execute`.
- Aprobar/rechazar **no ejecuta**: `execute` valida modo, firma HMAC, TTL 30 min,
  payload intacto y código N3, con claim atómico y una sola ejecución.

### Avisos automáticos y recordatorios

- Al arrancar los canales se inicia un **watcher** (10 s por defecto, timer
  `unref`) que detecta propuestas N2/N3 nuevas (`pending`/`held`) y envía la
  tarjeta al canal preferido con enlace/atajo. No reenvía las ya notificadas
  (`notified` persistente) y respeta `notifyOnCreate`.
- **Recordatorio a los 15 min** (configurable 1–120) si sigue pendiente, y otro a
  los 30 min. **Nunca más de 2** (`maxReminders` 0–2).
- Variables: `CHANNELS_APPROVALS_AUTOSTART=0` desactiva solo este watcher;
  `CHANNELS_APPROVALS_TICK_MS` ajusta el periodo (mínimo 5 s). Si usas
  `CHANNELS_AUTOSTART=off` (tests de canales), el watcher tampoco arranca;
  en ese caso ejecuta `runApprovalsTick()` desde el autocheck o una ruta interna.
- El endpoint `remind` es una **acción manual**: envía el recordatorio de inmediato
  (máximo 2 en total). El ritmo de 15/30 min lo aplica solo el watcher automático.
  `force:true` se acepta por compatibilidad y ya no es necesario.

### Entregables: documentos como adjuntos (propuesta)

`POST /api/channels/send-document` **no envía**: resuelve el `docId` contra
`lib/docs/index.mjs` (`readDocument(id)`), el índice `DATA_DIR/docs/index.json`,
proveedores registrados o ficheros de `DATA_DIR` (por id o nombre), y crea una
propuesta de la Oficina con el adjunto. Devuelve **202**
`{status:'pending_approval',proposal,doc}`; 404 `DOC_NOT_FOUND` si el
documento no existe. El límite del documento es 25 MB.

```powershell
# 1) generar el documento (t17) -> { id: "DOC-20261028-…", filename, bytes }
curl.exe -s -X POST http://127.0.0.1:3000/api/docs ^
  -H "Content-Type: application/json" ^
  -d "{\"type\":\"docx\",\"title\":\"Informe P95\",\"sections\":[{\"heading\":\"Resumen\",\"level\":1},{\"paragraph\":\"Texto del informe.\"}]}"

# 2) crear la propuesta (NO envía); devuelve proposal.id
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/send-document ^
  -H "Content-Type: application/json" ^
  -d "{\"docId\":\"DOC-20261028-…\",\"channel\":\"telegram\",\"to\":\"123456789\"}"

# 3) aprobar y ejecutar en la Oficina (el ejecutor envía el archivo)
#    Si el nivel es N3, guarda el código de 6 que devuelve el approve.
curl.exe -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/approve ^
  -H "Content-Type: application/json" -d "{\"by\":\"jefe\"}"
curl.exe -s -X POST http://127.0.0.1:3000/api/office/proposals/OF-0001/execute ^
  -H "Content-Type: application/json" -d "{}"
```

El envío real lo hace el ejecutor de canal al ejecutar la propuesta:

| Canal | Implementación al ejecutar |
|---|---|
| Telegram | `sendDocument` multipart (`chat_id`, `document`, `caption`) |
| WhatsApp | subida a `/{phoneNumberId}/media` + mensaje `type:"document"` con `filename` |
| Correo | MIME `multipart/mixed` con el adjunto en base64 y `Content-Disposition: attachment; filename=…` |
| Simulador | registra el documento en la bandeja local con nombre, tamaño y mime |

Los envíos ejecutados quedan en la bandeja (`meta.document = true`), con
`proposalId` y el id del proveedor, y en la auditoría. **Antes de ejecutar no
sale nada**: el outbox del canal permanece intacto.

### Prueba completa con el simulador (2 minutos)

```powershell
# 0) app en marcha y aprobaciones apuntando al simulador
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/approvals/config ^
  -H "Content-Type: application/json" ^
  -d "{\"preferredChannel\":\"simulator\",\"simulatorTarget\":\"demo-owner\",\"owners\":{\"simulator\":[\"demo-owner\"]}}"

# 1) propuesta N2 (destinatario externo + adjunto)
curl.exe -s -X POST http://127.0.0.1:3000/api/office/proposals ^
  -H "Content-Type: application/json" ^
  -d "{\"kind\":\"email\",\"channel\":\"email\",\"recipients\":[\"cliente@externo.com\"],\"subject\":\"Propuesta\",\"body\":\"Adjunto propuesta.\",\"attachments\":[\"propuesta.pdf\"]}"

# 2) enviar la tarjeta (usa el id OF-0001 devuelto)
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/approvals/OF-0001/send ^
  -H "Content-Type: application/json" -d "{\"channel\":\"simulator\",\"to\":\"demo-owner\"}"

# 3) conversar como el dueño
curl.exe -s -X POST http://127.0.0.1:3000/api/channels/simulate ^
  -H "Content-Type: application/json" -d "{\"text\":\"ok\",\"userId\":\"demo-owner\"}"
# → ✅ OF-0001 aprobada (N2 · EMAIL). La ejecución sigue siendo un paso aparte.

# 4) comprobar el gate y la bandeja
curl.exe -s http://127.0.0.1:3000/api/office/proposals/OF-0001
curl.exe -s "http://127.0.0.1:3000/api/channels/inbox?channel=simulator&limit=10"
curl.exe -s http://127.0.0.1:3000/api/office/ledger?limit=10
```

Variantes: `no` rechaza; `corrige: pon 10:00` deja la propuesta rechazada con la
corrección en `rejectReason` y en el ledger; `intruso` que responde `ok` recibe
«No autorizado» y genera `proposal.approval_denied`; una segunda respuesta del
dueño recibe «esa gestión ya se decidió». El autocheck automatiza todo esto.

### Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `403 OWNER_NOT_CONFIGURED` al enviar tarjeta | Canal sin lista blanca | Guarda `allowedChatIds`/`allowedNumbers`/`allowFrom` o `approvals.owners` |
| `403 NOT_OWNER` | `to` no está en la lista | Usa el chat/número/correo del dueño |
| `409 ALREADY_DECIDED` | La propuesta ya se aprobó/rechazó | Consulta `GET /api/office/proposals/:id` |
| `409 NOT_SENT` al recordar | No se envió tarjeta previa | Envía la tarjeta primero |
| `409 MAX_REMINDERS` | Ya hay 2 recordatorios | No se envían más |
| `409 CHANNEL_NOT_READY` | Canal desactivado | Actívalo en el centro de integraciones |
| `503 WEBHOOK_SECRET_MISSING` (gate) | Sin secreto en modo estricto | Configura los secretos del canal |
| El correo de aprobación no llega | Sin Gmail conectado/lectura | Conecta Gmail (OAuth) y activa el canal |
| WhatsApp no envía tarjeta fuera de 24 h | Ventana cerrada sin plantilla | Crea plantilla aprobada o escribe al bot primero |
| `DOC_NOT_FOUND` | `docId` inexistente o índice aún sin escribir | Genera con `POST /api/docs` o usa un fichero de `DATA_DIR` |
| `CHANNEL_NO_DOCUMENTS` | Canal sin soporte de adjuntos | Usa Telegram/WhatsApp/correo/simulador |


---

## 9. Añadir un canal nuevo en 30 líneas

Solo hay que crear un archivo en `lib/channel/`, registrarlo en `lib/channels.mjs` y (si
recibe por webhook) añadir una ruta en `lib/routes/channels.mjs`. El pipeline ya te da
dedupe, rate limit, asistente, bandeja, auditoría y reintentos.

```js
// lib/channel/matrix.mjs
import { sanitizeText } from './message.mjs';
import { ChannelError, requestJson } from './http.mjs';
import { buildConfigView, applyConfigFields } from './config.mjs';
import { getChannelConfig, plainClone } from './state.mjs';

const FIELDS = [
  { key: 'enabled', label: 'Canal activo', type: 'boolean', default: false },
  { key: 'homeserver', label: 'Homeserver', type: 'url', maxLength: 300 },
  { key: 'accessToken', label: 'Access Token', type: 'secret', maxLength: 512 },
  { key: 'defaultRoom', label: 'Sala por defecto', type: 'string', maxLength: 120 }
];

export function createMatrixAdapter() {
  let onMessage = null;
  return {
    id: 'matrix', label: 'Matrix', kind: 'messaging', alwaysAvailable: false,
    capabilities: { inbound: true, outbound: true, proactive: true,
      buttons: false, typing: false, threads: false, templates: false },
    configFields: FIELDS,
    instructions: ['Crea un bot en tu homeserver.', 'Guarda URL, token y sala, y activa el canal.'],
    status() {
      const config = getChannelConfig('matrix');
      const configured = !!config.homeserver && !!config.accessToken;
      return {
        id: 'matrix', label: 'Matrix', configured, enabled: config.enabled === true,
        ready: configured && config.enabled === true, detail: configured ? 'Configurado' : 'No configurado',
        instructions: this.instructions, warnings: [], config: buildConfigView(FIELDS, config),
        runtime: { lastError: plainClone(config.lastError), stats: config.stats || {} }
      };
    },
    async configure(body) {
      const result = await applyConfigFields({ channel: 'matrix', fields: FIELDS, body, settings: getChannelConfig('matrix') });
      const { patchChannelConfig } = await import('./state.mjs');
      if (Object.keys(result.settingsPatch).length) await patchChannelConfig('matrix', result.settingsPatch);
      return { ok: true, changed: result.changed, detail: 'Guardado y aplicado sin reiniciar.' };
    },
    async test() { return { ok: true, detail: 'Conexión validada.' }; },
    async send({ to, text }) {
      const config = getChannelConfig('matrix');
      if (!config.accessToken) throw new ChannelError('CHANNEL_NOT_CONFIGURED', 'Falta token de Matrix.', { channel: 'matrix', status: 409 });
      await requestJson(`${config.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(to || config.defaultRoom)}/send/m.room.message?access_token=${config.accessToken}`,
        { method: 'POST', body: { msgtype: 'm.text', body: text }, channel: 'matrix' });
      return { id: crypto.randomUUID(), via: 'matrix' };
    },
    start({ onMessage: handler }) { onMessage = handler; },
    stop() {},
    async processWebhook(payload) {
      await onMessage({
        channel: 'matrix',
        userId: String(payload.sender || 'matrix'),
        text: sanitizeText(payload.content?.body || payload.text),
        dedupeKey: `matrix:${payload.event_id}`,
        id: `matrix:${payload.event_id}`,
        meta: { room: payload.room_id },
        source: 'matrix'
      });
    }
  };
}
```

Registro en `lib/channels.mjs` (una línea en `getChannelRuntime`):

```js
import { createMatrixAdapter } from './channel/matrix.mjs';
// …
const adapters = { /* … */, matrix: createMatrixAdapter() };
for (const adapter of Object.values(adapters)) registry.register(adapter);
adapters.matrix.setDispatcher?.(pipeline.receive); // solo si usa setDispatcher
```

Y una ruta pública para su webhook (con el token/estado que definas):

```js
{
  method: 'POST', path: '/api/channels/matrix/inbound', auth: 'none', webhook: true, csrf: false,
  handler: async (ctx) => { await getChannelAdapter('matrix').processWebhook(await ctx.body()); return { received: true }; }
}
```

No hace falta tocar `server.mjs`: el auto-descubrimiento monta el módulo. El `POST` del
pipeline ya aplica dedupe/rate limit/asistente.

---

## 10. API de canales

Todas las rutas salvo las marcadas «público» son autenticadas (en modo local sin sesión,
abiertas). `HEAD` funciona en las `GET`. Errores con el formato del contrato
(`{error, code, field, details, requestId}`).

| Método | Ruta | Cuerpo / query | Respuesta |
|---|---|---|---|
| GET | `/api/channels` | — | `{items[],count,total,generatedAt}` |
| GET | `/api/channels/health` | — | `{ok,started,autostart,webhookStrict,channels[],limits}` |
| GET | `/api/channels/inbox` | `limit,channel,direction` | `{items[],count,total,stored}` |
| GET | `/api/channels/messages` | igual | alias de inbox |
| GET | `/api/channels/:id` | — | `{item}` (`generic`, `webhook:<nombre>`, …) |
| POST | `/api/channels/:id/config` | `{enabled?, …campos}` o `{fields:{…}}` | `{ok,detail,changed[],generatedToken?,item}` |
| POST | `/api/channels/:id/test` | `{to?,text?,chatId?}` | `{ok,detail,result,item}` · solo dueño/simulador (403 `NOT_OWNER` a terceros) |
| POST | `/api/channels/:id/send` | `{to\|recipients,body,subject?,attachments?}` | **202** `{status,approvalRequired,message,approvalUrl,proposal:{…risk,flags…},auto,executed}` (pending por defecto) |
| POST | `/api/channels/:id/enable` | `{enabled:true|false}` | `{ok,…,item}` |
| POST | `/api/channels/simulate` | `{text,userId?}` | `{ok,reply,outbound[],channel,userId,duplicate,messageId,approval?}` |
| GET | `/api/channels/approvals/pending` | — | `{items[],count,total,preferred,config}` |
| GET | `/api/channels/approvals/status` | — | config, dueños, watcher, stats |
| POST | `/api/channels/approvals/config` | `{preferredChannel?,notifyOnCreate?,reminderMinutes?,maxReminders?,simulatorTarget?,owners?,allowAutonomousOutbound?}` | `{ok,…status}` |
| POST | `/api/channels/approvals/:id/send` | `{channel,to?}` | `{ok,proposalId,channel,to,messageId,card,context}` |
| POST | `/api/channels/approvals/:id/remind` | `{channel?,to?,force?}` | `{ok,reminders,messageId,context}` |
| POST | `/api/channels/send-document` | `{docId,channel,to?,caption?,subject?}` | **202** misma forma + `doc` (pending por defecto; sin docId → 400) |
| POST | `/api/docs/:id/send-email` | `{to,subject,body,connectionId?}` | **202** propuesta (no envía); **503 EMAIL_NOT_CONFIGURED** si Gmail no está conectado |
| GET | `/api/channels/documents/status` | — | almacén y límites |
| GET | `/api/channels/documents/:docId` | — | metadatos del documento |
| POST | `/api/channels/inbound/:id` | JSON libre + token | `{received,channel,duplicate,accepted,reply,userId,outbound[]}` (público con token) |
| POST | `/api/channels/telegram/poll` | `{timeoutSec?}` | `{ok,updates,processed,offset}` |
| POST | `/api/channels/telegram/delete-webhook` | — | `{ok}` |
| POST | `/api/channels/email/poll` | — | `{ok,scanned,processed,ignored}` o `{ok:false,skipped,reason}` |
| GET | `/api/channels/email/oauth/start` | — | `302` a Google |
| GET | `/api/channels/email/oauth/callback` | `code,state` | `302 /?channel=email&connected=1` o `400 OAUTH_STATE_INVALID` (público) |
| POST | `/api/whatsapp/webhook` | payload de Meta + firma | `{received:true}` (público, HMAC) |
| GET | `/api/whatsapp/webhook` | handshake `hub.*` | `text/plain` challenge (público) |
| POST | `/api/telegram/webhook` | update de Telegram + secreto | `{received:true}` (público) |
| POST | `/api/webhooks/generic` | JSON libre + token | `{received,signal}` (público) |

### Códigos de error propios

| Código | HTTP | Cuándo |
|---|---|---|
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Firma HMAC o token de webhook incorrecto. |
| `WEBHOOK_SECRET_MISSING` | 503 | Webhook sin secreto en producción/auth. |
| `VERIFY_TOKEN_INVALID` | 403 | Handshake de WhatsApp con Verify Token incorrecto. |
| `CHANNEL_NO_PROPOSAL` | 400 | El canal no admite propuestas de salida (p. ej. webhook genérico). |
| `ACL_DENIED` | 403 | Documento reservado a externos sin `confirmedReserved:true`; incluye `details.reason/level/label`. |
| `ACL_UNAVAILABLE` | 503 | `lib/acl` no disponible; no se crea propuesta ni se envía. |
| `OFFICE_UNAVAILABLE` | 503 | La Oficina no respondió o no pudo auditar la autonomía; no se envía nada. |
| `EMAIL_NOT_CONFIGURED` | 503 | Envío de documento por correo sin Gmail conectado; no se envía nada. |
| `CHANNEL_NOT_CONFIGURED` | 409 | Prueba/envío sin credenciales; incluye `instructions`. |
| `CHANNEL_DISABLED` | 403 | Instancia de webhook deshabilitada. |
| `WA_UNAUTHORIZED` / `TELEGRAM_INVALID_TOKEN` / `GOOGLE_*` | 401/409/502 | Credenciales rechazadas por el proveedor (config atómica: no se guardan). |
| `WA_TEMPLATE_MISSING` | 409 | Ventana de 24 h cerrada y sin plantilla. |
| `TOO_MANY_REQUESTS` | 429 | Rate limit; incluye `retryAfterSec`. |
| `EMPTY_MESSAGE` | 400 | Payload sin texto en webhook genérico. |
| `NOT_CONFIGURABLE` | 400 | Intentar desactivar el simulador. |
| `UNKNOWN_CHANNEL` | 404 | Id de canal/instancia inexistente. |
| `OAUTH_STATE_INVALID` | 400 | Callback OAuth con state caducado/incorrecto. |
| `ALREADY_DECIDED` | 409 | Propuesta ya aprobada/rechazada/ejecutada; no se repite. |
| `OWNER_NOT_CONFIGURED` / `NOT_OWNER` | 403 | Canal sin lista blanca de dueño / destino fuera de ella. `details.listField` indica `allowedChatIds`, `allowedNumbers`, `allowFrom` o `approvals.owners.<canal>`. |
| `NOT_SENT` / `MAX_REMINDERS` | 409 | Recordatorio sin tarjeta previa o límite de 2 alcanzado. |
| `NO_TARGET` / `CHANNEL_NOT_READY` | 409 | Canal sin destino o desactivado para aprobaciones. |
| `DOC_NOT_FOUND` / `DOC_FILE_MISSING` | 404 | `docId` inexistente o archivo borrado. |
| `CHANNEL_NO_DOCUMENTS` / `DOC_TOO_LARGE` | 400/413 | Canal sin adjuntos o documento > 25 MB. |

---

## 11. Seguridad

- **Secretos cifrados**: los secretos del catálogo van a la bóveda AES-256-GCM
  (`store.secrets`) y se materializan en el entorno del proceso al arrancar/guardar. Los
  tokens de instancias de webhook y el token OAuth de Gmail se cifran con la misma clave
  maestra en `channelState`. En disco no hay tokens en claro (lo verifica el autocheck).
- **Nunca se devuelven valores**: la API solo expone `configured`, `source`, `hint` (4 últimos)
  y `updatedAt`. Los logs y errores pasan por redacción de secretos.
- **Firmas**: WhatsApp HMAC-SHA256 sobre el cuerpo crudo; Telegram `secret_token` comparado en
  tiempo constante; webhooks con token en tiempo constante.
- **Config atómica**: token de Telegram validado con `getMe` y credenciales de WhatsApp con
  `GET /{phoneNumberId}` **antes** de guardar. Si el proveedor las rechaza, no se persiste nada.
- **Listas blancas**: Telegram (`allowedChatIds` + chat por defecto) y correo (`allowFrom`)
  determinan quién puede dar órdenes. WhatsApp (`allowedNumbers`) es opcional pero el estado
  advierte si está vacía.
- **Aprobaciones**: solo el dueño (lista blanca) decide; cualquier otro intento recibe «no autorizado» y queda en el ledger del gate (`proposal.approval_denied`). Aprobar/rechazar no ejecuta; la ejecución sigue siendo única y firmada.
- **Salida a terceros = propuesta**: `POST /api/channels/:id/send`, `POST /api/channels/send-document` y `POST /api/docs/:id/send-email` solo crean una propuesta de la Oficina (202; el segundo devuelve 503 si Gmail no está conectado) y **no envían**. El envío real ocurre únicamente en `POST /api/office/proposals/:id/execute`, tras aprobación (y código si es N3). **Salvo la autonomía explícita** descrita abajo, no hay endpoint HTTP que envíe un mensaje o documento a un tercero directamente.
- **Autonomía explícita y auditada**: solo con `settings.office.allowAutonomousOutbound === true`, modo `total`/`autonomo`, riesgo ≤2, contacto conocido y nivel distinto de N3. Antes de enviar se apunta `outbound.autonomous` en el ledger; N3 nunca se auto-ejecuta. Si falta cualquier condición, la propuesta queda pending.
- **Al dueño = directo, con lista blanca**: las tarjetas de aprobación, recordatorios y acuses usan `notifyChannels`/adaptadores directos, pero solo hacia destinos del dueño (`owners`, `allowedChatIds`/`defaultChatId`, `allowedNumbers`/`defaultTo`, `allowFrom`/`email.to`). Es la única excepción directa y está limitada a esa lista.
- **Pruebas solo al dueño**: `POST /api/channels/:id/test` con `to`/`chatId` fuera de la lista blanca → `403 NOT_OWNER`; el canal simulador está exento. Las rutas heredadas `/api/whatsapp/test` y `/api/telegram/test` aplican la misma regla. `/api/gmail/send` conserva el gate de la Oficina (202 propuesta; `direct:true` solo con override auditado).
- **Anti-bucle de correo**: cabecera `X-Agenda-Copilot: auto-reply` + filtros de
  autorespondedores. **Anti-duplicado**: `dedupeKey` persistente en todos los canales.
- **Rate limit** por IP/usuario/canal (tabla en §3) y **auditoría** de configuración/pruebas
  (`channelState.audit`, 150 entradas) además de `lastError` visible.
- **Modo red**: si `HOST≠loopback` o `APP_AUTH=on`, `/api/channels/*` exige sesión; los
  webhooks son públicos pero exigen secreto (**503** si falta). El túnel no cambia esa regla.
- **La app no toca** `data/agenda-data.json` real ni `.env` en pruebas: usa `DATA_DIR`
  temporal. En producción, cualquier migración la hace el store con backup previo.

---

## 12. Costos y tiempos de aprobación

> Orientativo (verifica siempre las tarifas y políticas vigentes de cada proveedor).

| Canal | Costo | Tiempo de alta | Notas |
|---|---|---|---|
| **Simulador** | 0 | inmediato | Sin credenciales ni red. |
| **Telegram** | 0 | 2–5 min | BotFather es inmediato; sin aprobación. |
| **WhatsApp Cloud API** | Por conversación/mensaje según país y categoría; el número de prueba de Meta es gratis con destinatarios limitados | App: minutos · Verificación de negocio: 1–5 días hábiles · Plantillas: minutos–48 h | La ventana de servicio de 24 h suele no cobrarse; marketing/utility sí. Requiere método de pago para producción. |
| **Gmail (API)** | 0 | 10–30 min | Cuotas gratuitas holgadas. App OAuth en *Testing*: hasta 100 test users y posible caducidad de refresh token a ~7 días; publicación con `gmail.modify` puede requerir verificación de Google. |
| **Túnel Cloudflare** | 0 (quick tunnel) | inmediato | URL efímera. Túnel con nombre/dominio propio: gratis con cuenta + dominio. |
| **Webhook genérico** | 0 | inmediato | Slack/Discord/n8n/Zapier tienen sus propios planes. |

---

## 13. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Telegram no responde | Canal desactivado, token ausente o chat no autorizado | Revisa `enabled`, `configured`, `runtime.lastError` y `allowedChatIds`. |
| `409 TELEGRAM_WEBHOOK_CONFLICT` | Otro webhook activo en el bot | `POST /api/channels/telegram/delete-webhook` o guarda modo webhook y vuelve a polling. |
| `502 TELEGRAM_INVALID_TOKEN` | Token mal copiado/revocado | `/newbot` o `/token` en BotFather y vuelve a guardar. |
| Telegram recibe pero no contesta | Respuesta fallida (chat inexistente) o rate limit | Mira `lastError` y la bandeja (`status:"failed"`). |
| WhatsApp handshake `403 VERIFY_TOKEN_INVALID` | Verify Token distinto al de Meta | Copia el mismo valor en ambos lados. |
| WhatsApp webhook `401` | App Secret distinto o cuerpo modificado | Revisa App Secret; la firma es sobre el cuerpo **crudo**. |
| WhatsApp webhook `503` | Sin App Secret/Verify Token en producción o auth | Configúralos antes de exponer la app. |
| WhatsApp no envía fuera de 24 h | Ventana cerrada sin plantilla | Crea plantilla *Utility* y guarda nombre/idioma. Meta puede devolver `131047`. |
| WhatsApp `401/190` | Token caducado/revocado | Genera token permanente (System User). |
| Correo no lee | Sin permiso `gmail.modify`, redirect URI distinto o token caducado | Botón «Conectar Gmail», revisa `GMAIL_SCOPE_MISSING`/`GOOGLE_RECONNECT` y el redirect URI. |
| Correo se responde a sí mismo en bucle | Remitente/autorespuesta no filtrada | La app añade `X-Agenda-Copilot: auto-reply`; no borres esa cabecera. |
| Webhook genérico `404` | Instancia no creada | `POST /api/channels/webhook:<nombre>/config` primero. |
| Webhook genérico `401` | Token incorrecto/ausente | Usa el token mostrado al crear; si se perdió, rótalo. |
| `429` | Rate limit | Espera `retryAfterSec`; el simulador admite 60/min por IP. |
| `/api/channels` da `401` | Modo sesión | Inicia sesión en la app. Los webhooks siguen siendo públicos. |
| El estado muestra un error viejo | `lastError` persiste hasta una operación correcta | Pulsa Probar o guarda de nuevo (limpia el error). |

Logs: la app redacta secretos. El detalle de canales está en
`GET /api/channels/:id → runtime.lastError` y `stats`, y la actividad reciente en
`GET /api/activity`.

---

## 14. Autocheck y variables de prueba

```powershell
cd agenda-copilot
node lib/channel/selfcheck.mjs
```

Levanta un mock local de Telegram/WhatsApp/Gmail/OAuth/outbox y la app real con un `DATA_DIR`
temporal; **no usa red externa, credenciales reales ni toca tus datos**. Cubre 211
comprobaciones: simulador, HMAC de WhatsApp, ventana 24 h + plantilla, idempotencia de
`message.id`, long polling + offset + dedupe de `update_id`, botones, Gmail OAuth + polling +
respuesta en hilo + anti-bucle, webhook genérico con salida HTTP, **aprobaciones N2/N3**
(tarjetas, botones, lista blanca, correcciones, doble respuesta, intentos no autorizados
auditados, avisos/recordatorios), **adjuntos DOCX reales de `lib/docs`** por los cuatro
canales, rate limit, secretos cifrados en disco, `health`/`bootstrap` y ausencia de fugas.

Variables útiles (solo pruebas/avanzado):

| Variable | Default | Uso |
|---|---|---|
| `CHANNELS_AUTOSTART` | `on` | `off` desactiva los bucles de Telegram/Gmail al montar las rutas. |
| `CHANNELS_APPROVALS_AUTOSTART` | `on` | `off` desactiva el watcher de avisos/recordatorios de aprobaciones. |
| `CHANNELS_APPROVALS_TICK_MS` | `10000` | Periodo del watcher de aprobaciones (mínimo 5 s). |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Override del API de Telegram (mocks). |
| `WA_GRAPH_BASE` | `https://graph.facebook.com` | Override de Graph API. |
| `WA_API_VERSION` | config `apiVersion` o `v25.0` | Versión de Graph. |
| `GMAIL_API_BASE` | `https://gmail.googleapis.com/gmail/v1` | Override de Gmail. |
| `GOOGLE_TOKEN_URL` / `GOOGLE_USERINFO_URL` / `GOOGLE_AUTH_BASE` | endpoints de Google | Override OAuth (mocks). |
| `APP_URL` | — | URL pública para webhooks, redirects y `redirect_uri` de Gmail. |
| `KEEP_DATA=1` | — | Conserva el `DATA_DIR` del autocheck para inspección. |
| `CHANNELS_TEST_FAIL_OFFICE_LEDGER=1` | — | Solo pruebas: simula fallo del ledger al cambiar el flag de autonomía (503, sin cambio). |
| `CHANNELS_TEST_DISABLE_ACL=1` | — | Solo pruebas: simula ausencia de `lib/acl`; los envíos responden 503 ACL_UNAVAILABLE. |

Los secretos de canal se gestionan desde la UI o con `PUT /api/secrets/:name`
(`channels.telegram.botToken`, `channels.whatsapp.appSecret`, `webhooks.generic.secret`, …).
Las variables `TELEGRAM_*`, `WA_*`, `EMAIL_ENABLED`, `NOTIFY_EMAIL_TO` y `WEBHOOK_SECRET`
siguen funcionando como override por entorno (útil para CI o despliegues); la UI siempre
escribe en la bóveda cifrada.

---

## 14-bis. Integración con el scheduler (t8)

El motor de automatizaciones puede enviar avisos sin conocer los detalles de cada canal:

```js
import { notifyChannels, notifyChannel } from './lib/channels.mjs';

// Todos los canales activos y con destino configurado
const results = await notifyChannels('⏰ En 10 min: Bloque de foco', {
  subject: 'Recordatorio Agenda P95',   // asunto si va por correo
  channels: ['whatsapp', 'telegram', 'email'] // opcional; por defecto los tres
});
// → [{channel:'whatsapp', ok:true, id:'wamid…', error:null}, …]

// Un canal concreto (incluye instancias webhook:<nombre>)
await notifyChannel('telegram', { to: '123456789', text: 'Hola' });
```

- **Nunca lanza**: devuelve un resultado por canal para que un fallo de WhatsApp no impida el
  correo o Telegram. Los fallos quedan en `lastError` y en la bandeja (`status:"failed"`).
- WhatsApp proactivo usa **plantilla** automáticamente (fuera de la ventana de 24 h).
- Si quieres una instancia de webhook, usa `notifyChannel('webhook:<nombre>', { text })`.

### Campos `runtime` estables para la UI

Todos los canales exponen `runtime.inboundUrl` y `runtime.webhookUrl` (null si no aplica),
además de `runtime.lastError`, `runtime.stats` y los datos específicos (`polling` en Telegram,
`windowHours`/`openWindows` en WhatsApp, `oauthStart`/`redirectUri` en correo, `instances` en
el webhook genérico). `item.webhookUrl` se mantiene en el nivel superior por compatibilidad.

---

## 15. Checklist de aceptación

- [x] **Simulador conversacional**: `POST /api/channels/simulate` ejecuta el asistente real y
      la conversación se ve en `GET /api/channels/inbox`; probado en 2 minutos sin credenciales.
- [x] **Telegram con token real**: el bot responde en el móvil (long polling; sin HTTPS).
      **Sin token**: el canal queda «no configurado» con `instructions[]` y `test` devuelve
      `409 CHANNEL_NOT_CONFIGURED`.
- [x] **WhatsApp**: webhook con firma inválida → `401 WEBHOOK_SIGNATURE_INVALID`; firma válida
      → `200 {received:true}` y respuesta; `message.id` repetido no reprocesa.
- [x] **Mensaje repetido no duplica la cita**: verificado con `wamid` repetido y CAPTURA
      (la bandeja de la app crece exactamente 1) y con `update_id` de Telegram.
- [x] **La UI guarda y prueba credenciales sin reiniciar**: config escribe bóveda/estado y
      reinicia los bucles en caliente; `test` valida contra el proveedor (`getMe`,
      `GET /{phoneNumberId}`, Gmail profile).
- [x] Secretos cifrados, `lastError` visible, backoff, rate limit y auditoría.
- [x] Correo con OAuth de lectura, polling de no leídos y respuesta en el mismo hilo.
- [x] Webhook genérico con token y salida configurable (Slack/Discord/n8n/Zapier).
- [x] **Aprobaciones por canal**: tarjeta N2/N3, respuestas ok/no/corrige/1-2-3/botones, lista blanca de dueño, auditoría de intentos no autorizados, aviso y recordatorios (máx. 2).
- [x] **Sin bypass**: a terceros solo por propuesta pending (incluso en modo total), salvo autonomía explícita con flag/riesgo/contacto y auditoría previa; N3 nunca automático; test solo al dueño/simulador; los envíos directos internos quedan limitados al dueño.
- [x] **Entregables**: DOCX/XLSX/PPTX de `lib/docs` enviados como adjunto (vía propuesta ejecutada) por Telegram, WhatsApp, correo y simulador con nombre y tamaño correctos.
- [x] Documentación + script de túnel + autocheck reproducible.

---

## 16. Limitaciones conocidas

- **WhatsApp** no admite botones inline arbitrarios en texto libre: las alternativas 1/2/3 se
  ofrecen como texto (los botones reales requieren plantillas interactivas aprobadas). La
  app expone `capabilities.buttons=false` para WhatsApp.
- La **plantilla** de WhatsApp se envía con **un** parámetro de cuerpo (`{{1}}`). Plantillas
  con más variables requieren ampliar el adaptador.
- **Telegram** solo procesa texto (el resto de tipos recibe un aviso). No hay envío de
  archivos ni edición de mensajes del asistente.
- El **túnel rápido** de Cloudflare cambia de URL: para Gmail OAuth o uso continuo usa un
  túnel/dominio fijo y `APP_URL`.
- Gmail en modo *Testing* puede requerir reconectar cada ~7 días; la app lo detecta y lo
  muestra como `GOOGLE_RECONNECT`.
- La **bandeja local** guarda 300 mensajes y la auditoría 150 entradas (rotación automática);
  no es un archivo histórico ilimitado.
- El **rate limit** es en memoria: se reinicia al reiniciar el proceso (protección operativa,
  no cuota persistente).
- Los **tokens de instancias de webhook** se muestran una sola vez; si se pierden hay que
  rotarlos desde la UI.
- **Aprobaciones**: el aviso automático depende del watcher (≈10 s); no es instantáneo al
  crear la propuesta. Fuera de la ventana de 24 h, WhatsApp solo puede enviar la tarjeta si
  hay plantilla aprobada. El correo requiere Gmail conectado para enviar/recibir.
- **Salida**: crear una propuesta no envía nada; el outbox solo cambia al ejecutar. En modo total/autónomo sin el flag de autonomía sigue pending. Si el riesgo eleva la propuesta a N3 hace falta el código de 6 además de aprobar. Los documentos se envían tras ejecutar (no hay envío inline directo). Un reservado a externos exige `confirmedReserved:true` y siempre N3; un interno a externos queda N2 con aviso y no se auto-ejecuta.
- **Adjuntos**: máximo 25 MB por documento; WhatsApp/Telegram tienen además sus propios
  límites de plataforma. El nombre del adjunto se conserva, pero los caracteres no ASCII
  llevan fallback ASCII en clientes de correo antiguos.

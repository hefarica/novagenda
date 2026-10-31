# Estado de la oficina y conexiones pendientes

**Fecha:** 2026-10-30
**App local:** http://127.0.0.1:3000 · PID 27472 · 352 rutas · puesta en marcha 63 %
**Datos reales:** agenda 4 (rutinas de hoy) · documentos 0 · rutinas 6 · base 0 · OKR 0 · tareas 0

---

## 0. Asistente de puesta en marcha

Ya está dentro de la app: **Puesta en marcha** (menú ⚡ o botón azul del Inicio).
Tiene ocho pasos, presets por proveedor y a **Camila** al lado para explicar
qué falta. Los campos técnicos vienen resueltos; tú escribes usuario,
contraseña o token. La guía completa está en
[GUIA_PUESTA_EN_MARCHA.md](GUIA_PUESTA_EN_MARCHA.md).

---

## 1. Lo que ya está construido y probado

| Área | Estado |
|---|---|
| Puesta en marcha asistida con presets, progreso, equipo y Camila | Funciona |
| Agenda, reuniones y rutinas: crear, editar, borrar, duplicar | Funciona |
| Tareas y compromisos: crear, editar, cerrar, reabrir, borrar, duplicar | Funciona |
| Dictado por voz (una vez y continuo) | Funciona en el navegador; el permiso del micrófono lo das tú |
| Panel de Camila en el hero de Inicio | Conversación por texto y voz, Whisper local, respuestas de Chief of Staff |
| Fondo 3D y motion graphics | Canvas ligero, una figura por vista, tema claro/oscuro y movimiento reducido |
| Impresión / PDF de Agenda, Base, Tareas, Rutinas, Jornada y OKR | Funciona |
| Exportación CSV de Jornada, OKR y Tareas | Funciona |
| Búsqueda global (Ctrl K) con Agenda, Tareas, Rutinas, Documentos, Wiki, Personas, Tablas y Aprobaciones | Funciona |
| Documentos Word, Excel y PowerPoint con marca de agua | Funciona |
| Correo saliente SMTP, bandeja IMAP, hilos, reglas y borradores | Código listo; sin cuentas conectadas |
| Google Calendar / Gmail / Drive (OAuth y sincronización) | Conectado: beticosa1@gmail.com (Calendar + envío Gmail) |
| Telegram | Conectado y probado; conversación natural de Chief of Staff, texto, voz y video |
| Organización de 24 agentes y 4 equipos | CRUD, jerarquía, capacidades e importación OrgDNA |
| Estudio de entregables | Presentaciones PPTX, documentos DOCX y proyectos de código ZIP |
| Equipo interno de agentes, propuestas, aprobación N0–N3 y ledger | Funciona |
| Recordatorios y priorización (nudges) | Motor activo; sin canales de entrega configurados |
| Copia de seguridad y restauración | Funciona |
| Etiquetas de seguridad, auditoría, cifrado de secretos | Funciona |

**Verificación:** sintaxis 352/352, smoke 17/17, `npm test` PASS, E2E 13/13, puesta en marcha 14/14, tema 33/33, integridad del dato real PASS, voz de Telegram 10/10 PASS · E2E voz/video PASS · agente conversacional en canales PASS · panel/motion 19/19 PASS · organización/estudio 10/10 PASS · 24 perfiles y 4 equipos.

---

## 2. Lo que bloquea el uso real

Sin esto la app **no puede** enviar correos, leer tu Gmail, responder WhatsApp, avisarte por Telegram ni agendar en tu Google. No es código pendiente: son permisos y credenciales.

### 2.1 Google (Calendar, Gmail, Drive) — **hecho**

Proyecto `agenda-copilot-p95`, cliente **Agenda Copilot P95 Web** y cuenta
`beticosa1@gmail.com` conectada. Calendar y **envío** de Gmail funcionan por
OAuth. La bandeja de entrada sigue pendiente: el permiso actual es `gmail.send`,
no lectura; para leer el correo usa IMAP o un permiso adicional.

También quedaron registradas las URLs:

```
http://127.0.0.1:3000/api/auth/google/callback
http://localhost:3000/api/auth/google/callback
```

### 2.2 Correo saliente y bandeja

Dos caminos:

1. **Recomendado:** conectar la cuenta por Google OAuth (arriba). Sirve para Gmail y Calendar.
2. **Alternativa:** cuenta SMTP/IMAP con contraseña de aplicación:
   - SMTP: `smtp.gmail.com`, puerto `465`, TLS.
   - IMAP: `imap.gmail.com`, puerto `993`, TLS.
   - Usuario y contraseña de aplicación (no la contraseña normal).

Dónde se pega: **Integraciones → Correo**.

### 2.3 Telegram

Necesito:

- Token del bot (BotFather).
- Tu chat ID o el de los destinatarios.
- Decisión: polling local o webhook público.

Dónde se pega: **Integraciones → Canales → Telegram**.

### 2.4 WhatsApp

Hay que elegir una vía, porque no son equivalentes:

- **WhatsApp Business API (oficial):** número dedicado, verificación de negocio, costo por conversación. Más estable y no arriesga tu número principal.
- **Puente no oficial (whatsmeow/Baileys):** usa tu número actual, lee historial y responde; puede caerse o ser bloqueado por WhatsApp. Para el número principal no lo recomiendo.

Necesito: decisión, número y, si es no oficial, el dispositivo donde se empareja el QR. La aprobación por chat se mantiene: nada sale sin tu visto bueno.

### 2.5 Tu equipo y Chromium

Para que los agentes usen tu computador y el navegador:

- Instalar/registrar Desktop Commander como servidor MCP.
- Instalar/registrar Playwright MCP con un perfil de Chromium.
- Rutas de los ejecutables y token de emparejamiento.

Dónde se pega: **Integraciones → MCP**.

### 2.6 Tu estilo de redacción

Para que escriba como Héctor y no como un bot genérico necesito **muestras reales**:

- Mínimo 25 correos tuyos por registro (cliente, proveedor, entidad, colega, familiar).
- Exportados desde Gmail o pegados en **Estilo**.

Sin muestras, el sistema usa un perfil formal genérico; eso no cumple “que suene a mí”.

### 2.7 Recordatorios

El motor está activo, pero **canales de entrega están vacíos**. Para que te recuerde de verdad hay que marcar al menos uno: correo, Telegram o WhatsApp. Dónde: **Integraciones → Recordatorios**.

### 2.8 Micrófono

El dictado usa el micrófono del navegador. La primera vez Chrome pide permiso; hay que concederlo. No se puede automatizar ni fingir.

---

## 3. Orden en que lo conectaría

1. Google en modo lectura y modo sombra: ver calendario y correo, sin enviar nada.
2. Correo de prueba a ti mismo; verificar firma, adjunto y formato.
3. Telegram: un mensaje de ida y vuelta.
4. WhatsApp en sombra: leer un chat y proponer respuesta, sin enviar.
5. Primer envío real N2 con tu aprobación.
6. Recién entonces, autonomía por contacto y modo total.

Cada paso queda en el ledger y se puede revertir.

---

## 4. Límites que no voy a disimular

- El estilo se acerca, no se clona. Con muestras suficientes puede pasar por ti en la mayoría de los correos; alguien que te conozca mucho puede notar diferencias.
- WhatsApp no oficial puede fallar o provocar bloqueo del número.
- Desktop Commander da acceso real a tu disco; un texto malicioso de una web podría intentar usarlo. Por eso el ejecutor solo acepta payloads aprobados, no texto libre.
- El 80 % de trabajo ofimático es una meta de uso real, no una cifra que pueda declarar sin medirla contigo.
- La oficina no reemplaza tu criterio en temas legales, dinero o compromisos con terceros: esos siguen en N3.

---

## 5. Qué necesito de ti, en una frase

Abre **Puesta en marcha** y empieza por Camila. Cada servicio se pega ahí y
se prueba en el mismo paso. Si prefieres decírmelo por chat, dime cuál de
estas tres rutas quieres seguir:

1. **“Te doy Google y Telegram”** → me pasas Client ID/Secret y token; conecto lectura y hacemos la primera prueba.
2. **“Empieza por correo”** → me das una cuenta SMTP/IMAP de prueba y conectamos envío real.
3. **“Sigue solo local”** → autorizas que siga con módulos internos (reglas de correo, cuarentena, versionado de documentos) sin conexiones externas.

Sin una de esas tres, cualquier avance adicional es cosmético.











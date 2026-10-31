# Guía de puesta en marcha asistida

Abre **Puesta en marcha** desde el menú (⚡) o desde el botón azul del Inicio.
Vas a ver ocho pasos, tu progreso y a **Camila** al lado. Camila te dice qué
falta y qué escribir; no tienes que buscar la configuración en el menú.

> Regla de oro: los secretos se escriben en los campos de la página. Camila
> nunca te los pide por el chat. Quedan cifrados y no vuelven al navegador.

---

## 1. Modelo de lenguaje

Elige un preset:

| Proveedor | Qué poner | Nota |
|---|---|---|
| DeepSeek | clave de API | Es la opción más económica; ya viene con URL y modelo. |
| OpenAI | clave de API | URL y modelo vienen rellenos. |
| Ollama | nada de clave | Requiere Ollama instalado en tu equipo y el modelo descargado. |

Pulsa **Guardar y probar modelo**. Si responde, verás la latencia.

## 2. Correo

1. Elige el proveedor (Gmail, Outlook, Yahoo, iCloud, Zoho u Otro).
2. Escribe **tu correo**.
3. Escribe una **contraseña de aplicación** (no la normal si tienes 2FA).
4. Pulsa **Conectar, probar y enviar prueba**.

Yo relleno SMTP, IMAP, puertos y TLS. Solo abro la sección “Servidores” si tu
proveedor es distinto. La prueba envía un correo **a tu propia dirección** y
luego comprueba la bandeja IMAP. Si la bandeja falla, el envío puede quedar
guardado; el mensaje te dice qué pasó.

### Contraseñas de aplicación

- **Gmail:** Cuenta de Google → Seguridad → Verificación en dos pasos →
  Contraseñas de aplicaciones.
- **Outlook:** Microsoft puede exigir OAuth; si no acepta la contraseña,
  usa Google OAuth si es Workspace o una cuenta con contraseña de aplicación.
- **Yahoo / iCloud:** también usan contraseña de aplicación.

## 3. Google (Calendar, Gmail, Drive)

Necesitas un proyecto OAuth propio:

1. Google Cloud Console → APIs y servicios → Credenciales.
2. Crear credenciales → **ID de cliente OAuth** → **Aplicación web**.
3. En “URIs de redirección autorizados” pega la URL que muestra la página
   (termina en `/api/auth/google/callback`).
4. Copia **Client ID** y **Client Secret** en la página.
5. Añade tu cuenta en **Usuarios de prueba**.
6. Pulsa **Guardar y autorizar cuenta**.

Al volver de Google, la cuenta aparece conectada y el paso queda en verde.

## 4. Telegram

1. En Telegram, habla con **@BotFather** → `/newbot`.
2. Copia el token.
3. Escríbele algo a tu bot y busca tu `chat.id` (o usa el que ya conozcas).
4. Pega token y chat ID, pulsa **Guardar y probar**.

El modo local ya es **polling**: no necesitas abrir puertos ni HTTPS.

También entiende **notas de voz**: se transcriben localmente con Whisper y pasan
al mismo asistente. Requiere `ffmpeg` y las dependencias de
`requirements-voice.txt`; la primera vez descarga el modelo. Ver
[VOZ_TELEGRAM.md](VOZ_TELEGRAM.md).

## 5. WhatsApp

La página usa la vía **oficial de WhatsApp Business API**:

1. Meta for Developers → tu app → WhatsApp → API Setup.
2. Copia **Phone Number ID** y el **Access Token**.
3. Escribe tu número con código de país (solo dígitos).
4. Pulsa **Guardar y probar**.

No se conecta tu WhatsApp personal por QR. Eso evita arriesgar tu número y
mantiene la aprobación por chat.

## 6. Tu equipo y Chromium

Elige un preset:

- **Desktop Commander:** archivos, terminal y procesos de tu equipo.
- **Playwright / Chromium:** navegar y operar webs.

Se crea **desactivado**. Revísalo en **Ajustes → MCP** y actívalo solo cuando
quieras que la oficina use esa capacidad. Dar acceso al equipo es una decisión
tuya, no un paso automático.

## 7. Tu forma de escribir

Pega entre **25 y 50 correos tuyos** del mismo registro (cliente, proveedor,
entidad, colega o familiar), separados por una línea con `---`. Pulsa
**Analizar y guardar muestras**.

Sin muestras reales solo puedo escribir un formal genérico; eso no pasa por
tuyo. Con muestras, el redactor usa tus saludos, cierres, longitud de frase y
nivel de formalidad.

## 8. Recordatorios

Marca **correo**, **Telegram** o **WhatsApp** (los que ya estén conectados) y
pulsa **Guardar recordatorios**. El motor ya está activo; sin canal no tiene
por dónde avisarte.

---

## Camila

El panel derecho es una conversación real con el estado de la oficina. Pregunta:

- “¿Qué falta?”
- “Ayúdame con el correo”
- “Explícame Google”
- “Quiero conectar Telegram”

Si el modelo está conectado, Camila usa lenguaje natural con el estado real.
Si no, responde igual con el guion determinista. El micrófono del campo de
chat te deja dictar.

## Después de conectar

Cada envío real sigue pasando por el **gate de aprobación**:

- N0/N1: lectura y borradores.
- N2: enviar correo, responder WhatsApp, crear evento.
- N3: dinero, plazos legales o envíos masivos; pide código.

Puedes ver y revertir cada acción en **Oficina → Aprobaciones** y **Auditoría**.

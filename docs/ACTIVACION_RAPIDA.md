# Activación rápida

## 1. Ejecutar la app localmente

### Windows
Haz doble clic en `START_WINDOWS.bat`.

La primera ejecución crea `.env` copiando `.env.example`. La app abre en:
`http://localhost:3000`

### macOS/Linux

```bash
./START_MAC_LINUX.sh
```

## 2. Activar Google

Configura en `.env`:

```env
APP_URL=https://tu-dominio.com
APP_SECRET=una-clave-larga-aleatoria
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

URI OAuth autorizada:
`https://tu-dominio.com/api/auth/google/callback`

Después entra a **Ajustes → Conectar cuenta Google**. Puedes repetir el proceso para varias cuentas y marcar qué calendarios intervienen en la detección de choques.

## 3. Activar WhatsApp

```env
WA_ENABLED=true
WA_API_VERSION=v25.0
WA_PHONE_NUMBER_ID=...
WA_ACCESS_TOKEN=...
WA_VERIFY_TOKEN=...
WA_APP_SECRET=...
WA_DEFAULT_TO=57...
```

Webhook:
`https://tu-dominio.com/api/whatsapp/webhook`

## 4. Activar Telegram

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_DEFAULT_CHAT_ID=...
TELEGRAM_WEBHOOK_SECRET=...
```

Con HTTPS activo, llama una vez:

```bash
curl -X POST https://tu-dominio.com/api/telegram/set-webhook
```

## 5. Activar correo

Con una cuenta Google ya conectada:

```env
EMAIL_ENABLED=true
NOTIFY_EMAIL_TO=tu-correo@dominio.com
```

## 6. IA avanzada opcional

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-terra
```

Sin clave OpenAI, la app mantiene el parser local para órdenes P95 y lenguaje natural habitual.

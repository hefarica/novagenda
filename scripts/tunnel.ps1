<#
.SYNOPSIS
    Túnel HTTPS temporal (cloudflared) para conectar WhatsApp Cloud API y el
    webhook de Telegram con Agenda Copilot en local.

.DESCRIPTION
    La app escucha en 127.0.0.1:3000 (por defecto). Meta y Telegram necesitan
    una URL pública HTTPS para entregar webhooks. Este script levanta un túnel
    rápido de Cloudflare, muestra la URL y deja impresas las instrucciones para
    pegar en cada panel.

    El túnel rápido es EFÍMERO: cambia cada vez que se arranca. Para Gmail OAuth
    (redirect_uri fijo) o uso continuo, usa un túnel con nombre/dominio propio y
    guarda esa URL en APP_URL antes de arrancar la app.

.PARAMETER Port
    Puerto local de Agenda Copilot. Por defecto 3000.

.PARAMETER Install
    Si cloudflared no está instalado, intenta instalarlo con winget
    (Cloudflare.cloudflared). Requiere aceptar los acuerdos de winget.

.PARAMETER TimeoutSec
    Segundos máximos esperando a que cloudflared publique la URL. Por defecto 30.

.EXAMPLE
    pwsh -File scripts/tunnel.ps1

.EXAMPLE
    pwsh -File scripts/tunnel.ps1 -Port 3000 -Install

.NOTES
    - No modifica .env ni data/agenda-data.json.
    - El túnel expone tu app a Internet: mantén autenticación activa si el
      proceso sale de loopback (HOST=0.0.0.0 o APP_AUTH=on).
    - Cierra con Ctrl+C: el proceso hijo de cloudflared se detiene al salir.
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$Install,
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$appUrl = "http://127.0.0.1:$Port"

function Write-Step([string]$Message) { Write-Host "→ $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "✓ $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "! $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "✗ $Message" -ForegroundColor Red }

Write-Host ''
Write-Host 'Agenda Copilot P95 · túnel HTTPS para canales' -ForegroundColor White
Write-Host '──────────────────────────────────────────────' -ForegroundColor DarkGray

# 1. cloudflared ---------------------------------------------------------
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue)?.Source
if (-not $cloudflared) {
    $candidates = @(
        "$env:ProgramFiles\cloudflared\cloudflared.exe",
        "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $cloudflared = $candidate; break }
    }
}

if (-not $cloudflared) {
    Write-Warn2 'cloudflared no está instalado.'
    if ($Install) {
        Write-Step 'Instalando Cloudflare.cloudflared con winget…'
        try {
            winget install --id Cloudflare.cloudflared --exact --silent `
                --accept-source-agreements --accept-package-agreements | Out-Host
        } catch {
            Write-Fail "winget falló: $($_.Exception.Message)"
        }
        $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue)?.Source
        if (-not $cloudflared -and (Test-Path "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) {
            $cloudflared = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
        }
    }
    if (-not $cloudflared) {
        Write-Host ''
        Write-Host 'Instálalo manualmente y vuelve a ejecutar:' -ForegroundColor White
        Write-Host '  winget install --id Cloudflare.cloudflared --exact' -ForegroundColor Gray
        Write-Host '  (o descarga https://github.com/cloudflare/cloudflared/releases)' -ForegroundColor Gray
        exit 1
    }
}
Write-Ok "cloudflared: $cloudflared"

# 2. App local -----------------------------------------------------------
$health = $null
try {
    $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 3 -Method Get
    Write-Ok "App local responde en $appUrl (uptime $([int]$health.uptimeSec) s, $($health.routes) rutas)"
    if ($health.auth -and $health.auth.required) {
        Write-Warn2 "Autenticación activa ($($health.auth.mode)): los webhooks entran sin sesión, pero /api/channels exige login."
    }
} catch {
    Write-Fail "No hay app escuchando en $appUrl. Arráncala antes:  node start.mjs  (o START_WINDOWS.bat)"
    exit 1
}

# 3. Túnel ---------------------------------------------------------------
$stdout = Join-Path $env:TEMP "agenda-cloudflared-$PID.out.log"
$stderr = Join-Path $env:TEMP "agenda-cloudflared-$PID.err.log"
Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue

Write-Step 'Abriendo túnel rápido de Cloudflare (sin cuenta)…'
$process = Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel', '--no-autoupdate', '--url', $appUrl) `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -NoNewWindow -PassThru

$tunnelUrl = $null
$deadline = (Get-Date).AddSeconds([Math]::Max(5, $TimeoutSec))
try {
    while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
        Start-Sleep -Milliseconds 400
        foreach ($file in @($stderr, $stdout)) {
            if (Test-Path $file) {
                $text = Get-Content $file -Raw -ErrorAction SilentlyContinue
                $match = [regex]::Match([string]$text, 'https://[a-z0-9-]+\.trycloudflare\.com')
                if ($match.Success) { $tunnelUrl = $match.Value; break }
            }
        }
        if ($process.HasExited) { break }
    }

    if (-not $tunnelUrl) {
        Write-Fail 'No se pudo leer la URL del túnel. Revisa los logs:'
        Write-Host "  $stderr" -ForegroundColor Gray
        if (Test-Path $stderr) { Get-Content $stderr -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
        exit 1
    }

    Write-Ok "URL pública: $tunnelUrl"

    # 4. Instrucciones ---------------------------------------------------
    $waWebhook = "$tunnelUrl/api/whatsapp/webhook"
    $tgWebhook = "$tunnelUrl/api/telegram/webhook"
    $gmailCallback = "$tunnelUrl/api/channels/email/oauth/callback"

    Write-Host ''
    Write-Host 'WHATSAPP CLOUD API (Meta > WhatsApp > Configuration)' -ForegroundColor White
    Write-Host "  Callback URL:  $waWebhook" -ForegroundColor Gray
    Write-Host '  Verify token:  el que guardaste en la app (Canal WhatsApp > Verify Token).' -ForegroundColor Gray
    Write-Host '  Suscribe el campo «messages». Si usas App Secret, la firma HMAC es obligatoria.' -ForegroundColor Gray
    Write-Host '  Prueba: Centro de integraciones > WhatsApp > «Probar» (valida credenciales).' -ForegroundColor Gray

    Write-Host ''
    Write-Host 'TELEGRAM (opcional; el modo polling NO necesita túnel)' -ForegroundColor White
    Write-Host "  Webhook:  $tgWebhook" -ForegroundColor Gray
    Write-Host '  En la app: Canal Telegram > modo «webhook» + URL pública y guardar;' -ForegroundColor Gray
    Write-Host '  el secreto del webhook se registra automáticamente si está configurado.' -ForegroundColor Gray

    Write-Host ''
    Write-Host 'CORREO GMAIL (OAuth de lectura)' -ForegroundColor White
    Write-Host "  redirect_uri:  $gmailCallback" -ForegroundColor Gray
    Write-Warn2 'El túnel rápido cambia de URL en cada arranque: para Gmail usa un túnel/dominio fijo,'
    Write-Warn2 'registra ese redirect_uri en Google Cloud y arranca la app con APP_URL=<tu-url-fija>.'

    Write-Host ''
    Write-Host 'WEBHOOK GENÉRICO (Slack/Discord/n8n/Zapier/scripts)' -ForegroundColor White
    Write-Host "  https://…/api/channels/inbound/<instancia>  ·  token Bearer del centro de integraciones" -ForegroundColor Gray

    Write-Host ''
    Write-Host 'SEGURIDAD' -ForegroundColor White
    Write-Host '  · El túnel publica la app: si sales de loopback, activa sesión (APP_AUTH=on) y usa HTTPS.' -ForegroundColor Gray
    Write-Host '  · Los webhooks verifican firma/secreto; en modo producción sin secreto responden 503.' -ForegroundColor Gray
    Write-Host '  · Ctrl+C detiene el túnel. La URL dejará de funcionar.' -ForegroundColor Gray
    Write-Host ''
    Write-Host 'Túnel activo. Pulsa Ctrl+C para cerrarlo.' -ForegroundColor Cyan

    Wait-Process -Id $process.Id
}
finally {
    if ($process -and -not $process.HasExited) {
        try { Stop-Process -Id $process.Id -Force } catch { }
    }
    Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
    Write-Host 'Túnel cerrado.' -ForegroundColor DarkGray
}

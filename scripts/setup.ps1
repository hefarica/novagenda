#requires -Version 5.1
<#
  Configuración inicial de Agenda Copilot P95 en Windows (t6).

  - Comprueba Node 24+.
  - Crea .env a partir de .env.example (sin sobreescribir si ya existe).
  - Genera APP_SECRET aleatorio si el .env no lo tiene.
  - Deja el DATA_DIR listo y muestra los siguientes pasos.

  Uso:  powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '=== Agenda Copilot P95 · setup ===' -ForegroundColor Cyan

# 1. Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'No encuentro Node.js. Instala Node 24 LTS: https://nodejs.org/' -ForegroundColor Red
  exit 1
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) {
  Write-Host "Node $(& node -v) detectado; se recomienda Node 24 o superior." -ForegroundColor Yellow
} else {
  Write-Host "Node $(& node -v) OK" -ForegroundColor Green
}

# 2. .env
$envPath = Join-Path $root '.env'
$example = Join-Path $root '.env.example'
if (-not (Test-Path $envPath)) {
  if (Test-Path $example) {
    Copy-Item $example $envPath
    Write-Host '.env creado desde .env.example' -ForegroundColor Green
  } else {
    Set-Content -Path $envPath -Value "PORT=3000`nTIMEZONE=America/Bogota`nDATA_DIR=./data" -Encoding utf8
    Write-Host '.env mínimo creado' -ForegroundColor Yellow
  }
} else {
  Write-Host '.env ya existe: no se modifica' -ForegroundColor Green
}

# 3. APP_SECRET
$content = Get-Content $envPath -Raw
if ($content -match '(?m)^\s*APP_SECRET\s*=\s*$') {
  $secret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
  $content = $content -replace '(?m)^\s*APP_SECRET\s*=\s*$', "APP_SECRET=$secret"
  Set-Content -Path $envPath -Value $content -Encoding utf8 -NoNewline
  Write-Host 'APP_SECRET generado (no lo compartas ni lo subas a git)' -ForegroundColor Green
}

# 4. data/
$dataDir = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
Write-Host "Datos: $dataDir (se migran/crean al arrancar)" -ForegroundColor Green

Write-Host ''
Write-Host 'Siguientes pasos:' -ForegroundColor Cyan
Write-Host '  1) node start.mjs            # elige puerto libre y abre el navegador'
Write-Host '  2) npm test                  # suite + autocheques + guardia del dato'
Write-Host '  3) npm run smoke             # 12 flujos críticos de punta a punta'
Write-Host ''
Write-Host 'Opcional: Google (Integraciones), API LLM (Integraciones o .env) y canales.'

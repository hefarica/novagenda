<#
.SYNOPSIS
  Configura el proveedor LLM de Agenda Copilot P95 en 2 pasos.

.DESCRIPTION
  Paso 1: guarda proveedor/baseUrl/modelo/clave en la BÓVEDA cifrada de la app
          (nunca en archivos del proyecto ni en la consola).
  Paso 2: prueba el proveedor (POST /api/llm/test) y muestra el estado
          (GET /api/llm/status).

  Si la app exige sesión (HOST≠loopback o APP_AUTH=on) se hace login antes.
  La clave se pide como SecureString y NUNCA se imprime.

.EXAMPLES
  # Interactivo (pide los datos que falten)
  pwsh -File scripts/llm-setup.ps1

  # Sin preguntas (ideal para soporte remoto o CI manual)
  pwsh -File scripts/llm-setup.ps1 -NonInteractive `
      -Provider openai -BaseUrl 'https://api.mi-proveedor.com/v1' `
      -Model 'mi-modelo' -ApiKey 'sk-...'

  # Solo probar la configuración actual
  pwsh -File scripts/llm-setup.ps1 -SkipConfigure -SkipTest:$false

.NOTES
  El script no instala nada (ni Ollama ni modelos) y no usa dependencias.
#>
[CmdletBinding()]
param(
  [string]$AppUrl = 'http://127.0.0.1:3000',

  [ValidateSet('auto', 'openai', 'openai-responses', 'anthropic', 'ollama')]
  [string]$Provider,

  [string]$BaseUrl,
  [string]$Model,
  [string]$ApiKey,
  [string]$ApiVersion,
  [string]$ExtraHeadersJson,
  [string]$Username,
  [string]$Password,

  [switch]$SkipConfigure,
  [switch]$SkipTest,
  [switch]$ClearApiKey,
  [switch]$NonInteractive,
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$AppUrl = $AppUrl.TrimEnd('/')
$script:Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  !   $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  X   $Text" -ForegroundColor Red }

function Invoke-Api {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null
  )
  $uri = "$AppUrl$Path"
  $params = @{
    Uri                = $uri
    Method             = $Method
    WebSession         = $script:Session
    TimeoutSec         = $TimeoutSec
    UseBasicParsing    = $true
    Headers            = @{ Accept = 'application/json' }
  }
  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json'
    $params['Body'] = ($Body | ConvertTo-Json -Compress -Depth 8)
  }
  try {
    $response = Invoke-WebRequest @params
  } catch {
    $status = $null
    $payload = $null
    if ($_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $raw = $reader.ReadToEnd()
        if ($raw) { $payload = $raw | ConvertFrom-Json }
      } catch { $payload = $null }
    }
    $code = if ($payload -and $payload.code) { $payload.code } else { 'HTTP_ERROR' }
    $message = if ($payload -and $payload.error) { $payload.error } else { $_.Exception.Message }
    throw [System.Exception]::new("$Method $Path → $status $code : $message")
  }
  $text = $response.Content
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return ($text | ConvertFrom-Json)
}

function Read-TextValue([string]$Prompt, [string]$Default = '') {
  if ($NonInteractive) { return $Default }
  if ($Default) {
    $answer = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
  }
  return (Read-Host $Prompt).Trim()
}

function Read-SecretValue([string]$Prompt) {
  if ($NonInteractive) { return '' }
  while ($true) {
    $secure = Read-Host $Prompt -AsSecureString
    if ($null -eq $secure -or $secure.Length -eq 0) {
      Write-Warn 'La clave no puede estar vacía (Ctrl+C para salir).'
      continue
    }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
}

function Ensure-Session {
  Write-Step 'Comprobando la app y la autenticación'
  $status = Invoke-Api -Method 'GET' -Path '/api/auth/status'
  if (-not $status) { throw 'No se pudo leer /api/auth/status.' }
  Write-Host ("  host={0} modo={1} requiereSesion={2} autenticado={3}" -f $status.host, $status.mode, $status.authRequired, $status.authenticated)
  if ($status.setupRequired -eq $true) {
    Write-Warn 'La app no tiene contraseña configurada todavía.'
    Write-Warn 'Abre la app en el navegador, completa el onboarding y vuelve a ejecutar este script.'
    if ($NonInteractive) { throw 'Se requiere configurar la autenticación en el navegador.' }
  }
  if ($status.authRequired -eq $true -and $status.authenticated -ne $true) {
    if ($NonInteractive -and (-not $Username -or -not $Password)) {
      throw 'La app exige sesión: pasa -Username y -Password (o ejecuta sin -NonInteractive).'
    }
    if (-not $Username) { $Username = Read-TextValue 'Usuario' 'owner' }
    if (-not $Password) {
      $secure = Read-Host 'Contraseña' -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    $login = Invoke-Api -Method 'POST' -Path '/api/auth/login' -Body @{ username = $Username; password = $Password }
    if (-not $login.ok) { throw 'Login fallido.' }
    Write-Ok "Sesión iniciada como $($login.user.username)"
  } else {
    Write-Ok 'Sin sesión obligatoria (modo local).'
  }
}

function Show-Status {
  Write-Step 'Estado del proveedor LLM'
  $status = Invoke-Api -Method 'GET' -Path '/api/llm/status?probe=1'
  if (-not $status) { throw 'No se pudo leer /api/llm/status.' }
  Write-Host ("  provider      : {0}" -f $status.provider)
  Write-Host ("  modelo        : {0}" -f $status.model)
  Write-Host ("  baseUrl       : {0}" -f $status.baseUrl)
  Write-Host ("  configurado   : {0}" -f $status.configured)
  Write-Host ("  reachable     : {0}" -f $status.reachable)
  Write-Host ("  disponible    : {0}" -f $status.available)
  Write-Host ("  modo          : {0}" -f $status.mode)
  Write-Host ("  latencia      : {0} ms" -f $status.latencyMs)
  if ($status.killSwitch -eq $true) { Write-Warn 'Kill-switch ACTIVO: todo degrada a determinista.' }
  if ($status.chain) {
    foreach ($link in $status.chain) {
      Write-Host ("  eslabón       : {0} / {1} reachable={2} error={3}" -f $link.provider, $link.model, $link.reachable, $link.error)
    }
  }
  return $status
}

try {
  Write-Host 'Agenda Copilot P95 — configuración del proveedor LLM' -ForegroundColor White
  Ensure-Session

  if (-not $SkipConfigure) {
    Write-Step 'Paso 1/2 · Guardar credenciales en la bóveda'

    if (-not $Provider) { $Provider = Read-TextValue 'Proveedor (auto, openai, openai-responses, anthropic, ollama)' 'openai' }
    if (-not $BaseUrl) {
      $defaultBase = if ($Provider -eq 'ollama') { 'http://127.0.0.1:11434' } else { 'https://api.openai.com/v1' }
      $BaseUrl = Read-TextValue 'Base URL del proveedor' $defaultBase
    }
    if (-not $Model) { $Model = Read-TextValue 'Modelo' '' }
    if (-not $Model -and $Provider -ne 'ollama') { throw 'Falta el modelo: pásalo con -Model.' }

    if ($ClearApiKey) {
      $removed = Invoke-Api -Method 'DELETE' -Path '/api/secrets/llm.openai.apiKey'
      Write-Ok ("Clave eliminada (configured={0})" -f $removed.configured)
    } elseif (-not $ApiKey -and -not $NonInteractive) {
      Write-Host 'Pega la clave del proveedor (no se muestra y no se guarda en el proyecto).'
      $ApiKey = Read-SecretValue 'API key'
    }

    if ($ApiKey) {
      $null = Invoke-Api -Method 'PUT' -Path '/api/secrets/llm.openai.apiKey' -Body @{ value = $ApiKey }
      Write-Ok 'Clave guardada cifrada en la bóveda.'
    } else {
      $existing = Invoke-Api -Method 'GET' -Path '/api/secrets'
      $item = $existing.items | Where-Object { $_.name -eq 'llm.openai.apiKey' }
      if ($item -and $item.configured -eq $true) {
        Write-Ok 'Se conserva la clave ya configurada.'
      } else {
        throw 'No hay clave configurada: pásala con -ApiKey o ejecuta el script sin -NonInteractive.'
      }
    }

    if ($Provider) {
      $null = Invoke-Api -Method 'PUT' -Path '/api/secrets/llm.provider' -Body @{ value = $Provider }
      Write-Ok "Proveedor: $Provider"
    }
    if ($BaseUrl -and $Provider -ne 'ollama') {
      $null = Invoke-Api -Method 'PUT' -Path '/api/secrets/llm.openai.baseUrl' -Body @{ value = $BaseUrl }
      Write-Ok "Base URL: $BaseUrl"
    }
    if ($Model) {
      if ($Provider -eq 'ollama') {
        $null = Invoke-Api -Method 'PUT' -Path '/api/secrets/llm.ollama.model' -Body @{ value = $Model }
        $null = Invoke-Api -Method 'PUT' -Path '/api/secrets/llm.ollama.url' -Body @{ value = $BaseUrl }
        $null = Invoke-Api -Method 'POST' -Path '/api/llm/config' -Body @{ ollamaEnabled = $true; ollamaUrl = $BaseUrl; ollamaModel = $Model }
      } else {
        $null = Invoke-Api -Method 'PUT' -Path '/api/secrets/llm.openai.model' -Body @{ value = $Model }
      }
      Write-Ok "Modelo: $Model"
    }

    $configBody = @{}
    if ($ApiVersion) { $configBody['apiVersion'] = $ApiVersion }
    if ($ExtraHeadersJson) {
      try { $configBody['extraHeaders'] = ($ExtraHeadersJson | ConvertFrom-Json) }
      catch { throw 'ExtraHeadersJson no es un JSON válido (ej. {"x-portal":"mi-app"}).' }
    }
    if ($configBody.Count -gt 0) {
      $null = Invoke-Api -Method 'POST' -Path '/api/llm/config' -Body $configBody
      Write-Ok 'Extras aplicados (apiVersion / cabeceras).'
    }
  }

  if (-not $SkipTest) {
    Write-Step 'Paso 2/2 · Probar el proveedor'
    $test = Invoke-Api -Method 'POST' -Path '/api/llm/test' -Body @{ probe = 'chat' }
    if ($test.ok -eq $true) {
      Write-Ok ("Respuesta OK de {0} ({1}) en {2} ms" -f $test.provider, $test.model, $test.latencyMs)
      if ($test.usage) {
        Write-Host ("  tokens      : prompt={0} completion={1} total={2}" -f $test.usage.promptTokens, $test.usage.completionTokens, $test.usage.totalTokens)
      }
    } else {
      Write-Fail ("La prueba falló: {0} ({1})" -f $test.error, $test.errorCode)
      Write-Host '  Revisa: baseUrl (incluye /v1?), modelo, clave y salida a Internet.' -ForegroundColor Yellow
      Write-Host '  Detalle por eslabón:' -ForegroundColor Yellow
      if ($test.attempts) {
        foreach ($attempt in $test.attempts) {
          Write-Host ("   - {0}: ok={1} code={2} error={3}" -f $attempt.provider, $attempt.ok, $attempt.errorCode, $attempt.error)
        }
      }
      exit 1
    }
  }

  $finalStatus = Show-Status
  if ($SkipTest -and $finalStatus.reachable -eq $true) {
    Write-Ok 'El proveedor responde al health check.'
  }
  Write-Host ''
  Write-Host 'Listo. La app usará el proveedor en el agente, el autocompletado y los workflows,' -ForegroundColor Green
  Write-Host 'y seguirá funcionando en modo determinista si el proveedor falla.' -ForegroundColor Green
  exit 0
} catch {
  Write-Fail $_.Exception.Message
  Write-Host ''
  Write-Host 'Pistas:' -ForegroundColor Yellow
  Write-Host '  - 401/UNAUTHENTICATED: sesión requerida o clave incorrecta.'
  Write-Host '  - 400 INVALID_URL: baseUrl debe ser http(s), normalmente termina en /v1.'
  Write-Host '  - 404: baseUrl sin /v1 o proveedor sin /chat/completions.'
  Write-Host '  - Timeout/DNS: el equipo no tiene salida a Internet o el host no resuelve.'
  Write-Host '  - Si el proveedor no es OpenAI-compatible usa -Provider anthropic u openai-responses.'
  exit 1
}

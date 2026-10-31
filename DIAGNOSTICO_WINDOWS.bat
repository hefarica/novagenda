@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0agenda-diagnostico.txt"
(
  echo Agenda Copilot P95 - Diagnostico
  echo Fecha: %date% %time%
  echo Carpeta: %CD%
  echo.
  echo === ARCHIVOS CLAVE ===
  if exist server.mjs (echo server.mjs: OK) else (echo server.mjs: FALTA)
  if exist start.mjs (echo start.mjs: OK) else (echo start.mjs: FALTA)
  if exist public\index.html (echo public\index.html: OK) else (echo public\index.html: FALTA)
  if exist .env (echo .env: OK) else (echo .env: FALTA)
  echo.
  echo === NODE ===
  where node 2^>nul
  node -v 2^>nul
  echo.
  echo === PUERTOS ===
  powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3000,3001,3010 -ErrorAction SilentlyContinue | Format-Table -AutoSize"
  echo.
  echo === PRUEBA API ===
  powershell -NoProfile -Command "foreach($p in 3000,3001,3010){ try { $r=Invoke-RestMethod -Uri ('http://127.0.0.1:'+ $p +'/api/health') -TimeoutSec 1; Write-Host $p $r.app $r.version } catch { Write-Host $p 'sin respuesta' }}"
  echo.
  echo === CHECK DE SINTAXIS ===
  node --check start.mjs 2^>^&1
  node --check server.mjs 2^>^&1
) > "%LOG%" 2>&1

echo Diagnostico creado en:
echo %LOG%
echo.
notepad "%LOG%"
pause

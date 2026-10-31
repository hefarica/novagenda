@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Agenda Copilot P95 - Lanzador

echo.
echo ============================================================
echo   AGENDA COPILOT P95 2026 - INICIO SEGURO
echo ============================================================
echo.

if not exist "server.mjs" (
  echo [ERROR] No encuentro server.mjs en esta carpeta.
  echo Debes EXTRAER TODO el ZIP antes de ejecutar este archivo.
  pause
  exit /b 10
)
if not exist "start.mjs" (
  echo [ERROR] Falta start.mjs. El paquete esta incompleto.
  pause
  exit /b 11
)

where node >nul 2>&1
if errorlevel 1 goto :INSTALL_NODE

:CHECK_NODE
for /f %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo [ERROR] No pude determinar la version de Node.js.
  pause
  exit /b 14
)
if !NODE_MAJOR! LSS 24 (
  echo [AVISO] Node.js !NODE_MAJOR! detectado; se recomienda Node 24 o superior.
)
for /f "delims=" %%V in ('node -v') do set "NODE_VERSION=%%V"
echo [OK] Node.js !NODE_VERSION!

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [OK] Archivo .env creado desde .env.example
    echo      Revisa APP_SECRET y las integraciones antes de usar la app en real.
  )
)

echo.
echo [INFO] Iniciando Agenda Copilot (elige puerto libre y abre el navegador)...
echo        Deja esta ventana abierta mientras uses la app. Ctrl+C para detener.
echo.
node start.mjs
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [ERROR] El servidor termino con codigo %RC%.
  echo Ejecuta DIAGNOSTICO_WINDOWS.bat para generar agenda-diagnostico.txt.
  pause
) else (
  echo El servidor se ha detenido.
)
exit /b %RC%

:INSTALL_NODE
echo [AVISO] Node.js no esta instalado o no esta en PATH.
where winget >nul 2>&1
if errorlevel 1 goto :NODE_MANUAL
choice /C SN /N /M "Deseas instalar Node.js LTS ahora? [S/N]: "
if errorlevel 2 goto :NODE_MANUAL
echo.
echo Instalando Node.js LTS...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :NODE_MANUAL
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo Node fue instalado, pero Windows aun no actualizo PATH en esta ventana.
  echo Cierra esta ventana y vuelve a ejecutar START_WINDOWS.bat.
  pause
  exit /b 12
)
goto :CHECK_NODE

:NODE_MANUAL
echo.
echo [ACCION REQUERIDA] Instala Node.js 24 LTS y vuelve a ejecutar este archivo.
echo Pagina oficial: https://nodejs.org/
start "" "https://nodejs.org/"
pause
exit /b 13

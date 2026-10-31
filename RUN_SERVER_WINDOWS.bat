@echo off
setlocal
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3000"
set "APP_URL=http://127.0.0.1:%PORT%"
title Agenda Copilot P95 - Servidor : %PORT%
echo.
echo ============================================================
echo   AGENDA COPILOT P95 - SERVIDOR
echo   %APP_URL%
echo ============================================================
echo.
node start.mjs
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [ERROR] El servidor termino con codigo %RC%.
  echo Copia este mensaje o ejecuta DIAGNOSTICO_WINDOWS.bat.
) else (
  echo El servidor se ha detenido.
)
echo.
pause
exit /b %RC%

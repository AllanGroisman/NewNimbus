@echo off
echo ========================================
echo        NIMBUS - Parando tudo...
echo ========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-helper.ps1"

echo.
echo Tudo parado.
timeout /t 2 /nobreak >nul

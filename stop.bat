@echo off
echo ========================================
echo        NIMBUS - Parando tudo...
echo ========================================
echo.

taskkill /FI "WINDOWTITLE eq Nimbus - Backend*" /F 2>nul
taskkill /FI "WINDOWTITLE eq Nimbus - Frontend*" /F 2>nul
taskkill /FI "WINDOWTITLE eq Nimbus - ngrok*" /F 2>nul
taskkill /IM ngrok.exe /F 2>nul

echo.
echo Tudo parado!
timeout /t 2 /nobreak >nul

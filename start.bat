@echo off
title Nimbus - Iniciando...

echo ========================================
echo         NIMBUS - Iniciando tudo
echo ========================================
echo.

:: Emails que viram admin automaticamente no login
:: (separe por virgula pra adicionar mais)
set "ADMIN_EMAILS=allangroisman@gmail.com"

:: Inicia o backend
echo [1/3] Iniciando Backend (porta 3001)...
start "Nimbus - Backend" cmd /k "cd /d %~dp0backend && set ADMIN_EMAILS=%ADMIN_EMAILS%&& node server.js"

:: Aguarda o backend subir
timeout /t 2 /nobreak >nul

:: Inicia o frontend
echo [2/3] Iniciando Frontend (porta 5173)...
start "Nimbus - Frontend" cmd /k "cd /d %~dp0frontend && npx vite --host"

:: Aguarda o frontend subir
timeout /t 3 /nobreak >nul

:: Inicia o ngrok
echo [3/3] Iniciando ngrok (acesso externo)...
start "Nimbus - ngrok" cmd /k "ngrok http 5173"

echo.
echo ========================================
echo   Tudo rodando! Acesse localhost:5173
echo   Veja a URL publica no terminal ngrok
echo ========================================
echo.
echo Para parar tudo, rode: stop.bat
echo Ou feche esta janela e as outras 3.
pause

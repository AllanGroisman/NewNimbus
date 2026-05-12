@echo off
title Nimbus - Iniciando...

echo ========================================
echo         NIMBUS - Iniciando tudo
echo ========================================
echo.

:: Emails que viram admin automaticamente no login
:: (separe por virgula pra adicionar mais)
set "ADMIN_EMAILS=allangroisman@gmail.com"

:: Backend storage: "json" (legado) ou "pg" (Postgres).
:: Setup do PG ja feito (migration + dados migrados). Pra usar PG:
::   1) Garanta que o Docker Desktop esta aberto
::   2) docker compose up -d  (no diretorio raiz — sobe Postgres + Redis)
::   3) Ja pode rodar este start.bat com STORAGE_BACKEND=pg
:: Pra voltar pro JSON: troca pra "json" abaixo (dados ainda estao em backend/data/)
set "STORAGE_BACKEND=pg"
set "DATABASE_URL=postgresql://nimbus:nimbus_dev@localhost:5432/nimbus?schema=public"

:: Backend queue (Fase 2): "memory" (legado) ou "redis" (BullMQ).
:: Modo redis: persistencia da fila + retry automatico. Exige Docker Compose up
:: (servico nimbus-redis). Pra desabilitar, troca pra "memory".
set "QUEUE_BACKEND=redis"
set "REDIS_URL=redis://localhost:6379"

:: Para rodar a bateria de testes antes de subir: chame test.bat manualmente
:: (ou encadeie no terminal: test.bat ^&^& start.bat).

:: Inicia o backend (server: HTTP API + scheduler producer)
:: Env vars setadas no topo deste .bat ja sao herdadas pela cmd-filha.
echo [1/4] Iniciando Backend (porta 3001)...
start "Nimbus - Backend" /D "%~dp0backend" cmd /k node server.js

:: Aguarda o backend subir
timeout /t 2 /nobreak >nul

:: Em modo redis, sobe o worker em paralelo (Baileys + consumer das filas).
:: Em modo memory, NAO subir worker — o server ja faz tudo no mesmo processo.
if /I "%QUEUE_BACKEND%"=="redis" (
    echo [2/4] Iniciando Worker ^(Baileys + filas^)...
    start "Nimbus - Worker" /D "%~dp0backend" cmd /k node worker.js
    timeout /t 2 /nobreak >nul
)

:: Inicia o frontend
echo [3/4] Iniciando Frontend (porta 5173)...
start "Nimbus - Frontend" /D "%~dp0frontend" cmd /k npx vite --host

:: Aguarda o frontend subir
timeout /t 3 /nobreak >nul

:: Inicia o ngrok
echo [4/4] Iniciando ngrok (acesso externo)...
start "Nimbus - ngrok" cmd /k "ngrok http 5173"

echo.
echo ========================================
echo   Tudo rodando! Acesse localhost:5173
echo   Veja a URL publica no terminal ngrok
echo ========================================
echo.
echo Para parar tudo, rode: stop.bat
echo Ou feche esta janela e as outras.
pause

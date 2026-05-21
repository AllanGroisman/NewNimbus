@echo off
title Nimbus - Iniciando...

echo ========================================
echo         NIMBUS - Iniciando tudo
echo ========================================
echo.

:: ── Pre-flight: Docker rodando? ───────────────────────────────────────
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Docker Desktop nao esta rodando.
    echo.
    echo   Abra o Docker Desktop, espere o icone ficar verde
    echo   na bandeja, e rode start.bat de novo.
    echo.
    pause
    exit /b 1
)

:: ── Sobe Postgres + Redis se ainda nao estao up ───────────────────────
echo [pre] Verificando Postgres + Redis...
docker ps --format "{{.Names}}" | findstr /B /C:"nimbus-postgres" >nul
if errorlevel 1 (
    echo [pre] Subindo Postgres + Redis ^(docker compose up -d^)...
    docker compose up -d
    if errorlevel 1 (
        echo [ERRO] docker compose falhou. Aborta.
        pause
        exit /b 1
    )
    :: Espera Postgres ficar pronto
    echo [pre] Aguardando Postgres ficar pronto...
    set "READY=0"
    for /L %%i in (1,1,30) do (
        docker exec nimbus-postgres pg_isready -U nimbus -d nimbus >nul 2>&1
        if not errorlevel 1 (
            set "READY=1"
            goto :pg_ready
        )
        timeout /t 1 /nobreak >nul
    )
    :pg_ready
    if "%READY%"=="0" (
        echo [ERRO] Postgres nao ficou pronto em 30s. Aborta.
        pause
        exit /b 1
    )
    echo [pre] OK.
) else (
    echo [pre] Postgres ja esta no ar.
)
echo.

:: ── Pergunta se quer subir o ngrok ────────────────────────────────────
set "START_NGROK="
set /p "START_NGROK=Iniciar ngrok (acesso externo)? [S/N] (default S): "
if /I "%START_NGROK%"=="N" (
    set "START_NGROK=N"
) else (
    set "START_NGROK=S"
)
echo.

:: ── Envs herdadas pelas cmd filhas ────────────────────────────────────
:: ADMIN_EMAILS: quem fizer login com esse email vira admin automaticamente.
set "ADMIN_EMAILS=allangroisman@gmail.com"
set "DATABASE_URL=postgresql://nimbus:nimbus_dev@localhost:5432/nimbus?schema=public"
:: Fila: "redis" (default, BullMQ persistente) ou "memory" (single-proc, sem worker).
set "QUEUE_BACKEND=redis"
set "REDIS_URL=redis://localhost:6379"

:: ── Backend ───────────────────────────────────────────────────────────
echo [1/4] Iniciando Backend (porta 3001)...
start "Nimbus - Backend" /D "%~dp0backend" cmd /k node server.js
timeout /t 2 /nobreak >nul

:: ── Worker (so em modo redis) ─────────────────────────────────────────
if /I "%QUEUE_BACKEND%"=="redis" (
    echo [2/4] Iniciando Worker ^(Baileys + filas^)...
    start "Nimbus - Worker" /D "%~dp0backend" cmd /k node worker.js
    timeout /t 2 /nobreak >nul
)

:: ── Frontend ──────────────────────────────────────────────────────────
echo [3/4] Iniciando Frontend (porta 5173)...
start "Nimbus - Frontend" /D "%~dp0frontend" cmd /k npx vite --host
timeout /t 3 /nobreak >nul

:: ── ngrok (opcional) ──────────────────────────────────────────────────
if /I "%START_NGROK%"=="S" (
    echo [4/4] Iniciando ngrok ^(acesso externo^)...
    start "Nimbus - ngrok" cmd /k "ngrok http 5173"
) else (
    echo [4/4] ngrok pulado.
)

echo.
echo ========================================
echo   Tudo rodando! Acesse http://localhost:5173
if /I "%START_NGROK%"=="S" echo   URL publica no terminal do ngrok.
echo ========================================
echo.
echo   Login admin padrao:
echo     email: allangroisman@gmail.com
echo     senha: ^(veja DEFAULT_ADMIN_PASSWORD em backend\.env^)
echo.
echo Para parar tudo: stop.bat
pause

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

:: ── Sincronizar banco com Backblaze ───────────────────────────────────
echo [sync] Verificando Backblaze...
set "_LATEST_REMOTE="
set "_LATEST_LOCAL=db-00000000-000000.sql.gz"

pushd "%~dp0backend"
for /f %%i in ('node scripts\check-remote.js 2^>nul') do set "_LATEST_REMOTE=%%i"
if not exist backups mkdir backups
for /f %%i in ('dir /b /o-n backups\db-*.sql.gz 2^>nul') do (
    if "%_LATEST_LOCAL%"=="db-00000000-000000.sql.gz" set "_LATEST_LOCAL=%%i"
)
popd

if not defined _LATEST_REMOTE (
    echo [sync] Backblaze nao configurado ou sem backups remotos.
    echo.
    goto :sync_done
)

if "%_LATEST_REMOTE%" GTR "%_LATEST_LOCAL%" (
    echo.
    echo [sync] *** Banco no Backblaze e mais novo! ***
    echo   Remoto: %_LATEST_REMOTE%
    echo   Local:  %_LATEST_LOCAL%
    echo.
    echo   s = restaurar do Backblaze ^(sobrescreve banco local^)
    echo   n = manter banco local e enviar ao Backblaze
    echo   i = ignorar ^(nao faz nada^)
    echo.
    set "SYNC_OPT=i"
    set /p "SYNC_OPT=Opcao? [s/n/i] (default i): "
    if /I "%SYNC_OPT%"=="S" (
        echo [sync] Restaurando banco do Backblaze...
        pushd "%~dp0backend"
        node scripts\restore-remote.js --latest
        popd
        echo [sync] Banco restaurado com sucesso!
        echo.
        goto :sync_done
    )
    if /I "%SYNC_OPT%"=="N" (
        goto :do_push
    )
    echo [sync] Ignorado.
    echo.
    goto :sync_done
) else (
    echo [sync] Banco local esta atualizado ^(%_LATEST_LOCAL%^).
)

:do_push
set "DO_BACKUP=N"
set /p "DO_BACKUP=Enviar banco local ao Backblaze (para restaurar na VPS depois)? [S/N] (default N): "
if /I "%DO_BACKUP%"=="S" (
    echo [backup] Gerando dump do banco...
    for /f %%i in ('node -e "var d=new Date();var p=function(n){return ('0'+n).slice(-2)};console.log(d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()))"') do set "_TS=%%i"
    docker exec nimbus-postgres sh -c "pg_dump -U nimbus nimbus | gzip" > "%~dp0backend\backups\db-%_TS%.sql.gz"
    if errorlevel 1 (
        echo [ERRO] Dump falhou. Continuando sem backup...
    ) else (
        echo [backup] Enviando para o Backblaze...
        pushd "%~dp0backend"
        node scripts\backup-remote.js --latest
        popd
        echo [backup] Pronto! Na VPS, rode start.sh e escolha restaurar o banco.
    )
)

:sync_done
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

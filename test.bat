@echo off
setlocal
title Nimbus - Testes
set ROOT=%~dp0
set FAIL=0

:: ─── Backend + integration (tests/) ─────────────────────────────────────
cd /d "%ROOT%tests"
if not exist node_modules (
    echo Primeira execucao: instalando deps de tests/...
    call npm install --silent
)
echo.
echo [1/2] Backend + Integration + Journey ^(PG^) ...
call npm test
if errorlevel 1 set FAIL=1

:: ─── Frontend (frontend/) ──────────────────────────────────────────────
cd /d "%ROOT%frontend"
if not exist node_modules (
    echo Primeira execucao: instalando deps de frontend/...
    call npm install --silent
)
echo.
echo [2/2] Frontend ^(RTL + jsdom^) ...
call npm test
if errorlevel 1 set FAIL=1

cd /d "%ROOT%"
echo.
if "%FAIL%"=="1" (
    echo TESTES FALHARAM
) else (
    echo TODOS OS TESTES PASSARAM
)
endlocal & exit /b %FAIL%

@echo off
setlocal
title Nimbus - Testes
cd /d "%~dp0tests"
if not exist node_modules (
    echo Primeira execucao: instalando deps de teste...
    call npm install --silent
)
call npm test
endlocal & exit /b %errorlevel%

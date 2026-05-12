@echo off
echo ========================================
echo        NIMBUS - Parando tudo...
echo ========================================
echo.

:: /T mata a arvore inteira (cmd /k + node filho). Sem /T o node sobrevive
:: porque taskkill no cmd nao propaga pro processo filho.
taskkill /FI "WINDOWTITLE eq Nimbus - Backend*"  /T /F 2>nul
taskkill /FI "WINDOWTITLE eq Nimbus - Worker*"   /T /F 2>nul
taskkill /FI "WINDOWTITLE eq Nimbus - Frontend*" /T /F 2>nul
taskkill /FI "WINDOWTITLE eq Nimbus - ngrok*"    /T /F 2>nul

:: Fallback: caso alguma janela tenha sido fechada manualmente deixando o node
:: orfao, mata por linha de comando (server.js / worker.js especificos).
:: Usa PowerShell pra evitar fragilidade do parser do wmic em .bat.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server\.js|worker\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

:: ngrok orfao (taskkill por titulo as vezes nao pega se o titulo mudou).
taskkill /IM ngrok.exe /F 2>nul

echo.
echo Tudo parado!
timeout /t 2 /nobreak >nul

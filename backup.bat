@echo off
title Nimbus - Gerenciador de Backup
cd /d "%~dp0backend"
node scripts\sync-manager.js
pause

@echo off
REM Doble clic para encender el servidor de BiblioLLM en este PC.
title BiblioLLM - servidor
cd /d "%~dp0"
call npm run servidor
pause

@echo off
REM Double-click launcher for the Xicord installer. Runs install.ps1 with the
REM execution policy bypassed for this one process only (nothing permanent).
title Xicord installer
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause

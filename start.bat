@echo off
title Xicord Dashboard
cd /d "%~dp0"
echo Starting the Xicord Dashboard...
echo (leave this window open while you use the dashboard)
echo.
node "%~dp0xicord-dashboard-server.js"
echo.
echo Dashboard stopped.
pause

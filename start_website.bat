@echo off
title Virtual Cricket Universe Platform
cd /d "%~dp0"

echo ===================================================
echo   CRICKET ESPORTS LIVE BROADCAST & PLATFORM
echo ===================================================
echo.
echo Starting local web server on port 3000...
echo.

start "" "http://localhost:3000"
node server.js

pause

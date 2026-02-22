@echo off
title AntigravityHub - Remote Chat Viewer
cd /d "%~dp0"

echo.
echo  ==========================================
echo   AntigravityHub v2 - Remote Chat Viewer
echo   Scan QR on your phone to connect
echo  ==========================================
echo.

:: Kill existing processes on port 3000
echo [*] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Check node_modules
if not exist "node_modules" (
    echo [*] Installing dependencies...
    call npm install
    echo.
)

:: Read token
set /p TOKEN=<.token

:: Start server
echo [*] Starting server...
echo     URL: http://localhost:3000/?token=%TOKEN%
echo.

node server.js
pause

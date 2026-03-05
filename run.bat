@echo off
setlocal enabledelayedexpansion
title Antigravity Phone Connect - Quick Run

:: Navigate to script directory
cd /d "%~dp0"

echo ============================================
echo  Antigravity Phone Connect - Quick Run
echo ============================================
echo.
echo  [INFO] Antigravity debug port assumed open.
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

:: Ensure dependencies are installed
if not exist "node_modules" (
    echo [1/2] Installing dependencies...
    call npm install
    echo.
) else (
    echo [1/2] Dependencies OK.
)

:: Ensure .env exists
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env not found, creating from .env.example...
        copy .env.example .env >nul
        echo [INFO] .env created. Edit it if needed.
    )
)

:: Kill any existing node server on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    echo [INFO] Killing existing process on port 3000 ^(PID: %%a^)...
    taskkill /f /pid %%a >nul 2>&1
)

:: Start server with hot reload (auto-restart on file changes)
echo [2/2] Starting server with hot reload...
echo.
echo ============================================
echo  Server: https://localhost:3000
echo  Hot Reload: ON (auto-restart on changes)
echo  Watching: server.js, public/**, generate_ssl.js
echo  Press Ctrl+C to stop
echo ============================================
echo.
npx nodemon --watch server.js --watch public --watch generate_ssl.js --ext js,html,css,json --signal SIGTERM --delay 1 server.js

:: Keep window open on crash
echo.
echo [INFO] Server stopped. Press any key to exit.
pause >nul

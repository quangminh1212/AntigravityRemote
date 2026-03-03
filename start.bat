@echo off
title AntigravityHub Remote Access
chcp 65001 >nul 2>&1

echo ═══════════════════════════════════════════
echo   AntigravityHub - Mobile Remote Access
echo ═══════════════════════════════════════════
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found! Please install Node.js first.
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    echo.
)

:: Parse arguments
set CDP_PORT=9222
set PORT=3000

:parse_args
if "%~1"=="" goto start
if /i "%~1"=="--cdp-port" (
    set CDP_PORT=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--port" (
    set PORT=%~2
    shift
    shift
    goto parse_args
)
shift
goto parse_args

:start
echo [INFO] CDP Port: %CDP_PORT%
echo [INFO] Web Port: %PORT%
echo.

:: Set environment variables
set CDP_PORT=%CDP_PORT%
set PORT=%PORT%

:: Start the server
node server.js

pause

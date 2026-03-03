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
set CDP_PORT=9333
set PORT=3000
set AUTO_LAUNCH=1

:parse_args
if "%~1"=="" goto check_cdp
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
if /i "%~1"=="--no-launch" (
    set AUTO_LAUNCH=0
    shift
    goto parse_args
)
shift
goto parse_args

:check_cdp
echo [INFO] CDP Port: %CDP_PORT%
echo [INFO] Web Port: %PORT%
echo.

:: Check if Antigravity already has CDP
netstat -ano 2>nul | findstr ":%CDP_PORT%.*LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] CDP port %CDP_PORT% already in use
    goto start
)

:: Auto-launch Antigravity with CDP if not already running
if "%AUTO_LAUNCH%"=="1" (
    echo [INFO] Starting Antigravity with CDP on port %CDP_PORT%...
    
    :: Find Antigravity executable
    set AG_PATH=
    if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
        set "AG_PATH=%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
    )
    if exist "%PROGRAMFILES%\Antigravity\Antigravity.exe" (
        set "AG_PATH=%PROGRAMFILES%\Antigravity\Antigravity.exe"
    )
    
    if defined AG_PATH (
        echo [INFO] Found: !AG_PATH!
        start "" "!AG_PATH!" --remote-debugging-port=%CDP_PORT%
        echo [INFO] Waiting for Antigravity to start...
        timeout /t 5 /nobreak >nul
    ) else (
        echo [WARN] Antigravity not found. Please start it manually with:
        echo        antigravity --remote-debugging-port=%CDP_PORT%
    )
)

:start
:: Set environment variables
set CDP_PORT=%CDP_PORT%
set PORT=%PORT%

:: Start the server
node server.js

pause

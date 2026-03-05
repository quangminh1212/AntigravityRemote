@echo off
setlocal enabledelayedexpansion
title Antigravity Remote - Quick Run

:: Navigate to script directory
cd /d "%~dp0"

echo ============================================
echo  Antigravity Remote - Quick Run
echo ============================================
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
    echo [1/3] Installing dependencies...
    call npm install
    echo.
) else (
    echo [1/3] Dependencies OK.
)

:: Ensure .env exists
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env not found, creating from .env.example...
        copy .env.example .env >nul
        echo [INFO] .env created. Edit it if needed.
    )
)

:: ============================================
:: [2/3] Check CDP availability - auto-launch Antigravity if needed
:: ============================================
echo [2/3] Checking Antigravity CDP connection...

set CDP_FOUND=0
for %%p in (9000 9001 9002 9003) do (
    if !CDP_FOUND!==0 (
        curl -s -o nul -w "%%{http_code}" http://127.0.0.1:%%p/json/list >nul 2>nul
        if !errorlevel!==0 (
            :: curl succeeded, check if the response is actually valid
            curl -s http://127.0.0.1:%%p/json/list 2>nul | findstr /i "webSocketDebuggerUrl" >nul 2>nul
            if !errorlevel!==0 (
                echo [OK] CDP found on port %%p
                set CDP_FOUND=1
            )
        )
    )
)

if !CDP_FOUND!==0 (
    echo [WARN] CDP not found on any port ^(9000-9003^).
    echo [INFO] Restarting Antigravity with debug port...

    :: Kill existing Antigravity processes
    echo [INFO] Closing existing Antigravity instances...
    taskkill /f /im Antigravity.exe >nul 2>&1
    timeout /t 2 /nobreak >nul

    :: Find Antigravity executable
    set "ANTI_EXE="
    if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
        set "ANTI_EXE=%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
    )

    if "!ANTI_EXE!"=="" (
        echo [ERROR] Antigravity.exe not found. Please launch manually with:
        echo         antigravity . --remote-debugging-port=9000
        echo.
    ) else (
        echo [INFO] Launching: Antigravity --remote-debugging-port=9000
        :: Launch Antigravity with CDP port, opening the most recent workspace
        start "" "!ANTI_EXE!" --remote-debugging-port=9000
        echo [INFO] Waiting for Antigravity to start...

        :: Wait for CDP to become available (max 30 seconds)
        set CDP_READY=0
        for /l %%i in (1,1,15) do (
            if !CDP_READY!==0 (
                timeout /t 2 /nobreak >nul
                curl -s http://127.0.0.1:9000/json/list 2>nul | findstr /i "webSocketDebuggerUrl" >nul 2>nul
                if !errorlevel!==0 (
                    echo [OK] CDP is ready on port 9000!
                    set CDP_READY=1
                )
            )
        )

        if !CDP_READY!==0 (
            echo [WARN] CDP not detected after 30s. Server will keep retrying...
        )
    )
) else (
    echo [OK] Antigravity CDP is already available.
)

echo.

:: Kill any existing node server on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    echo [INFO] Killing existing process on port 3000 ^(PID: %%a^)...
    taskkill /f /pid %%a >nul 2>&1
)

:: Start server with hot reload (auto-restart on file changes)
echo [3/3] Starting server with hot reload...
echo.
echo ============================================
echo  Server: https://localhost:3000
echo  Hot Reload: ON (auto-restart on changes)
echo  Watching: server.js, public/**, generate_ssl.js
echo  Press Ctrl+C to stop
echo ============================================
echo.
npx nodemon --watch server.js --watch public --watch generate_ssl.js --ext js,html,css,json --ignore log.txt --ignore log.old.txt --ignore node_modules --signal SIGTERM --delay 2 server.js

:: Keep window open on crash
echo.
echo [INFO] Server stopped. Press any key to exit.
pause >nul

@echo off
setlocal enabledelayedexpansion
title Antigravity Remote - Full Stack Runner
chcp 65001 >nul 2>&1

:: Navigate to script directory
cd /d "%~dp0"

echo ============================================
echo  Antigravity Remote - Full Stack Runner
echo ============================================
echo.

:: ============================================
:: Parse arguments: --server-only to skip Tauri
:: ============================================
set "MODE=full"
if /i "%~1"=="--server-only" set "MODE=server"
if /i "%~1"=="-s" set "MODE=server"

:: ============================================
:: [1/5] Check Node.js
:: ============================================
echo [1/5] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo       Node.js %%v detected.

:: ============================================
:: [2/5] Check dependencies
:: ============================================
echo [2/5] Checking dependencies...
if not exist "node_modules" (
    echo       Installing npm dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo       Dependencies installed.
) else (
    echo       npm dependencies OK.
)
echo.

:: ============================================
:: [3/5] Ensure .env exists
:: ============================================
echo [3/5] Checking .env configuration...
if not exist ".env" (
    if exist ".env.example" (
        echo       .env not found, creating from .env.example...
        copy .env.example .env >nul
        echo       .env created. Edit it if needed.
    ) else (
        echo       [WARN] No .env or .env.example found. Using defaults.
    )
) else (
    echo       .env configuration OK.
)
echo.

set "BROWSER_PROTOCOL=http"
if exist "certs\server.key" if exist "certs\server.cert" set "BROWSER_PROTOCOL=https"

:: ============================================
:: Detect last active Antigravity workspace
:: ============================================
set "LAST_REPO="
set "TARGET_REPO=%CD%"
set "AG_STORAGE_JSON=%APPDATA%\Antigravity\User\globalStorage\storage.json"

if exist "!AG_STORAGE_JSON!" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$storage = $env:APPDATA + '\Antigravity\User\globalStorage\storage.json'; try { $json = Get-Content -Raw -LiteralPath $storage | ConvertFrom-Json; $uri = $json.windowsState.lastActiveWindow.folder; if (-not $uri -and $json.backupWorkspaces.folders -and $json.backupWorkspaces.folders.Count -gt 0) { $uri = $json.backupWorkspaces.folders[0].folderUri }; if ($uri) { $path = [System.Uri]::new($uri).LocalPath; if ($path -match '^/[A-Za-z]:') { $path = $path.Substring(1) }; $path = $path -replace '/', '\'; $path } } catch { }"` ) do (
        set "LAST_REPO=%%i"
    )
)

if defined LAST_REPO (
    if exist "!LAST_REPO!" (
        set "TARGET_REPO=!LAST_REPO!"
        echo       Last active Antigravity workspace: !TARGET_REPO!
    ) else (
        echo       [WARN] Last workspace from Antigravity storage was not found: !LAST_REPO!
        echo       [INFO] Falling back to current folder: !TARGET_REPO!
    )
) else (
    echo       [INFO] No recent Antigravity workspace found. Using current folder: !TARGET_REPO!
)
echo.

:: ============================================
:: [4/5] Check CDP (Antigravity Editor)
:: ============================================
echo [4/5] Checking Antigravity CDP connection...

set CDP_FOUND=0
for %%p in (9000 9001 9002 9003) do (
    if !CDP_FOUND!==0 (
        curl -s -o nul -w "%%{http_code}" http://127.0.0.1:%%p/json/list >nul 2>nul
        if !errorlevel!==0 (
            curl -s http://127.0.0.1:%%p/json/list 2>nul | findstr /i "webSocketDebuggerUrl" >nul 2>nul
            if !errorlevel!==0 (
                echo       CDP found on port %%p
                set CDP_FOUND=1
            )
        )
    )
)

if !CDP_FOUND!==0 (
    echo       [WARN] CDP not found on any port ^(9000-9003^).
    echo       [INFO] Attempting to launch Antigravity with debug port...

    :: Kill existing Antigravity processes
    taskkill /f /im Antigravity.exe >nul 2>&1
    timeout /t 2 /nobreak >nul

    :: Find Antigravity executable
    set "ANTI_EXE="
    if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
        set "ANTI_EXE=%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
    )

    if "!ANTI_EXE!"=="" (
        echo       [WARN] Antigravity.exe not found. Server will keep retrying CDP.
        echo              Launch manually: antigravity . --remote-debugging-port=9000
    ) else (
        echo       Launching Antigravity --remote-debugging-port=9000
        echo       Workspace: !TARGET_REPO!
        start "" "!ANTI_EXE!" "!TARGET_REPO!" --remote-debugging-port=9000
        echo       Waiting for CDP to become ready...

        set CDP_READY=0
        for /l %%i in (1,1,15) do (
            if !CDP_READY!==0 (
                timeout /t 2 /nobreak >nul
                curl -s http://127.0.0.1:9000/json/list 2>nul | findstr /i "webSocketDebuggerUrl" >nul 2>nul
                if !errorlevel!==0 (
                    echo       CDP ready on port 9000!
                    set CDP_READY=1
                )
            )
        )

        if !CDP_READY!==0 (
            echo       [WARN] CDP not detected after 30s. Server will keep retrying...
        )
    )
) else (
    echo       Antigravity CDP is already available.
)
echo.

:: ============================================
:: Kill any existing process on port 3000
:: ============================================
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    echo [INFO] Killing existing process on port 3000 ^(PID: %%a^)...
    taskkill /f /pid %%a >nul 2>&1
)

:: ============================================
:: [5/5] Launch based on mode
:: ============================================
if "!MODE!"=="server" goto :server_only

:: --- FULL MODE: Tauri Window + Server ---
echo [5/5] Starting Tauri App (Window + Server)...
echo.

:: Check Rust/Cargo for Tauri
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Rust/Cargo not found. Falling back to server-only mode.
    echo        Install Rust from: https://rustup.rs/
    echo.
    goto :server_only
)

echo ============================================
echo  Mode:       FULL (Tauri Window + Server)
echo  Server:     Embedded local webview ^(http://127.0.0.1:3000^)
echo  Tauri:      Portrait desktop window ^(9:16^)
echo  Workspace:  !TARGET_REPO!
echo  Press Ctrl+C to stop everything
echo ============================================
echo.

:: tauri dev will:
:: 1. Run beforeDevCommand (npm run start:embedded) to start backend
:: 2. Build and launch the Tauri desktop window
:: 3. Window connects to http://127.0.0.1:3000
npx tauri dev 2>&1

:: If Tauri exits, we're done
echo.
echo [INFO] Tauri app closed. Press any key to exit.
pause >nul
exit /b 0

:: --- SERVER-ONLY MODE ---
:server_only
echo [5/5] Starting server only (no Tauri window)...
echo.
echo ============================================
echo  Mode:       SERVER-ONLY
echo  Server:     !BROWSER_PROTOCOL!://localhost:3000
echo  Hot Reload: ON (auto-restart on changes)
echo  Watching:   server.js, public/**, generate_ssl.js
echo  Press Ctrl+C to stop
echo ============================================
echo.
npx nodemon --watch server.js --watch public --watch generate_ssl.js --ext js,html,css,json --ignore log.txt --ignore log.old.txt --ignore debug.log --ignore node_modules --signal SIGTERM --delay 2 server.js

echo.
echo [INFO] Server stopped. Press any key to exit.
pause >nul

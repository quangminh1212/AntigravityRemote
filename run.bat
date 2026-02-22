@echo off
chcp 65001 >nul 2>&1
title AntigravityHub - Remote Chat Viewer
cd /d "%~dp0"

echo.
echo  ==========================================
echo   AntigravityHub v2.1 - Remote Chat Viewer
echo   Scan QR on your phone to connect
echo  ==========================================
echo.

:: Kill existing processes on port 3000
echo [1/5] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Check Node.js
echo [2/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found! Please install from https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo     Node.js %%v

:: Check and install dependencies
echo [3/5] Checking dependencies...
if not exist "node_modules" (
    echo     Installing dependencies...
    call npm install --production
    if errorlevel 1 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
    echo     Dependencies installed.
) else (
    echo     Dependencies OK.
)

:: Build VSIX extension
echo [4/5] Building VSIX extension...
if exist "antigravity-hub-*.vsix" del /q "antigravity-hub-*.vsix" >nul 2>&1
call npx -y @vscode/vsce package --allow-missing-repository >nul 2>&1
if exist "antigravity-hub-*.vsix" (
    for %%f in (antigravity-hub-*.vsix) do (
        echo     Built: %%f
        set "VSIX_FILE=%%f"
    )
) else (
    echo     [WARN] VSIX build failed, skipping extension install.
    goto :start_server
)

:: Install to Antigravity
echo [5/5] Installing extension to Antigravity...
where antigravity >nul 2>&1
if errorlevel 1 (
    echo     [WARN] Antigravity CLI not found, skipping install.
) else (
    call antigravity --install-extension "%VSIX_FILE%" --force >nul 2>&1
    echo     Extension installed! Reload Antigravity to activate.
)

:start_server
echo.
echo  ------------------------------------------
echo   Starting standalone server...
echo  ------------------------------------------
echo.

:: Read token
if exist ".token" (
    set /p TOKEN=<.token
) else (
    echo     Token will be generated on first run.
)

:: Start server with hot reload (auto-restart on file changes)
npx -y nodemon --watch server.js --watch public --ext js,html,css --signal SIGTERM server.js
pause

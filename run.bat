@echo off
title Antigravity Hub - Dev Mode
cd /d "%~dp0"

echo.
echo  ========================================
echo   Antigravity Hub - Hot Reload Dev Mode
echo  ========================================
echo.

:: Kill existing processes on port 3000 and 3001
echo [*] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Check node_modules
if not exist "node_modules" (
    echo [*] Installing dependencies...
    call npm install
    echo.
)

:: Read token from .token file
set /p TOKEN=<.token

:: Run dev server (esbuild watch + auto-reload + server restart)
echo [*] Starting dev server with hot-reload...
echo     - Edit public/index.html = browser auto-reloads
echo     - Edit src/*.ts = auto-rebuild + server restart
echo.
echo  [URL] http://localhost:3000/?token=%TOKEN%
echo.

:: Auto-open browser after a short delay (server needs ~2s to start)
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000/?token=%TOKEN%"

call npm run dev
pause

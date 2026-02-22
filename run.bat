@echo off
title Antigravity Hub - Dev Mode
cd /d "%~dp0"

echo.
echo  ========================================
echo   Antigravity Hub - Hot Reload Dev Mode
echo  ========================================
echo.

:: Check node_modules
if not exist "node_modules" (
    echo [*] Installing dependencies...
    call npm install
    echo.
)

:: Run dev server (esbuild watch + auto-reload + server restart)
echo [*] Starting dev server with hot-reload...
echo     - Edit public/index.html = browser auto-reloads
echo     - Edit src/*.ts = auto-rebuild + server restart
echo     - Open http://localhost:3000/?token=pwaphqy5pwdvbhcs8qdkr
echo.
call npm run dev
pause

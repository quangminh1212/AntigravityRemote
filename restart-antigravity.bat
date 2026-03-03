@echo off
title Restart Antigravity with CDP
chcp 65001 >nul 2>&1

set CDP_PORT=9333

echo ═══════════════════════════════════════════
echo   Restart Antigravity with CDP Port %CDP_PORT%
echo ═══════════════════════════════════════════
echo.

:: Find Antigravity
set "AG_PATH="
if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
    set "AG_PATH=%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
)
if not defined AG_PATH (
    echo [ERROR] Antigravity not found!
    pause
    exit /b 1
)

echo [INFO] Found: %AG_PATH%
echo [INFO] Closing Antigravity...

:: Kill existing Antigravity processes
taskkill /f /im Antigravity.exe >nul 2>&1
timeout /t 3 /nobreak >nul

echo [INFO] Starting Antigravity with --remote-debugging-port=%CDP_PORT%...
start "" "%AG_PATH%" --remote-debugging-port=%CDP_PORT%

echo [INFO] Waiting for Antigravity to start...
timeout /t 8 /nobreak >nul

:: Verify CDP
curl -s http://localhost:%CDP_PORT%/json/version >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Antigravity CDP is ready on port %CDP_PORT%!
    echo [INFO] You can now run start.bat
) else (
    echo [WARN] CDP not yet available. Antigravity may still be loading...
    echo [INFO] Try running start.bat after a few seconds
)

echo.
pause

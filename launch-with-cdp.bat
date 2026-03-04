@echo off
setlocal enabledelayedexpansion
title Launch Antigravity with CDP
chcp 65001 >nul 2>&1

set CDP_PORT=9333

echo =============================================
echo   Launch Antigravity with CDP Port %CDP_PORT%
echo =============================================
echo.
echo [WARN] Thao tac nay se TAT Antigravity hien tai
echo        roi MO LAI voi CDP enabled.
echo.
echo Nhan phim bat ky de tiep tuc...
pause >nul

echo [INFO] Dang tat Antigravity...
taskkill /f /im Antigravity.exe >nul 2>&1
echo [INFO] Doi 5 giay...
ping -n 6 127.0.0.1 >nul

echo [INFO] Khoi chay Antigravity voi --remote-debugging-port=%CDP_PORT%...
start "" "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=%CDP_PORT%

echo [INFO] Doi 10 giay cho Antigravity load...
ping -n 11 127.0.0.1 >nul

:: Verify CDP
curl -s http://localhost:%CDP_PORT%/json/version >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo.
    echo [OK] CDP da san sang tren port %CDP_PORT%!
    echo [INFO] Bay gio chay: npm start
) else (
    echo [WARN] CDP chua san sang. Thu kiem tra lai...
    ping -n 6 127.0.0.1 >nul
    curl -s http://localhost:%CDP_PORT%/json/version >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo [OK] CDP da san sang tren port %CDP_PORT%!
    ) else (
        echo [FAIL] CDP khong kha dung. Antigravity co the da block remote debugging.
    )
)

echo.
echo Nhan phim bat ky de chay server...
pause >nul

:: Start the server
cd /d "%~dp0"
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
)
node server.js
pause

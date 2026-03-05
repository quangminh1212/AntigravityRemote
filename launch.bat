@echo off
echo ============================================
echo  Antigravity Phone Connect - Launcher
echo ============================================
echo.

:: Step 1: Close all Antigravity processes
echo [1/3] Closing Antigravity...
taskkill /F /IM Antigravity.exe >nul 2>&1
if %errorlevel%==0 (
    echo      Done - Antigravity closed.
) else (
    echo      Antigravity was not running.
)

:: Wait for processes to fully terminate
timeout /t 3 /nobreak >nul

:: Step 2: Reopen Antigravity with remote debugging port at this repo
echo [2/3] Opening Antigravity with remote-debugging-port=9000...
start "" "C:\Users\GHC\AppData\Local\Programs\Antigravity\Antigravity.exe" "C:\Dev\AntigravityRemote" --remote-debugging-port=9000

:: Wait for Antigravity to start up
echo      Waiting for Antigravity to start...
timeout /t 8 /nobreak >nul

:: Step 3: Start the Phone Connect server
echo [3/3] Starting Phone Connect server...
echo.
echo ============================================
echo  Server starting on http://localhost:3000
echo  Press Ctrl+C to stop the server
echo ============================================
echo.
node server.js

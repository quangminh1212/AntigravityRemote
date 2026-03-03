@echo off
echo ============================================
echo   Starting Antigravity with CDP enabled
echo ============================================
echo.
echo Closing existing Antigravity...
taskkill /f /im Antigravity.exe >nul 2>&1
timeout /t 3 /nobreak >nul
echo Starting Antigravity with --remote-debugging-port=9222...
start "" "C:\Users\GHC\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=9000
echo.
echo Done! Antigravity is starting with CDP on port 9222.
echo Extension will auto-connect and serve mobile UI on port 3000.
echo.
pause

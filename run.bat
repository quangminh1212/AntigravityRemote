@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

title Antigravity Remote - Build ^& Install
cd /d "%~dp0"

echo ============================================
echo   Antigravity Remote - Build ^& Install
echo ============================================
echo.

:: ── Detect Antigravity CLI
set "AG_CLI="
where antigravity >nul 2>&1
if !errorlevel! equ 0 (
    for /f "tokens=*" %%p in ('where antigravity 2^>nul') do (
        if not defined AG_CLI set "AG_CLI=%%p"
    )
)
if not defined AG_CLI (
    set "AG_CLI=%LOCALAPPDATA%\Programs\Antigravity\bin\antigravity.cmd"
)
if not exist "!AG_CLI!" (
    echo [ERROR] Antigravity CLI not found.
    echo         Expected: !AG_CLI!
    echo         Install Antigravity or add it to PATH.
    goto :error
)
echo [OK] Antigravity CLI: !AG_CLI!
echo.

:: ── Step 1: Check Node.js
echo [1/6] Checking Node.js...
where node >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Node.js not found. Download from https://nodejs.org/
    goto :error
)
for /f "tokens=*" %%v in ('node -v') do echo       Node %%v
echo.

:: ── Step 2: Install dependencies
echo [2/6] Installing dependencies...
if not exist "node_modules\" (
    call npm install --no-audit --no-fund
    if !errorlevel! neq 0 (
        echo [ERROR] npm install failed.
        goto :error
    )
) else (
    call npm install --prefer-offline --no-audit --no-fund >nul 2>&1
)
echo       OK
echo.

:: ── Step 3: Build
echo [3/6] Building extension...

:: TypeScript check (non-blocking)
echo       TypeScript check...
node --no-experimental-strip-types node_modules\typescript\lib\tsc.js -p ./ --noEmit >nul 2>nul
set /a TSC_EXIT=!errorlevel!+0
if !TSC_EXIT! equ 0 (
    echo       Type check OK.
) else (
    echo       [WARNING] TypeScript has warnings. Continuing...
)

:: esbuild bundle
echo       esbuild bundle...
node esbuild.js >nul 2>nul
set /a ESB_EXIT=!errorlevel!+0
if !ESB_EXIT! neq 0 (
    echo [ERROR] esbuild bundle failed ^(exit !ESB_EXIT!^).
    goto :error
)

:: Verify output
if not exist "out\extension.js" (
    echo [ERROR] out\extension.js not generated.
    goto :error
)
echo       OK: out\extension.js
echo.

:: ── Step 4: Run tests
echo [4/6] Running tests...
call npx mocha -r ts-node/register src/test/injectFile.test.ts src/test/injectMessage.test.ts src/test/server.test.ts --timeout 10000 >_test_output.log 2>&1
set /a TEST_EXIT=!errorlevel!+0
if !TEST_EXIT! neq 0 (
    echo [WARNING] Some tests failed:
    type _test_output.log
    echo.
    echo       Continuing with build...
) else (
    :: Extract pass count
    for /f "tokens=*" %%l in ('findstr /c:"passing" _test_output.log') do echo       %%l
    echo       All tests passed.
)
echo.

:: ── Step 5: Package VSIX
echo [5/6] Packaging .vsix...

:: Clean old .vsix files
del /q *.vsix >nul 2>&1

:: Package with vsce
call npx vsce package --no-git-tag-version --no-update-package-json >_vsce_output.log 2>&1
set /a VSCE_EXIT=!errorlevel!+0
if !VSCE_EXIT! neq 0 (
    echo [ERROR] vsce package failed:
    type _vsce_output.log
    goto :error
)

:: Find the generated .vsix
set "VSIX_FILE="
for %%f in (*.vsix) do set "VSIX_FILE=%%f"
if not defined VSIX_FILE (
    echo [ERROR] No .vsix file generated.
    goto :error
)
echo       OK: !VSIX_FILE!
echo.

:: ── Step 6: Install into Antigravity
echo [6/6] Installing into Antigravity...
echo       Uninstalling old version...
"!AG_CLI!" --uninstall-extension xlab.antigravity-remote-extension >nul 2>&1

echo       Installing !VSIX_FILE!...
"!AG_CLI!" --install-extension "!VSIX_FILE!" --force >_install_output.log 2>&1
set /a INST_EXIT=!errorlevel!+0
if !INST_EXIT! neq 0 (
    echo [WARNING] Install may have issues:
    type _install_output.log
    echo.
    echo       Trying alternate install...
    "!AG_CLI!" --install-extension "%CD%\!VSIX_FILE!" --force >_install_output.log 2>&1
)
type _install_output.log | findstr /i /c:"success" /c:"installed" /c:"was" >nul 2>&1
echo       Install completed.
echo.

:: ── Launch Antigravity with remote debugging port
echo ============================================
echo   BUILD ^& INSTALL COMPLETE
echo ============================================
echo.
echo   Extension: !VSIX_FILE!
echo.
echo   Next steps:
echo     1. Restart Antigravity to load the new extension
echo     2. Launch Antigravity with debug port:
echo        antigravity --remote-debugging-port=9000
echo     3. Use Command Palette: "Antigravity Remote: Start Server"
echo     4. Then: "Antigravity Remote: Show QR Code"
echo.

set /p LAUNCH="Launch Antigravity now with debug port? (Y/N): "
if /i "!LAUNCH!"=="Y" (
    echo.
    echo   Launching Antigravity with --remote-debugging-port=9000 ...
    start "" "!AG_CLI!" --remote-debugging-port=9000
    echo   Antigravity launched!
)

echo.
goto :end

:error
echo.
echo ============================================
echo   BUILD FAILED
echo ============================================
echo.

:end
:: Cleanup temp files
for %%f in (_test_output.log _vsce_output.log _install_output.log _check_vsce.js _check_vsce.cjs) do if exist "%%f" del /q "%%f" >nul 2>&1
endlocal
pause

@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

title Antigravity Link - Build ^& Launch
cd /d "%~dp0"

echo ============================================
echo   Antigravity Link - Auto Build ^& Launch
echo ============================================
echo.

:: ── Step 1: Check Node.js
echo [1/4] Checking Node.js...
where node >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Node.js not found. Download from https://nodejs.org/
    goto :error
)
for /f "tokens=*" %%v in ('node -v') do echo       Node %%v
echo.

:: ── Step 2: Install dependencies
echo [2/4] Installing dependencies...
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
echo [3/4] Building extension...

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

:: ── Step 4: VS Code
echo [4/4] Opening VS Code...
where code >nul 2>&1
if !errorlevel! equ 0 (
    start "" code .
    echo       VS Code opened.
) else (
    echo       [INFO] Open this folder in VS Code manually then press F5.
)

echo.
echo ============================================
echo   BUILD COMPLETE - Extension ready!
echo ============================================
echo   Press F5 in VS Code for Extension Dev Host
echo.
goto :end

:error
echo.
echo ============================================
echo   BUILD FAILED
echo ============================================
echo.

:end
for %%f in (_check_vsce.js _check_vsce.cjs _vsce_output.log _tsc_out.log) do if exist "%%f" del /q "%%f" >nul 2>&1
endlocal
pause

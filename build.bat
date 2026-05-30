@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title OpenWorkflow (Build EXE)

cd /d "%~dp0app"

echo ============================================================
echo   OpenWorkflow  -  Package Windows EXE  (tauri build)
echo ============================================================
echo.

REM ---- prerequisites ----
where node >nul 2>nul || ( echo [X] Node.js not found: https://nodejs.org & pause & exit /b 1 )
where cargo >nul 2>nul || ( echo [X] Rust/cargo not found: https://rustup.rs & pause & exit /b 1 )
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
for /f "delims=" %%v in ('cargo -V') do echo [OK] %%v

if not exist "node_modules" (
    echo [..] installing dependencies ...
    call npm install || ( echo [X] npm install failed & pause & exit /b 1 )
)

echo.
echo [..] building frontend + compiling Rust + packaging installer ...
echo      (first build downloads the NSIS bundler and compiles crates;
echo       this can take several minutes)
echo ============================================================
echo.

call npm run package
if errorlevel 1 (
    echo.
    echo [X] build failed. See the log above.
    pause & exit /b 1
)

echo.
echo ============================================================
echo   BUILD COMPLETE
echo ============================================================
set "REL=%~dp0app\src-tauri\target\release"
echo   Standalone app : !REL!\OpenWorkflow.exe
echo   Installer (exe): !REL!\bundle\nsis\OpenWorkflow_0.1.0_x64-setup.exe
echo ------------------------------------------------------------
echo   - Double-click OpenWorkflow.exe to run directly (needs WebView2,
echo     which ships with Windows 10/11).
echo   - Or run the *_x64-setup.exe installer to install it like normal software.
echo ------------------------------------------------------------

REM ---- open the output folders in Explorer ----
if exist "!REL!\bundle\nsis" start "" explorer "!REL!\bundle\nsis"
if exist "!REL!\OpenWorkflow.exe" start "" explorer /select,"!REL!\OpenWorkflow.exe"

echo.
pause
endlocal

@echo off
setlocal enabledelayedexpansion
title OpenWorkflow Runner
cd /d "%~dp0"

set "EXE=app\src-tauri\target\release\OpenWorkflow.exe"
set "MODE=auto"
if /I "%~1"=="/run"   set "MODE=run"
if /I "%~1"=="/build" set "MODE=build"

echo ============================================================
echo   OpenWorkflow Runner
echo ============================================================
echo   run.bat          auto: rebuild if sources changed, then launch
echo   run.bat /run     launch existing exe only
echo   run.bat /build   build only, do not launch
echo ============================================================
echo.

set "NEED_BUILD=0"
if "%MODE%"=="build" set "NEED_BUILD=1"
if "%MODE%"=="run"   goto after_decide
if not exist "%EXE%" goto need_first_build

REM auto mode + exe exists: ask the helper whether sources are newer
powershell -NoProfile -ExecutionPolicy Bypass -File "app\scripts\needs-rebuild.ps1" "%EXE%" "%CD%"
if errorlevel 1 goto sources_newer
echo [OK] exe up to date - skip build.
goto after_decide
:sources_newer
echo [..] sources newer than exe - will rebuild.
set "NEED_BUILD=1"
goto after_decide

:need_first_build
echo [..] no exe yet - first build required.
set "NEED_BUILD=1"

:after_decide
if "%NEED_BUILD%"=="1" goto do_build
goto do_launch

:do_build
where node >nul 2>nul || goto no_node
where cargo >nul 2>nul || goto no_cargo
if exist "app\node_modules" goto have_deps
echo [..] installing dependencies ...
pushd app
call npm install
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" goto npm_fail
:have_deps
echo.
echo [..] building: npm run package  ^(first build compiles Rust, may take minutes^)
echo ============================================================
pushd app
call npm run package
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" goto build_fail
echo [OK] build done: %EXE%
if "%MODE%"=="build" goto build_only_done

:do_launch
if not exist "%EXE%" goto no_exe
echo.
echo [..] launching OpenWorkflow ...
start "" "%EXE%"
echo [OK] launched an independent window. You can close this console.
echo      (self-test tip: point the in-app workspace to a project COPY.)
timeout /t 3 >nul
goto end

:build_only_done
echo.
echo [OK] build complete (not launched).
goto pause_end

:no_node
echo [X] Node.js 18+ not found: https://nodejs.org
goto pause_end
:no_cargo
echo [X] Rust/cargo not found: https://rustup.rs
goto pause_end
:npm_fail
echo [X] npm install failed.
goto pause_end
:build_fail
echo [X] build failed - see errors above.
goto pause_end
:no_exe
echo [X] exe not found: %EXE%
goto pause_end

:pause_end
pause
:end
endlocal

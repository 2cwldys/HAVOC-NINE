@echo off
REM ===========================================================================
REM  build_export_all.cmd -- one-click full build: engine, assets/scripts, export
REM
REM  Runs, in order:
REM    1. xash3d-h9-patches\xash.bat   (engine + assemble into H9XASH)
REM    2. build.bat                    (AMX Mod X plugins, assets, server side --
REM                                     this step runs export.bat itself on a
REM                                     clean build, carrying H9XASH into export\
REM                                     and this git mirror)
REM
REM  Paths come from buildpaths.ini beside this script (TSM_ROOT under [paths]).
REM  Edit buildpaths.ini, not this file, if TSM ever moves.
REM
REM  Source: this file lives in TSM too, at TSM_ROOT\build_export_all.cmd --
REM  edit it there (and buildpaths.ini's TSM_ROOT line stays local to each copy),
REM  since export.bat does not carry loose root-level files like this one into
REM  the repo on its own, only the ones it explicitly copies.
REM ===========================================================================
setlocal enabledelayedexpansion

set "INI=%~dp0buildpaths.ini"
set "TSM_ROOT="

if not exist "%INI%" (
    echo [ERROR] buildpaths.ini not found beside this script at:
    echo         %INI%
    pause
    exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%INI%") do (
    set "KEY=%%A"
    set "VAL=%%B"
    if /i "!KEY!"=="TSM_ROOT" set "TSM_ROOT=!VAL!"
)

if not defined TSM_ROOT (
    echo [ERROR] TSM_ROOT= not found under [paths] in buildpaths.ini.
    pause
    exit /b 1
)

if not exist "%TSM_ROOT%\xash3d-h9-patches\xash.bat" (
    echo [ERROR] TSM not found at %TSM_ROOT% -- fix TSM_ROOT in buildpaths.ini.
    pause
    exit /b 1
)

echo ===============================================================
echo  1/2: engine + assemble  (xash3d-h9-patches\xash.bat)
echo ===============================================================
call "%TSM_ROOT%\xash3d-h9-patches\xash.bat"
if errorlevel 1 (
    echo.
    echo [FAILED] xash.bat reported an error -- stopping before build.bat so a
    echo          broken engine build is not exported.
    pause
    exit /b 1
)

echo.
echo ===============================================================
echo  2/2: AMX Mod X plugins, assets, server side, then export
echo ===============================================================
call "%TSM_ROOT%\build.bat"
set "BUILDEXIT=%ERRORLEVEL%"

echo.
echo ===============================================================
if "%BUILDEXIT%"=="0" (
    echo  DONE -- H9XASH, export\, and this repo are all up to date.
) else (
    echo  [WARN] build.bat exited with code %BUILDEXIT% -- check the output above.
)
echo ===============================================================
pause
endlocal

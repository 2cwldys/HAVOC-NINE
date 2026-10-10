@echo off
REM ===========================================================================
REM  build.bat -- build and deploy the TS match mode
REM
REM  THIS FOLDER IS THE SINGLE SOURCE OF TRUTH.
REM  Edit the .sma and .cfg here. This script syncs them into the game folder,
REM  compiles, and deploys the .amxx to plugins.
REM
REM  Why: a second copy of the source lived inside the game folder and the two
REM  drifted apart, so a build thousands of bytes behind the fixes was being
REM  tested for hours. Copy-then-compile makes that impossible.
REM
REM  Usage:  build.bat | build.bat ts_matchmode | build.bat all
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ---- edit this if your install moves ---------------------------------------
set "TSROOT=D:\SteamLibrary\steamapps\common\Half-Life\ts\addons\amxmodx"
REM ---------------------------------------------------------------------------

set "SRC=%~dp0"
set "SCRIPTING=%TSROOT%\scripting"
set "CONFIGS=%TSROOT%\configs"
set "PLUGINS=%TSROOT%\plugins"
set "AMXXPC=%SCRIPTING%\amxxpc.exe"
set "OUT=%SRC%compiled"

if not exist "%AMXXPC%" (
    echo [ERROR] amxxpc.exe not found at:
    echo         %AMXXPC%
    echo         Fix TSROOT at the top of this script.
    goto :done
)
if not exist "%PLUGINS%" (
    echo [ERROR] Plugins folder missing: %PLUGINS%
    goto :done
)
if not exist "%OUT%" mkdir "%OUT%"

if "%~1"=="" (
    set "TARGETS=ts_matchmode ts_probe"
) else (
    if /i "%~1"=="all" (
        set "TARGETS="
        for %%f in ("%SRC%*.sma") do set "TARGETS=!TARGETS! %%~nf"
    ) else (
        set "TARGETS=%*"
    )
)
echo Building:!TARGETS!
echo.

echo --- syncing source into the game folder ---
for %%n in (!TARGETS!) do (
    if exist "%SRC%%%n.sma" (
        copy /y "%SRC%%%n.sma" "%SCRIPTING%\%%n.sma" >nul
        if errorlevel 1 (echo [FAIL] could not sync %%n.sma) else (echo   synced %%n.sma)
    )
)
for %%c in ("%SRC%*.cfg") do (
    copy /y "%%c" "%CONFIGS%\%%~nxc" >nul
    if errorlevel 1 (echo [FAIL] could not sync %%~nxc) else (echo   synced %%~nxc)
)
echo.

set OK=0
set BAD=0

for %%n in (!TARGETS!) do (
    if not exist "%SRC%%%n.sma" (
        echo [SKIP] %%n.sma not in this folder
    ) else (
        echo ===== %%n.sma =====
        REM Delete old output first: otherwise a failed compile leaves the
        REM previous binary behind and the deploy ships it as if it worked.
        if exist "%OUT%\%%n.amxx" del /q "%OUT%\%%n.amxx"
        pushd "%SCRIPTING%"
        "%AMXXPC%" "%%n.sma" -o"%OUT%\%%n.amxx"
        popd
        if exist "%OUT%\%%n.amxx" (
            copy /y "%OUT%\%%n.amxx" "%PLUGINS%\%%n.amxx" >nul
            if errorlevel 1 (
                echo [FAIL] compiled but could not copy to plugins.
                echo        Is the server running and holding the file open?
                set /a BAD+=1
            ) else (
                echo [OK]   deployed %%n.amxx
                set /a OK+=1
            )
        ) else (
            echo [FAIL] no .amxx produced -- see compiler output above
            set /a BAD+=1
        )
        echo.
    )
)

REM ---- keep the server package in step -------------------------------------
REM Only on a clean build. Exporting after a failure would ship the previous
REM binary alongside the new source, which is the one combination that looks
REM right and is not.
if !BAD! EQU 0 (
    if exist "%SRC%export.bat" call "%SRC%export.bat"
) else (
    echo --- export skipped: fix the build first ---
)
echo.

echo ---------------------------------------------------------------
echo  Deployed: !OK!    Failed: !BAD!
if !BAD! GTR 0 (
    echo  Failed builds were NOT deployed, so nothing stale shipped.
) else (
    echo  Restart the server fully ^(not amxx reload^) so new cvars
    echo  register, then run:  amx_tsm_debug
    echo  Confirm the BUILD line is what you expect.
)
echo ---------------------------------------------------------------

:done
echo.
pause
endlocal

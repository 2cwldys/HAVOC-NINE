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
    REM ts_floatchat is OFF. It redrew a RELIABLE hud message per viewer per talker, ten
REM times a second, and kept an entity per player for the bubble -- it was flooding the
REM reliable stream and eating edicts, and it never drew on screen anyway. The source
REM and the sprites are kept; it is simply not built or deployed.
set "TARGETS=ts_matchmode ts_probe ts_advertise"
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
REM ts_advertise.cfg HOLDS THE DISCORD BOT TOKEN, so it is only ever created, never
REM overwritten. Syncing it like the others would wipe the token on every build, and
REM the only symptom would be the plugin saying Discord is not configured.
for %%c in ("%SRC%*.cfg") do (
    if /i "%%~nxc"=="ts_advertise.cfg" (
        if exist "%CONFIGS%\%%~nxc" (
            echo   kept    %%~nxc  ^(holds your token; not overwritten^)
        ) else (
            copy /y "%%c" "%CONFIGS%\%%~nxc" >nul
            echo   created %%~nxc  ^(put the token in it^)
        )
    ) else (
        copy /y "%%c" "%CONFIGS%\%%~nxc" >nul
        if errorlevel 1 (echo [FAIL] could not sync %%~nxc) else (echo   synced %%~nxc)
    )
)

REM ---- sounds into the live mod folder ---------------------------------------
REM The wavs in sound\ are the ones the map plays and the two the plugin plays by name
REM (the sudden-death sting and the join jingle). A precached name with no file behind
REM it is a FATAL Host_Error on map load, not a silent no-op, and until now only
REM export.bat ever put these anywhere -- so the live server had none of them.
if exist "%SRC%sound" (
    xcopy /y /q "%SRC%sound\*.wav" "%TSROOT%\..\..\sound" >nul
    echo   synced sound\*.wav
)
REM MP3 music tracks for the ambient queue (HL mp3 player, 2D non-spatial)
if exist "%SRC%sound\music" (
    xcopy /y /q "%SRC%sound\music\*.mp3" "%TSROOT%\..\..\ts\sound\music\" >nul
    echo   synced sound\music\*.mp3
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

REM ---- the AmxxEasyHttp module ---------------------------------------------
REM ts_advertise cannot load without it: Discord is HTTPS only and AMXX has no TLS
REM of its own. Both files are vendored in compts\, so this is a copy rather than a
REM download. Only ever created, never refreshed, so a newer one put there by hand
REM is not quietly reverted on the next build.
REM
REM WITHOUT THE .pem every request fails certificate validation and reports it as a
REM connection error rather than as a missing file.
if not exist "%TSROOT%\modules\easy_http_amxx.dll" (
    if exist "%SRC%compts\ts\addons\amxmodx\modules\easy_http_amxx.dll" (
        copy /y "%SRC%compts\ts\addons\amxmodx\modules\easy_http_amxx.dll" "%TSROOT%\modules\" >nul
        echo   installed easy_http_amxx.dll
    )
)
if not exist "%TSROOT%\data\amxx_easy_http_cacert.pem" (
    if exist "%SRC%compts\ts\addons\amxmodx\data\amxx_easy_http_cacert.pem" (
        copy /y "%SRC%compts\ts\addons\amxmodx\data\amxx_easy_http_cacert.pem" "%TSROOT%\data\" >nul
        echo   installed amxx_easy_http_cacert.pem
    )
)

REM easy_http.inc is needed to COMPILE ts_advertise and is not part of AMXX,
REM so it must travel with the package.
if not exist "%TSROOT%\scripting\include\easy_http.inc" (
    if exist "%SRC%compts\scripting\include\easy_http.inc" (
        copy /y "%SRC%compts\scripting\include\easy_http.inc" "%TSROOT%\scripting\include\" >nul
        echo   installed easy_http.inc
    )
)

REM ---- register the plugins with AMXX --------------------------------------
REM Deploying the .amxx is NOT enough. AMXX only loads what plugins.ini lists, so a
REM freshly built plugin sits in the plugins folder doing nothing and its chat
REM command produces no response whatsoever -- not an error, not a refusal, just
REM silence, which reads exactly like a broken command.
for %%n in (!TARGETS!) do (
    if exist "%PLUGINS%\%%n.amxx" (
        findstr /i /c:"%%n.amxx" "%CONFIGS%\plugins.ini" >nul 2>&1
        if errorlevel 1 (
            >> "%CONFIGS%\plugins.ini" echo %%n.amxx
            echo   registered %%n.amxx in plugins.ini
        )
    )
)
echo.

REM ---- the Half-Life folder, not the mod folder ----------------------------
REM Everything above deploys into ts\addons\amxmodx. The launcher and the Discord
REM bot do NOT live there: ts.bat sits beside hlds.exe because that is what it runs,
REM and discord-bot\ sits beside ts\ because the bot finds the plugin's config at
REM ..\ts\addons\amxmodx\configs. Deployed here so the live install matches the
REM package instead of only the export folder having them.
for %%i in ("%TSROOT%\..\..\..") do set "HLROOT=%%~fi"
if exist "%HLROOT%\hlds.exe" (
    if exist "%SRC%ts.bat" (
        copy /y "%SRC%ts.bat" "%HLROOT%\" >nul && echo   deployed ts.bat          ^-^> %HLROOT%
    )
    if exist "%SRC%discord-bot" (
        REM No /purge: rsvp.json and __pycache__ are written there at runtime and are
        REM not ours to delete.
        xcopy /y /i /e /q "%SRC%discord-bot" "%HLROOT%\discord-bot" >nul && echo   deployed discord-bot\    ^-^> %HLROOT%\discord-bot
    )
) else (
    echo   [WARN] no hlds.exe at %HLROOT% -- ts.bat and discord-bot\ not deployed
)
echo.

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

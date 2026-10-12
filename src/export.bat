@echo off
REM ===========================================================================
REM  export.bat -- assemble the server package in .\export
REM
REM  WHAT THIS IS FOR
REM
REM  export\ is a drop-in copy of everything this match mode needs, laid out in
REM  the same shape as a Half-Life install, so a second machine can be set up by
REM  copying folders rather than by remembering which seven files were touched.
REM
REM  It is GENERATED. Never edit anything under export\ -- the next build
REM  overwrites it. Edit the sources in this folder and in the game folder, then
REM  run build.bat, which calls this script for you.
REM
REM  Usage:  export.bat        (or just run build.bat)
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "HL=D:\SteamLibrary\steamapps\common\Half-Life"
set "TS=%HL%\ts"
set "AMXX=%TS%\addons\amxmodx"
set "EX=%~dp0export"

echo --- assembling the server package in export\ ---

for %%d in (
    "%EX%"
    "%EX%\src"
    "%EX%\docs"
    "%EX%\ts"
    "%EX%\ts\addons\amxmodx\plugins"
    "%EX%\ts\addons\amxmodx\configs"
    "%EX%\ts\addons\amxmodx\scripting"
    "%EX%\ts\addons\metamod"
    "%EX%\rcbot\dlls"
    "%EX%\rcbot\waypoints\ts"
) do if not exist "%%~d" mkdir "%%~d" >nul 2>&1

REM ---- source of truth: this folder ----------------------------------------
copy /y "%~dp0ts_matchmode.sma"  "%EX%\src\"                 >nul && echo   src\ts_matchmode.sma
copy /y "%~dp0ts_probe.sma"      "%EX%\src\"                 >nul && echo   src\ts_probe.sma
copy /y "%~dp0ts_advertise.sma"  "%EX%\src\"                 >nul && echo   src\ts_advertise.sma
copy /y "%~dp0build.bat"         "%EX%\src\"                 >nul && echo   src\build.bat
copy /y "%~dp0export.bat"        "%EX%\src\"                 >nul && echo   src\export.bat
copy /y "%~dp0COMMANDS.txt"      "%EX%\docs\"                >nul && echo   docs\COMMANDS.txt

REM At the package root, beside README.txt, because that is where someone setting up
REM a second machine will look for it rather than in src\.
copy /y "%~dp0install-rcbot.bat" "%EX%\"                     >nul && echo   install-rcbot.bat

REM ---- compiled plugin -----------------------------------------------------
REM From compiled\, not from the server's plugins folder: a failed build leaves
REM the old binary deployed, and shipping that is how a stale plugin travels to
REM another machine looking current.
if exist "%~dp0compiled\ts_matchmode.amxx" (
    copy /y "%~dp0compiled\ts_matchmode.amxx" "%EX%\ts\addons\amxmodx\plugins\" >nul
    echo   ts\addons\amxmodx\plugins\ts_matchmode.amxx
) else (
    echo   [WARN] no compiled\ts_matchmode.amxx -- package has no plugin binary
)

if exist "%~dp0compiled\ts_advertise.amxx" (
    copy /y "%~dp0compiled\ts_advertise.amxx" "%EX%\ts\addons\amxmodx\plugins\" >nul
    echo   ts\addons\amxmodx\plugins\ts_advertise.amxx
) else (
    echo   [WARN] no compiled\ts_advertise.amxx -- package has no Discord advert plugin
)

REM ---- configs -------------------------------------------------------------
copy /y "%~dp0ts_matchmode.cfg" "%EX%\ts\addons\amxmodx\configs\"  >nul && echo   configs\ts_matchmode.cfg
copy /y "%~dp0ts_matchmode.sma" "%EX%\ts\addons\amxmodx\scripting\" >nul
copy /y "%~dp0ts_advertise.cfg" "%EX%\ts\addons\amxmodx\configs\"  >nul && echo   configs\ts_advertise.cfg
copy /y "%~dp0ts_advertise.sma" "%EX%\ts\addons\amxmodx\scripting\" >nul

REM easy_http.inc is needed to COMPILE ts_advertise and is not part of AMXX, so it
REM travels with the package or the next machine cannot rebuild it.
if not exist "%EX%\ts\addons\amxmodx\scripting\include" mkdir "%EX%\ts\addons\amxmodx\scripting\include" >nul 2>&1
if exist "%~dp0compts\scripting\include\easy_http.inc" (
    copy /y "%~dp0compts\scripting\include\easy_http.inc" "%EX%\ts\addons\amxmodx\scripting\include\" >nul
    echo   scripting\include\easy_http.inc
)

REM Per-map spawn sets live only in the game folder -- they are written there by
REM amx_tsm_spawn_save, so this is the only copy.
set "SPAWNS=0"
for %%f in ("%AMXX%\configs\tsm_spawns_*.cfg") do (
    copy /y "%%f" "%EX%\ts\addons\amxmodx\configs\" >nul
    set /a SPAWNS+=1
)
echo   configs\tsm_spawns_*.cfg  ^(!SPAWNS! map^(s^)^)

REM game.cfg is the one that decides gamerules, so it is not optional.
if exist "%TS%\game.cfg" (
    copy /y "%TS%\game.cfg" "%EX%\ts\" >nul && echo   ts\game.cfg
) else (
    echo   [WARN] ts\game.cfg missing -- teamplay will not be enabled on a fresh install
)
if exist "%TS%\server.cfg"       copy /y "%TS%\server.cfg"       "%EX%\ts\" >nul
if exist "%TS%\listenserver.cfg" copy /y "%TS%\listenserver.cfg" "%EX%\ts\" >nul

REM ---- metamod -------------------------------------------------------------
if exist "%TS%\addons\metamod\plugins.ini" (
    copy /y "%TS%\addons\metamod\plugins.ini" "%EX%\ts\addons\metamod\" >nul && echo   ts\addons\metamod\plugins.ini
)

REM ---- rcbot ---------------------------------------------------------------
REM Only the TS waypoints. The other mods' sets are several megabytes and have
REM nothing to do with this.
if exist "%HL%\rcbot" (
    copy /y "%HL%\rcbot\*.ini" "%EX%\rcbot\" >nul 2>&1
    copy /y "%HL%\rcbot\*.rld" "%EX%\rcbot\" >nul 2>&1
    copy /y "%HL%\rcbot\*.txt" "%EX%\rcbot\" >nul 2>&1
    copy /y "%HL%\rcbot\dlls\rcbot_mm.dll" "%EX%\rcbot\dlls\" >nul 2>&1
    copy /y "%HL%\rcbot\dlls\rcbot_mm.so"  "%EX%\rcbot\dlls\" >nul 2>&1
    xcopy /y /q "%HL%\rcbot\waypoints\ts\*.rcw" "%EX%\rcbot\waypoints\ts\" >nul 2>&1
    echo   rcbot\ ^(configs, dlls, TS waypoints^)
) else (
    echo   [WARN] rcbot not found at %HL%\rcbot -- package has no bot support
)

REM ---- the rcbot patch ------------------------------------------------------
REM rcbot_mm.dll copied above is a CUSTOM build. The source of that change ships
REM beside it so the binary is not an unexplained file on the next machine, and so
REM it can be rebuilt when rcbot releases a new version.
if exist "%SRC%rcbot-patch" (
    xcopy /y /i /e /q "%SRC%rcbot-patch" "%EX%\rcbot-patch" >nul
    echo   rcbot-patch\ ^(diff, patched sources, build instructions^)
)

REM No .so can be built here, so the linux binary stays stock. Flagged beside it:
REM a linux server that uses it silently gets the bug back.
if exist "%EX%\rcbot\dlls\rcbot_mm.so" (
    echo This .so is STOCK rcbot and does NOT contain the TS team fix.> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo.>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo On linux, bots go back to attacking their own team: stock rcbot decides>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo The Specialists teams by comparing player model strings, so teammates in>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo different models read as enemies.>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo.>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo To build one: clone rcbotold at the commit in ..\..\rcbot-patch\BASE-COMMIT.txt,>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo apply rcbot-ts-teams.patch, build with the AMBuildScript in the repo root.>> "%EX%\rcbot\dlls\READ-ME-rcbot_mm.so.txt"
    echo   rcbot\dlls\rcbot_mm.so  ^(STOCK -- see the READ-ME beside it^)
)

REM ---- Discord bot ---------------------------------------------------------
REM Sits BESIDE ts\ rather than inside it, because the bot finds the plugin's config
REM by looking at ..\ts\addons\amxmodx\configs -- one copy of the token, in the file
REM that already holds it, rather than a second config of its own to forget to rotate.
REM
REM ts.bat goes at the package root: it is what someone runs, and it starts the bot,
REM runs hlds and stops the bot again. A plugin cannot start a program, so the
REM launcher does it.
if exist "%~dp0discord-bot" (
    xcopy /y /i /e /q "%~dp0discord-bot" "%EX%\discord-bot" >nul
    echo   discord-bot\ ^(gateway bot: presence, slash commands, RSVP^)
)
if exist "%~dp0ts.bat" (
    copy /y "%~dp0ts.bat" "%EX%\" >nul && echo   ts.bat  ^(starts the bot, then hlds^)
)

REM ---- .gitignore ----------------------------------------------------------
REM Written here rather than kept as a file so that EVERY export has one, including
REM the first on a fresh machine.
REM
REM ts_advertise.cfg is the one that matters: it holds the BOT TOKEN, which is the
REM entire bot account -- whoever has it can act as the bot in every guild it is in,
REM until it is reset, and there is nothing else to revoke.
> "%EX%\.gitignore" echo # ts_advertise.cfg holds the Discord bot token. Never commit it.
>> "%EX%\.gitignore" echo #
>> "%EX%\.gitignore" echo # The token is the whole bot account, not access to one channel.
>> "%EX%\.gitignore" echo # If it ever lands in a commit, Reset Token in the Discord developer portal:
>> "%EX%\.gitignore" echo # removing the file afterwards does not help, the history keeps it.
>> "%EX%\.gitignore" echo ts/addons/amxmodx/configs/ts_advertise.cfg
>> "%EX%\.gitignore" echo.
>> "%EX%\.gitignore" echo # Runtime state written by the bot, not source.
>> "%EX%\.gitignore" echo discord-bot/rsvp.json
>> "%EX%\.gitignore" echo discord-bot/bot.log
>> "%EX%\.gitignore" echo discord-bot/bot.err
>> "%EX%\.gitignore" echo discord-bot/__pycache__/
echo   .gitignore

REM ---- class-icon sprite ---------------------------------------------------
REM Built by tools\make-class-icons.py, not shipped with TS. Clients need it or the
REM icons draw nothing, so it goes in the package next to the configs.
if exist "%SRC%sprites" (
    xcopy /y /i /e /q "%SRC%sprites" "%EX%\ts\sprites" >nul
    echo   ts\sprites\ ^(class icons^)
)

REM ---- compts -------------------------------------------------- compts-patch-block
REM Follows the rcbot-patch pattern: the real copy lives OUTSIDE export, so a clean
REM build cannot wipe it, and it is synced in on every successful build.
if exist "%SRC%compts" (
    xcopy /y /i /e /q "%SRC%compts" "%EX%\compts" >nul
    echo   compts\ ^(elo plugin, webserver, models^)
)

REM ---- stamp ---------------------------------------------------------------
REM tokens=3 lands on the quoted value; the quotes are stripped after. Splitting on
REM a quote delimiter instead needs an escape that cmd mis-parses inside for /f.
set "BUILD=unknown"
for /f "tokens=3" %%v in ('findstr /c:"#define TSM_BUILD" "%~dp0ts_matchmode.sma"') do set "BUILD=%%v"
set "BUILD=!BUILD:"=!"
> "%EX%\VERSION.txt" (
    echo TS Match Mode server package
    echo.
    echo Build:     !BUILD!
    echo Exported:  %DATE% %TIME%
    echo Source:    %~dp0
    echo.
    echo Generated by export.bat. Do not edit anything in this folder by hand.
)
echo   VERSION.txt  ^(build !BUILD!^)

echo --- package ready: %EX% ---
endlocal

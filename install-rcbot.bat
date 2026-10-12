@echo off
REM ===========================================================================
REM  install-rcbot.bat -- install rcbot from this package into a Half-Life folder
REM
REM  WHAT THIS IS FOR
REM
REM  Installing rcbot by hand means copying four kinds of file into two different
REM  folders and editing metamod's plugins.ini without breaking it. This asks where
REM  Half-Life is and does it, and refuses rather than guesses when something is
REM  not as it expects.
REM
REM  It is SAFE TO RUN TWICE. It will not add a second rcbot line, it will not
REM  overwrite the configs you have tuned, and it keeps a copy of anything it
REM  replaces.
REM
REM  Usage:  double-click it, or  install-rcbot.bat
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "SRC=%~dp0"
set "DID=0"

echo.
echo ===========================================================================
echo  rcbot installer
echo ===========================================================================
echo.

if not exist "%SRC%rcbot\dlls\rcbot_mm.dll" (
    echo [ERROR] This does not look like the package.
    echo         Expected: %SRC%rcbot\dlls\rcbot_mm.dll
    echo         Run this from the export folder, beside README.txt.
    goto :done
)

REM ---- ask ------------------------------------------------------------------
REM The HALF-LIFE folder, not the mod folder. rcbot lives BESIDE ts\, because
REM metamod resolves plugins.ini paths relative to the mod directory and the line
REM it gets is ..\rcbot\dlls\rcbot_mm.dll .
echo  Where is Half-Life installed?
echo.
echo  This is the folder that CONTAINS ts\ -- not ts\ itself.
echo  For example:  D:\SteamLibrary\steamapps\common\Half-Life
echo.
set "HL="
set /p "HL=Half-Life folder: "

if not defined HL (
    echo.
    echo [ERROR] Nothing entered.
    goto :done
)

REM Strip surrounding quotes, which Explorer's "Copy as path" adds. Same trick
REM export.bat uses on the build stamp.
set "HL=!HL:"=!"
if "!HL:~-1!"=="\" set "HL=!HL:~0,-1!"

echo.

REM ---- check ----------------------------------------------------------------
REM The mod folder instead of the Half-Life folder is the mistake people actually
REM make, and it is the worst one: rcbot would land in ts\rcbot\, metamod would
REM never find it, and nothing would say so.
if exist "!HL!\liblist.gam" (
    echo [ERROR] That is a MOD folder, not the Half-Life folder.
    echo         You gave:  !HL!
    echo         Try:       the folder above it, which contains ts\
    goto :done
)

if not exist "!HL!\ts" (
    echo [ERROR] No ts\ folder inside:
    echo         !HL!
    echo         That is the mod this package is for, so this is the wrong folder.
    goto :done
)

if not exist "!HL!\hl.exe" if not exist "!HL!\hlds.exe" (
    echo [ERROR] Neither hl.exe nor hlds.exe is in:
    echo         !HL!
    echo         That does not look like a Half-Life install.
    goto :done
)

set "MM=!HL!\ts\addons\metamod"
if not exist "!MM!\dlls\metamod.dll" (
    echo [ERROR] Metamod is not installed:
    echo         !MM!\dlls\metamod.dll
    echo         rcbot is a Metamod plugin. Install Metamod and AMX Mod X first.
    goto :done
)

REM Deliberately NOT created if missing. A plugins.ini without the amxmodx_mm.dll
REM line would load rcbot and break AMX Mod X, which is worse than not installing.
if not exist "!MM!\plugins.ini" (
    echo [ERROR] Metamod has no plugins.ini:
    echo         !MM!\plugins.ini
    echo         Metamod is not configured. Sort that first -- writing one here
    echo         would risk leaving AMX Mod X unloaded.
    goto :done
)

echo   target: !HL!
echo   metamod: ok
echo.

REM ---- the files ------------------------------------------------------------
for %%d in (
    "!HL!\rcbot"
    "!HL!\rcbot\dlls"
    "!HL!\rcbot\waypoints"
    "!HL!\rcbot\waypoints\ts"
    "!HL!\rcbot\botprofiles"
    "!HL!\rcbot\manual"
    "!HL!\rcbot\map_configs"
    "!HL!\rcbot\visibility"
) do if not exist "%%~d" mkdir "%%~d" >nul 2>&1

REM Those last four hold nothing here but rcbot writes into them at runtime.

echo --- configs ---
REM Five of these are yours once the server has run: bot_users.ini carries admin
REM names and passwords, and the rest get tuned in place. They are only written
REM when they are not already there.
for %%f in ("%SRC%rcbot\*.ini") do (
    set "KEEP="
    for %%k in (bot_users.ini bot_playerids.ini bot_config.ini bot_folder.ini rcbot_folder.ini) do (
        if /i "%%~nxf"=="%%k" set "KEEP=1"
    )
    if defined KEEP (
        if exist "!HL!\rcbot\%%~nxf" (
            echo   kept your %%~nxf
        ) else (
            copy /y "%%f" "!HL!\rcbot\" >nul && echo   %%~nxf
        )
    ) else (
        copy /y "%%f" "!HL!\rcbot\" >nul && echo   %%~nxf
    )
)

copy /y "%SRC%rcbot\*.rld" "!HL!\rcbot\" >nul 2>&1 && echo   *.rld  ^(TS team loadouts^)
copy /y "%SRC%rcbot\*.txt" "!HL!\rcbot\" >nul 2>&1 && echo   *.txt  ^(rcbot's own docs^)

echo.
echo --- the plugin ---
REM Keep a way back. The .stock beside it is how one copy reverts to unpatched
REM rcbot; an existing one is never overwritten, or that way back is lost.
if exist "!HL!\rcbot\dlls\rcbot_mm.dll" (
    if exist "!HL!\rcbot\dlls\rcbot_mm.dll.stock" (
        echo   rcbot_mm.dll.stock already kept
    ) else (
        copy /y "!HL!\rcbot\dlls\rcbot_mm.dll" "!HL!\rcbot\dlls\rcbot_mm.dll.stock" >nul
        echo   kept the old one as rcbot_mm.dll.stock
    )
)
copy /y "%SRC%rcbot\dlls\rcbot_mm.dll" "!HL!\rcbot\dlls\" >nul
if errorlevel 1 (
    echo [FAIL] could not write rcbot_mm.dll.
    echo        Is the server running and holding the file open?
    goto :done
)
echo   rcbot_mm.dll  ^(PATCHED -- fixes bots attacking their own team^)

if exist "%SRC%rcbot\dlls\rcbot_mm.so" (
    copy /y "%SRC%rcbot\dlls\rcbot_mm.so" "!HL!\rcbot\dlls\" >nul 2>&1
    copy /y "%SRC%rcbot\dlls\READ-ME-rcbot_mm.so.txt" "!HL!\rcbot\dlls\" >nul 2>&1
    echo   rcbot_mm.so   ^(STOCK -- linux only, see the READ-ME beside it^)
)

echo.
echo --- waypoints ---
set "WP=0"
for %%f in ("%SRC%rcbot\waypoints\ts\*.rcw") do (
    copy /y "%%f" "!HL!\rcbot\waypoints\ts\" >nul
    set /a WP+=1
)
echo   waypoints\ts\  ^(!WP! map^(s^)^)

echo.
echo --- metamod ---
REM Appended, never rewritten. A for /f rewrite of plugins.ini needs
REM "usebackq eol= delims=" or the default eol=; silently eats every comment line
REM in the file -- appending cannot do that.
findstr /i /c:"rcbot_mm.dll" "!MM!\plugins.ini" >nul 2>&1
if not errorlevel 1 (
    echo   plugins.ini already names rcbot -- left alone
    findstr /i /c:";" "!MM!\plugins.ini" | findstr /i /c:"rcbot_mm.dll" >nul 2>&1
    if not errorlevel 1 (
        echo   [WARN] the rcbot line looks COMMENTED OUT. Remove the leading ; by
        echo          hand if you want it loaded -- this script will not uncomment it.
    )
) else (
    copy /y "!MM!\plugins.ini" "!MM!\plugins.ini.bak" >nul
    echo   kept plugins.ini.bak
    echo.>>"!MM!\plugins.ini"
    echo ; RCBot -- must be present at server START ^(declares PT_STARTUP^); cannot be meta load'ed>>"!MM!\plugins.ini"
    echo win32   ..\rcbot\dlls\rcbot_mm.dll>>"!MM!\plugins.ini"
    echo   added the rcbot line to plugins.ini
)

set "DID=1"

:done
echo.
if "!DID!"=="1" (
    echo ---------------------------------------------------------------
    echo  Installed.
    echo.
    echo  RESTART THE SERVER FULLY. rcbot declares PT_STARTUP, so it has
    echo  to be there when the server starts -- meta load cannot add it.
    echo.
    echo  To confirm the PATCHED build is the one running, look in the
    echo  server log for:   [RCBOT TS] team check:
    echo  Stock rcbot never prints that, and without the patch bots go
    echo  back to shooting their own team.
    echo.
    echo  Waypoints are required for bots. A map with no .rcw in
    echo  rcbot\waypoints\ts\ will not be navigated -- use
    echo  rcbot autowaypoint 1 and walk it.
    echo ---------------------------------------------------------------
) else (
    echo --- nothing was changed ---
)
echo.
pause
endlocal

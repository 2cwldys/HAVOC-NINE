@echo off
REM ===========================================================================
REM  h9xash.bat -- starts The Specialists (H9TE client) on Xash3D FWGS
REM
REM  Picks a random main-menu track first, the same way ts_launch.bat does for the
REM  Steam install: ts\menu_music.txt is the list, one filename per line matching a
REM  file in ts\sound\music\, # comments and blank lines ignored. The pick goes to
REM  ts\menu_music_resolved.cfg, which ts\userconfig.cfg runs at startup.
REM
REM  The main-menu background video is picked the same way, from ts\menu_bg_videos.txt
REM  (files in ts\media\) into ts\menu_bg_video_resolved.cfg.
REM
REM  Anything given to this script is passed on to the engine, e.g.
REM      h9xash.bat -dev 2 -log
REM      h9xash.bat +map h9_te_neuropolis
REM
REM  Source: TSM\xash3d-h9-patches\overlay\h9xash.bat -- edit it there, not in H9XASH.
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "HERE=%~dp0"

REM ---- Valve's Half-Life files, borrowed from YOUR install on first launch -----
REM H9XASH ships without valve\: it is Valve's, and owning Half-Life is the price of
REM entry. Without it the engine stops at once with "couldn't load gfx.wad".
REM Paths are used through !HERE! inside this block, so a folder name with
REM parentheses in it cannot end the block early.
if not exist "valve\gfx.wad" (
    set "HLVALVE="
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!HERE!find_halflife.ps1"`) do set "HLVALVE=%%P"
    if not defined HLVALVE (
        echo.
        echo  H9XASH needs Half-Life's valve folder, and no Steam Half-Life was found.
        echo  Copy the valve folder from your Half-Life install into
        echo      !HERE!
        echo  so that !HERE!valve\gfx.wad exists, then run this again.
        echo.
        pause
        exit /b 1
    )
    echo [h9xash] first launch: copying Half-Life's valve folder from !HLVALVE!
    echo          ^(once, about 450 MB^)
    robocopy "!HLVALVE!" "!HERE!valve" /E /XF extras.pk3 /NJH /NJS /NDL /NFL /NP >nul
    if errorlevel 8 (
        echo [h9xash] the copy failed -- copy the valve folder by hand, see README_H9XASH.txt
        pause
        exit /b 1
    )
)

REM ---- server lists and the optional Steam broker ----------------------------------
REM networking.ini says which HTTP server lists the Internet tab reads, and whether the
REM Steam broker starts with the game. h9_networking.ps1 writes ts\xashcomm.lst and
REM ts\networking_resolved.cfg from it. If it fails, the game still starts, with the
REM FWGS list only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_networking.ps1"

REM ---- this install's client id -----------------------------------------------------
REM user_id.ini holds a random id H9XASH makes once on first run (h9_userid.ps1) and
REM keeps using after that, unless h9_regenerate_userid.bat is run. Writes
REM ts\userid_resolved.cfg so the engine has it in cl_h9_userid. See
REM docs\CUSTOM_XASH_USERID.txt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_userid.ps1"

set "MUSICLIST=ts\menu_music.txt"
set "RESOLVED=ts\menu_music_resolved.cfg"
set "CHOSEN=equilibrium.mp3"

REM ---- pass 1: count the usable lines (not blank, not a # comment) ----------
set "COUNT=0"
if exist "%MUSICLIST%" (
    for /f "usebackq eol=| delims=" %%L in ("%MUSICLIST%") do (
        set "LINE=%%L"
        if defined LINE if "!LINE:~0,1!" neq "#" set /a COUNT+=1
    )
)

REM ---- pick an index up front, then walk the file again to find that line ---
if %COUNT% GTR 0 (
    REM Two plain statements on purpose: a parenthesized "(%RANDOM% %% COUNT) + 1"
    REM inside this if-block makes cmd close the block at the first ")" it sees.
    set /a "PICK=%RANDOM% %% COUNT"
    set /a "PICK+=1"
    set "SEEN=0"
    for /f "usebackq eol=| delims=" %%L in ("%MUSICLIST%") do (
        set "LINE=%%L"
        if defined LINE if "!LINE:~0,1!" neq "#" (
            set /a SEEN+=1
            if !SEEN! equ !PICK! set "CHOSEN=!LINE!"
        )
    )
)

REM Xash has no "mp3 on"; "mp3 loop" alone starts the track. The volume is the
REM player's own MP3Volume (ts\userconfig.cfg sets it), so nothing here sets it.
(
    echo mp3 loop sound/music/!CHOSEN!
) > "%RESOLVED%"

echo [h9xash] main menu music: !CHOSEN!

REM ---- same idea, for the main-menu background video -------------------------------
set "BGLIST=ts\menu_bg_videos.txt"
set "BGRESOLVED=ts\menu_bg_video_resolved.cfg"
set "BGCHOSEN=mainmenu_bg.avi"

set "BGCOUNT=0"
if exist "%BGLIST%" (
    for /f "usebackq eol=| delims=" %%L in ("%BGLIST%") do (
        set "LINE=%%L"
        if defined LINE if "!LINE:~0,1!" neq "#" set /a BGCOUNT+=1
    )
)

if %BGCOUNT% GTR 0 (
    set /a "BGPICK=%RANDOM% %% BGCOUNT"
    set /a "BGPICK+=1"
    set "BGSEEN=0"
    for /f "usebackq eol=| delims=" %%L in ("%BGLIST%") do (
        set "LINE=%%L"
        if defined LINE if "!LINE:~0,1!" neq "#" (
            set /a BGSEEN+=1
            if !BGSEEN! equ !BGPICK! set "BGCHOSEN=!LINE!"
        )
    )
)

(
    echo ui_background_video_file "!BGCHOSEN!"
) > "%BGRESOLVED%"

echo [h9xash] main menu video: !BGCHOSEN!

REM By full path: a shell with NoDefaultCurrentDirectoryInExePath set will not run a
REM program from the current folder by its bare name. cmd waits for HAVOC 9.exe to exit
REM before the next line runs.
"%~dp0HAVOC 9.exe" -game ts -console %*
set "GAMEEXIT=!ERRORLEVEL!"

REM ---- stop the Steam broker this launch started, and no other ----------------------
REM The pid file exists only when h9_networking.ps1 started a broker. Its image name is
REM checked before anything is stopped, in case the pid has been reused. The pid file is
REM removed only once the broker is gone, so a broker that will not stop is never left
REM running with no record of it. System tools are named by full path: a PATH that puts
REM some other find.exe first would otherwise change what these lines do.
if exist "%~dp0steam\steam_broker.pid" (
    set "BROKERPID="
    set /p BROKERPID=<"%~dp0steam\steam_broker.pid"
    if defined BROKERPID (
        "%SystemRoot%\System32\tasklist.exe" /fi "PID eq !BROKERPID!" /fi "IMAGENAME eq steam_broker.exe" /nh 2>nul | "%SystemRoot%\System32\find.exe" /i "steam_broker" >nul && "%SystemRoot%\System32\taskkill.exe" /pid !BROKERPID! /t /f >nul 2>&1
        "%SystemRoot%\System32\tasklist.exe" /fi "PID eq !BROKERPID!" /fi "IMAGENAME eq steam_broker.exe" /nh 2>nul | "%SystemRoot%\System32\find.exe" /i "steam_broker" >nul && (
            echo [h9xash] the Steam broker, pid !BROKERPID!, did not stop. End steam_broker.exe in Task Manager.
        ) || del /q "%~dp0steam\steam_broker.pid" >nul 2>&1
    ) else (
        del /q "%~dp0steam\steam_broker.pid" >nul 2>&1
    )
)
exit /b !GAMEEXIT!

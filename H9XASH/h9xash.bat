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

REM ---- a new install's settings ------------------------------------------------------
REM With no ts\config.cfg yet, the game starts from TS's stock binds and settings in
REM ts\config.stock.cfg. A config.cfg that exists is the player's own (it holds their id)
REM and is never replaced.
if not exist "ts\config.cfg" if exist "ts\config.stock.cfg" copy /y "ts\config.stock.cfg" "ts\config.cfg" >nul

REM ---- server lists and the optional Steam broker ----------------------------------
REM networking.ini says which HTTP server lists the Internet tab reads, and whether the
REM Steam broker starts with the game. h9_networking.ps1 writes ts\xashcomm.lst and
REM ts\networking_resolved.cfg from it. If it fails, the game still starts, with the
REM FWGS list only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_networking.ps1"

REM ---- this install's client id -----------------------------------------------------
REM user_id.ini holds this install's id, which the engine makes on its first start, keeps
REM protected for this Windows user and reads itself (Link your Account in the main menu
REM links it to a havoc9.org account). h9_userid.ps1 only takes the id out of the plain
REM text files older builds kept it in: ts\userid_resolved.cfg and ts\config.cfg. See
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

REM ---- the port Create Game takes ------------------------------------------------------
REM port= under [server] in networking.ini (27015 when it is missing or not a port), passed
REM as -port, the engine's own switch for the port a server here binds. A -port or +port
REM given to this script wins: then none is added.
set "H9PORT=27015"
if exist "networking.ini" for /f "usebackq eol=; tokens=1,2 delims== " %%a in ("networking.ini") do if /i "%%a"=="port" set "H9PORT=%%b"
if not defined H9PORT set "H9PORT=27015"
set "H9PORTN="
set /a "H9PORTN=H9PORT" 2>nul
if not "!H9PORTN!"=="!H9PORT!" set "H9PORT=27015"
if !H9PORT! lss 1 set "H9PORT=27015"
if !H9PORT! gtr 65535 set "H9PORT=27015"
set "H9PORTARG=-port !H9PORT!"
(echo(%*) | findstr /i /c:"-port" /c:"+port" >nul && set "H9PORTARG="

REM ---- the process priority ----------------------------------------------------------
REM priority= under [process] in networking.ini: Normal, AboveNormal or High, and AboveNormal
REM when it is missing or none of these. While the PC is busy, Windows gives the CPU to
REM HAVOC 9.exe before programs of a lower priority; on an idle PC nothing changes. Realtime runs
REM as High: a busy game at Realtime holds back Windows' own input, disk and network work. No core
REM is pinned: Windows runs the game on any of the PC's cores.
set "H9PRIO="
if exist "networking.ini" for /f "usebackq eol=; tokens=1,2 delims== " %%a in ("networking.ini") do if /i "%%a"=="priority" set "H9PRIO=%%~b"
set "H9PRIOSW=/ABOVENORMAL"
if /i "!H9PRIO!"=="Normal" set "H9PRIOSW=/NORMAL"
if /i "!H9PRIO!"=="High" set "H9PRIOSW=/HIGH"
if /i "!H9PRIO!"=="Realtime" set "H9PRIOSW=/HIGH"
if /i "!H9PRIO!"=="Realtime" echo [h9xash] priority=Realtime in networking.ini runs as High.
if defined H9PRIO if /i not "!H9PRIO!"=="Normal" if /i not "!H9PRIO!"=="AboveNormal" if /i not "!H9PRIO!"=="High" if /i not "!H9PRIO!"=="Realtime" echo [h9xash] priority= in networking.ini is not Normal, AboveNormal or High: AboveNormal is used.

REM By full path: a shell with NoDefaultCurrentDirectoryInExePath set will not run a
REM program from the current folder by its bare name. start /b /wait runs it at the priority
REM above and waits for it to exit before the next line runs, its exit code in ERRORLEVEL.
start "" /b /wait !H9PRIOSW! "%~dp0HAVOC 9.exe" -game ts -console !H9PORTARG! %*
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

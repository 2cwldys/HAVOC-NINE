@echo off
REM ===========================================================================
REM  h9xash.bat -- starts The Specialists (H9TE client) on Xash3D FWGS
REM
REM  Picks a random main-menu track first, the same way ts_launch.bat does for the
REM  Steam install: ts\menu_music.txt is the list, one filename per line matching a
REM  file in ts\sound\music\, # comments and blank lines ignored. The pick goes to
REM  ts\menu_music_resolved.cfg, which ts\userconfig.cfg runs at startup.
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

REM By full path: a shell with NoDefaultCurrentDirectoryInExePath set will not run a
REM program from the current folder by its bare name.
"%~dp0xash3d.exe" -game ts -console %*

@echo off
REM ===========================================================================
REM  ts_launch.bat -- picks a random main-menu track, then starts the real game
REM
REM  WHY THIS EXISTS. The main menu is drawn before any map or server exists, so
REM  nothing server-side (ts_matchmode.sma) can reach it. A client.dll patch was
REM  tried and worked as code, but config.cfg turned out to do the same job for
REM  free -- GoldSrc already execs userconfig.cfg at startup, through the normal
REM  command pipeline, no console or patched binary needed. The one thing a cfg
REM  file cannot do on its own is pick something DIFFERENT each launch: cfg/alias
REM  scripting can only read and execute files, never write one back to disk for
REM  next time. So that one step happens here instead, in a real script with real
REM  file access, run once per launch, before the engine itself starts.
REM
REM  SET THIS AS STEAM'S LAUNCH OPTIONS for Half-Life (right-click the game in
REM  your Steam library -> Properties -> General -> Launch Options) so Steam
REM  runs this FIRST, with %command% standing in for the real launch Steam would
REM  otherwise have run directly:
REM
REM      "ts_launch.bat" %command%
REM
REM  (Steam already runs launch options from the game's own install folder, so
REM  the plain filename above is enough -- no drive letter or full path needed.)
REM
REM  ts\menu_music.txt is the track list this reads: one filename per line,
REM  matching a file in sound\music\, # comments and blank lines ignored. If it
REM  lists more than one track, one is chosen at random on every launch. Edit
REM  that file to change what can play -- this script never needs to change.
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

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
REM Two passes instead of a batch "array" (TRACK1, TRACK2, ...) read back by a
REM computed name -- that needs the "call set" double-expansion trick, which is
REM easy to get subtly wrong with nothing to catch it. A second plain pass over
REM a file this small costs nothing and has no indirection to get wrong.
if %COUNT% GTR 0 (
    REM Split into two plain statements on purpose: a parenthesized grouping
    REM here, e.g. "(%RANDOM% %% COUNT) + 1", confuses cmd's OUTER parser for
    REM this already-parenthesized if-block -- it naively pairs the first ")"
    REM it sees as closing the if-block itself, leaving the trailing "+ 1"
    REM dangling outside it, which cmd then rejects as a syntax error.
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

(
    echo MP3Volume "0.2"
    echo mp3 on
    echo mp3 loop sound/music/!CHOSEN!
) > "%RESOLVED%"

echo [ts_launch] main menu music: !CHOSEN!

%*

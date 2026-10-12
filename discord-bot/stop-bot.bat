@echo off
REM ---------------------------------------------------------------------------
REM  stop-bot.bat -- stops the Discord bot
REM
REM  Run it on its own to stop a bot you started by hand. ts.bat also calls it when
REM  the game server exits, with "quiet" so it says nothing when there was nothing
REM  running.
REM
REM  It stops the process whose pid is in bot.pid, which the bot writes on startup
REM  and removes on a clean exit. Killing by name would take every python on the
REM  machine with it, which on this one would include an unrelated bot.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "QUIET="
if /i "%~1"=="quiet" set "QUIET=1"

if not exist "bot.pid" (
    if not defined QUIET echo [stop] No bot.pid -- the bot does not appear to be running.
    goto :done
)

set /p BOTPID=<"bot.pid"
if not defined BOTPID (
    if not defined QUIET echo [stop] bot.pid is empty.
    del /q "bot.pid" >nul 2>&1
    goto :done
)

REM Check it is actually there before claiming to have stopped anything: a pid file
REM left behind by a crash names a process that is long gone, and on a machine that
REM has been up a while that number has been handed to something else.
tasklist /fi "PID eq %BOTPID%" 2>nul | find "%BOTPID%" >nul
if errorlevel 1 (
    if not defined QUIET echo [stop] bot.pid says %BOTPID%, but nothing is running under it. Clearing it.
    del /q "bot.pid" >nul 2>&1
    goto :done
)

taskkill /PID %BOTPID% /T /F >nul 2>&1
if errorlevel 1 (
    echo [stop] could not stop pid %BOTPID%.
) else (
    if not defined QUIET echo [stop] Discord bot stopped ^(pid %BOTPID%^).
)
del /q "bot.pid" >nul 2>&1

:done
if not defined QUIET (
    echo.
    pause
)
endlocal

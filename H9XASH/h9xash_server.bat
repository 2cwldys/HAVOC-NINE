@echo off
REM ---------------------------------------------------------------------------
REM  h9xash_server.bat -- starts the Discord bot, runs HAVOC 9.exe as a dedicated
REM  server (-dedicated, the engine's own headless mode -- no window opens), stops
REM  the bot again.
REM
REM  Run this from the H9XASH folder.
REM
REM  The bot is started HERE and not by the plugin, because a plugin cannot start a
REM  program: AMXX has no native for it. The launcher gets the same result anyway --
REM  the bot comes up with the server and goes down with it.
REM
REM  .advertise does NOT need the bot running. The plugin posts to Discord itself,
REM  because a bot token is a credential rather than a connection. The bot adds the
REM  inbound half: showing online, the slash commands, and the RSVP buttons.
REM
REM  First time only:  discord-bot\install.bat
REM ---------------------------------------------------------------------------
setlocal

REM Run from this script's own folder, so it works however it was launched.
cd /d "%~dp0"

REM BOTOURS records whether THIS run started the bot. Only a bot we started is a bot we
REM stop on the way out -- see the end of the file.
set "BOTOURS="

if not exist "discord-bot\ts_bot.py" (
    echo [ts] No discord-bot\ts_bot.py -- starting the server without it.
    goto :run
)

REM ---- is one already up? ----------------------------------------------------------
REM bot.pid is no longer deleted on the way in, because it is now the only way to tell.
REM Restarting the server should not cost you the bot, and a second copy is worse than
REM none: both instances connect to Discord as the same application, the gateway hands
REM every event to each of them, and so every slash command answers twice and every RSVP
REM button is counted twice.
REM
REM The pid file on its own is not enough to go on. A bot that was killed leaves one
REM behind naming a process that is long gone, and on a machine that has been up a while
REM that number has since been handed to something else -- so the process is checked for,
REM and checked to be a python, before this concludes anything is running.
if not exist "discord-bot\bot.pid" goto :startbot

set /p BOTPID=<"discord-bot\bot.pid"
if not defined BOTPID goto :stalepid

set "BOTIMG="
for /f "tokens=1" %%i in ('tasklist /fi "PID eq %BOTPID%" /nh 2^>nul') do set "BOTIMG=%%i"
if not defined BOTIMG goto :stalepid

REM Matched on "python" rather than on python.exe exactly, so a bot running under
REM pythonw.exe or py.exe is recognised rather than mistaken for a stale pid and quietly
REM duplicated -- which is the single outcome this whole section exists to prevent.
echo %BOTIMG% | find /i "python" >nul
if errorlevel 1 goto :stalepid

echo [ts] Discord bot already running ^(pid %BOTPID%, %BOTIMG%^) -- leaving it alone.
echo [ts] It will still be running after the server exits.
goto :run

:stalepid
echo [ts] discord-bot\bot.pid names nothing that is running -- clearing it.
del /q "discord-bot\bot.pid" >nul 2>&1

:startbot
REM Plain "start" with plain redirection. No PowerShell and no line continuations:
REM the bot writes its own pid to discord-bot\bot.pid, which is simpler than any way
REM a batch file has of finding out, and cannot misparse.
REM
REM Its output goes to bot.log because a minimized window nobody is watching looks
REM exactly like a bot that started fine, whether or not it died on the first line.
start "TS Discord bot" /min cmd /c "python discord-bot\ts_bot.py > discord-bot\bot.log 2>&1"

REM ping rather than timeout: timeout refuses to run when stdin is redirected, which
REM it is whenever this is launched from anything but a plain console window.
ping -n 4 127.0.0.1 >nul 2>&1

if not exist "discord-bot\bot.pid" goto :botfailed
set /p BOTPID=<"discord-bot\bot.pid"
set "BOTOURS=1"
echo [ts] Discord bot started ^(pid %BOTPID%, log: discord-bot\bot.log^)
goto :run

:botfailed
echo [ts] WARNING: the Discord bot is not running. Reason:
if exist "discord-bot\bot.log" type "discord-bot\bot.log"
echo [ts]          The server will start anyway, and adverts will still post.

:run
echo.

REM ---- the port --------------------------------------------------------------------
REM port= under [server] in networking.ini (27015 when it is missing or not a port). A -port
REM or +port given to this script wins: its value is the port, and none is added. Anything
REM given to this script goes on to the engine after its own arguments.
set "H9PORT=27015"
if exist "networking.ini" for /f "usebackq eol=; tokens=1,2 delims== " %%a in ("networking.ini") do if /i "%%a"=="port" set "H9PORT=%%b"
set "H9PORTARG=-port"
set "H9NEXT="
for %%x in (%*) do call :portarg "%%~x"
if not defined H9PORT set "H9PORT=27015"
set "H9PORTN="
set /a "H9PORTN=H9PORT" 2>nul
if not "%H9PORTN%"=="%H9PORT%" set "H9PORT=27015"
if %H9PORT% lss 1 set "H9PORT=27015"
if %H9PORT% gtr 65535 set "H9PORT=27015"
if defined H9PORTARG set "H9PORTARG=-port %H9PORT%"

REM ---- the process priority ----------------------------------------------------------
REM priority= under [process] in networking.ini: Normal, AboveNormal or High, and AboveNormal
REM when it is missing or none of these. While the PC is busy, Windows gives the CPU to
REM HAVOC 9.exe before programs of a lower priority; on an idle PC nothing changes. Realtime runs
REM as High: a busy game at Realtime holds back Windows' own input, disk and network work. No core
REM is pinned: Windows runs the game on any of the PC's cores.
set "H9PRIO="
if exist "networking.ini" for /f "usebackq eol=; tokens=1,2 delims== " %%a in ("networking.ini") do if /i "%%a"=="priority" set "H9PRIO=%%~b"
set "H9PRIOSW=/ABOVENORMAL"
if /i "%H9PRIO%"=="Normal" set "H9PRIOSW=/NORMAL"
if /i "%H9PRIO%"=="High" set "H9PRIOSW=/HIGH"
if /i "%H9PRIO%"=="Realtime" set "H9PRIOSW=/HIGH"
if /i "%H9PRIO%"=="Realtime" echo [ts] priority=Realtime in networking.ini runs as High.
if defined H9PRIO if /i not "%H9PRIO%"=="Normal" if /i not "%H9PRIO%"=="AboveNormal" if /i not "%H9PRIO%"=="High" if /i not "%H9PRIO%"=="Realtime" echo [ts] priority= in networking.ini is not Normal, AboveNormal or High: AboveNormal is used.

REM ---- the H9 server list ------------------------------------------------------------
REM h9_heartbeat.ps1 runs beside the server: every two minutes while HAVOC 9.exe -dedicated
REM on that port runs, it tells the H9 server list (heartbeat_url in networking.ini,
REM https://havoc9.org/serverlist) that this server is up, so it shows in every player's
REM Internet tab. heartbeat=0 under [server] in networking.ini turns it off (a LAN or
REM private server). It stops by itself when the server does.
start "" /b powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0h9_heartbeat.ps1" -Port %H9PORT%

REM -log makes the engine mirror its console to engine.log (default name; see
REM Sys_CheckParm("-log") in xash3d-fwgs\engine\common\sys_con.c). Without it a crash
REM leaves NOTHING behind: the AMXX log records the map change and stops there, and a
REM hard crash writes no minidump either, so there is no evidence of what happened.
REM It is cleared first so whatever is in it belongs to this run and no other.
if exist engine.log del /q engine.log

REM By full path, same reason h9xash.bat uses one: a shell with
REM NoDefaultCurrentDirectoryInExePath set will not run a program from the current
REM folder by its bare name. -dedicated is the engine's own flag (see -help), not a
REM separate binary -- host.c switches it into headless mode at startup, same as
REM HLDS does from the one GoldSrc engine. start /b /wait runs it in this window at the
REM priority above and waits for it to exit, its exit code in ERRORLEVEL.
start "" /b /wait %H9PRIOSW% "%~dp0HAVOC 9.exe" -dedicated -game ts -console -log -num_edicts 4096 %H9PORTARG% +ip 0.0.0.0 +mp_teamplay 1 +sv_lan 0 +maxplayers 64 +map h9_te_neuropolis +hostname "HAVOC 9 TEAM ELIMINATION" %*
set "SRVEXIT=%ERRORLEVEL%"

REM hlds has exited -- by quit, by crash, or by this window being closed. Take the bot
REM with it, but ONLY if this run is what started it. A bot that was already up when the
REM server launched belongs to whoever started it, and stopping it here would make every
REM server restart cost you the bot -- which is the thing being avoided.
if not defined BOTOURS goto :keptbot
if exist "discord-bot\stop-bot.bat" call "discord-bot\stop-bot.bat" quiet
goto :afterbot

:keptbot
echo [ts] Leaving the Discord bot running -- it was already up before this run.

:afterbot

echo.
echo ===============================================================
echo  HAVOC 9.exe exited with code %SRVEXIT%
echo ===============================================================

REM The tail of the console is where the engine says what killed it. A Host_Error
REM names itself; a silent stop with no FATAL line is an access violation, and the
REM last lines still say what it was doing at the time.
if not exist engine.log goto :nolog
echo.
echo ---- last 40 lines of engine.log ----
powershell -NoProfile -Command "Get-Content engine.log -Tail 40"
echo ---- end ----
echo.
echo ---- lines that look fatal ----
powershell -NoProfile -Command "Select-String -Path engine.log -Pattern 'FATAL|Host_Error|Sys_Error|Mod_NumForName|not precached|SZ_GetSpace|overflow|Bad model' | Select-Object -Last 15 | ForEach-Object { $_.Line }"
echo ---- end ----
echo.
echo  The whole console is in engine.log beside HAVOC 9.exe.
goto :held

:nolog
echo  No engine.log was written, so it died before the engine opened one.

:held
echo.
echo  This window is staying open on purpose so the above can be read.
pause

endlocal

goto :eof

REM a -port or +port among this script's arguments: the next one is the port, and the
REM engine gets it from there
:portarg
if defined H9NEXT (
    set "H9PORT=%~1"
    set "H9NEXT="
    set "H9PORTARG="
)
if /i "%~1"=="-port" set "H9NEXT=1"
if /i "%~1"=="+port" set "H9NEXT=1"
goto :eof

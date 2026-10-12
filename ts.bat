@echo off
REM ---------------------------------------------------------------------------
REM  ts.bat -- starts the Discord bot, runs the game server, stops the bot again
REM
REM  Run this from the Half-Life folder, the one with the dedicated server in it.
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

if not exist "discord-bot\ts_bot.py" (
    echo [ts] No discord-bot\ts_bot.py -- starting the server without it.
    goto :run
)

if exist "discord-bot\bot.pid" del /q "discord-bot\bot.pid" >nul 2>&1

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

if exist "discord-bot\bot.pid" (
    set /p BOTPID=<"discord-bot\bot.pid"
    echo [ts] Discord bot started   ^(log: discord-bot\bot.log^)
) else (
    echo [ts] WARNING: the Discord bot is not running. Reason:
    if exist "discord-bot\bot.log" type "discord-bot\bot.log"
    echo [ts]          The server will start anyway, and adverts will still post.
)

:run
echo.
hlds.exe -console -port 27015 -game ts +ip 0.0.0.0 +mp_teamplay 1 +sv_lan 0 +maxplayers 32 +map h9_te_neuropolis +hostname "HAVOC 9 TEAM ELIMINATION"

REM hlds has exited -- by quit, by crash, or by this window being closed. Take the
REM bot with it.
if exist "discord-bot\stop-bot.bat" call "discord-bot\stop-bot.bat" quiet

endlocal

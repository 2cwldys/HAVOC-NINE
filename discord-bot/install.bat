@echo off
REM ---------------------------------------------------------------------------
REM  install.bat -- the Discord bot's python dependencies
REM
REM  Run this once, from this folder, before the first ts.bat.
REM
REM  It installs discord.py (the gateway connection, which is what makes the bot
REM  show online and lets Discord push slash commands and button clicks to it) and
REM  python-a2s (which queries the game server directly over UDP for /who).
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] python is not on PATH.
    echo         Install Python 3.9 or newer and tick "Add python.exe to PATH".
    goto :done
)

for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo Using %%v
echo.

REM -m pip rather than a bare "pip": on a machine with more than one python, bare
REM pip installs into whichever one happens to be first on PATH, and the bot then
REM fails with "No module named a2s" while pip insists it is installed.
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] install failed. If it is a permissions error, try:
    echo         python -m pip install --user -r requirements.txt
    goto :done
)

echo.
echo --- checking ---
python -c "import discord, a2s; print('  discord.py', discord.__version__); print('  python-a2s ok')"
if errorlevel 1 (
    echo [ERROR] the packages installed but will not import.
    goto :done
)

echo.
echo Dependencies are in place.
echo.
echo Next: put the bot token and channel id in
echo       ..\ts\addons\amxmodx\configs\ts_advertise.cfg
echo then run ts.bat from the Half-Life folder.

:done
echo.
pause
endlocal

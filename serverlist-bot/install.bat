@echo off
REM ---------------------------------------------------------------------------
REM  install.bat -- the H9 server list's python dependencies, and its settings file
REM
REM  Run this once, from this folder, before the first run.bat. It copies
REM  serverlist.cfg.example to serverlist.cfg when there is none yet. That file holds the
REM  heartbeat key, so fill it in before the list takes servers from heartbeats.
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

REM -m pip rather than a bare "pip", the same as discord-bot\install.bat: a bare pip can
REM install into a different python from the one that runs the list.
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] install failed. If it is a permissions error, try:
    echo         python -m pip install --user -r requirements.txt
    goto :done
)

if not exist serverlist.cfg (
    copy /y serverlist.cfg.example serverlist.cfg >nul
    echo Created serverlist.cfg from serverlist.cfg.example.
)

echo.
echo Dependencies are in place.
echo.
echo Next: set heartbeat_key in serverlist.cfg, then run run.bat.

:done
echo.
pause
endlocal

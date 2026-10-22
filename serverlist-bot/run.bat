@echo off
REM ---------------------------------------------------------------------------
REM  run.bat -- start the H9 server list. Stop it with Ctrl+C, or close this window.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
python h9_serverlist.py
echo.
pause
endlocal

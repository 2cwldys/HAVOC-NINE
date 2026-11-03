@echo off
REM ---------------------------------------------------------------------------
REM  h9_regenerate_userid.bat -- throw away this install's client id, make a new one
REM
REM  Run from this folder (H9XASH\). It deletes user_id.ini; the game makes a new
REM  random id at its next start, not linked to any account (a game running with its
REM  main menu up makes it at once). See docs\CUSTOM_XASH_USERID.txt.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_userid.ps1" -Force

echo.
pause
endlocal

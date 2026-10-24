@echo off
REM ---------------------------------------------------------------------------
REM  h9_regenerate_userid.bat -- throw away this install's client id, make a new one
REM
REM  Run from this folder (H9XASH\). Takes effect on your next launch, not this one --
REM  see docs\CUSTOM_XASH_USERID.txt.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_userid.ps1" -Force

echo.
pause
endlocal

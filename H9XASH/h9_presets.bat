@echo off
REM ---------------------------------------------------------------------------
REM  h9_presets.bat -- swap AMX Mod X config presets, or toggle plugins directly
REM
REM  Run from this folder (H9XASH\). See presets\README.txt for how to add your
REM  own presets. Everything this changes gets backed up first into
REM  presets\backup\ -- see h9_presets.ps1 for exactly what and when.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_presets.ps1"

echo.
pause
endlocal

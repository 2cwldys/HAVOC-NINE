@echo off
setlocal
cd /d "%~dp0"

set "ORIGINAL=D:\Downloads\TSM\backups\valve_TSM_20261030-230114\gfx.wad"

echo === build ===
node tools\build.mjs
if errorlevel 1 goto :fail

echo.
echo === validate ===
node tools\validate.mjs "%ORIGINAL%" "dist\gfx.wad" "dist\VALIDATION.txt"
if errorlevel 1 goto :fail

echo.
echo Done. dist\gfx.wad is ready.
echo Run "node tools\install.mjs" to copy it into H9XASH\valve.
exit /b 0

:fail
echo.
echo BUILD FAILED
exit /b 1

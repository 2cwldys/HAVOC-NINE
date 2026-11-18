@echo off
REM h9_hdtextures.cmd -- get the HD texture pack, or bring it up to date.
REM
REM The game works without it. This downloads the AI-upscaled textures, which the engine uses
REM instead of the originals; the originals are never changed and turning the pack off goes
REM straight back to them. Your havoc9.org account page gives you the code it asks for.
REM
REM Arguments are passed through, so h9_hdtextures.cmd -DryRun works too.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_hdtextures.ps1" %*
if errorlevel 2 (
	echo.
	echo   Nothing was downloaded. See the message above.
)
pause

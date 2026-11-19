@echo off
REM h9_hdtextures.cmd -- get the HD texture pack, or bring it up to date.
REM
REM The game works without it. This downloads the AI-upscaled textures, which the engine uses
REM instead of the originals; the originals are never changed and turning the pack off goes
REM straight back to them.
REM
REM The work is H9XASH-Updater's: it keeps the pack as its own store with its own manifest and
REM installs it into ts\materials, it links to a havoc9.org account the way the site's own button
REM does (it opens your browser, shows a short code to approve and waits), and it downloads only
REM what changed, so a file that did not change is never fetched twice. This file is here so that
REM "HD textures" is a thing you can double-click.
REM
REM   h9_hdtextures.cmd                 install the pack, or bring it up to date
REM   h9_hdtextures.cmd --hd-remove     take it off again (the game keeps working)
REM   h9_hdtextures.cmd --check         say what would change, change nothing
REM   h9_hdtextures.cmd --status        what is installed, and the account link
REM
REM Anything after the command name is passed through, so every H9XASH-Updater option works here
REM (--help lists them all).

setlocal
set "UPD=%~dp0H9XASH-Updater.exe"
if not exist "%UPD%" set "UPD=%~dp0..\H9XASH-Updater.exe"

if not exist "%UPD%" (
	echo.
	echo   H9XASH-Updater.exe is not beside this file.
	echo   It ships inside the H9XASH download; get it from https://havoc9.org/downloads/
	echo   and put it in this folder, then run this again.
	echo.
	pause
	exit /b 2
)

"%UPD%" --hd --dir "%~dp0." %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
	echo.
	echo   Nothing was installed. See the message above.
)
exit /b %RC%

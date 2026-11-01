@echo off
REM stage-h9xash.cmd -- packs H9XASH into a clean client ZIP in dist\ (see stage-h9xash.ps1).
REM   stage-h9xash.cmd              make the ZIP
REM   stage-h9xash.cmd -DryRun      stage and scrub only, keep the staged folder, no ZIP
REM   stage-h9xash.cmd -KeepStage   make the ZIP and keep the staged folder to test-play it
REM Run with no arguments (a double-click), it waits for a key at the end.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stage-h9xash.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

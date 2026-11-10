@echo off
REM stage-h9xash.cmd -- packs H9XASH into clean ZIPs in dist\, one per platform (see stage-h9xash.ps1).
REM   stage-h9xash.cmd              H9XASH.zip (Windows files) and H9XASH-linux.zip (Linux files); a native
REM                                 build with only xashds also gives H9XASH-linux-server.zip
REM   stage-h9xash.cmd -DryRun      stage and scrub only, keep the staged folder, no ZIP
REM   stage-h9xash.cmd -KeepStage   make the ZIPs and keep the staged folder to test-play it
REM   stage-h9xash.cmd -NoLinux     the Windows ZIP only
REM Run with no arguments (a double-click), it waits for a key at the end.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stage-h9xash.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

@echo off
REM make-vps-package.cmd -- packs havoc9.org for a host into dist\ (see make-vps-package.ps1).
REM   make-vps-package.cmd                   dist\havoc9-vps-<target>-<build>-<yyyyMMdd-HHmm>.zip for linux and windows
REM   make-vps-package.cmd -Target linux     one of them (-Target windows for the other)
REM   make-vps-package.cmd -WebClient        and the web client's files in a third ZIP (1.2 GB)
REM   make-vps-package.cmd -KeepStage        keep the staged folders to look through them
REM Linux: unzip, cd into the folder, sudo bash setup.sh (vps\linux\README-VPS.txt).
REM Windows: Extract All, right-click setup.cmd, Run as administrator (vps\windows\README-WINDOWS.txt).
REM Run with no arguments (a double-click), it waits for a key at the end.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-vps-package.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

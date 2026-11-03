@echo off
REM build.cmd -- builds dist\H9XASH-Updater.exe from this folder's sources (README_UPDATER.txt).
REM Options go on to build.ps1, e.g.   build.cmd -WorkDir D:\temp\updater-work
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
exit /b %ERRORLEVEL%

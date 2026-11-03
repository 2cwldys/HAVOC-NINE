@echo off
REM setup.cmd -- runs setup.ps1 (havoc9.org on this Windows machine) in an administrator
REM PowerShell. Arguments go to setup.ps1, for example: setup.cmd -WhatIf   or   setup.cmd -Check
REM README-WINDOWS.txt is the guide. Double-clicked, it waits for a key at the end.
setlocal
net session >nul 2>&1 || (echo   [FAIL] start it as administrator: right-click, Run as administrator& if "%~1"=="" pause& exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

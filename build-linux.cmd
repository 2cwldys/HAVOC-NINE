@echo off
REM build-linux.cmd -- builds H9's Linux i386 server in WSL2 into H9XASH-linux\ (see build-linux.ps1 and linux\build-linux.sh).
REM   build-linux.cmd -Setup -WithAmbuild   install the build tools in the h9build distro (once)
REM   build-linux.cmd                       every step: reTS, Metamod-R, the dedicated engine, AMX Mod X, RCBot, the layout
REM   build-linux.cmd -Skip amxx            leave a step out
REM   build-linux.cmd -Steps rcbot,assemble only these steps
REM   build-linux.cmd -Stage                and pack dist\H9XASH.zip and dist\H9XASH-linux*.zip afterwards
REM Run with no arguments (a double-click), it waits for a key at the end.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-linux.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

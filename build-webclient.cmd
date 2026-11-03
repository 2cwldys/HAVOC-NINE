@echo off
REM build-webclient.cmd -- builds the web client from this checkout (see build-webclient.ps1).
REM   build-webclient.cmd                  toolchain, engine, client library, then webclient-build\webclient-bin and stage
REM   build-webclient.cmd -NoStage         the builds only, no stage
REM   build-webclient.cmd -UpdateTracked   also copy the builds over webclient-bin, the folder git tracks
REM   build-webclient.cmd -Out D:\wcb      somewhere other than webclient-build\
REM Run with no arguments (a double-click), it waits for a key at the end.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-webclient.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

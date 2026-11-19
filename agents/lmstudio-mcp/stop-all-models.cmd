@echo off
setlocal enabledelayedexpansion

:: Re-launch inside cmd /k so the window always stays open
if not defined _PERSIST (
    set _PERSIST=1
    cmd /k "%~f0" %*
    exit /b
)

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YLW=%ESC%[93m"
set "CYN=%ESC%[96m"
set "WHT=%ESC%[97m"
set "RST=%ESC%[0m"

echo.
echo %CYN% =================================================%RST%
echo %CYN%   LM Studio  ^>^>  Unload All Models%RST%
echo %CYN% =================================================%RST%
echo %CYN%   Frees VRAM without stopping the server%RST%
echo %CYN% =================================================%RST%
echo.

where lms >nul 2>&1
if errorlevel 1 (
    echo %RED% [ERROR]%RST% lms CLI not found.
    echo         Run install.cmd first.
    echo.
    cmd /k
    exit /b 1
)

echo %WHT% Unloading all models...%RST%
echo.
lms unload --all
if errorlevel 1 (
    echo.
    echo %YLW%  !!%RST%     lms unload --all returned an error.
    echo         Models may already be unloaded, or no model was loaded.
) else (
    echo.
    echo %GRN%  OK%RST%     All models unloaded.
)

echo.
echo %CYN% =================================================%RST%
echo %WHT%  Server is still running on http://localhost:1234%RST%
echo %WHT%  To load a model again:  start-server.cmd%RST%
echo %WHT%  To stop the server:     stop-server.cmd%RST%
echo %CYN% =================================================%RST%
echo.
cmd /k

@echo off
setlocal enabledelayedexpansion

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YLW=%ESC%[93m"
set "CYN=%ESC%[96m"
set "WHT=%ESC%[97m"
set "RST=%ESC%[0m"

echo.
echo %CYN% =================================================%RST%
echo %CYN%   LM Studio  ^>^>  Remove Startup Task%RST%
echo %CYN% =================================================%RST%
echo.

schtasks /query /tn "LMStudio API Server" >nul 2>&1
if errorlevel 1 (
    echo %YLW% [NOTE]%RST%  No startup task named "LMStudio API Server" was found.
    echo         Nothing to remove -- you're already clean.
    echo.
    cmd /k
    exit /b 0
)

echo %YLW%  LM Studio will no longer start automatically on login.%RST%
echo.
set "CONFIRM="
set /p "CONFIRM= Are you sure? (Y/N): "
if /i not "!CONFIRM!"=="Y" (
    echo.
    echo %YLW%  --    Cancelled.%RST%
    echo.
    cmd /k
    exit /b 0
)
echo.
echo %WHT% Removing startup task...%RST%
echo.
schtasks /delete /tn "LMStudio API Server" /f >nul 2>&1
if errorlevel 1 (
    echo %RED% [ERROR]%RST% Could not remove the task.
    echo.
    echo         Right-click this script and choose "Run as Administrator"
    echo         then try again.
    echo.
    cmd /k
    exit /b 1
)

echo %GRN% [OK]%RST%    Startup task removed.
echo.
echo %WHT% LM Studio will no longer start automatically on login.%RST%
echo.
echo %CYN% To start the server manually when you need it, run:%RST%
echo.
echo %WHT%    start-server.cmd%RST%
echo.
cmd /k

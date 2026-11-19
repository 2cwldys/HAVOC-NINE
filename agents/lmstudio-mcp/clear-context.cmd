@echo off
setlocal enabledelayedexpansion

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "GRN=%ESC%[92m"
set "YLW=%ESC%[93m"
set "CYN=%ESC%[96m"
set "WHT=%ESC%[97m"
set "RST=%ESC%[0m"

echo.
echo %CYN% =================================================%RST%
echo %CYN%   LM Studio  ^>^>  Clear Working Context%RST%
echo %CYN% =================================================%RST%
echo.

set "CURRENT=%~dp0context\CURRENT.md"

if not exist "!CURRENT!" (
    echo %YLW%  --    No working context file found.%RST%
    echo         Nothing to clear.
    echo.
    cmd /k
    exit /b 0
)

echo %YLW%  This will permanently delete your current working context.%RST%
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

del "!CURRENT!" >nul 2>&1
if errorlevel 1 (
    echo %YLW%  !!   Could not delete context\CURRENT.md%RST%
    echo         Try deleting it manually.
    echo.
    cmd /k
    exit /b 1
)

echo %GRN%  OK   Working context cleared.%RST%
echo.
echo %WHT%  The local model will no longer include session context%RST%
echo %WHT%  in queries until Claude starts a new task.%RST%
echo.
cmd /k

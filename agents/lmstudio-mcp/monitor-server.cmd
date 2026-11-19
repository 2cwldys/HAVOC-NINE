@echo off
setlocal

cd /d "%~dp0"

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "RED=%ESC%[91m"
set "YLW=%ESC%[93m"
set "RST=%ESC%[0m"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo %RED% [ERROR]%RST% Node.js not found. Install from https://nodejs.org
    echo.
    cmd /k
    exit /b 1
)

if not exist "node_modules\chalk" (
    echo.
    echo %YLW% [NOTE]%RST%  Dependencies not installed. Run install.cmd first.
    echo.
    cmd /k
    exit /b 1
)

node monitor-server.js

echo.
cmd /k

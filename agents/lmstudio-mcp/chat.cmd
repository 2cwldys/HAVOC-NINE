@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    echo.
    cmd /k
    exit /b 1
)

if not exist "node_modules\@modelcontextprotocol" (
    echo.
    echo  [ERROR] Dependencies not installed. Run install.cmd first.
    echo.
    cmd /k
    exit /b 1
)

node chat.js

echo.
cmd /k

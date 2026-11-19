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
echo %CYN%   LM Studio  ^>^>  Stop API Server%RST%
echo %CYN% =================================================%RST%
echo.

:: Preferred: lms CLI
where lms >nul 2>&1
if not errorlevel 1 (
    :: Unload model first
    set "MODEL_NAME_ENV="
    for /f "tokens=1,* delims==" %%k in ('findstr /i "^MODEL_NAME=" "%~dp0.env" 2^>nul') do (
        if /i "%%k"=="MODEL_NAME" set "MODEL_NAME_ENV=%%l"
    )
    if defined MODEL_NAME_ENV (
        echo %WHT% Unloading model: !MODEL_NAME_ENV!...%RST%
        lms unload "!MODEL_NAME_ENV!" >nul 2>&1
        echo %GRN%  OK%RST%     Model unloaded
        echo.
    )

    echo %WHT% Stopping server via lms CLI...%RST%
    lms server stop >nul 2>&1
    echo.
)

:: Always kill llmster regardless of whether lms server stop succeeded
set "LLMSTER_PID="
for /f "tokens=2 delims=," %%p in ('tasklist /fi "imagename eq llmster.exe" /fo csv /nh 2^>nul') do set "LLMSTER_PID=%%~p"

if defined LLMSTER_PID (
    echo %WHT% Stopping llmster [PID !LLMSTER_PID!]...%RST%
    taskkill /PID !LLMSTER_PID! /F >nul 2>&1
    if errorlevel 1 (
        echo %RED%  !!%RST%     Could not kill llmster -- try running as Administrator.
    ) else (
        echo %GRN%  OK%RST%     llmster stopped.
    )
) else (
    echo %YLW%  --%RST%     llmster was not running.
)

:: Port fallback -- kill anything still on 1234
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":1234 " ^| findstr "LISTENING"') do (
    if not defined PID set "PID=%%p"
)
if defined PID (
    echo.
    echo %WHT% Process still on port 1234 [PID !PID!] -- killing...%RST%
    taskkill /PID !PID! /F >nul 2>&1
    echo %GRN%  OK%RST%     Port 1234 freed.
)

echo.
echo %GRN%  OK%RST%     Server fully stopped.
echo.
cmd /k

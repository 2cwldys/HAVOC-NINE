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
echo %CYN%   LM Studio  ^>^>  Start API Server%RST%
echo %CYN% =================================================%RST%
echo.

where lms >nul 2>&1
if not errorlevel 1 (
    :: Check if llmster is already running
    set "LLMSTER_RUNNING=0"
    for /f "tokens=2 delims=," %%p in ('tasklist /fi "imagename eq llmster.exe" /fo csv /nh 2^>nul') do set "LLMSTER_RUNNING=1"

    if "!LLMSTER_RUNNING!"=="1" (
        echo %YLW% [NOTE]%RST%  LM Studio backend ^(llmster^) is already running.
        echo.
    ) else (
        echo %WHT% Starting LM Studio API server on port 1234...%RST%
        echo.
        lms server start --port 1234
        if errorlevel 1 (
            echo.
            echo %YLW% [NOTE]%RST%  Server may already be running.
        ) else (
            echo.
            echo %GRN%  OK%RST%     llmster started -- server on http://localhost:1234
        )
        echo.
    )

    :: Auto-import any .gguf files in the local models dir so lms knows them
    set "LOCAL_MDIR=%~dp0models"
    if exist "!LOCAL_MDIR!" (
        for /d %%p in ("!LOCAL_MDIR!\*") do (
            for /d %%m in ("%%p\*") do (
                for %%g in ("%%m\*.gguf") do (
                    lms import "%%g" >nul 2>&1
                )
            )
        )
    )

    :: Load the model from .env (interactive if model not found -- lets user pick)
    set "MODEL_NAME_ENV="
    for /f "tokens=1,* delims==" %%k in ('findstr /i "^MODEL_NAME=" "%~dp0.env" 2^>nul') do (
        if /i "%%k"=="MODEL_NAME" set "MODEL_NAME_ENV=%%l"
    )
    if defined MODEL_NAME_ENV (
        echo %WHT% Loading model: !MODEL_NAME_ENV!...%RST%
        lms load "!MODEL_NAME_ENV!"
        if errorlevel 1 (
            echo.
            echo %RED% [ERROR]%RST% Model "!MODEL_NAME_ENV!" is not downloaded.
            echo %WHT%         Run setup to download it:  npm run setup%RST%
        ) else (
            echo %GRN%  OK%RST%     Model ready
        )
    )

    echo.
    echo %WHT% Claude Code will connect automatically when the project is open.%RST%
    echo.
    cmd /k
    exit /b 0
)

:: lms CLI not on PATH -- try GUI fallback
echo %YLW% [NOTE]%RST%  lms CLI not found on PATH. Trying to launch LM Studio GUI...
echo.

set "FOUND=0"
if exist "%LOCALAPPDATA%\LM-Studio\LM Studio.exe" (
    start "" "%LOCALAPPDATA%\LM-Studio\LM Studio.exe"
    set "FOUND=1"
)
if !FOUND!==0 if exist "%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe" (
    start "" "%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe"
    set "FOUND=1"
)
if !FOUND!==0 if exist "%PROGRAMFILES%\LM Studio\LM Studio.exe" (
    start "" "%PROGRAMFILES%\LM Studio\LM Studio.exe"
    set "FOUND=1"
)

if !FOUND!==1 (
    echo %GRN% [OK]%RST%    LM Studio opened.
    echo.
    echo %WHT% In LM Studio:%RST%
    echo.
    echo         1. Click the Developer icon in the left sidebar
    echo         2. Click  Start Server
    echo         3. Go to My Models tab and load a model
    echo.
    echo %WHT% Then open VS Code and type /mcp in Claude Code.%RST%
) else (
    echo %RED% [ERROR]%RST% LM Studio not found on this machine.
    echo.
    echo %WHT% Run install.cmd to download and set everything up automatically.%RST%
)

echo.
cmd /k

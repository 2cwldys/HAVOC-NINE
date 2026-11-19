@echo off

:: Re-launch inside cmd /k so the window always stays open, even on a crash
if not defined _PERSIST (
    set _PERSIST=1
    cmd /k "%~f0" %*
    exit /b
)

setlocal enabledelayedexpansion

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YLW=%ESC%[93m"
set "CYN=%ESC%[96m"
set "WHT=%ESC%[97m"
set "RST=%ESC%[0m"

:: Kill any llmster left over from a previous interrupted install
taskkill /F /IM llmster.exe >nul 2>&1

:: Log file - captures stderr and step markers so crashes can be diagnosed
set "LOG=%~dp0install.log"
echo. > "%LOG%"
echo ============================================================ >> "%LOG%"
echo  Install started: %DATE% %TIME% >> "%LOG%"
echo ============================================================ >> "%LOG%"

echo.
echo %CYN% =================================================%RST%
echo %CYN%   HAVOC 9  ^>^>  LM Studio Agent Installer%RST%
echo %CYN% =================================================%RST%
echo %CYN%   Log: install.log%RST%
echo %CYN% =================================================%RST%
echo.

:: -------------------------------------------------------
:: Step 1 -- Check Node.js
:: -------------------------------------------------------
echo [Step 1] Checking Node.js >> "%LOG%"
echo %WHT% [1/5] Checking Node.js...%RST%

where node >nul 2>&1
if errorlevel 1 (
    echo [Step 1 FAILED] node not found >> "%LOG%"
    echo.
    echo %RED% [ERROR]%RST% Node.js is not installed.
    echo.
    echo %WHT%         Download it from: https://nodejs.org%RST%
    echo         Install it, then run this script again.
    echo.
    cmd /k
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v 2^>^&1') do set NODE_VER=%%v
echo [Step 1] node %NODE_VER% >> "%LOG%"
echo %GRN%  OK%RST%     Node.js %NODE_VER%

where npm >nul 2>&1
if errorlevel 1 (
    echo [Step 1 FAILED] npm not found >> "%LOG%"
    echo %RED% [ERROR]%RST% npm not found. Reinstall Node.js from https://nodejs.org
    echo.
    cmd /k
    exit /b 1
)
echo [Step 1] npm found >> "%LOG%"
echo %GRN%  OK%RST%     npm found

:: -------------------------------------------------------
:: Step 2 -- Check / Install LM Studio
:: -------------------------------------------------------
echo [Step 2] Checking LM Studio >> "%LOG%"
echo [2.1] blank line >> "%LOG%"
echo.
echo [2.2] header echo >> "%LOG%"
echo  [2/5] Checking LM Studio...
echo [2.3] set LMS_FOUND >> "%LOG%"
set "LMS_FOUND=0"
echo [2.4] before where lms >> "%LOG%"
where lms >nul 2>&1
echo [2.5] where lms errorlevel=%ERRORLEVEL% >> "%LOG%"
if not errorlevel 1 (
    echo [2.6] lms CLI found >> "%LOG%"
    echo  OK  LM Studio CLI found
    set "LMS_FOUND=1"
)
echo [2.7] LMS_FOUND=!LMS_FOUND! >> "%LOG%"
if !LMS_FOUND!==0 (
    echo [2.8] checking LOCALAPPDATA path 1 >> "%LOG%"
    if exist "%LOCALAPPDATA%\LM-Studio\LM Studio.exe" (
        echo [2.9] GUI found at LM-Studio >> "%LOG%"
        echo  OK  LM Studio is installed
        set "LMS_FOUND=1"
    )
)
echo [2.10] LMS_FOUND=!LMS_FOUND! >> "%LOG%"
if !LMS_FOUND!==0 (
    echo [2.11] checking LOCALAPPDATA path 2 >> "%LOG%"
    if exist "%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe" (
        echo [2.12] GUI found at Programs >> "%LOG%"
        echo  OK  LM Studio is installed
        set "LMS_FOUND=1"
    )
)
echo [2.13] LMS_FOUND=!LMS_FOUND! >> "%LOG%"
if !LMS_FOUND!==0 (
    echo [2.14] LM Studio not found, asking before download >> "%LOG%"
    echo.
    echo  --  LM Studio is not installed.
    echo.
    echo      This step would download and run the official installer from
    echo        https://lmstudio.ai/install.ps1
    echo      LM Studio is third-party software. It is NOT part of HAVOC 9 and is not
    echo      distributed with it. Installing it means accepting its own terms:
    echo        https://lmstudio.ai/app-terms
    echo.
    echo      Say N and this installer still finishes: the bridge and the H9 tools work,
    echo      and you can install LM Studio yourself whenever you like.
    echo.
    set "LMS_CHOICE="
    set /p "LMS_CHOICE= Download and install LM Studio now? (Y/N): "
    echo [2.14b] answer=!LMS_CHOICE! >> "%LOG%"
    if /i not "!LMS_CHOICE!"=="Y" (
        echo.
        echo  --  Skipped. Install it from https://lmstudio.ai when you want it, then run
        echo      start-server.cmd. Nothing else here depends on it.
        echo.
        goto :after_lmstudio
    )
    echo  ..  downloading from lmstudio.ai...
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://lmstudio.ai/install.ps1 | iex" 2>> "%LOG%"
    if errorlevel 1 (
        echo [Step 2 FAILED] LM Studio install failed >> "%LOG%"
        echo.
        echo %RED% [ERROR]%RST% LM Studio installation failed.
        echo %WHT%         Try installing manually from https://lmstudio.ai%RST%
        echo %YLW%  Check install.log for details.%RST%
        echo.
        cmd /k
        exit /b 1
    )
    echo [2.15] LM Studio installed >> "%LOG%"
    echo.
    echo  OK  LM Studio installed successfully
)
:after_lmstudio
echo [2.16] Step 2 complete >> "%LOG%"

:: -------------------------------------------------------
:: Step 3 -- Install Node dependencies
:: -------------------------------------------------------
echo [Step 3] Running npm install >> "%LOG%"
echo.
echo %WHT% [3/5] Installing Node.js dependencies...%RST%
echo.
cd /d "%~dp0"
set NODE_OPTIONS=--use-system-ca
call npm install 2>> "%LOG%"
if errorlevel 1 (
    echo [Step 3 FAILED] npm install returned errorlevel %ERRORLEVEL% >> "%LOG%"
    echo.
    echo %RED% [ERROR]%RST% npm install failed.
    echo.
    echo %YLW%  Check install.log for the full error output.%RST%
    echo.
    cmd /k
    exit /b 1
)
echo [Step 3] npm install succeeded >> "%LOG%"
echo.
echo %GRN%  OK%RST%     Dependencies installed

:: -------------------------------------------------------
:: Step 4 -- Run setup wizard
:: -------------------------------------------------------
echo [Step 4] Running setup wizard >> "%LOG%"
echo.
echo %WHT% [4/5] Setup wizard - configure your model...%RST%
echo.
call npm run setup 2>> "%LOG%"
if errorlevel 1 (
    echo [Step 4] Setup wizard exited with errors >> "%LOG%"
    echo.
    echo %YLW% [NOTE]%RST%  Setup wizard reported errors - check install.log for details.
    echo         You can re-run it later with: npm run setup
    echo.
)
echo [Step 4] Setup wizard finished >> "%LOG%"

:: -------------------------------------------------------
:: Step 5 -- Startup task (ask first)
:: -------------------------------------------------------
echo [Step 5] Startup task prompt >> "%LOG%"
echo.
echo %CYN% =================================================%RST%
echo %CYN%   Auto-Startup (Optional)%RST%
echo %CYN% =================================================%RST%
echo.
echo %WHT% Would you like the LM Studio server to start automatically%RST%
echo %WHT% each time you log into Windows?%RST%
echo.
echo %YLW%  Y  = Register a startup task (recommended - server is always ready)%RST%
echo %YLW%  N  = Skip it (run start-server.cmd manually after each restart)%RST%
echo.
set "STARTUP_CHOICE="
set /p "STARTUP_CHOICE= Your choice (Y/N): "
if /i not "!STARTUP_CHOICE!"=="Y" goto :skip_startup

:: Register the startup task
where lms >nul 2>&1
if errorlevel 1 (
    echo [Step 5] lms not on PATH, skipping startup task >> "%LOG%"
    echo.
    echo %YLW% [NOTE]%RST%  lms CLI not on PATH - cannot register startup task.
    echo         Open LM Studio manually to start the server.
    goto :start_server
)

schtasks /create /tn "LMStudio API Server" /tr "lms server start --port 1234" /sc onlogon /rl limited /f >nul 2>> "%LOG%"
if errorlevel 1 (
    echo [Step 5] schtasks failed >> "%LOG%"
    echo.
    echo %YLW% [NOTE]%RST%  Could not register startup task (may need admin rights).
    echo         Run install.cmd as Administrator to retry, or use start-server.cmd manually.
) else (
    echo [Step 5] Startup task registered >> "%LOG%"
    echo.
    echo %GRN%  OK%RST%     Startup task registered - server will auto-start on login.
    echo         To remove it later, run: %WHT%remove-startup.cmd%RST%
)
goto :start_server

:skip_startup
echo [Step 5] Startup task skipped >> "%LOG%"
echo.
echo %YLW%  --    Startup task skipped.%RST%
echo         Run %WHT%start-server.cmd%RST% after each restart to start the server.

:start_server
:: -------------------------------------------------------
:: Step 6 -- Start server then load the chosen model
:: -------------------------------------------------------
echo [Step 6] Starting LM Studio server >> "%LOG%"
echo.
echo %WHT% [5/5] Starting LM Studio API server...%RST%
echo.
where lms >nul 2>&1
if not errorlevel 1 (
    start /b cmd /c "lms server start --port 1234"
    echo [Step 6] lms server start launched (detached) >> "%LOG%"
    echo %GRN%  OK%RST%     LM Studio server launched on http://localhost:1234

    :: Read MODEL_NAME from .env so we can load it without opening LM Studio
    set "MODEL_NAME_ENV="
    for /f "tokens=1,* delims==" %%k in ('findstr /i "^MODEL_NAME=" "%~dp0.env" 2^>nul') do (
        if /i "%%k"=="MODEL_NAME" set "MODEL_NAME_ENV=%%l"
    )

    if defined MODEL_NAME_ENV (
        echo.
        echo %WHT% Loading model: !MODEL_NAME_ENV!...%RST%
        echo %YLW%         (this may take a moment if the model needs to be downloaded)%RST%
        echo.
        echo [Step 6] Loading model !MODEL_NAME_ENV! >> "%LOG%"
        timeout /t 3 /nobreak >nul
        lms load "!MODEL_NAME_ENV!" 2>> "%LOG%"
        if errorlevel 1 (
            echo [Step 6] lms load failed - model not downloaded >> "%LOG%"
            echo %RED% [ERROR]%RST% Model "!MODEL_NAME_ENV!" is not downloaded.
            echo %WHT%         Run:  npm run setup%RST%
            echo %WHT%         Setup will offer to download it for you.%RST%
        ) else (
            echo [Step 6] model loaded >> "%LOG%"
            echo %GRN%  OK%RST%     Model loaded and ready
        )
    )
) else (
    echo [Step 6] lms not on PATH >> "%LOG%"
    echo %YLW% [NOTE]%RST%  lms CLI not on PATH - open LM Studio manually and
    echo         enable the server under the Developer tab.
)

:: -------------------------------------------------------
:: Done
:: -------------------------------------------------------
echo [DONE] Install completed: %DATE% %TIME% >> "%LOG%"
echo.
echo %CYN% =================================================%RST%
echo %CYN%   All done! One last step:%RST%
echo %CYN% =================================================%RST%
echo.
echo %WHT%  In VS Code, press  Ctrl+Shift+P  and run:%RST%
echo.
echo %WHT%      Developer: Reload Window%RST%
echo.
echo %WHT%  Then type  /mcp  in Claude Code.%RST%
echo %WHT%  You should see "lmstudio" listed as connected.%RST%
echo.
echo %YLW%  Need to start the server again after a restart?%RST%
echo         Run:  %WHT%start-server.cmd%RST%
echo.
echo %CYN% =================================================%RST%
echo %WHT%  Install log saved to: install.log%RST%
echo %WHT%  Close this window when you are ready.%RST%
echo %CYN% =================================================%RST%
echo.
cmd /k

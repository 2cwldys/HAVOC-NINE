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
echo %CYN%   LM Studio  ^>^>  Purge Downloaded Models%RST%
echo %CYN% =================================================%RST%
echo.

set "MODELS_DIR=%USERPROFILE%\.lmstudio\models"

:: Check if models directory exists and has content
if not exist "!MODELS_DIR!\" (
    echo %YLW%  --    No models directory found at:%RST%
    echo         !MODELS_DIR!
    echo.
    echo         Nothing to purge.
    echo.
    cmd /k
    exit /b 0
)

:: Check if any publisher subdirectories exist
set "HAS_MODELS=0"
for /d %%d in ("!MODELS_DIR!\*") do set "HAS_MODELS=1"

if "!HAS_MODELS!"=="0" (
    echo %YLW%  --    Models directory is empty, nothing to purge.%RST%
    echo.
    cmd /k
    exit /b 0
)

:: Show what's downloaded (via lms ls for nice output; fall back to dir)
echo %WHT% Downloaded models:%RST%
echo.
where lms >nul 2>&1
if not errorlevel 1 (
    lms ls 2>nul || dir /b "!MODELS_DIR!"
) else (
    dir /b "!MODELS_DIR!"
)
echo.

echo %RED%  WARNING: This permanently removes all downloaded model files.%RST%
echo %WHT%  Open LM Studio ^> Discover tab to re-download models afterwards.%RST%
echo.

set "CONFIRM="
set /p "CONFIRM= Are you sure? (Y/N): "
if /i not "!CONFIRM!"=="Y" (
    echo.
    echo %YLW%  --    Cancelled. Nothing deleted.%RST%
    echo.
    cmd /k
    exit /b 0
)
echo.

:: Unload all models first so files aren't locked
where lms >nul 2>&1
if not errorlevel 1 (
    echo %WHT% Unloading all models...%RST%
    lms unload --all >nul 2>&1
    echo %GRN%  OK%RST%     Models unloaded
    echo.
)

:: Delete all publisher subdirectories under the models folder
echo %WHT% Deleting model files from:%RST%
echo         !MODELS_DIR!
echo.

for /d %%d in ("!MODELS_DIR!\*") do (
    echo %YLW%  ..%RST%     Deleting %%~nd...
    rd /s /q "%%d"
    if errorlevel 1 (
        echo %RED%  !!%RST%     Could not delete %%~nd
        echo         Right-click this script and choose Run as Administrator, then retry.
    ) else (
        echo %GRN%  OK%RST%     Deleted
    )
)

:: Also purge publisher subdirs inside the local models dir (keep the folder itself)
set "LOCAL_MDIR=%~dp0models"
if exist "!LOCAL_MDIR!\" (
    echo.
    echo %WHT% Purging local models dir:%RST%
    echo         !LOCAL_MDIR!
    echo.
    set "LOCAL_DELETED=0"
    for /d %%d in ("!LOCAL_MDIR!\*") do (
        echo %YLW%  ..%RST%     Deleting %%~nd...
        rd /s /q "%%d"
        if errorlevel 1 (
            echo %RED%  !!%RST%     Could not delete %%~nd
        ) else (
            echo %GRN%  OK%RST%     Deleted
            set "LOCAL_DELETED=1"
        )
    )
    if "!LOCAL_DELETED!"=="0" (
        echo %YLW%  --    Local models folder is already empty.%RST%
    )
)

echo.
echo %GRN%  OK%RST%     Done. All model files removed.
echo.
echo %CYN% =================================================%RST%
echo %WHT%  To get a new model:%RST%
echo %WHT%    1. Open LM Studio%RST%
echo %WHT%    2. Click the Discover tab (magnifying glass)%RST%
echo %WHT%    3. Search and download a model%RST%
echo %WHT%    4. Run:  npm run setup%RST%
echo %CYN% =================================================%RST%
echo.
cmd /k

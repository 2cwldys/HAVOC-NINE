@echo off
setlocal enabledelayedexpansion

for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "YLW=%ESC%[93m"
set "CYN=%ESC%[96m"
set "WHT=%ESC%[97m"
set "GRN=%ESC%[92m"
set "RED=%ESC%[91m"
set "RST=%ESC%[0m"

set "NATIVE_DIR=%USERPROFILE%\.lmstudio\models"
set "LOCAL_DIR=%~dp0models"

echo.
echo %CYN% =================================================%RST%
echo %CYN%   LM Studio  ^>^>  Open Models Folder%RST%
echo %CYN% =================================================%RST%
echo.
echo %WHT% Which models folder would you like to open?%RST%
echo.

:: Show status of each location
if exist "!NATIVE_DIR!" (
    echo %GRN%  [1]%RST%  Native  -- !NATIVE_DIR!
) else (
    echo %YLW%  [1]%RST%  Native  -- !NATIVE_DIR!  %YLW%[not created yet]%RST%
)

if exist "!LOCAL_DIR!" (
    echo %GRN%  [2]%RST%  Local   -- !LOCAL_DIR!
) else (
    echo %YLW%  [2]%RST%  Local   -- !LOCAL_DIR!  %YLW%[not created yet]%RST%
)

echo %CYN%  [3]%RST%  Both
echo.

set "CHOICE="
set /p "CHOICE= Your choice (1/2/3): "

if "!CHOICE!"=="1" goto :open_native
if "!CHOICE!"=="2" goto :open_local
if "!CHOICE!"=="3" goto :open_both
echo.
echo %YLW%  --    Invalid choice -- exiting.%RST%
goto :end

:open_native
echo.
if not exist "!NATIVE_DIR!" (
    echo %YLW%  --    Native models folder does not exist yet.%RST%
    echo         Download a model first:  npm run setup
) else (
    echo %CYN%  Opening:  !NATIVE_DIR!%RST%
    explorer "!NATIVE_DIR!"
)
goto :end

:open_local
echo.
if not exist "!LOCAL_DIR!" (
    echo %YLW%  --    Local models folder does not exist yet.%RST%
    echo         Run npm run setup and choose "Local" when asked where to store models.
) else (
    echo %CYN%  Opening:  !LOCAL_DIR!%RST%
    explorer "!LOCAL_DIR!"
)
goto :end

:open_both
echo.
if exist "!NATIVE_DIR!" (
    echo %CYN%  Opening:  !NATIVE_DIR!%RST%
    explorer "!NATIVE_DIR!"
) else (
    echo %YLW%  --    Native folder does not exist yet -- skipping.%RST%
)
if exist "!LOCAL_DIR!" (
    echo %CYN%  Opening:  !LOCAL_DIR!%RST%
    explorer "!LOCAL_DIR!"
) else (
    echo %YLW%  --    Local folder does not exist yet -- skipping.%RST%
)
if not exist "!NATIVE_DIR!" if not exist "!LOCAL_DIR!" (
    echo.
    echo         Neither folder exists yet.  Run npm run setup to download a model.
)
goto :end

:end
echo.

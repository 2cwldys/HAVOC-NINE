@echo off

:: Keep window open even if something crashes
if not defined _PERSIST (
    set _PERSIST=1
    cmd /k "%~f0" %*
    exit /b
)

setlocal enabledelayedexpansion

echo.
echo  =================================================
echo    LM Studio  --  Launch API Server
echo  =================================================
echo.

:: -------------------------------------------------------
:: Preferred: lms CLI (headless, no GUI required)
:: -------------------------------------------------------
where lms >nul 2>&1
if errorlevel 1 goto :no_lms

echo  Starting LM Studio server on port 1234 (headless)...
echo  No GUI required -- server runs in the background.
echo.
lms server start --port 1234
echo.
echo  OK: Server started on http://localhost:1234
echo.
echo  To load a model:   lms load ^<model-name^>
echo  Or open LM Studio GUI to load one visually.
echo.
goto :done

:: -------------------------------------------------------
:: Fallback: launch LM Studio GUI
:: -------------------------------------------------------
:no_lms
echo  lms CLI not found -- trying to open LM Studio GUI...
echo.

set "LMS_EXE="
if exist "%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe"  set "LMS_EXE=%LOCALAPPDATA%\Programs\LM Studio\LM Studio.exe"
if exist "%LOCALAPPDATA%\LM-Studio\LM Studio.exe"           set "LMS_EXE=%LOCALAPPDATA%\LM-Studio\LM Studio.exe"
if exist "%PROGRAMFILES%\LM Studio\LM Studio.exe"           set "LMS_EXE=%PROGRAMFILES%\LM Studio\LM Studio.exe"
if exist "%PROGRAMFILES(X86)%\LM Studio\LM Studio.exe"      set "LMS_EXE=%PROGRAMFILES(X86)%\LM Studio\LM Studio.exe"

if not defined LMS_EXE goto :not_found

echo  OK: Opening LM Studio...
echo.
start "" "!LMS_EXE!"
echo  In LM Studio:
echo    1. Click the Developer icon in the left sidebar
echo    2. Click Start Server
echo    3. Load a model from the My Models tab
echo.
echo  Then open VS Code and type /mcp in Claude Code.
echo.
goto :done

:not_found
echo  ERROR: LM Studio not found on this machine.
echo.
echo  Run install.cmd to download and install it automatically.
echo.

:done

@echo off
setlocal EnableExtensions
title wad2png - GoldSrc WAD to PNG
pushd "%~dp0" || exit /b 1

if "%~1"=="" (
    echo.
    echo Usage:
    echo   wad2png.cmd textures.wad
    echo   wad2png.cmd textures.wad -o exported
    echo   wad2png.cmd *.wad
    echo   wad2png.cmd gfx.wad --palette palette.lmp
    echo.
    echo Drag and drop one or more WAD files onto this script,
    echo or run it from Command Prompt with WAD paths as arguments.
    echo Output defaults to the "exported" folder beside this script.
    echo.
    pause
    popd
    exit /b 0
)

py -3 "%~dp0wad2png.py" %*
if errorlevel 9009 (
    echo.
    echo ERROR: Python 3 was not found. Install Python 3 and enable the "py" launcher,
    echo or run wad2png.py with your Python executable.
)
echo.
pause
popd
exit /b

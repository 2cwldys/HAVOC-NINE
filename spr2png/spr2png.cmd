
@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Portable Half-Life SPR to PNG Converter

pushd "%~dp0" || exit /b 1

set "TOOL=%~dp0goldutil.exe"
set "OUTPUT=%~dp0exported_png"
set "LOG=%~dp0goldutil_output.log"
set /a COUNT=0
set /a FAILED=0

echo ============================================
echo   PORTABLE HALF-LIFE SPR TO PNG CONVERTER
echo ============================================
echo Tool: "%TOOL%"
echo.

if not exist "%TOOL%" (
    echo ERROR: goldutil.exe is missing.
    echo It must be beside this batch file.
    goto :finish
)

if not exist "%OUTPUT%" mkdir "%OUTPUT%"

if not "%~1"=="" goto :arguments

if exist "%~dp0sprites\" (
    call :folder "%~dp0sprites"
) else (
    echo No input supplied.
    echo Drag SPR files or folders onto this script,
    echo or create a sprites folder beside it.
)
goto :summary

:arguments
if "%~1"=="" goto :summary

if exist "%~1\" (
    call :folder "%~1"
) else if exist "%~1" (
    if /i "%~x1"==".spr" (
        call :convert "%~1"
    ) else (
        echo SKIPPED: Not an SPR file: "%~1"
    )
) else (
    echo ERROR: Input not found: "%~1"
    set /a FAILED+=1
)

shift
goto :arguments

:folder
for %%F in ("%~1\*.spr") do (
    if exist "%%~fF" call :convert "%%~fF"
)
exit /b 0

:convert
set /a COUNT+=1
set "FILE=%~1"
set "DEST=%OUTPUT%\%~n1"

if not exist "%DEST%" mkdir "%DEST%"

echo.
echo --------------------------------------------
echo INPUT:  "%FILE%"
echo OUTPUT: "%DEST%"
echo --------------------------------------------
echo Running GoldUtil...
echo.

rem Run GoldUtil with separate, correctly quoted arguments.
rem Keep this command on ONE physical line.
"%TOOL%" spr extract --dir "%DEST%" "%FILE%" > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

if exist "%LOG%" (
    for %%Z in ("%LOG%") do (
        if %%~zZ GTR 0 (
            echo GoldUtil output:
            type "%LOG%"
            echo.
        )
    )
)

echo GoldUtil exit code: %RC%

if not "%RC%"=="0" (
    echo RESULT: FAILED - GoldUtil returned an error.
    set /a FAILED+=1
    exit /b 0
)

dir /b /a-d "%DEST%\*.png" >nul 2>&1
if errorlevel 1 (
    echo RESULT: NO PNG FILES FOUND.
    echo Check the GoldUtil output above and the log:
    echo "%LOG%"
    set /a FAILED+=1
) else (
    echo RESULT: SUCCESS
    echo Exported PNG files:
    dir /b /a-d "%DEST%\*.png"
)

exit /b 0

:summary
echo.
echo ============================================
echo CONVERSION SUMMARY
echo ============================================
echo Sprites processed: %COUNT%
echo Failures:          %FAILED%
echo Output directory:  "%OUTPUT%"
echo Command log:       "%LOG%"
echo ============================================

:finish
echo.
echo Press any key to exit.
pause >nul
popd
endlocal

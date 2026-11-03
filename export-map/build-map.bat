@echo off
REM ===========================================================================
REM  build-map.bat -- build the map in a window you can watch
REM
REM  Double-click it, or run it with the same words make.mjs takes:
REM
REM      build-map.bat                      check and draw only, seconds
REM      build-map.bat compile fast         a draft, about 20 seconds
REM      build-map.bat compile version      full lighting, kept as versions\NN
REM      build-map.bat deploy               compile and install into the game
REM      build-map.bat deploy 02            install a version already built
REM
REM  WHY THIS EXISTS. A full compile is four minutes of hlvis and hlrad, and
REM  watching it from outside meant asking somebody else whether it had
REM  finished. The window stays open at the end so the result can be read.
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo  ===========================================================
echo   h9_te_neuropolis -- map build
echo   %DATE% %TIME%
echo  ===========================================================
echo.

if "%~1"=="" (
    echo  no arguments: checking and drawing only, nothing will be compiled.
    echo  pass "compile fast" for a draft, or "compile version" for a full one.
    echo.
)

node make.mjs %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo  ===========================================================
    echo   finished.
    echo  ===========================================================
) else (
    echo  ===========================================================
    echo   FAILED -- exit code %RC%. The lines above say why.
    echo  ===========================================================
)
echo.
pause

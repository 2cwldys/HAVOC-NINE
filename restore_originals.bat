@echo off
REM ===========================================================================
REM  restore_originals.bat -- portable restore of the ORIGINAL (stock) TS files
REM
REM  Run this from (or double-click it in) the Half-Life folder -- the one that
REM  contains hl.exe and the ts folder:
REM
REM      <Half-Life>\restore_originals.bat
REM
REM  It refuses to run anywhere else: if the current folder does not contain
REM  ts\resource, it tells you to move the script to the Half-Life folder.
REM
REM  It reads, whichever exists:
REM      ts\original.zip            (vgui.dll + config.cfg + valve textschemes)
REM      ts\resource\original.zip   (background tiles, trackerscheme.res, ...)
REM      ts\cl_dlls\original.zip    (stock client.dll)
REM
REM  and puts the stock files back where the game reads them:
REM      vgui.dll         -> <Half-Life>\vgui.dll   (this folder)
REM      config.cfg       -> ts\config.cfg
REM      resource files   -> ts\resource\           (a single wrapper folder
REM                                                  in the zip is stripped)
REM      client.dll       -> ts\cl_dlls\client.dll  (from cl_dlls\original.zip)
REM      client.dll.patch -> deleted (patch artifact, not a stock file)
REM      ts\*_textscheme.txt  are deleted (theme additions, not stock files)
REM
REM  Nothing is touched until you answer Y. Close Half-Life first: it locks
REM  vgui.dll and ts\cl_dlls\client.dll while running.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

REM ---- the tool only makes sense from the Half-Life folder ------------------
if not exist "%CD%\ts\resource" goto :wrong_folder

set "TS=%CD%\ts"
set "UIZIP=%TS%\original.zip"
set "RSZIP=%TS%\resource\original.zip"
set "CLZIP=%TS%\cl_dlls\original.zip"
set "RTMP=%TEMP%\ts_restore_%RANDOM%%RANDOM%"

echo ============================================================
echo  Restore original TS files
echo ============================================================
echo  Half-Life  : %CD%
echo  Mod folder : %TS%
echo.
if exist "%UIZIP%" (
    echo   [found]   ts\original.zip          ^(vgui.dll, config.cfg^)
) else (
    echo   [missing] ts\original.zip
)
if exist "%RSZIP%" (
    echo   [found]   ts\resource\original.zip ^(background, res, menu art^)
) else (
    echo   [missing] ts\resource\original.zip
)
if exist "%CLZIP%" (
    echo   [found]   ts\cl_dlls\original.zip  ^(client.dll^)
) else (
    echo   [missing] ts\cl_dlls\original.zip
)
echo.
echo  The stock files will overwrite the current themed files.
echo  The purple ts\*_textscheme.txt files will be removed.
echo  ts\cl_dlls\client.dll.patch will be removed.
echo  Close Half-Life before continuing.
echo.

if not exist "%UIZIP%" if not exist "%RSZIP%" if not exist "%CLZIP%" (
    echo  Nothing to restore: no original.zip was found.
    echo  Put original.zip in ts\, resource\original.zip in ts\resource\,
    echo  and/or cl_dlls\original.zip in ts\cl_dlls\, then run it again.
    echo.
    pause
    exit /b 1
)

:ask
set "ANSWER="
set /p "ANSWER=Restore the originals? [Y/N]: "
if /i "%ANSWER%"=="Y" goto :restore
if /i "%ANSWER%"=="N" goto :cancel
echo   Please type Y or N.
goto :ask

:restore
echo.
if not exist "%RTMP%" mkdir "%RTMP%" >nul 2>nul
if exist "%UIZIP%" call :restore_ui
if exist "%RSZIP%" call :restore_tree "%RSZIP%" "%TS%\resource" "ts\resource\original.zip"
if exist "%CLZIP%" (
    call :restore_tree "%CLZIP%" "%TS%\cl_dlls" "ts\cl_dlls\original.zip"
    if not errorlevel 1 (
        if exist "%TS%\cl_dlls\client.dll.patch" (
            attrib -r "%TS%\cl_dlls\client.dll.patch" >nul 2>nul
            del /q "%TS%\cl_dlls\client.dll.patch" >nul 2>nul
            if exist "%TS%\cl_dlls\client.dll.patch" (
                echo   [ERROR] client.dll.patch could not be removed.
            ) else (
                echo   [ok] client.dll.patch removed
            )
        ) else (
            echo   [ok] client.dll.patch was not present
        )
    )
)
if exist "%RTMP%" rmdir /s /q "%RTMP%" >nul 2>nul
echo.
echo  Restore complete. Restart Half-Life to load the restored files.
echo.
pause
exit /b 0

:restore_ui
echo   Extracting ts\original.zip ...
powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%UIZIP%' -DestinationPath '%RTMP%\ui' -Force"
if errorlevel 1 (
    echo   [ERROR] ts\original.zip could not be extracted.
    exit /b 1
)
set "UISRC=%RTMP%\ui"
if not exist "%UISRC%\vgui.dll" (
    for /d %%D in ("%RTMP%\ui\*") do if exist "%%D\vgui.dll" set "UISRC=%%~fD"
)
if exist "%UISRC%\vgui.dll" (
    copy /y "%UISRC%\vgui.dll" "%CD%\vgui.dll" >nul
    if errorlevel 1 (
        echo   [ERROR] vgui.dll could not be copied.
    ) else (
        echo   [ok] vgui.dll  -^> %CD%\vgui.dll
    )
) else (
    echo   [warn] vgui.dll was not found in ts\original.zip
)
if exist "%UISRC%\config.cfg" (
    copy /y "%UISRC%\config.cfg" "%TS%\config.cfg" >nul
    if errorlevel 1 (
        echo   [ERROR] config.cfg could not be copied.
    ) else (
        echo   [ok] config.cfg -^> %TS%\config.cfg
    )
)
echo   Removing purple ts\*_textscheme.txt ...
del /q "%TS%\*_textscheme.txt" >nul 2>nul
echo   [ok] purple text schemes removed
exit /b 0

:restore_tree
REM  %1 = zip, %2 = destination folder, %3 = label for messages
set "ZIP=%~1"
set "DEST=%~2"
set "LABEL=%~3"
set "TREETMP=%RTMP%\tree_%RANDOM%%RANDOM%"
echo   Extracting %LABEL% ...
powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%TREETMP%' -Force"
if errorlevel 1 (
    echo   [ERROR] %LABEL% could not be extracted.
    exit /b 1
)
set "SRC=%TREETMP%"
set "HASROOT="
for /f "delims=" %%F in ('dir /b /a-d "%TREETMP%" 2^>nul') do set "HASROOT=1"
set "DIRCOUNT=0"
set "ONEDIR="
for /d %%D in ("%TREETMP%\*") do (
    set /a DIRCOUNT+=1
    set "ONEDIR=%%~fD"
)
if not defined HASROOT if "%DIRCOUNT%"=="1" set "SRC=%ONEDIR%"
if exist "%SRC%\RESTORE.txt" del /q "%SRC%\RESTORE.txt" >nul 2>nul
echo   Copying %LABEL% files ...
xcopy "%SRC%\*" "%DEST%\" /E /Y /I /Q /R >nul
if errorlevel 2 (
    echo   [ERROR] %LABEL% files could not be copied.
    exit /b 1
)
echo   [ok] %LABEL% -^> %DEST%
exit /b 0

:wrong_folder
echo ============================================================
echo  Not in the Half-Life folder
echo ============================================================
echo  This tool must sit in the Half-Life folder -- the one that
echo  contains hl.exe and the ts folder -- for example:
echo      ...\Half-Life\restore_originals.bat
echo.
echo  Current folder: %CD%
echo.
echo  Move restore_originals.bat there and run it again.
echo.
pause
exit /b 1

:cancel
echo.
echo  Cancelled. Nothing was changed.
echo.
pause
exit /b 0

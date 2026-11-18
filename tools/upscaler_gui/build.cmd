@echo off
REM build.cmd -- makes the standalone H9Upscaler, a folder that runs on a PC with no Python.
REM
REM Run setup.cmd --build first. The result is dist\H9Upscaler, about 200 MB: the program, the
REM ONNX runtime with DirectML, and the model. Zip that folder to hand it to someone.
REM
REM   build.cmd              build into dist\
REM   build.cmd <folder>     build somewhere else (D:\temp say, to keep it off a full C:)
REM
REM It is a onedir build on purpose. A onefile of this size unpacks 200 MB into a temp folder on
REM every launch, which is slow and leaves rubbish behind.
setlocal
cd /d "%~dp0"

set "VPY=%~dp0.venv\Scripts\python.exe"
if not exist "%VPY%" (
	echo.
	echo   No .venv here. Run setup.cmd --build first.
	echo.
	pause
	exit /b 1
)

"%VPY%" -c "import PyInstaller" 2>nul
if errorlevel 1 (
	echo   PyInstaller is missing. Installing it now...
	"%VPY%" -m pip install --quiet pyinstaller || goto :failed
)

if not exist "model\4xLSDIRplus.onnx" (
	echo.
	echo   model\4xLSDIRplus.onnx is missing, so the build would have nothing to run.
	echo   README.txt says how to make it. Stopping.
	echo.
	pause
	exit /b 1
)

set "OUT=%~dp0dist"
if not "%~1"=="" set "OUT=%~1"
set "WORK=%OUT%\.build"

echo --- building into %OUT%
"%VPY%" -m PyInstaller "build\h9upscale.spec" --noconfirm --distpath "%OUT%" --workpath "%WORK%" || goto :failed

echo.
echo --- checking the built copy actually works
"%OUT%\H9Upscaler\H9Upscaler.exe" --selftest
if errorlevel 1 (
	echo.
	echo   The built copy failed its own test. Do not ship it.
	pause
	exit /b 1
)

echo.
echo   Built: %OUT%\H9Upscaler
echo   That folder is the whole program. Zip it to pass it on.
pause
exit /b 0

:failed
echo.
echo   The build failed above.
pause
exit /b 1

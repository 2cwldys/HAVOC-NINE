@echo off
REM setup.cmd -- installs what H9 Upscaler needs, into a virtual environment beside this script.
REM
REM Nothing goes into your system Python and nothing needs administrator rights. Run it once, then
REM run.cmd to start the program or build.cmd to make the standalone H9Upscaler.exe.
REM
REM It picks the ONNX runtime for this machine: onnxruntime-directml, which runs the model on any
REM DirectX 12 card (NVIDIA, AMD or Intel), and falls back to the CPU build if that will not
REM install. The CPU is perhaps thirty times slower, so it says which one it got.
REM
REM   setup.cmd            install into .venv beside this script
REM   setup.cmd --build    install the build tool (PyInstaller) too
REM
REM Needs Python 3.10 or newer from python.org or the Microsoft Store.
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
	echo.
	echo   No Python found. Install Python 3.10 or newer from https://www.python.org/downloads/
	echo   and tick "Add python.exe to PATH" in the installer.
	echo.
	pause
	exit /b 1
)

echo --- making the virtual environment in .venv
%PY% -m venv .venv || goto :failed
set "VPY=%~dp0.venv\Scripts\python.exe"

echo --- pip
"%VPY%" -m pip install --quiet --upgrade pip || goto :failed

echo --- numpy and Pillow
"%VPY%" -m pip install --quiet -r requirements.txt || goto :failed

echo --- the ONNX runtime
"%VPY%" -m pip install --quiet onnxruntime-directml
if errorlevel 1 (
	echo     DirectML would not install; using the CPU build instead ^(much slower^)
	"%VPY%" -m pip install --quiet onnxruntime || goto :failed
)

if /i "%~1"=="--build" (
	echo --- PyInstaller, for build.cmd
	"%VPY%" -m pip install --quiet pyinstaller || goto :failed
)

echo.
echo --- what it ended up with
"%VPY%" h9upscale.py --check
echo.
if not exist "model\4xLSDIRplus.onnx" (
	echo   The model is missing. It is 64 MB and is not kept in git: README.txt says how to
	echo   make model\4xLSDIRplus.onnx from the .pth, or copy one in from a built release.
	echo.
)
echo   Done. run.cmd starts it; build.cmd makes the standalone exe.
pause
exit /b 0

:failed
echo.
echo   Something failed above. Nothing outside this folder was changed.
pause
exit /b 1

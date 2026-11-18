@echo off
REM run.cmd -- starts H9 Upscaler from this folder, using the .venv setup.cmd made.
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
	echo   No .venv here. Run setup.cmd first.
	pause
	exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" h9upscale.py %*

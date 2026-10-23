@echo off
REM generate_patches.cmd -- one click: git-diff each tracked DLL/EXE's source against
REM where its .patch file last left off, fold any change in via dllmerge.ps1, log what
REM happened. Add new targets in generate_patches.ps1's $Targets list.
REM Writes generate_patches.log beside this script (gitignored -- it's a run report,
REM not something to commit).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0generate_patches.ps1"
echo.
echo Log: %~dp0generate_patches.log
pause
endlocal

@echo off
REM wsl_install.bat -- makes the WSL2 distro h9build that build-linux.cmd builds the Linux server in (see wsl_install.ps1).
REM   wsl_install.bat                  the distro on D:\wsl\h9build, with the build tools
REM   wsl_install.bat -WithAmbuild     and AMBuild (builds AMX Mod X; its license is linux\LICENSE-AMBUILD.txt)
REM   wsl_install.bat -Dir E:\wsl\h9build   another place for the distro's disk
REM   wsl_install.bat -SkipSetup       the distro only, no tools
REM Your own WSL distros are not touched. Run with no arguments (a double-click), it waits for a key at the end.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wsl_install.ps1" %*
set "RC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RC%

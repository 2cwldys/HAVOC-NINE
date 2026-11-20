@echo off
rem Announce the build the site is serving, by hand.
rem
rem The bot does this by itself when downloads\.build changes. Run this when that did not happen:
rem the bot was down, the setting was added after the release, or the release went out before any
rem of it existed. It records the build afterwards, so the bot does not post it a second time.
rem
rem   announce-release.cmd                 announce what the site serves now
rem   announce-release.cmd --dry-run       show what would be sent, send nothing
rem   announce-release.cmd --build 1.68    announce a particular build
rem   announce-release.cmd --force         send again even if it was announced already
setlocal

set "HERE=%~dp0"
set "PY=%HERE%venv\Scripts\python.exe"
if not exist "%PY%" set "PY=C:\havoc9\serverlist\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=C:\havoc9\tools\python\python.exe"
if not exist "%PY%" (
    echo announce-release: no Python found. Looked in:
    echo   %HERE%venv\Scripts\python.exe
    echo   C:\havoc9\serverlist\venv\Scripts\python.exe
    echo   C:\havoc9\tools\python\python.exe
    exit /b 1
)

"%PY%" "%HERE%announce-release.py" %*
exit /b %ERRORLEVEL%

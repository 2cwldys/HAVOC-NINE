@echo off
REM The whole site on this PC, to try it: pages, accounts, the forum and the web client at
REM http://127.0.0.1:8090/, opened in the default browser. bin\local-site.js does the setup;
REM its notes say where this PC's accounts are kept (never in the checkout). Ctrl+C stops it.
where node >nul 2>&1 || (echo   [FAIL] Node.js 24 or newer is not on PATH& pause& exit /b 1)
node "%~dp0bin\local-site.js" --open %*
if errorlevel 1 pause

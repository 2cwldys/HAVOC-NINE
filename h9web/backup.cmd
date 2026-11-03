@echo off
setlocal
REM A backup of this PC's local site (local-site.cmd): its accounts database, the forum's
REM pictures and the modules' files, as one .h9backup file in
REM %USERPROFILE%\Documents\h9web-backups, where the newest 30 are kept. It is safe while the
REM site runs. secrets.json and data.key are not in it (README.txt section 10). Options after
REM the name go to "h9web-backup.js backup" and win over these, for example
REM   backup.cmd --keep 60
REM   backup.cmd --out E:\h9web-backups
REM backup-task.ps1 runs the same backup on a schedule. Started by double-click (cmd /c), it
REM waits for a key at the end; H9_NOPAUSE=1 stops that.
set "H9_PAUSE="
for %%x in (%cmdcmdline%) do if /i "%%~x"=="/c" set "H9_PAUSE=1"
if defined H9_NOPAUSE set "H9_PAUSE="
set "H9_RC=1"
where node >nul 2>&1 || (echo   [FAIL] Node.js 24 or newer is not on PATH& goto done)
set "H9_LOCAL=%LOCALAPPDATA%\h9web-local"
if defined H9WEB_LOCAL set "H9_LOCAL=%H9WEB_LOCAL%"
if not exist "%H9_LOCAL%\config.json" (echo   [FAIL] no local site in %H9_LOCAL%: start local-site.cmd once first& goto done)
node "%~dp0bin\h9web-backup.js" backup --config "%H9_LOCAL%\config.json" --out "%USERPROFILE%\Documents\h9web-backups" --keep 30 %*
set "H9_RC=%errorlevel%"
:done
if defined H9_PAUSE pause
exit /b %H9_RC%

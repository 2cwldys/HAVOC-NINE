@echo off
REM ---------------------------------------------------------------------------
REM  enter_userid.cmd -- use your havoc9.org account's player id in this install
REM
REM  Sign in on havoc9.org, open ACCOUNT and show your player id, then run this
REM  from this folder (H9XASH\) and paste it. Servers then see this install and
REM  the web client as the same player. The id it replaces is kept in
REM  user_id.ini.bak, and h9_regenerate_userid.bat makes a new random one any
REM  time. Takes effect on your next launch. See docs\CUSTOM_XASH_USERID.txt.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
echo.
echo  Paste your player id from havoc9.org (ACCOUNT), then press Enter.
echo  It is 32 characters, 0-9 and a-f. Keep it to yourself: whoever has it
echo  is you to H9's servers.
echo.
set "H9ID="
set /p "H9ID=Player id: "
if not defined H9ID (echo  Nothing entered; nothing was changed.& goto :done)
set "H9ID=%H9ID:"=%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0h9_userid.ps1" -SetId "%H9ID%"
:done
echo.
pause
endlocal

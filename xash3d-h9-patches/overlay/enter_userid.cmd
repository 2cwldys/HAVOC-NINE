@echo off
REM ---------------------------------------------------------------------------
REM  enter_userid.cmd -- use your havoc9.org account's player id in this install
REM
REM  The easy way needs no id at all: Link your Account in the game's main menu
REM  (or .link in chat on an H9 server) shows a code to approve on havoc9.org.
REM  This is the old way, and still works: sign in on havoc9.org, open ACCOUNT
REM  and show your player id, then run this from this folder (H9XASH\) and paste
REM  it. The game takes it and protects it at its next start; servers then see
REM  this install and the web client as the same player. h9_regenerate_userid.bat
REM  makes a new random id any time. See docs\CUSTOM_XASH_USERID.txt.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
echo.
echo  Paste your player id from havoc9.org (ACCOUNT), then press Enter.
echo  It is 32 characters, 0-9 and a-f. Keep it to yourself: whoever has it
echo  is you to H9's servers. Easier: Link your Account in the game's main menu.
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

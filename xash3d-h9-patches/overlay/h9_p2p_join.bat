@echo off
REM ---------------------------------------------------------------------------
REM  h9_p2p_join.bat <invite code> -- joins a friend's game through the P2P relay
REM  (docs\P2P_JOIN.txt).
REM
REM      h9_p2p_join.bat H9-7KQMX-2PDRT
REM
REM  It redeems the code, waits until the relay answers, then starts the game with
REM  +connect <the address it prints> and keeps the helper running until the game
REM  ends. The code is good once and for ten minutes. A link that ends in the code
REM  works too.
REM
REM  You need Node.js 20 or newer (https://nodejs.org) and the relay's address: either
REM  service= in p2p.ini (copy p2p.ini.example; the host tells you the address) or
REM      h9_p2p_join.bat H9-7KQMX-2PDRT --service https://relay.example.org
REM
REM  Other options: --no-game (print the address, start nothing: type
REM  connect <address> in a game that is running, or set start_game=0 in p2p.ini),
REM  --relay-only (never exchange network addresses with the host).
REM
REM  Source: TSM\xash3d-h9-patches\overlay\h9_p2p_join.bat -- edit it there.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
if "%~1"=="" goto :usage
call "%~dp0h9_p2p_find.bat"
if errorlevel 1 goto :failed
"%P2PNODE%" "%P2PHELPER%" play %* --ini "%~dp0p2p.ini"
set "P2PEXIT=%ERRORLEVEL%"
if "%P2PEXIT%"=="0" goto :done
echo.
echo [p2p] The join ended with code %P2PEXIT%. The line above says why.
goto :failed

:usage
echo Usage: h9_p2p_join.bat ^<invite code^> [--service ^<relay address^>] [--no-game] [--relay-only]
echo The code looks like H9-7KQMX-2PDRT and comes from the host.

:failed
echo.
pause
endlocal
exit /b 1

:done
endlocal

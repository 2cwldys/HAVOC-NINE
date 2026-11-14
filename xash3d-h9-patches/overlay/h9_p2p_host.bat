@echo off
REM ---------------------------------------------------------------------------
REM  h9_p2p_host.bat -- runs the P2P helper beside your game, so that friends can
REM  join it without a forwarded port (docs\P2P_JOIN.txt).
REM
REM  You need
REM    * Node.js 20 or newer (https://nodejs.org),
REM    * p2p.ini beside this file: copy p2p.ini.example to p2p.ini and fill in
REM      service= (the relay's address) and token= (the host token its owner gave you),
REM    * the game running, with  h9_p2p 1  typed in its console.
REM
REM  Leave this window open while friends play. In the game's console,
REM  h9_p2p_invite <label> makes an invite: the code is printed there. Ctrl+C here
REM  (or closing the window) closes the path; every friend and invite goes with it.
REM
REM  Anything after the name goes to the helper: --idle-exit <minutes>, --service <url>.
REM  Windows may ask whether Node.js may use the network the first time: the helper
REM  only talks to the relay, to your game on this PC and, for an invite that says
REM  direct, to that friend.
REM
REM  Source: TSM\xash3d-h9-patches\overlay\h9_p2p_host.bat -- edit it there.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
call "%~dp0h9_p2p_find.bat"
if errorlevel 1 goto :failed
if not exist "%~dp0p2p.ini" goto :noini
"%P2PNODE%" "%P2PHELPER%" host --ini "%~dp0p2p.ini" %*
set "P2PEXIT=%ERRORLEVEL%"
if "%P2PEXIT%"=="0" goto :done
echo.
echo [p2p] The helper ended with code %P2PEXIT%. The line above says why.
goto :failed

:noini
echo [p2p] There is no p2p.ini beside this file.
echo [p2p] Copy p2p.ini.example to p2p.ini, put the relay's address in service= and your host token in token=, and run this again.

:failed
echo.
pause
endlocal
exit /b 1

:done
endlocal

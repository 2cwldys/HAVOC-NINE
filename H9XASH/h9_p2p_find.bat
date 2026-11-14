@echo off
REM ---------------------------------------------------------------------------
REM  h9_p2p_find.bat -- finds Node.js 20 or newer and the P2P helper.
REM
REM  Called by h9_p2p_host.bat, h9_p2p_join.bat and h9xash_server.bat. It sets
REM  P2PNODE (the node.exe) and P2PHELPER (the helper's p2p\bin\h9p2p.js) and
REM  returns 0, or says what is missing and returns 1. Nothing is downloaded or
REM  installed. Run on its own it only prints what it found.
REM
REM  The helper is looked for in this order:
REM    1. %H9_P2P_HELPER%, the full path of h9p2p.js
REM    2. p2p\bin\h9p2p.js beside this file (the repository's p2p folder copied in)
REM    3. ..\p2p\bin\h9p2p.js (the repository: H9XASH sits next to p2p\)
REM
REM  Source: TSM\xash3d-h9-patches\overlay\h9_p2p_find.bat -- edit it there.
REM ---------------------------------------------------------------------------
set "P2PNODE="
set "P2PHELPER="
for /f "delims=" %%n in ('where node 2^>nul') do if not defined P2PNODE set "P2PNODE=%%n"
if not defined P2PNODE goto :nonode
set "P2PNODEV="
for /f "tokens=1 delims=." %%v in ('"%P2PNODE%" --version 2^>nul') do set "P2PNODEV=%%v"
if not defined P2PNODEV goto :nonode
set "P2PNODEV=%P2PNODEV:v=%"
set "P2PNODEN=0"
set /a "P2PNODEN=%P2PNODEV%" 2>nul
if %P2PNODEN% LSS 20 goto :oldnode

if defined H9_P2P_HELPER if exist "%H9_P2P_HELPER%" set "P2PHELPER=%H9_P2P_HELPER%"
if not defined P2PHELPER if exist "%~dp0p2p\bin\h9p2p.js" set "P2PHELPER=%~dp0p2p\bin\h9p2p.js"
if not defined P2PHELPER if exist "%~dp0..\p2p\bin\h9p2p.js" set "P2PHELPER=%~dp0..\p2p\bin\h9p2p.js"
if not defined P2PHELPER goto :nohelper
if "%~1"=="show" echo [p2p] node %P2PNODEV%: %P2PNODE%
if "%~1"=="show" echo [p2p] helper: %P2PHELPER%
exit /b 0

:nonode
echo [p2p] Node.js is not installed. The P2P helper needs Node.js 20 or newer:
echo [p2p] get the LTS installer from https://nodejs.org and run this again. Nothing is downloaded by this script.
exit /b 1

:oldnode
echo [p2p] Node.js %P2PNODEV% is too old: the P2P helper needs Node.js 20 or newer (https://nodejs.org, the LTS installer).
exit /b 1

:nohelper
echo [p2p] The helper (p2p\bin\h9p2p.js) is not beside this file or in the folder above it.
echo [p2p] Copy the p2p folder of the H9 repository next to this one, or set H9_P2P_HELPER to the full path of p2p\bin\h9p2p.js.
exit /b 1

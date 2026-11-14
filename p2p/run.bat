@echo off
rem Starts the P2P relay (bin\h9rv.js) from relay.config.json beside this file. README.txt explains every key.
rem
rem   run.bat                  run the relay; Ctrl+C stops it
rem   run.bat --check          read the config and the hosts file, say what is wrong, start nothing
rem   run.bat token Mike       make a host token for Mike: its hash goes into hosts.json, the token is shown once
rem   run.bat hosts list       who has a token (never the tokens);  run.bat hosts remove ^<id^>
rem
rem The first run makes relay.config.json and hosts.json from the examples and stops, so that you fill them in; h9rv itself
rem refuses a config or a hosts file that still holds the examples' CHANGE-ME values. Nothing is downloaded or installed.
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo   [FAIL] Node.js 20 or newer is needed and was not found: https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo   [FAIL] this Node.js is older than 20: https://nodejs.org
  pause
  exit /b 1
)

if /i "%~1"=="token" goto hostsfile
if /i "%~1"=="hosts" goto hostsfile

set made=0
if not exist relay.config.json (
  copy /y relay.config.example.json relay.config.json >nul
  set made=1
)
if not exist hosts.json (
  copy /y hosts.example.json hosts.json >nul
  set made=1
)
if "%made%"=="1" (
  echo run.bat: made relay.config.json and hosts.json from the examples. Now:
  echo   1. edit relay.config.json: publicUdp.host is the name or address that players reach this machine by
  echo   2. make a token for each host:   run.bat token Mike
  echo   3. start the relay:              run.bat
  pause
  exit /b 1
)

rem relay.site.ini (never committed) holds H9RV_SITE_URL=<address of the site> for auth.mode h9web
if exist relay.site.ini for /f "usebackq tokens=1,* delims==" %%a in ("relay.site.ini") do if /i "%%a"=="H9RV_SITE_URL" set "H9RV_SITE_URL=%%b"
node bin\h9rv.js --config relay.config.json %*
set rc=%errorlevel%
if not "%rc%"=="0" pause
exit /b %rc%

:hostsfile
node bin\h9rv.js %* --hosts hosts.json
exit /b %errorlevel%

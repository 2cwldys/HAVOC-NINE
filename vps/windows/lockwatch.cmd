@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ===========================================================================
REM  lockwatch.cmd -- watches C:\setup\incoming for a received file nothing can read.
REM
REM  THE FAULT IT WATCHES FOR. A delivery arrives over SFTP and receive-deploy.ps1
REM  hashes each file as it lands. The session that wrote it sometimes still holds
REM  the handle, so the read fails with
REM      The process cannot access the file because it is being used by another process
REM  and the delivery stops. On 2026-11-19 that killed two deliveries of build 1.67
REM  in a row, both on blobs-6.tar, after all 10.9 GB had already arrived; the file
REM  hashed perfectly as soon as the handle went.
REM
REM  THE FIX IS NOT HERE. receive-deploy.ps1's Sha() now waits for the handle --
REM  seven retries over about 36 s -- which is what actually ends that failure, and
REM  it costs nothing when the handle is free. This script is the thing you run when
REM  a handle is held for longer than that, to see what is going on.
REM
REM  WHY IT REPORTS AND DOES NOT ACT. It cannot safely tell a stuck handle from a
REM  transfer still in progress. The obvious test -- has the file stopped growing --
REM  does not work: Windows reports a size of 0 for a file held exclusively, so a
REM  file being written looks exactly like a file that has stalled. That was measured,
REM  not assumed: a test that wrote to a locked file continuously was still reported
REM  as "unchanged and still locked". A watchdog that cannot tell those apart must not
REM  kill the receiver, because doing so during a real upload aborts the delivery.
REM  So: it names the file and the holder, and "release" is a separate thing you run
REM  once you have looked.
REM
REM  USAGE
REM      lockwatch.cmd start     watch in the background, logging what it sees
REM      lockwatch.cmd stop      stop watching
REM      lockwatch.cmd status    whether it is watching, and the end of its log
REM      lockwatch.cmd once      look now and report. Exit 0 nothing locked,
REM                              1 something is locked, 2 bad usage
REM      lockwatch.cmd release   stop sftp-server.exe, to free a handle you have
REM                              decided is stuck. It starts again by itself on the
REM                              next transfer. NEVER run this during an upload.
REM
REM  For a holder that is an orphaned sshd session rather than sftp-server, use
REM  h9_find_lock.ps1: it names every sshd and marks the service listener and your own
REM  session as the two that must never be ended.
REM
REM  Stopping is by flag file, not by killing a process, so the loop leaves cleanly
REM  between passes instead of dying partway through one.
REM
REM  Overridable in the environment, which is also how this is tested off the host:
REM      H9_INCOMING             default C:\setup\incoming
REM      H9_LOCKWATCH_LOG        default C:\havoc9\logs\lockwatch.log
REM      H9_LOCKWATCH_FLAG       default C:\havoc9\data\lockwatch.run
REM      H9_LOCKWATCH_INTERVAL   seconds between passes, default 30
REM ===========================================================================

set "INCOMING=%H9_INCOMING%"
if not defined INCOMING set "INCOMING=C:\setup\incoming"
set "LOGFILE=%H9_LOCKWATCH_LOG%"
if not defined LOGFILE set "LOGFILE=C:\havoc9\logs\lockwatch.log"
set "FLAG=%H9_LOCKWATCH_FLAG%"
if not defined FLAG set "FLAG=C:\havoc9\data\lockwatch.run"
set "INTERVAL=%H9_LOCKWATCH_INTERVAL%"
if not defined INTERVAL set "INTERVAL=30"

for %%D in ("%LOGFILE%") do if not exist "%%~dpD" md "%%~dpD" 2>nul
for %%D in ("%FLAG%") do if not exist "%%~dpD" md "%%~dpD" 2>nul

set "ACTION=%~1"
if not defined ACTION set "ACTION=status"

if /i "%ACTION%"=="start"   goto :do_start
if /i "%ACTION%"=="stop"    goto :do_stop
if /i "%ACTION%"=="status"  goto :do_status
if /i "%ACTION%"=="once"    goto :do_once
if /i "%ACTION%"=="release" goto :do_release
if /i "%ACTION%"=="loop"    goto :do_loop

echo usage: %~nx0 start ^| stop ^| status ^| once ^| release
exit /b 2

REM ---------------------------------------------------------------------------
:do_start
if exist "%FLAG%" (
    echo lockwatch is already watching. "%~nx0 status" to look, "stop" to end it.
    exit /b 1
)
> "%FLAG%" echo started %date% %time%
start "h9-lockwatch" /min cmd /c call "%~f0" loop
call :log "started: watching %INCOMING%, a pass every %INTERVAL%s. It reports only; 'release' acts."
exit /b 0

REM ---------------------------------------------------------------------------
:do_stop
if not exist "%FLAG%" (
    echo lockwatch is not watching.
) else (
    del /q "%FLAG%" 2>nul
    call :log "stopped: the flag is gone, the loop leaves within one pass"
)
taskkill /f /fi "WINDOWTITLE eq h9-lockwatch*" >nul 2>&1
exit /b 0

REM ---------------------------------------------------------------------------
:do_status
if exist "%FLAG%" (echo lockwatch : WATCHING) else (echo lockwatch : not watching)
echo incoming  : %INCOMING%
echo log       : %LOGFILE%
echo pass      : every %INTERVAL%s, report only
tasklist /fi "imagename eq sftp-server.exe" 2>nul | find /i "sftp-server.exe" >nul && echo sftp      : sftp-server.exe is running right now || echo sftp      : no sftp-server.exe
if not exist "%LOGFILE%" goto :status_end
echo --- the end of the log ---
powershell -NoProfile -Command "Get-Content -LiteralPath '%LOGFILE%' -Tail 8" 2>nul || echo   (read %LOGFILE% for it)
:status_end
exit /b 0

REM ---------------------------------------------------------------------------
:do_once
call :scan
exit /b %NLOCKED%

REM ---------------------------------------------------------------------------
:do_release
call :scan
if "%NLOCKED%"=="0" (
    call :log "release: nothing in %INCOMING% is locked; doing nothing"
    exit /b 0
)
tasklist /fi "imagename eq sftp-server.exe" 2>nul | find /i "sftp-server.exe" >nul
if errorlevel 1 (
    call :log "release: %NLOCKED% file(s) locked, but no sftp-server.exe. An orphaned sshd session may hold them: run h9_find_lock.ps1, which marks the listener and your own session as the ones never to end."
    exit /b 1
)
taskkill /f /im sftp-server.exe >nul 2>&1
if errorlevel 1 (
    call :log "release: could not stop sftp-server.exe"
    exit /b 1
)
call :log "release: stopped sftp-server.exe, which held %NLOCKED% locked file(s). It starts again by itself on the next transfer."
exit /b 0

REM ---------------------------------------------------------------------------
:do_loop
call :log "loop: watching"
:loop_top
if not exist "%FLAG%" (
    call :log "loop: the flag is gone, leaving"
    exit /b 0
)
call :scan
timeout /t %INTERVAL% /nobreak >nul 2>&1
goto :loop_top

REM ---------------------------------------------------------------------------
REM One look. Sets NLOCKED. Reports; never acts.
:scan
set "NLOCKED=0"
if not exist "%INCOMING%" goto :eof

REM Opening for append writes nothing, costs nothing whatever the file's size, and
REM fails exactly when another process holds the file. Note the SIZE of a file that
REM fails this test cannot be trusted: Windows reports 0 for a file held exclusively.
for /r "%INCOMING%" %%F in (*) do (
    ( >>"%%~fF" call ) 2>nul || (
        set /a NLOCKED+=1
        call :log "  locked: %%~fF"
    )
)

if "%NLOCKED%"=="0" goto :eof
tasklist /fi "imagename eq sftp-server.exe" 2>nul | find /i "sftp-server.exe" >nul
if errorlevel 1 (
    call :log "%NLOCKED% file(s) locked and no sftp-server.exe: an orphaned sshd session is the usual holder. h9_find_lock.ps1 names them."
) else (
    call :log "%NLOCKED% file(s) locked, sftp-server.exe is running. If a delivery is uploading this is normal and will clear; receive-deploy waits about 36 s for it. If nothing is uploading, '%~nx0 release' frees it."
)
goto :eof

REM ---------------------------------------------------------------------------
:log
>>"%LOGFILE%" echo [%date% %time%] %~1
echo %~1
goto :eof

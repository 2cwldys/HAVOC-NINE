@echo off
REM ===========================================================================
REM  xash.bat -- builds and assembles H9XASH: The Specialists 3.0 with the H9TE
REM              client, on Xash3D FWGS
REM
REM  Usage:  xash.bat            engine, then assemble
REM          xash.bat engine     build TSM\xash3d-fwgs (32-bit, MSVC) into H9XASH
REM          xash.bat assemble   lay stock TS 3.0, reTS, the H9TE client and the Xash
REM                              overlay into H9XASH, copy your Half-Life's valve\,
REM                              then the server side (addons, below)
REM          xash.bat addons     only the server side: Metamod, AMXX with ts_matchmode
REM                              and RCBot from the live install. build.bat runs this
REM                              after every deploy, so H9XASH hosts what was built.
REM          xash.bat assets     only the client files: the H9TE client from export\ts
REM                              and the overlay, keeping any file newer in H9XASH.
REM                              export.bat runs this before it copies H9XASH, so
REM                              H9XASH carries the same sounds, sprites, maps and
REM                              menus as the Steam install.
REM
REM  TSM IS THE SOURCE OF TRUTH. H9XASH is generated: edit TSM\xash3d-h9-patches\overlay
REM  and the patches beside this script, never the copies in H9XASH. export.bat carries
REM  H9XASH into export\ and the git mirror, without valve\ (see README_H9XASH.txt).
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."
set "TSM=%CD%"

REM ---- edit these if your installs move ----------------------------------------
set "HLROOT=D:\SteamLibrary\steamapps\common\Half-Life"
REM The SDL2 version FWGS's own Windows build pins (.github\workflows\c-cpp.yml).
set "SDLVER=2.32.10"
REM Pinned by engine\client\avi\avi_ffmpeg.h's AVI_ValidateFFmpegVersion() check
REM (libavutil 61 / libavformat 63 / libavcodec 63 / libswresample 7 / libswscale 10).
REM Unlike SDL2 this is NOT auto-fetched: no 32-bit Windows build of FFmpeg 9.0.x
REM exists prebuilt anywhere, so it's built once from source (MSYS2 MINGW32, i686
REM cross-toolchain) and the result kept in deps\ like SDL2's own devel package.
set "FFMPEGVER=9.0.2"
REM ---------------------------------------------------------------------------

set "H9=%TSM%\H9XASH"
set "FWGS=%TSM%\xash3d-fwgs"
set "XASH=%TSM%\xash3d-h9-patches"
set "STAGE=%XASH%\stage"
set "SDL=%XASH%\deps\SDL2-%SDLVER%"
set "FFMPEG=%XASH%\deps\ffmpeg-%FFMPEGVER%"
set "WEB=%TSM%\webassembly-patch"

set "DO_ENGINE=1"
set "DO_ASSEMBLE=1"
set "DO_ADDONS=1"
set "DO_ASSETS=0"
if /i "%~1"=="engine" set "DO_ASSEMBLE=0"
if /i "%~1"=="engine" set "DO_ADDONS=0"
if /i "%~1"=="assemble" set "DO_ENGINE=0"
if /i "%~1"=="addons" set "DO_ENGINE=0"
if /i "%~1"=="addons" set "DO_ASSEMBLE=0"
if /i "%~1"=="assets" set "DO_ENGINE=0"
if /i "%~1"=="assets" set "DO_ASSEMBLE=0"
if /i "%~1"=="assets" set "DO_ADDONS=0"
if /i "%~1"=="assets" set "DO_ASSETS=1"

if "%DO_ENGINE%"=="1" call :engine || goto :fail
if "%DO_ASSEMBLE%"=="1" call :assemble || goto :fail
if "%DO_ADDONS%"=="1" call :addons || goto :fail
if "%DO_ASSETS%"=="1" call :assets || goto :fail
echo.
echo --- H9XASH ready: %H9% ---
goto :eof

:fail
echo.
echo [FAIL] xash.bat stopped -- see the message above.
exit /b 1


REM ===========================================================================
:engine
echo --- engine: %FWGS% ---
if not exist "%FWGS%\wscript" (
    echo [ERROR] no engine source. Get it with:
    echo         git clone --recursive https://github.com/FWGS/xash3d-fwgs "%FWGS%"
    exit /b 1
)

if not exist "%SDL%\lib\x86\SDL2.dll" (
    echo   fetching SDL2 %SDLVER%
    if not exist "%XASH%\deps" mkdir "%XASH%\deps"
    curl -sSL -o "%XASH%\deps\SDL2-devel-%SDLVER%-VC.zip" "https://github.com/libsdl-org/SDL/releases/download/release-%SDLVER%/SDL2-devel-%SDLVER%-VC.zip" || exit /b 1
    tar -xf "%XASH%\deps\SDL2-devel-%SDLVER%-VC.zip" -C "%XASH%\deps" || exit /b 1
)

if not exist "%FFMPEG%\lib\avutil-61.dll" (
    echo [ERROR] no FFmpeg %FFMPEGVER% build at %FFMPEG%
    echo         SDL2 fetches itself; FFmpeg doesn't -- no 32-bit Windows build of
    echo         9.0.x exists prebuilt anywhere. Build it once from source with the
    echo         MSYS2 MINGW32 i686 cross-toolchain, installing headers+DLLs into
    echo         that folder ^(include\ and lib\^), then re-run this.
    exit /b 1
)

REM The four webassembly patches, then H9's own. Only where there is a .git to test
REM against; a patch that is already in place (it reverses cleanly) is skipped.
REM Before adding, editing, splitting, or removing any patch below, read AND
REM update patches\PATCH_CHANGELOG.md -- a stale patch here does not error
REM until the next full rebuild, with no clue which one broke it.
if exist "%FWGS%\.git" (
    call :patch "%FWGS%\3rdparty\library_suffix" "%WEB%\engine-library_suffix.patch" || exit /b 1
    call :patch "%FWGS%" "%WEB%\engine.patch" || exit /b 1
    call :patch "%FWGS%\3rdparty\mainui" "%WEB%\engine-mainui.patch" || exit /b 1
    call :patch "%FWGS%\3rdparty\freevgui" "%WEB%\freevgui.patch" || exit /b 1
    call :patch "%FWGS%\3rdparty\freevgui" "%XASH%\patches\freevgui-h9-scheme.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-cloak.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-cmdbuf.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-chatmouse.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-suddendeath.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-xray.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-sprguard.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-spraypicker.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-spraycmd.patch" || exit /b 1
    call :patch "%FWGS%\3rdparty\mainui" "%XASH%\patches\mainui-h9-gamestartup.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-userid.patch" || exit /b 1
    call :patch "%FWGS%" "%XASH%\patches\engine-h9-presence.patch" || exit /b 1
)

REM Configured once; waf reconfigures by itself when a wscript changes.
REM --msvc_prerelease lets waf find a preview Visual Studio (this machine has only
REM VS 2026 Insiders); it changes nothing when a release one is installed.
REM
REM The config is ALSO redone whenever the cache still points at an SDL folder that
REM is not the one above: the patches folder moved twice (TSM\xash ->
REM TSM\xash3d-h9-patches) and a stale path made the link die with LNK1104
REM "cannot open file 'SDL2.lib'" on every build after the move.
pushd "%FWGS%"
set "RECONF="
if not exist "build\c4che\_cache.py" set "RECONF=1"
if exist "build\c4che\_cache.py" findstr /C:"%SDL%" "build\c4che\engine_cache.py" >nul 2>&1 || set "RECONF=1"
if exist "build\c4che\_cache.py" findstr /C:"%FFMPEG%" "build\c4che\engine_cache.py" >nul 2>&1 || set "RECONF=1"
if defined RECONF (
    call "%FWGS%\waf.bat" configure -s "%SDL%" -T release --msvc_prerelease --enable-ffmpeg --enable-ffmpeg-dlopen --ffmpeg-dir="%FFMPEG%" || (popd & exit /b 1)
)
call "%FWGS%\waf.bat" build || (popd & exit /b 1)
if exist "%STAGE%" rmdir /s /q "%STAGE%"
call "%FWGS%\waf.bat" install --destdir="%STAGE%" || (popd & exit /b 1)
popd

if not exist "%H9%\valve" mkdir "%H9%\valve"

REM The launcher, renamed on the way in: the engine still builds xash3d.exe (game_launch's
REM own target name, left alone so the source stays close to upstream), and this is the one
REM place that turns it into H9's own name. A stale copy under the old name is removed, so a
REM rename can never leave both sitting in H9XASH at once.
if exist "%H9%\xash3d.exe" del /q "%H9%\xash3d.exe"
copy /y "%STAGE%\xash3d.exe" "%H9%\HAVOC 9.exe" >nul || exit /b 1

for %%f in (xash.dll ref_gl.dll menu.dll filesystem_stdio.dll vgui.dll) do (
    copy /y "%STAGE%\%%f" "%H9%\" >nul || exit /b 1
)
if exist "%STAGE%\ref_soft.dll" copy /y "%STAGE%\ref_soft.dll" "%H9%\" >nul
copy /y "%SDL%\lib\x86\SDL2.dll" "%H9%\" >nul || exit /b 1
REM The 5 FFmpeg libraries themselves, plus the MinGW runtime DLLs they were built
REM against and load at runtime via their own import tables (checked with objdump -p):
REM libgcc_s_dw2-1 (all five), libwinpthread-1 (avutil), libbz2-1/libiconv-2/zlib1
REM (avformat), liblzma-5 (avcodec). None of these are Windows system DLLs, so without
REM them LoadLibrary on avutil-61.dll fails, AVI_Initailize() fails silently, and the
REM whole AVI subsystem -- this feature AND the existing logo.avi banner -- goes dark
REM with no error at all.
for %%f in (avutil-61.dll avformat-63.dll avcodec-63.dll swresample-7.dll swscale-10.dll libgcc_s_dw2-1.dll libwinpthread-1.dll libbz2-1.dll libiconv-2.dll liblzma-5.dll zlib1.dll) do (
    copy /y "%FFMPEG%\lib\%%f" "%H9%\" >nul || exit /b 1
)
copy /y "%STAGE%\valve\extras.pk3" "%H9%\valve\" >nul || exit /b 1

set "HEAD=unknown"
set "BASE=unknown"
for /f %%c in ('git -C "%FWGS%" rev-parse --short HEAD 2^>nul') do set "HEAD=%%c"
for /f %%c in ('git -C "%FWGS%" rev-parse --short origin/master 2^>nul') do set "BASE=%%c"
> "%H9%\ENGINE.txt.new" (
    echo Xash3D FWGS, 32-bit Windows, built by TSM\xash3d-h9-patches\xash.bat
    echo.
    echo Source:   https://github.com/FWGS/xash3d-fwgs  ^(GPL-3.0^)
    echo Upstream: master !BASE!
    echo Built:    branch h9 at !HEAD!, %DATE% %TIME%
    echo Patches:  webassembly-patch\*.patch, then from xash3d-h9-patches\patches:
    echo           freevgui-h9-scheme.patch, engine-h9-cloak.patch, engine-h9-cmdbuf.patch,
    echo           engine-h9-chatmouse.patch, engine-h9-suddendeath.patch, engine-h9-xray.patch,
    echo           engine-h9-sprguard.patch, engine-h9-spraypicker.patch, engine-h9-spraycmd.patch,
    echo           mainui-h9-gamestartup.patch, engine-h9-userid.patch, and
    echo           engine-h9-presence.patch
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%XASH%\dllmerge.ps1" "%H9%\ENGINE.txt" "%H9%\ENGINE.txt.new" || exit /b 1

REM Each DLL built from patched source carries ^<dll^>.patch beside it: what it is, then
REM the diff against upstream FWGS it was built with, paths from the xash3d-fwgs root so
REM "git apply" replays it on a fresh clone. Written from git on every build, so it always
REM matches the binary next to it.
call :dllpatch xash.dll "engine common" "3rdparty/library_suffix" "The engine. The webassembly patch's engine part (emscripten code, compiled out on Windows), engine-h9-cloak.patch (a server-side cloak on your own model), engine-h9-cmdbuf.patch (a command buffer that holds H9's configs), engine-h9-chatmouse.patch (mouse-look while typing in chat), engine-h9-suddendeath.patch (sudden-death fog read from the h9_fog_* server cvars into movevars; the four cvars exist from engine start, so config.cfg keeps them), engine-h9-spraypicker.patch (the spray picker is honored again: the bitmap picked from ts\logos is remapped into the player's own tempdecal.wad and sent under every protocol, an uploaded tempdecal.wad spraying unchanged when there is no pick), engine-h9-spraycmd.patch (the spray command: spray lists every picture on the ts\logos shelf, spray name equips one of them, spray off takes the pick off so an uploaded tempdecal sprays), engine-h9-sprguard.patch (the client's sprite query family answers 0 on a bad or unloaded HSPRITE instead of crashing -- the guard for installs with missing or foreign content), engine-h9-userid.patch (cl_h9_userid: a plain, regenerable client id salted per destination server and sent as the userinfo key h9_clientid, see docs/CUSTOM_XASH_USERID.txt), engine-h9-presence.patch (Discord Rich Presence via cl_presence.c, see docs/RICH_PRESENCE.txt), and a new CIN_MENUBG video slot plus extended menu API v2 (the main menu's video background; cvar-gated in menu.dll, falls back cleanly if off, missing, or FFmpeg isn't present)." "" || exit /b 1
call :dllpatch ref_gl.dll "ref/gl" "" "The OpenGL renderer. The webassembly patch's renderer part: MSR's bloom and scene MSAA (r_bloom, r_scene_msaa) and gl2_shim fixes, plus engine-h9-suddendeath.patch (movevars fog on a plain game) and engine-h9-xray.patch (renderfx 64: sudden death's glow shells, drawn through walls)." "" || exit /b 1
call :dllpatch filesystem_stdio.dll "filesystem" "" "The filesystem. The webassembly patch's one change here is emscripten-only." "" || exit /b 1
call :dllpatch menu.dll "" "3rdparty/mainui" "The main menu, mainui. engine-mainui.patch (webassembly), mainui-h9-gamestartup.patch (a track a config started keeps playing), and ui_background_video: a looping video background layered in ahead of the WON/Steam/color background, on by default, falling back to it cleanly if disabled, the asset is missing, or FFmpeg isn't available. ui_background_video_file names the file (h9xash.bat picks one at random from ts\menu_bg_videos.txt, same as it already does for menu music)." "" || exit /b 1
call :dllpatch vgui.dll "" "3rdparty/freevgui" "The VGUI1 library, FWGS's open freevgui. freevgui.patch (webassembly) and freevgui-h9-scheme.patch: H9's purple scheme." "Those six colours are all that H9's patched GoldSrc vgui.dll changes (18 bytes, see Half-Life\vgui.dll.patch); the textschemes, HUD and menu colours live in ts\, not here." || exit /b 1
call :dllpatch "HAVOC 9.exe" "game_launch" "" "The launcher, game_launch's own xash3d.exe target, copied in under H9's name by this script rather than renamed at the source. Its icon comes from game_launch\havoc9.ico (game.rc), the same picture as ts\game.ico." "" || exit /b 1

echo   engine !HEAD! installed into %H9%
exit /b 0

:dllpatch
REM %1 = the DLL, %2 = its paths in xash3d-fwgs or "", %3 = its submodule or "",
REM %4 = what it is and which patches went into it, %5 = one more line or "".
REM The diff is taken from the working tree, not from HEAD, so the patch holds what the DLL was
REM built from, committed or not. Staging goes through a temporary index, so the real index of
REM xash3d-fwgs is never touched. Each build adds a block to the patch history: when it was made,
REM the working tree status and the commits on h9 that touch these paths, all read from git.
REM dllmerge.ps1 folds the new file into the one beside the DLL, so nothing already in it is removed.
set "FINAL=%H9%\%~1.patch"
set "OUTP=%FINAL%.new"
> "%OUTP%" echo H9XASH %~1 -- built from patched source by TSM\xash3d-h9-patches\xash.bat
>> "%OUTP%" echo.
>> "%OUTP%" echo %~4
if not "%~5"=="" >> "%OUTP%" echo %~5
>> "%OUTP%" echo.
>> "%OUTP%" echo Below is the whole source change, paths from the xash3d-fwgs root; "git apply" replays it on a clone.
>> "%OUTP%" echo.
>> "%OUTP%" echo The notes above were written by an earlier build and are kept as they were. The history below is the record
>> "%OUTP%" echo of each build, read from git when that build was made. The newest block describes the diff at the end.
>> "%OUTP%" echo.
>> "%OUTP%" echo == Patch history ==
>> "%OUTP%" echo Generated %DATE% %TIME%, from branch h9 at !HEAD!, upstream FWGS master !BASE!:
>> "%OUTP%" echo Working tree status for these paths (anything listed is not committed, and is in the diff):
if not "%~2"=="" git -C "%FWGS%" status --short -- %~2 >> "%OUTP%"
if not "%~3"=="" git -C "%FWGS%\%~3" status --short >> "%OUTP%"
>> "%OUTP%" echo Commits on h9 since upstream that touch these paths, oldest first:
if not "%~2"=="" git -C "%FWGS%" log --reverse --format="%%h %%ad %%s" --date=short origin/master..HEAD -- %~2 >> "%OUTP%"
set "SUBBASE="
if not "%~3"=="" for /f %%c in ('git -C "%FWGS%" rev-parse origin/master:%~3 2^>nul') do set "SUBBASE=%%c"
if defined SUBBASE >> "%OUTP%" echo In %~3, since its upstream commit %SUBBASE%:
if defined SUBBASE git -C "%FWGS%\%~3" log --reverse --format="%%h %%ad %%s" --date=short %SUBBASE%..HEAD >> "%OUTP%"
>> "%OUTP%" echo.
if not "%~2"=="" call :workdiff %~2 >> "%OUTP%"
if defined SUBBASE call :workdiffsub "%~3" !SUBBASE! >> "%OUTP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%XASH%\dllmerge.ps1" "%FINAL%" "%OUTP%" || exit /b 1
exit /b 0

:workdiff
REM Diffs the paths given in the call against origin/master. The working tree is staged into
REM a temporary index first, so files not yet committed, new ones included, are in the diff.
set "TMPIDX=%TEMP%\h9idx-%RANDOM%%RANDOM%.idx"
set "GIT_INDEX_FILE=%TMPIDX%"
git -C "%FWGS%" read-tree HEAD && git -C "%FWGS%" add -A -- %* && git -C "%FWGS%" diff --cached origin/master -- %*
set "GIT_INDEX_FILE="
del "%TMPIDX%" 2>nul
exit /b 0

:workdiffsub
REM The same for a submodule, against the commit the superproject recorded at origin/master.
set "TMPIDX=%TEMP%\h9idx-%RANDOM%%RANDOM%.idx"
set "GIT_INDEX_FILE=%TMPIDX%"
git -C "%FWGS%\%~1" read-tree HEAD && git -C "%FWGS%\%~1" add -A && git -C "%FWGS%\%~1" diff --cached --src-prefix=a/%~1/ --dst-prefix=b/%~1/ %2
set "GIT_INDEX_FILE="
del "%TMPIDX%" 2>nul
exit /b 0

:patch
REM %1 = the repository, %2 = the patch.
git -C %1 apply --reverse --check %2 >nul 2>&1 && (echo   in place  %~nx2& exit /b 0)
REM Plain apply first: when the region's text already sits in the tree exactly as
REM the patch's pre-image (a patch updated here by hand before its commit), the
REM blob-level --3way pre-image check can never match. --3way stays as the
REM fallback for a checkout drifted from the base the patch was written against.
git -C %1 apply %2 >nul 2>&1 || git -C %1 apply --3way %2 >nul 2>&1 || (echo [ERROR] %~nx2 does not apply to %~1 -- resolve it by hand& exit /b 1)
echo   applied   %~nx2
exit /b 0


REM ===========================================================================
:commands
REM ts\commands.cfg is the game copy of COMMANDS.txt, so "exec commands" prints the
REM command reference. It is rebuilt from COMMANDS.txt on every assemble and assets run.
echo --- commands.cfg from COMMANDS.txt ---
powershell -NoProfile -ExecutionPolicy Bypass -File "%TSM%\make_commands_cfg.ps1"
if errorlevel 1 exit /b 1
exit /b 0

:assemble
echo --- assemble: %H9% ---
if not exist "%TSM%\ts3.0\ts\liblist.gam" (
    echo [ERROR] no stock TS 3.0 at %TSM%\ts3.0\ts -- install ts-3-final.exe there
    exit /b 1
)
if not exist "%TSM%\export\reTS\ts" (
    echo [ERROR] no reTS at %TSM%\export\reTS
    exit /b 1
)
if not exist "%TSM%\export\ts\maps" (
    echo [ERROR] no H9TE client at %TSM%\export\ts -- run build.bat first
    exit /b 1
)

REM Robocopy codes 0-7 are success, 8 and up are failure.

REM 1. Stock TS 3.0 -- only files H9XASH does not have yet. The base never changes,
REM    and this way a re-run neither undoes the layers above it nor resets the
REM    config.cfg Xash keeps your settings in. liblist.gam keeps its 2007 date,
REM    which keeps Xash from regenerating gameinfo.txt over the overlay's.
robocopy "%TSM%\ts3.0\ts" "%H9%\ts" /E /XC /XN /XO /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
echo   1 stock TS 3.0

REM 2. reTS: client.dll, mp.dll, delta.lst. addons\ is Metamod/AMXX, server-side.
robocopy "%TSM%\export\reTS\ts" "%H9%\ts" /E /XD addons /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
echo   2 reTS

REM 3. The H9TE client. cl_dlls\ is left out on purpose: its client.dll carries the
REM    Steam-only binary cloak patch, and on Xash the engine does that job
REM    (engine-h9-cloak.patch) -- so reTS's own client.dll from layer 2 stays.
robocopy "%TSM%\export\ts" "%H9%\ts" /E /XD addons cl_dlls /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
echo   3 H9TE client

REM 4. The Xash overlay.
call :commands || exit /b 1
robocopy "%XASH%\overlay" "%H9%" /E /XF networking.ini /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
REM networking.ini is the player's file once it exists: a fresh install gets the template,
REM and a rebuild keeps whatever was edited there.
if not exist "%H9%\networking.ini" copy /y "%XASH%\overlay\networking.ini" "%H9%\" >nul
echo   4 Xash overlay

REM 5. Valve's Half-Life content, from YOUR install. Never exported: it is Valve's,
REM    and a copy of the repo has to bring its owner's own Half-Life.
if exist "%HLROOT%\valve\liblist.gam" (
    robocopy "%HLROOT%\valve" "%H9%\valve" /E /XF extras.pk3 /NJH /NJS /NDL /NFL /NP >nul
    if errorlevel 8 exit /b 1
    echo   5 valve\ from %HLROOT%
) else (
    echo   [WARN] no Half-Life at %HLROOT% -- copy your valve\ folder into %H9% by hand
)
exit /b 0


REM ===========================================================================
:assets
REM Layers 3 and 4 again, on every export: new and changed sounds, sprites, maps,
REM resource and textschemes reach H9XASH as they reach the Steam install. /XO keeps
REM any file that is NEWER in H9XASH -- edits made there, and what the game writes as
REM it runs -- so only what TSM changed since goes in.
echo --- assets: %H9% ---
if not exist "%TSM%\export\ts\maps" (
    echo [ERROR] no H9TE client at %TSM%\export\ts -- run build.bat first
    exit /b 1
)
robocopy "%TSM%\export\ts" "%H9%\ts" /E /XO /XD addons cl_dlls /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
echo   3 H9TE client
call :commands || exit /b 1
robocopy "%XASH%\overlay" "%H9%" /E /XO /XF networking.ini /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
if not exist "%H9%\networking.ini" copy /y "%XASH%\overlay\networking.ini" "%H9%\" >nul
echo   4 Xash overlay
exit /b 0

REM ===========================================================================
:addons
REM 6. Hosting H9 matches: Metamod, AMXX with H9's plugins and configs, and RCBot,
REM    copied from the live install -- where build.bat deploys ts_matchmode -- so
REM    H9XASH runs it exactly as the Steam TS install does. Its logs\ stay behind,
REM    and so does rcbot's bot_playerids.ini, which is the live server's own state.
REM
REM    ts_advertise.cfg is the one file not copied: the live one holds the Discord bot
REM    token, and a local test server would post its matches to Discord. H9XASH gets
REM    TSM's empty template, once -- the plugin loads and stays unconfigured until a
REM    token is put in H9XASH's own copy, which is never overwritten.
if not exist "%HLROOT%\ts\addons\metamod\dlls\metamod.dll" (
    echo   [WARN] no Metamod at %HLROOT%\ts\addons -- H9XASH cannot host H9 matches,
    echo          and its gameinfo.txt loads Metamod: point gamedll at dlls/mp.dll
    exit /b 0
)
robocopy "%HLROOT%\ts\addons" "%H9%\ts\addons" /E /XD logs /XF ts_advertise.cfg /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
if not exist "%H9%\ts\addons\amxmodx\configs\ts_advertise.cfg" copy /y "%TSM%\ts_advertise.cfg" "%H9%\ts\addons\amxmodx\configs\" >nul
robocopy "%HLROOT%\rcbot" "%H9%\rcbot" /E /XF bot_playerids.ini /NJH /NJS /NDL /NFL /NP >nul
if errorlevel 8 exit /b 1
echo   6 Metamod, AMXX ^(ts_matchmode^) and RCBot from %HLROOT%
exit /b 0

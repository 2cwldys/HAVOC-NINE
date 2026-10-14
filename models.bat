@echo off
REM ---------------------------------------------------------------------------
REM  models.bat -- change which player models each class uses, per team
REM
REM  The pools live in ts_matchmode.cfg, on the tsm_classN lines, NOT in the .sma --
REM  the plugin only reads them. So this edits the cfg, which means no recompile:
REM  change a pool, restart the server, done.
REM
REM  Every edit is checked first, against the two limits that are invisible in the
REM  file and have taken the server down before:
REM
REM    * a model name over 22 characters is FATAL -- TS builds the path into a
REM      64-byte buffer unchecked, so the name is truncated and the server dies on
REM      Mod_NumForName with nothing in the AMXX log.
REM    * the class line is read into fixed buffers. Over them the list is cut off
REM      mid-name and the class silently falls back to the default model.
REM
REM  A change that would break either is REFUSED and nothing is written.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [models] node is not on PATH, and this needs it.
    echo          Install Node.js, or edit ts_matchmode.cfg by hand -- but mind the
    echo          22-character model name limit if you do.
    goto :done
)

if not exist "ts_matchmode.cfg" (
    echo [models] no ts_matchmode.cfg here. Run this from the folder that has it.
    goto :done
)

if "%~1"=="" goto :help

node "models.mjs" %*
goto :done

:help
echo.
echo   models.bat ^<command^>
echo.
echo     list                              show every class, both teams, with the
echo                                       lengths and anything that is wrong
echo     check                             the same thing ^(it always checks^)
echo     installed                         every model on disk, and which are in use
echo.
echo     set    ^<class^> ^<msr^|ins^> ^<a,b,c^>   replace that team's pool
echo     add    ^<class^> ^<msr^|ins^> ^<a,b^>     add to it
echo     rm     ^<class^> ^<msr^|ins^> ^<a,b^>     take out of it
echo.
echo   ^<class^> is the number or the name: 1 or Assault, 6 or Medic.
echo   An EMPTY pool is not a mistake -- it means that team keeps whatever model
echo   the player already had, which is what Breacher does.
echo.
echo   Examples:
echo     models.bat list
echo     models.bat add 1 msr repuheavy_fem_nhelm
echo     models.bat set 4 msr repuheavyw,repuheavyw_soot,repuheavyw_mud
echo     models.bat rm  7 ins XCCPRurik_wrecked
echo.
echo   The old file is kept as ts_matchmode.cfg.bak on every write.
echo   Restart the server afterwards so the cvars are re-read.
echo.
node "models.mjs" list

:done
endlocal

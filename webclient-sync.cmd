@echo off
rem webclient-sync.cmd -- keeps the web client in step with the engine: node tools\webclient-sync.mjs (--check, --watch, --force, --stage)
node "%~dp0tools\webclient-sync.mjs" %*
exit /b %errorlevel%

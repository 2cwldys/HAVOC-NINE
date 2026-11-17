@echo off
REM The one test entry point. Fully offline: it builds its own repositories
REM under D:\temp\chain-work\h9chain-tests and reads neither real tree.
py -3 -I "%~dp0test_h9chain.py" %*

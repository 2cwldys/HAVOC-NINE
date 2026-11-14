@echo off
rem Builds the helper's test programs (64-bit): g2p_cli.exe (the G2P on a file of lines), fake_helper.exe (a helper that misbehaves on purpose), helper_fuzz.exe.
rem usage: build_tests.bat [output folder]      default: the folder bin next to this file
rem Run them with the files named in their headers: g2p_parity.py, client_fuzz.py (the lab of tools\h9tts), helper_fuzz.exe <h9kokoro64.exe> <sessions>.
setlocal
set HERE=%~dp0
set OUT=%HERE%bin
if not "%~1"=="" set OUT=%~1
set VCVARS=C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvarsall.bat
if not exist "%VCVARS%" (
  echo vcvarsall.bat not found: %VCVARS%
  exit /b 1
)
call "%VCVARS%" x64 >nul 2>nul
if errorlevel 1 exit /b 1
if not exist "%OUT%" mkdir "%OUT%"
set CL_DLL=%HERE%..\..\..\reTS\cl_dll
set FLAGS=/nologo /O2 /MT /EHsc /std:c++17 /W3 /D_CRT_SECURE_NO_WARNINGS /I "%CL_DLL%" /I "%HERE%..\src" /Fo"%OUT%\\"
cl %FLAGS% /Fe"%OUT%\g2p_cli.exe" "%HERE%g2p_cli.cpp"
if errorlevel 1 exit /b 1
cl %FLAGS% /Fe"%OUT%\fake_helper.exe" "%HERE%fake_helper.cpp"
if errorlevel 1 exit /b 1
cl %FLAGS% /Fe"%OUT%\helper_fuzz.exe" "%HERE%helper_fuzz.cpp"
if errorlevel 1 exit /b 1
echo build ok: %OUT%
endlocal

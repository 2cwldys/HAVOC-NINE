@echo off
rem Builds the line pack tool (h9pk.exe, 64-bit) with the Visual Studio command-line compiler.
rem usage: build_tools.bat [output folder]      default: the folder bin next to this file
rem The tool uses only reTS\cl_dll\h9_tts_pack.h (the format the client reads).
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
cl /nologo /O2 /MT /EHsc /std:c++17 /W3 /D_CRT_SECURE_NO_WARNINGS /I "%HERE%..\..\reTS\cl_dll" /Fo"%OUT%\\" /Fe"%OUT%\h9pk.exe" "%HERE%h9pk.cpp"
if errorlevel 1 exit /b 1
echo build ok: %OUT%\h9pk.exe
endlocal

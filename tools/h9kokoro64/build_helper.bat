@echo off
rem Builds h9kokoro64.exe (64-bit, static CRT) with the Visual Studio command-line compiler. It needs only the sources in this folder and
rem reTS\cl_dll's shared headers (h9_tts_proto.h, h9_tts_catalogue.h, h9_tts_chains.h, h9_tts_fx.h, h9_tts_pack.h). ONNX Runtime is not linked:
rem onnxruntime.dll is loaded at run time from the folder of the exe.
rem usage: build_helper.bat [output folder]      default: the folder bin next to this file
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
cl /nologo /O2 /MT /EHsc /std:c++17 /W3 /GS /guard:cf /D_CRT_SECURE_NO_WARNINGS /I "%HERE%src" /I "%HERE%third_party\onnxruntime" /I "%HERE%..\..\reTS\cl_dll" /Fo"%OUT%\\" /Fe"%OUT%\h9kokoro64.exe" "%HERE%src\main.cpp" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /SUBSYSTEM:CONSOLE
if errorlevel 1 exit /b 1
echo build ok: %OUT%\h9kokoro64.exe
endlocal

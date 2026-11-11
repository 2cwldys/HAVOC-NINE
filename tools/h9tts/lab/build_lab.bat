@echo off
rem Builds the lab (kokoro_lab.exe) with the 32-bit compiler, the way the client library is built: static CRT, C++17.
rem usage: build_lab.bat [stage folder]      default: the folder stage next to this file; the exe goes to <stage>\ts\cl_dlls
setlocal
set HERE=%~dp0
set STAGE=%HERE%stage
if not "%~1"=="" set STAGE=%~1
set VCVARS=C:\Program Files\Microsoft Visual Studio\18\Insiders\VC\Auxiliary\Build\vcvarsall.bat
if not exist "%VCVARS%" (
  echo vcvarsall.bat not found: %VCVARS%
  exit /b 1
)
call "%VCVARS%" x86 >nul 2>nul
if errorlevel 1 exit /b 1
set CL_DLL=%HERE%..\..\..\reTS\cl_dll
if not exist "%STAGE%\ts\cl_dlls" mkdir "%STAGE%\ts\cl_dlls"
set OBJ=%STAGE%\obj
if not exist "%OBJ%" mkdir "%OBJ%"
cl /nologo /O2 /MT /EHsc /std:c++17 /W3 /D_CRT_SECURE_NO_WARNINGS /DWIN32 /D_WINDOWS /I "%CL_DLL%" /Fo"%OBJ%\\" /Fe"%STAGE%\ts\cl_dlls\kokoro_lab.exe" "%HERE%kokoro_lab.cpp" "%CL_DLL%\h9_tts_kokoro.cpp" "%CL_DLL%\h9_tts_kokoro_link.cpp" /link /LARGEADDRESSAWARE advapi32.lib winmm.lib
if errorlevel 1 exit /b 1
echo build ok: %STAGE%\ts\cl_dlls\kokoro_lab.exe
endlocal

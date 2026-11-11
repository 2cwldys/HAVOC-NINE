@echo off
rem Builds the C++ tests of the Kokoro voices into a folder with the address sanitizer on (64-bit): pack_fuzz.exe, mixer_test.exe and framewatch_test.exe. Run them with the files named in their headers.
rem usage: build_tests.bat [output folder]      default: the folder bin next to this file
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
cl /nologo /Od /Zi /MD /EHsc /std:c++17 /W3 /fsanitize=address /D_CRT_SECURE_NO_WARNINGS /I "%CL_DLL%" /Fo"%OUT%\\" /Fd"%OUT%\\" /Fe"%OUT%\pack_fuzz.exe" "%HERE%pack_fuzz.cpp"
if errorlevel 1 exit /b 1
cl /nologo /Od /Zi /MD /EHsc /std:c++17 /W3 /fsanitize=address /D_CRT_SECURE_NO_WARNINGS /I "%CL_DLL%" /Fo"%OUT%\\" /Fd"%OUT%\\" /Fe"%OUT%\mixer_test.exe" "%HERE%mixer_test.cpp"
if errorlevel 1 exit /b 1
cl /nologo /Od /Zi /MD /EHsc /std:c++17 /W3 /fsanitize=address /D_CRT_SECURE_NO_WARNINGS /I "%CL_DLL%" /Fo"%OUT%\\" /Fd"%OUT%\\" /Fe"%OUT%\framewatch_test.exe" "%HERE%framewatch_test.cpp"
echo build ok: %OUT%
endlocal

@echo off
setlocal
pushd "%~dp0" || exit /b 1
title Build wad2png.exe

where cl.exe >nul 2>nul
if not errorlevel 1 (
    echo Building with Microsoft C++ compiler...
    cl.exe /nologo /std:c++17 /O2 /EHsc wad2png.cpp /Fe:wad2png.exe
    if errorlevel 1 goto :failed
    goto :success
)

where g++.exe >nul 2>nul
if not errorlevel 1 (
    echo Building with MinGW g++...
    g++.exe -std=c++17 -O2 -static -static-libgcc -static-libstdc++ wad2png.cpp -o wad2png.exe
    if errorlevel 1 goto :failed
    goto :success
)

echo ERROR: No C++ compiler found.
echo Install Visual Studio Build Tools with "Desktop development with C++",
echo or install MinGW-w64 and add g++.exe to PATH, then run this script again.
goto :failed

:success
echo.
echo Build complete: "%~dp0wad2png.exe"
echo The executable uses no Python or third-party DLLs.
goto :end

:failed
echo.
echo Build failed. See the compiler output above.
:end
echo.
pause
popd

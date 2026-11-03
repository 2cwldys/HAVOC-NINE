@echo off
REM ===========================================================================
REM  build_webview.bat -- builds h9webview.dll, H9XASH's embedded web page for a
REM                       server's splash MOTD (Microsoft Edge WebView2)
REM
REM  Usage:  build_webview.bat [output folder]      (default: ..\stage\webview)
REM
REM  32-bit, MSVC, static CRT, with the WebView2 SDK's static loader linked in:
REM  the DLL needs nothing but Windows and the WebView2 runtime. xash.bat runs it
REM  with the engine and copies the DLL, its .patch and the SDK's licence into
REM  H9XASH. The SDK is NuGet's Microsoft.Web.WebView2, kept in ..\deps; it is
REM  fetched once when it is not there. h9webview.cpp says what the DLL does.
REM ===========================================================================
setlocal
set "HERE=%~dp0"
set "WV2VER=1.0.4258.31"
set "DEPS=%HERE%..\deps"
set "PKG=%DEPS%\Microsoft.Web.WebView2.%WV2VER%"
set "SDK=%PKG%\build\native"
set "OUT=%~1"
if "%OUT%"=="" set "OUT=%HERE%..\stage\webview"

if not exist "%SDK%\include\WebView2.h" (
    echo   fetching the WebView2 SDK %WV2VER%
    if not exist "%PKG%" mkdir "%PKG%"
    curl -sSL -o "%DEPS%\Microsoft.Web.WebView2.%WV2VER%.nupkg" "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/%WV2VER%" || exit /b 1
    tar -xf "%DEPS%\Microsoft.Web.WebView2.%WV2VER%.nupkg" -C "%PKG%" build/native/include/WebView2.h build/native/include/WebView2EnvironmentOptions.h build/native/x86/WebView2LoaderStatic.lib build/native/x86/WebView2Loader.dll build/native/x86/WebView2Loader.dll.lib LICENSE.txt NOTICE.txt Microsoft.Web.WebView2.nuspec || exit /b 1
)

REM The newest Visual Studio with the C++ tools, a preview one too (this machine has
REM only VS 2026 Insiders), set up for x86 from an x64 host.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [ERROR] no vswhere.exe: Visual Studio with the C++ tools is needed
    exit /b 1
)
set "VSDIR="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
    echo [ERROR] no Visual Studio with the C++ x86/x64 tools
    exit /b 1
)
set "PATH=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%PATH%"
call "%VSDIR%\VC\Auxiliary\Build\vcvarsall.bat" x64_x86 >nul || exit /b 1

if not exist "%OUT%" mkdir "%OUT%"
cl /nologo /LD /O2 /MT /EHsc /std:c++17 /W3 /GS /guard:cf /DUNICODE /D_UNICODE /DNDEBUG ^
   /I"%SDK%\include" /I"%HERE%." "%HERE%h9webview.cpp" /Fo"%OUT%\\" /Fe"%OUT%\h9webview.dll" ^
   /link /NOLOGO /DLL /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /GUARD:CF ^
   "%SDK%\x86\WebView2LoaderStatic.lib" urlmon.lib ole32.lib oleaut32.lib advapi32.lib user32.lib shell32.lib version.lib ws2_32.lib || exit /b 1
if not exist "%OUT%\h9webview.dll" exit /b 1

REM The .patch beside the DLL, as every DLL H9XASH builds from source carries: what it is,
REM how it was made, then its whole source.
set "P=%OUT%\h9webview.dll.patch"
> "%P%" echo H9XASH h9webview.dll -- built from source by TSM\xash3d-h9-patches\webview\build_webview.bat
>> "%P%" echo.
>> "%P%" echo The splash MOTD's embedded web page: a server's h9_motd "page", shown inside the MOTD panel with
>> "%P%" echo Microsoft Edge WebView2 (docs\H9_MOTD.txt). The engine loads it by name (cl_motd.c,
>> "%P%" echo engine-h9-motd.patch) and falls back to the page's picture or text without it.
>> "%P%" echo.
>> "%P%" echo Built: %DATE% %TIME%, 32-bit, MSVC /O2 /MT, against the WebView2 SDK %WV2VER% (NuGet
>> "%P%" echo Microsoft.Web.WebView2, its LICENSE.txt shipped as h9webview.WebView2-LICENSE.txt), with
>> "%P%" echo WebView2LoaderStatic.lib linked in: no WebView2Loader.dll is needed.
>> "%P%" echo.
>> "%P%" echo Below is the whole source: webview\h9webview.h, then webview\h9webview.cpp.
>> "%P%" echo.
type "%HERE%h9webview.h" >> "%P%"
>> "%P%" echo.
type "%HERE%h9webview.cpp" >> "%P%"
REM The SDK's licence asks that a binary carry it: it goes beside the DLL.
copy /y "%PKG%\LICENSE.txt" "%OUT%\h9webview.WebView2-LICENSE.txt" >nul || exit /b 1
echo   built h9webview.dll (WebView2 SDK %WV2VER%)
exit /b 0

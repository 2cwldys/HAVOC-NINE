@echo off
setlocal enabledelayedexpansion

echo Removing LM Studio junctions for local models...
set "LMS_MODELS=%USERPROFILE%\.lmstudio\models"

for /d %%P in ("models\*") do (
    for /d %%M in ("%%P\*") do (
        set "dest=%LMS_MODELS%\%%~nxP\%%~nxM"
        if exist "!dest!" (
            echo Removing: !dest!
            rmdir "!dest!"
        )
    )
)

echo Done.
pause

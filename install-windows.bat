@echo off
setlocal enabledelayedexpansion
REM Installs or upgrades Kiro Chat in VS Code. Double-click to run.
cd /d "%~dp0"

set "EXT_ID=local.kiro-chat"
set "VSIX=kiro-chat.vsix"

echo.
echo   Kiro Chat installer
echo   ===================
echo.

if not exist "%VSIX%" (
  echo   ERROR: %VSIX% is not in this folder.
  echo   Keep this file next to it, then run again.
  echo.
  pause
  exit /b 1
)

where code >nul 2>&1
if errorlevel 1 goto manual

REM Report what is already installed, if anything.
set "OLD="
for /f "tokens=1,2 delims=@" %%a in ('code --list-extensions --show-versions 2^>nul ^| findstr /i /c:"%EXT_ID%"') do set "OLD=%%b"

if defined OLD (
  echo   Found version !OLD! already installed.
  echo   Upgrading in place. Your settings are kept.
) else (
  echo   No previous version found. Installing fresh.
)
echo.

call code --install-extension "%VSIX%" --force
if errorlevel 1 goto manual

set "NEW="
for /f "tokens=1,2 delims=@" %%a in ('code --list-extensions --show-versions 2^>nul ^| findstr /i /c:"%EXT_ID%"') do set "NEW=%%b"

echo.
if defined NEW (
  echo   Installed version !NEW!.
) else (
  echo   Installed.
)
echo.
echo   Now close VS Code completely and open it again.
echo   Then click the Kiro icon in the bar down the left side.
echo.
echo   Note: extensions installed this way do not update themselves.
echo   To upgrade later, run this file again with a newer %VSIX%.
echo.
pause
exit /b 0

:manual
echo.
echo   Could not install automatically ^(the "code" command is not available^).
echo.
echo   Do it by hand instead, it takes about ten seconds:
echo     1. Open VS Code
echo     2. Click Extensions in the left bar
echo     3. Click the "..." menu at the top of that panel
echo     4. Choose "Install from VSIX..."
echo     5. Pick this file:
echo        %~dp0%VSIX%
echo.
echo   Installing over an older version is safe. Settings are kept.
echo.
pause
exit /b 1

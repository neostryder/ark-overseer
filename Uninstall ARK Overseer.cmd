@echo off
setlocal
set "PACKAGE=%~dp0"
set "VERIFY_ERROR=PowerShell 7 could not be verified. Download it from https://aka.ms/powershell"
set "UNPACK_ERROR=PowerShell 7 could not be unpacked. Download it from https://aka.ms/powershell"
where pwsh.exe >nul 2>nul
if not errorlevel 1 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%PACKAGE%tools\uninstall.ps1" %*
  exit /b %errorlevel%
)
set "ZIP=%PACKAGE%vendor\PowerShell-7.6.6-win-x64.zip"
for /f "tokens=1" %%H in ('certutil -hashfile "%ZIP%" SHA256 ^| findstr /r /i "^[0-9a-f][0-9a-f]*$"') do set "ACTUAL=%%H"
if /i not "%ACTUAL%"=="02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860" (
  echo %VERIFY_ERROR%
  pause
  exit /b 1
)
set "TEMPPS=%TEMP%\ark-overseer-pwsh-7.6.6"
if not exist "%TEMPPS%\pwsh.exe" (
  mkdir "%TEMPPS%" >nul 2>nul
  tar.exe -xf "%ZIP%" -C "%TEMPPS%"
)
for /r "%TEMPPS%" %%P in (pwsh.exe) do if exist "%%P" set "PWSH=%%P"
if not defined PWSH (
  echo %UNPACK_ERROR%
  pause
  exit /b 1
)
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%PACKAGE%tools\uninstall.ps1" %*
exit /b %errorlevel%

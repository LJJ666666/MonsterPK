@echo off
chcp 65001 >nul
REM ============================================================
REM  mobile-server / install-device.bat - double-click to run
REM  Finds Git Bash + adb, runs install-device.sh:
REM  installs 2 APKs + pushes backend pkg and scripts to the phone.
REM  Requires: USB debugging on, phone connected via USB cable.
REM  Paths: env override -> common locations -> clear error (no hardcoded abs path).
REM ============================================================
setlocal
cd /d "%~dp0"

REM ---- 1. locate bash ----
set "MPK_BASH="
if defined BASH if exist "%BASH%" set "MPK_BASH=%BASH%"
if not defined MPK_BASH if exist "C:\Users\Six\.workbuddy\binaries\PortableGit\versions\1.3.0\bin\bash.exe" set "MPK_BASH=C:\Users\Six\.workbuddy\binaries\PortableGit\versions\1.3.0\bin\bash.exe"
if not defined MPK_BASH if exist "D:\software\WorkBuddy\resources\vendor\PortableGit\bin\bash.exe" set "MPK_BASH=D:\software\WorkBuddy\resources\vendor\PortableGit\bin\bash.exe"
if not defined MPK_BASH if exist "C:\Program Files\Git\bin\bash.exe" set "MPK_BASH=C:\Program Files\Git\bin\bash.exe"
if not defined MPK_BASH (
  echo [ERROR] Git Bash not found. Set env BASH to bash.exe and retry.
  goto :fail
)
echo [ms] bash = %MPK_BASH%

REM ---- 2. run installer (relative path; cwd is already mobile-server) ----
echo [ms] installing to phone...
"%MPK_BASH%" -lc "bash scripts/install-device.sh"
if errorlevel 1 goto :fail

echo.
echo [ms] DONE. On the phone, open Termux and run these 3 lines:
echo   termux-setup-storage
echo   bash /sdcard/mpk/device-setup.sh
echo   bash /sdcard/mpk/device-start.sh
echo.
pause
exit /b 0

:fail
echo.
echo [ms] FAILED. Check errors above. If adb not connected, check USB debugging + cable.
pause
exit /b 1

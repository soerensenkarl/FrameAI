@echo off
title FrameAI Prod Server
REM Starts the PROD Flask server on port 5000 AND the Cloudflare tunnel.
REM MUST be run from C:\FrameAI (the master-branch worktree).
REM The window title "FrameAI Prod Server" is used by 2_UPDATE_PROD.BAT
REM to find and close this window when shipping new code.
pushd "%~dp0"

REM --- Guard: refuse to run from the wrong worktree.
for /f "usebackq delims=" %%i in (`git rev-parse --abbrev-ref HEAD 2^>nul`) do set BRANCH=%%i
if /i not "%BRANCH%"=="master" (
  echo.
  echo ERROR: run_prod.bat must run from C:\FrameAI ^(master branch^).
  echo You are in a folder on branch: %BRANCH%
  echo Double-click the run_prod.bat in C:\FrameAI instead.
  echo.
  popd & pause & exit /b 1
)

REM --- Warn if Rhino GUI is open. It shares the single Cloud Zoo license
REM     with rhinoinside in prod, so having it open causes intermittent
REM     NotLicensedException on /generate-frame etc.
tasklist /FI "IMAGENAME eq Rhino.exe" 2>nul | find /I "Rhino.exe" >nul
if not errorlevel 1 (
  echo.
  echo ================================================================
  echo   WARNING: Rhino 8 ^(GUI^) is running on this PC.
  echo   It shares the single Rhino license with prod and WILL cause
  echo   "Rhino license unavailable" errors for testers.
  echo   Close Rhino 8 on your desktop, then retry.
  echo ================================================================
  echo.
  pause
)

REM --- Kill anything already on port 5000 (defensive).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":5000 " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM --- Ensure the Cloudflare tunnel is running. If one is already alive
REM     from an earlier session, leave it alone (URL stays stable).
set CFLARED="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CFLARED% (
  echo WARNING: cloudflared not found at %CFLARED%.
  echo Prod will start but testers cannot reach it ^(no tunnel^).
) else (
  tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
  if errorlevel 1 (
    echo Starting Cloudflare named tunnel "frameai" ^(frame.syntropic.dk^)...
    start "FrameAI Tunnel" cmd /k %CFLARED% tunnel run frameai
  ) else (
    echo Cloudflare tunnel already running - leaving it alone.
  )
)

REM --- Start the Flask server.
set PORT=5000
set FRAMEAI_ENV=prod
pushd src
if not exist "..\.venv\Scripts\activate.bat" (
  echo.
  echo ERROR: could not find .venv at C:\FrameAI\.venv
  echo The venv should have been created during initial setup.
  popd & popd & pause & exit /b 1
)
call "..\.venv\Scripts\activate.bat"
python app.py
popd
popd
echo.
echo Prod server exited. Press any key to close this window.
pause >nul

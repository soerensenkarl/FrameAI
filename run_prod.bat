@echo off
title FrameAI Prod Server
REM Starts the PROD Flask server on port 5000 AND the Cloudflare tunnel
REM that exposes it publicly. Run this from C:\FrameAI.
REM The window title "FrameAI Prod Server" is used by 2_UPDATE_PROD.BAT
REM to find and close this window when shipping new code.

REM --- Kill anything already on port 5000 (defensive; 2_UPDATE_PROD.BAT
REM     does this too, but this lets you double-click run_prod.bat safely
REM     without first remembering to stop an old instance).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":5000 " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM --- Ensure the Cloudflare tunnel is running. If one is already alive
REM     from an earlier session, leave it alone (its URL stays stable).
set CFLARED="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CFLARED% (
  echo WARNING: cloudflared not found at %CFLARED%.
  echo Prod will start but testers cannot reach it ^(no tunnel^).
) else (
  tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
  if errorlevel 1 (
    echo Starting Cloudflare tunnel in its own window...
    start "FrameAI Tunnel" cmd /k %CFLARED% tunnel --url http://localhost:5000
  ) else (
    echo Cloudflare tunnel already running — leaving it alone.
  )
)

REM --- Start the Flask server in THIS window.
set PORT=5000
set FRAMEAI_ENV=prod
pushd "%~dp0src"
call "..\.venv\Scripts\activate.bat"
python app.py
popd
echo.
echo Prod server exited. Press any key to close this window.
pause >nul

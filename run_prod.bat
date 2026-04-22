@echo off
title FrameAI Prod Server
REM Starts the PROD Flask server on port 5000.
REM Run this from C:\FrameAI (master branch). The Cloudflare tunnel forwards public traffic here.
REM The window title "FrameAI Prod Server" is used by 2_UPDATE_PROD.BAT to find
REM and close this window when shipping new code.
set PORT=5000
set FRAMEAI_ENV=prod
pushd "%~dp0src"
call "..\.venv\Scripts\activate.bat"
python app.py
popd
echo.
echo Prod server exited. Press any key to close this window.
pause >nul

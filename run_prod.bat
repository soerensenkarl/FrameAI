@echo off
REM Starts the PROD Flask server on port 5000.
REM Run this from C:\FrameAI (master branch). The Cloudflare tunnel forwards public traffic here.
set PORT=5000
set FRAMEAI_ENV=prod
pushd "%~dp0src"
call "..\.venv\Scripts\activate.bat"
python app.py
popd

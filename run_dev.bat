@echo off
REM Starts the DEV Flask server on port 5001 for local iteration.
REM Run this from C:\FrameAI-dev (feature branch). Not exposed publicly.
REM Open http://localhost:5001 in your browser.
REM
REM FRAMEAI_SKIP_RHINO=1 means this server loads WITHOUT Rhino,
REM so it can run alongside the prod server (which is holding the single
REM Rhino license). All UI / frontend work functions normally;
REM geometry endpoints (/generate-frame etc.) return a 503 with a clear
REM message. To test geometry in dev: stop prod first, then comment out
REM the SKIP_RHINO line below and re-run this script.
set PORT=5001
set FRAMEAI_ENV=dev
set FRAMEAI_SKIP_RHINO=1
pushd "%~dp0src"
REM Prefer a local .venv in the dev folder; fall back to the prod venv at ..\FrameAI\.venv.
if exist "..\.venv\Scripts\activate.bat" (
  call "..\.venv\Scripts\activate.bat"
) else if exist "..\..\FrameAI\.venv\Scripts\activate.bat" (
  call "..\..\FrameAI\.venv\Scripts\activate.bat"
) else (
  echo ERROR: could not find a .venv. Expected one at ..\.venv or ..\..\FrameAI\.venv
  popd
  exit /b 1
)
python app.py
popd

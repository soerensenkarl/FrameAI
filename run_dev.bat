@echo off
REM Starts the DEV Flask server on port 5001 for local iteration.
REM Run this from C:\FrameAI-dev (feature branch). Not exposed publicly.
REM Open http://localhost:5001 in your browser.
set PORT=5001
set FRAMEAI_ENV=dev
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

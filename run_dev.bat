@echo off
title FrameAI Dev Server
REM Starts the DEV Flask server on port 5001 for local iteration.
REM Run this from C:\FrameAI-dev (feature branch). Not exposed publicly.
REM Open http://localhost:5001 in your browser.
REM
REM Rhino is held by the single PROD process (port 5000), so this dev
REM process loads WITHOUT rhinoinside and forwards geometry API calls
REM to prod via RHINO_PROXY_URL. Result: full UI + geometry in dev,
REM zero disruption to testers on prod. Requires prod to be running.
REM
REM To test backend Rhino changes in dev (rare), stop prod first, then
REM unset/comment FRAMEAI_SKIP_RHINO and RHINO_PROXY_URL below.
set PORT=5001
set FRAMEAI_ENV=dev
set FRAMEAI_SKIP_RHINO=1
set RHINO_PROXY_URL=http://localhost:5000
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

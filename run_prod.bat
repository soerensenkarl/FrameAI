@echo off
title FrameAI Prod Launcher
REM Launches the PROD Flask server (port 5000) under the local Windows
REM user 'frameai' (Rhino license B = kjs@woodstock-robotics.com).
REM Your normal user (woods, license A) keeps Rhino 8 GUI free for
REM design work. No license contention because each Windows user has
REM its own Cloud Zoo seat.
REM
REM First run on this machine: runas /savecred prompts ONCE for
REM frameai's password; the credential is then saved in your Credential
REM Manager and reused silently on every later launch.
REM
REM MUST be run from C:\FrameAI (master-branch worktree).
REM Flask opens its own window titled "FrameAI Prod Server" which
REM 2_UPDATE_PROD.BAT finds and closes when shipping new code.
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

REM --- Sanity check: venv must exist at C:\FrameAI\.venv.
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo.
  echo ERROR: could not find .venv at %~dp0.venv
  echo The venv should have been created during initial setup.
  popd & pause & exit /b 1
)

REM --- Clear any stale prod server. Old Flask runs under frameai, so
REM     the kill must run as frameai too.
echo === Clearing any stale prod server ===
runas /savecred /user:%COMPUTERNAME%\frameai "%~dp0_kill_prod.bat"
timeout /t 2 /nobreak >nul

REM --- Ensure the Cloudflare tunnel is running. Tunnel runs in THIS
REM     (woods) session because cloudflared config lives in
REM     C:\Users\woods\.cloudflared. If one is already alive from an
REM     earlier session, leave it alone (URL stays stable).
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

REM --- Launch Flask under frameai (license B) in a new window titled
REM     "FrameAI Prod Server". The inner cmd /k chain sets the title
REM     first so the window is recognisable to 2_UPDATE_PROD.BAT and
REM     _kill_prod.bat the moment it opens.
echo.
echo Launching Flask server as 'frameai' ^(Rhino license B^)...
echo If this is the first launch, you'll be prompted for frameai's password.
echo.
runas /savecred /user:%COMPUTERNAME%\frameai "cmd /k title FrameAI Prod Server && cd /d %~dp0src && set PORT=5000 && set FRAMEAI_ENV=prod && %~dp0.venv\Scripts\python.exe app.py"
if errorlevel 1 (
  echo.
  echo runas failed. If the saved credential is bad, open Credential Manager
  echo and remove the entry for 'frameai' under "Windows Credentials", then
  echo re-run this bat to re-enter the password.
)

popd
echo.
echo Launcher done. Flask is running in the "FrameAI Prod Server" window.
echo Press any key to close THIS launcher window.
pause >nul

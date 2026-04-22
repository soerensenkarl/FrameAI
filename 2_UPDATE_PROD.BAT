@echo off
REM Merge the feature branch into master (i.e. ship to prod) and
REM automatically restart the prod server so new code is immediately live.
REM Run from C:\FrameAI (the prod worktree).
pushd "%~dp0"

for /f "usebackq delims=" %%i in (`git rev-parse --abbrev-ref HEAD 2^>nul`) do set BRANCH=%%i
if /i not "%BRANCH%"=="master" (
  echo.
  echo ERROR: this script only runs on the master branch.
  echo You are on: %BRANCH%
  echo Double-click this in C:\FrameAI instead of C:\FrameAI-dev.
  echo.
  popd & pause & exit /b 1
)

echo === Fetching latest from origin ===
git fetch origin
echo.

echo === Commits that will land on master ===
git log --oneline HEAD..feature
echo.

for /f %%c in ('git log HEAD..feature --oneline ^| find /c /v ""') do set NC=%%c
if "%NC%"=="0" (
  echo Nothing to merge. master is already in sync with feature.
  echo Skipping merge; restarting prod anyway.
  echo.
  goto restart
)

git merge feature --no-ff -m "Merge feature into master"
if errorlevel 1 (
  echo.
  echo Merge had conflicts. Resolve them in C:\FrameAI then commit, or run:
  echo   git merge --abort
  echo to cancel. Nothing has been pushed or restarted.
  popd & pause & exit /b 1
)

git push origin master
if errorlevel 1 (
  echo.
  echo Push failed ^(no internet?^). Merge is saved locally; re-run this to retry.
  popd & pause & exit /b 1
)

:restart
echo === Stopping old prod server ===
REM Close any window titled "FrameAI Prod Server"
taskkill /F /FI "WINDOWTITLE eq FrameAI Prod Server*" >nul 2>&1
REM Belt-and-braces: kill whatever is still listening on :5000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":5000 " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM Give the OS a moment to release the port
timeout /t 2 /nobreak >nul

echo === Launching new prod server in its own window ===
start "FrameAI Prod Server" cmd /k "%~dp0run_prod.bat"

echo.
echo Done. A new "FrameAI Prod Server" window is opening now.
echo Tunnel reconnects within a few seconds — testers' URL stays the same.
popd & pause

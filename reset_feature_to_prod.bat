@echo off
REM Wipe feature and make it identical to prod (master).
REM Run from C:\FrameAI-dev. DESTRUCTIVE — loses commits + force-pushes.
pushd "%~dp0"

for /f "usebackq delims=" %%i in (`git rev-parse --abbrev-ref HEAD 2^>nul`) do set BRANCH=%%i
if /i not "%BRANCH%"=="feature" (
  echo.
  echo ERROR: this script only runs on the feature branch.
  echo You are on: %BRANCH%
  echo Double-click this in C:\FrameAI-dev instead of C:\FrameAI.
  echo.
  popd & pause & exit /b 1
)

echo === Fetching latest prod state from origin ===
git fetch origin
echo.

echo === Commits on feature that will be LOST ===
git log origin/master..HEAD --oneline
echo.

echo === Uncommitted changes that will be LOST ===
git status --short
echo.

echo This resets feature to match origin/master and FORCE-PUSHES to GitHub.
echo Commits shown above that are not in master will be gone forever.
echo.
set /p CONFIRM=Type YES ^(uppercase^) to confirm:
if /i not "%CONFIRM%"=="YES" (
  echo.
  echo Cancelled. Nothing changed.
  popd & pause & exit /b 0
)

git reset --hard origin/master
if errorlevel 1 (
  echo.
  echo Local reset failed.
  popd & pause & exit /b 1
)

git clean -fd

git push --force origin feature
if errorlevel 1 (
  echo.
  echo Force-push failed ^(no internet?^). Local feature is reset; remote is unchanged.
  echo Re-run this script to retry the push.
  popd & pause & exit /b 1
)

echo.
echo Done. Feature now exactly matches master.
popd & pause

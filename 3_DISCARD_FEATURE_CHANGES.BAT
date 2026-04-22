@echo off
REM Throw away uncommitted changes on feature. Goes back to the last commit.
REM Run from C:\FrameAI-dev. DESTRUCTIVE — cannot be undone.
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

echo === The following changes will be PERMANENTLY DISCARDED ===
git status --short
echo.

for /f %%c in ('git status --porcelain ^| find /c /v ""') do set CHG=%%c
if "%CHG%"=="0" (
  echo Nothing to discard. Working tree is already clean.
  popd & pause & exit /b 0
)

echo This cannot be undone. Your last commit stays; only uncommitted work is lost.
echo.
set /p CONFIRM=Type YES ^(uppercase^) to confirm:
if /i not "%CONFIRM%"=="YES" (
  echo.
  echo Cancelled. Nothing changed.
  popd & pause & exit /b 0
)

git reset --hard HEAD
git clean -fd

echo.
echo Done. Feature is back to its last commit.
popd & pause

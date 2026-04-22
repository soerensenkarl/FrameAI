@echo off
REM Save (commit + push) your work on the feature branch.
REM Run from C:\FrameAI-dev (the dev worktree). Prompts for a commit message.
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

echo === Changes that will be committed ===
git status --short
git diff --stat
echo.

REM Bail if there's nothing to commit (tracked or untracked)
for /f %%c in ('git status --porcelain ^| find /c /v ""') do set CHG=%%c
if "%CHG%"=="0" (
  echo Nothing to commit. You're already in sync.
  popd & pause & exit /b 0
)

set /p MSG=Commit message (one line):
if "%MSG%"=="" (
  echo.
  echo No message given. Cancelled.
  popd & pause & exit /b 1
)

git add -A
git commit -m "%MSG%"
if errorlevel 1 (
  echo.
  echo Commit failed. Nothing pushed.
  popd & pause & exit /b 1
)

git push origin feature
if errorlevel 1 (
  echo.
  echo Push failed ^(no internet?^). Commit is saved locally; re-run this to retry the push.
  popd & pause & exit /b 1
)

echo.
echo Done. Feature branch saved and pushed.
popd & pause

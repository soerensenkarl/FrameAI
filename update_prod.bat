@echo off
REM Merge the feature branch into master (i.e. ship to prod).
REM Run from C:\FrameAI (the prod worktree). Pushes master after merging.
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

REM Detect whether anything actually needs merging
for /f %%c in ('git log HEAD..feature --oneline ^| find /c /v ""') do set NC=%%c
if "%NC%"=="0" (
  echo Nothing to merge. master is already in sync with feature.
  popd & pause & exit /b 0
)

git merge feature --no-ff -m "Merge feature into master"
if errorlevel 1 (
  echo.
  echo Merge had conflicts. Resolve them in C:\FrameAI then commit, or run:
  echo   git merge --abort
  echo to cancel. Nothing has been pushed.
  popd & pause & exit /b 1
)

git push origin master
if errorlevel 1 (
  echo.
  echo Push failed ^(no internet?^). Merge is saved locally; re-run this to retry.
  popd & pause & exit /b 1
)

echo.
echo Done. Prod files on disk now match feature.
echo.
echo REMEMBER: if you changed Python code ^(app.py, box_gen.py, etc.^),
echo you need to stop the prod server and re-run run_prod.bat for the
echo change to take effect. Frontend-only changes show up on next refresh.
popd & pause

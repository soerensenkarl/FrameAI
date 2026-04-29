@echo off
title FrameAI: One-shot prod reset (untrack runtime data + wipe test projects)
REM ----------------------------------------------------------------------
REM   ONE-TIME PROD RESET
REM ----------------------------------------------------------------------
REM   Use this when prod's master branch has runtime data (user.json,
REM   design.json, quote.json, meta.json under projects/) leaking into the
REM   tracked tree, blocking 2_UPDATE_PROD merges.
REM
REM   What it does (in order):
REM     1. Kill the prod Flask server (runs as user 'frameai').
REM     2. Wipe data/frameai.db, data/notifications.log, projects/, output/.
REM        (admin user is re-bootstrapped on the next server start)
REM     3. git rm --cached every tracked file under projects/ + output/.
REM     4. Append projects/ and output/ to .gitignore if not already there.
REM     5. Commit the untrack on master.
REM     6. Fetch origin, merge feature -> master, push master.
REM     7. Sync the dev worktree's feature branch with the new master.
REM     8. Relaunch prod.
REM
REM   Run from C:\FrameAI (the master-branch worktree). Double-click.
REM ----------------------------------------------------------------------
pushd "%~dp0"

REM --- Guard: must be in the master worktree.
for /f "usebackq delims=" %%i in (`git rev-parse --abbrev-ref HEAD 2^>nul`) do set BRANCH=%%i
if /i not "%BRANCH%"=="master" (
  echo.
  echo ERROR: this script only runs from C:\FrameAI ^(master branch^).
  echo You are on: %BRANCH%
  echo.
  popd ^& pause ^& exit /b 1
)

echo.
echo ===============================================================
echo  PROD RESET
echo ===============================================================
echo This will wipe ALL runtime data on prod:
echo   - data/frameai.db          (admin re-created on next start)
echo   - data/notifications.log
echo   - projects/                (all test projects)
echo   - output/                  (.3dm scratch)
echo Then untrack projects/ + output/ on master, ship feature, restart.
echo.
echo Dev (C:\FrameAI-dev) is left untouched apart from a feature-branch
echo sync at the end so it stays aligned with master.
echo.
set /p CONFIRM=Type 'reset' to proceed (anything else cancels):
if /i not "%CONFIRM%"=="reset" (
  echo.
  echo Cancelled.
  popd ^& pause ^& exit /b 0
)

REM --- 1. Kill prod server (runs under the frameai user; cross-user kill
REM        needs runas via the existing helper).
echo.
echo === Stopping prod server ===
runas /savecred /user:%COMPUTERNAME%\frameai "%~dp0_kill_prod.bat" 2>nul
timeout /t 2 /nobreak >nul

REM --- 2. Wipe runtime data on disk.
echo === Wiping runtime data ===
if exist "data\frameai.db" del /F /Q "data\frameai.db" >nul
if exist "data\notifications.log" del /F /Q "data\notifications.log" >nul
if exist "projects" rmdir /S /Q "projects"
if exist "output"   rmdir /S /Q "output"

REM --- 3. Untrack everything in projects/ and output/ from the master index.
REM        Errors are fine here — they just mean nothing was tracked.
echo === Untracking runtime folders ===
git rm -r --cached projects/ 2>nul
git rm -r --cached output/   2>nul

REM --- 4. Make sure .gitignore covers the runtime paths.
echo === Updating .gitignore ===
findstr /xc:"projects/" .gitignore >nul 2>&1
if errorlevel 1 echo projects/>>.gitignore
findstr /xc:"output/" .gitignore >nul 2>&1
if errorlevel 1 echo output/>>.gitignore
git add .gitignore

REM --- 5. Commit on master. If there's nothing to commit (idempotent re-run),
REM        keep going.
echo === Committing cleanup on master ===
git commit -m "untrack runtime data; wipe test projects" 2>nul

REM --- 6. Fetch + merge feature -> master + push.
echo === Fetching origin ===
git fetch origin
echo === Merging feature into master ===
git merge feature --no-ff -m "Merge feature into master (post-reset)"
if errorlevel 1 (
  echo.
  echo MERGE FAILED. Investigate manually in C:\FrameAI:
  echo   git status
  echo   git merge --abort     ^(to cancel and try again^)
  echo No push happened. Prod was not restarted.
  popd ^& pause ^& exit /b 1
)
echo === Pushing master ===
git push origin master
if errorlevel 1 (
  echo.
  echo PUSH FAILED ^(no internet?^). Local merge is saved; re-run later.
  popd ^& pause ^& exit /b 1
)

REM --- 7. Sync the dev worktree's feature branch with the new master so
REM        future ships from dev start clean. Best-effort — if dev has
REM        uncommitted work, the merge here will fail and the user can
REM        resolve later. We don't block prod restart on it.
echo === Syncing dev feature branch with master ===
git -C "C:\FrameAI-dev" fetch origin
git -C "C:\FrameAI-dev" merge origin/master --no-edit
if errorlevel 1 (
  echo Dev feature sync had merge conflicts ^(uncommitted work?^).
  echo Resolve manually in C:\FrameAI-dev later. Prod is fine; continuing.
) else (
  git -C "C:\FrameAI-dev" push origin feature 2>nul
)

REM --- 8. Restart prod in its own window.
echo === Starting prod server ===
start "FrameAI Prod Launcher" cmd /k "%~dp0run_prod.bat"

echo.
echo ===============================================================
echo  DONE.
echo ===============================================================
echo Prod is starting fresh:
echo   - Admin user (kjs@woodstock-robotics.com) re-bootstraps on first
echo     /api/auth/me hit. Password unchanged: woodstock2026.
echo   - Zero projects.
echo   - projects/ and output/ are now gitignored on master.
echo Dev's feature branch was synced with master.
echo Future ships go through 1_COMMIT_FEATURE -^> 2_UPDATE_PROD as usual.
echo.
popd ^& pause

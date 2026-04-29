@echo off
REM Closes the prod server: kills the "FrameAI Prod Server" cmd window
REM (and its python child) plus anything still listening on :5000.
REM
REM Cross-user taskkill needs admin, so this MUST run *as the user that
REM owns the prod process* (i.e. frameai). The launchers reach into
REM frameai's session via:
REM   runas /savecred /user:%COMPUTERNAME%\frameai "%~dp0_kill_prod.bat"
taskkill /F /FI "WINDOWTITLE eq FrameAI Prod Server*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":5000 " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

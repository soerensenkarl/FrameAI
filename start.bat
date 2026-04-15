@echo off
:: Kill any existing instance on port 5000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000.*LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
cd /d "%~dp0src"
call "%~dp0.venv\Scripts\python.exe" app.py
pause

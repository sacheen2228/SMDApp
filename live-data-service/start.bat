@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python not found. Install from python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
echo Starting live data service. Dashboard: http://127.0.0.1:8765
python live_service.py %*
pause

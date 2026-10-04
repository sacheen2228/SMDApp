@echo off
cd /d "%~dp0"
set PYW=
for /f "delims=" %%i in ('where pythonw 2^>nul') do if not defined PYW set PYW=%%i
if not defined PYW (echo pythonw not found. Install Python from python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
schtasks /Create /SC ONLOGON /TN "LiveOptionDataService" /TR "\"%PYW%\" \"%~dp0live_service.py\"" /RL LIMITED /F
if %errorlevel%==0 (
  echo.
  echo Done. The service now starts automatically every time you log in to Windows.
  schtasks /Run /TN "LiveOptionDataService" >nul
  echo Started. Open http://127.0.0.1:8765 in your browser.
) else (
  echo Failed. Right-click this file and choose "Run as administrator".
)
pause

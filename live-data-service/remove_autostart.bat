@echo off
schtasks /Delete /TN "LiveOptionDataService" /F
taskkill /IM pythonw.exe /F >nul 2>nul
echo Auto-start removed.
pause

@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "CANAI_EXIT=%ERRORLEVEL%"
pause
exit /b %CANAI_EXIT%

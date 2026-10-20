@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
set "CANAI_EXIT=%ERRORLEVEL%"
pause
exit /b %CANAI_EXIT%

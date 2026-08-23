@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo Starting DLR Data Pipeline in background...
node scripts\dev-services.mjs start
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo API: http://localhost:3001/health
echo Web: http://localhost:3000
echo Services continue running after this window is closed.
echo Logs: %ROOT%logs
exit /b 0

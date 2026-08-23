@echo off
setlocal EnableDelayedExpansion
if "%~1"=="--" shift
set "ARGS="
:collect_args
if "%~1"=="" goto run_script
set "ARGS=!ARGS! %1"
shift
goto collect_args
:run_script
set "SCRIPT_PATH=%~dp0one-click-ecommerce.ps1"
if not exist "!SCRIPT_PATH!" set "SCRIPT_PATH=%~dp0scripts\one-click-ecommerce.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "!SCRIPT_PATH!" !ARGS!
exit /b %ERRORLEVEL%

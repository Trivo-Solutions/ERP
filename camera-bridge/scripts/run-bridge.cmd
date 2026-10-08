@echo off
rem TRIVO Camera Bridge launcher. Started by the scheduled task (install-task.ps1); can also be run by hand.
rem Restarts the bridge after a crash (exit code 1) but NOT after a configuration error (2), a second
rem instance (3) or a clean stop (0): restarting cannot fix those.
setlocal
set NODE_ENV=production
cd /d "%~dp0.."
:loop
node dist\index.js run
set RC=%ERRORLEVEL%
if "%RC%"=="0" exit /b 0
if "%RC%"=="2" exit /b 2
if "%RC%"=="3" exit /b 3
echo [%date% %time%] bridge exited with code %RC%; restarting in 10 seconds>> "%LOCALAPPDATA%\TrivoCameraBridge\logs\launcher.log"
timeout /t 10 /nobreak >nul
goto loop

@echo off
cd /d "%~dp0"

if not exist .env (
  echo No .env found - copy .env.example to .env and set PRINTER_NAME first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

call npm run build
call npm start

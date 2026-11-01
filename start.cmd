@echo off
rem Double-click to start PCBot Manager. First run installs dependencies.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=4321

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org
  echo   or run:  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed - see the messages above.
    pause
    exit /b 1
  )
)

rem Open the browser a few seconds after the server starts.
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:%PORT%"
node server\index.js
pause

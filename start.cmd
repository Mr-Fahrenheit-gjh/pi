@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 LTS including npm: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0bin\start-custom.js" %*
set "PI_START_EXIT=%errorlevel%"
if not "%PI_START_EXIT%"=="0" pause
exit /b %PI_START_EXIT%

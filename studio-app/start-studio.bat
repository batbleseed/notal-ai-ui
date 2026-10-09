@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo First run: installing Electron and the packager. This takes a few minutes, once.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)
call npm start
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo Notal AI Studio did not start. Read the message above, then try again.
pause

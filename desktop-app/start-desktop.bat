@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo First run: downloading Electron. This takes a few minutes.
  call npm install
  if errorlevel 1 goto :fail
)
call npm start
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo Notal AI did not start. Read the message above, then try again.
pause

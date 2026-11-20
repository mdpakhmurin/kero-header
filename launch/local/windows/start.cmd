@echo off
setlocal
title Kero Header
cd /d "%~dp0..\..\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||major===22&&minor>=13?0:1)"
if errorlevel 1 (
  echo Please update Node.js to version 22.13 or newer: https://nodejs.org/
  pause
  exit /b 1
)
node "%CD%\scripts\launch.mjs"
if errorlevel 1 (
  echo.
  echo Kero Header could not start. See the error above.
  pause
  exit /b 1
)

@echo off
setlocal
title Kero Header
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Please update Node.js to version 22 or newer: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs"
if errorlevel 1 (
  echo.
  echo Kero Header could not start. See the error above.
  pause
  exit /b 1
)

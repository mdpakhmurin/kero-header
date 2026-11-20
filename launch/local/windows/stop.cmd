@echo off
setlocal
title Kero Header - Stop
cd /d "%~dp0..\..\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to stop Kero Header.
  pause
  exit /b 1
)
node "%CD%\scripts\stop.mjs"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul

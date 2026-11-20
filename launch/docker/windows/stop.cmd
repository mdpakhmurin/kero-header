@echo off
setlocal
title Kero Header - Stop Docker
cd /d "%~dp0..\..\.."
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not installed.
  goto failed
)
docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose is required.
  goto failed
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker is not running or is unavailable.
  goto failed
)
docker compose down
if errorlevel 1 goto failed
echo.
echo Kero Header is stopped. Your data is preserved.
pause
exit /b 0

:failed
echo.
echo Could not stop Kero Header. See the error above.
pause
exit /b 1

@echo off
setlocal
title Kero Header - Docker
cd /d "%~dp0..\..\.."
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not installed. Install Docker Desktop and try again.
  goto failed
)
docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose is required. Update Docker Desktop and try again.
  goto failed
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker is not running. Start Docker Desktop and try again.
  goto failed
)
docker compose up -d --build --wait --wait-timeout 90
if errorlevel 1 goto failed
echo.
echo Kero Header is running. Published address:
docker compose port editor 3210
echo Open http://localhost at the port shown above, or PUBLIC_ORIGIN from .env.
echo Use stop.cmd to stop the editor.
pause
exit /b 0

:failed
echo.
echo Could not start Kero Header. See the error above.
pause
exit /b 1

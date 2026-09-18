@echo off
rem Double-click to set up (first run) and start the dashboard server and the phone app server.
rem Needs Node.js 22 LTS from https://nodejs.org. See README.md, "Windows laptop".
title Cascade rig
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install "Node.js 22 LTS" from https://nodejs.org/en/download
  echo and double-click this file again.
  echo.
  pause
  exit /b 1
)

node scripts\start.mjs %*
echo.
pause

@echo off
chcp 65001 >nul
title MelodyBox

echo ==============================================
echo    MelodyBox
echo ==============================================

:: === 配置：修改这个路径指向你的 NeteaseCloudMusicApi 目录 ===
set "API_DIR=C:\Users\19558\NeteaseCloudMusicApi"
:: =================================================================

:: Kill old processes
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

:: Start Netease API
echo Starting API (localhost:3000) ...
start "API" /MIN cmd /c "%API_DIR%\start.bat"
timeout /t 5 /nobreak >nul

:: Start frontend
echo Starting frontend (localhost:5000) ...
start "Frontend" /MIN cmd /c "%~dp0start-server.bat"
timeout /t 2 /nobreak >nul

:: Open browser
start http://localhost:5000
echo.
echo Browser opened. Scan QR to login.
echo Close this window to stop all services.
echo.
pause
taskkill /f /im node.exe >nul 2>&1

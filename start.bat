@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Arto — не закрывайте это окно, пока рисуете
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"

rem Открыть Arto отдельным окном (как приложение); если Edge нет — в обычном браузере
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; try { Start-Process msedge -ArgumentList '--app=http://localhost:7777','--window-size=1400,900' -ErrorAction Stop } catch { Start-Process 'http://localhost:7777' }"

"%NODE%" server.js
if errorlevel 1 pause

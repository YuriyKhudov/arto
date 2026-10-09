@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Обновление Arto
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" update.js
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Установка Arto
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Установка Arto

rem Запуск прямо из архива — установка туда бессмысленна
set "HERE=%~dp0"
if /i not "%HERE:\AppData\Local\Temp\=%"=="%HERE%" (
  echo.
  echo   Похоже, установка запущена прямо из архива.
  echo   Сначала распакуйте архив: правой кнопкой по Arto-*.zip - "Извлечь все...",
  echo   выберите папку, где много места (например D:\Arto^), и запустите install.bat оттуда.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause

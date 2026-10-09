@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Arto — не закрывайте это окно, пока рисуете

rem Запуск прямо из архива (Windows распаковывает во временную папку) — работать не будет
set "HERE=%~dp0"
if /i not "%HERE:\AppData\Local\Temp\=%"=="%HERE%" (
  echo.
  echo   Похоже, Arto запущен прямо из архива.
  echo   Сначала распакуйте архив: правой кнопкой по Arto-*.zip - "Извлечь все...",
  echo   затем в распакованной папке запустите install.bat.
  echo.
  pause
  exit /b 1
)

set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Не найден Node.js. Запустите install.bat ещё раз — он всё доустановит.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\@huggingface\transformers" (
  echo.
  echo   Не установлены библиотеки программы. Запустите install.bat ещё раз.
  echo.
  pause
  exit /b 1
)

rem Окно Arto откроется само, как только программа будет готова
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"

"%NODE%" server.js
if errorlevel 1 (
  echo.
  echo   Arto остановился с ошибкой. Текст ошибки — выше и в файле data\server.log
  echo.
  pause
)

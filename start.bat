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

rem Node.js: свой из папки runtime, иначе системный
set "NODE=node"
set "NPM=npm"
if exist "runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if exist "runtime\npm.cmd" set "NPM=%~dp0runtime\npm.cmd"
if exist "runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
"%NODE%" -v >nul 2>&1
if errorlevel 1 goto nonode

rem Библиотеки программы: если их нет — доустанавливаем сами
if exist "node_modules\@huggingface\transformers\package.json" goto run
echo.
echo   Доустанавливаю библиотеки программы — один раз, 1-3 минуты, нужен интернет...
echo.
if not exist "data" mkdir "data"
call "%NPM%" install --omit=dev --ignore-scripts --no-audit --no-fund
if exist "node_modules\@huggingface\transformers\package.json" goto run
echo.
echo   Не получилось установить библиотеки. Проверьте интернет и запустите Arto ещё раз.
echo   Текст ошибки — выше. Его можно переслать автору программы.
echo.
pause
exit /b 1

:nonode
echo.
echo   Не найден Node.js. Запустите install.bat ещё раз — он всё доустановит.
echo.
pause
exit /b 1

:run
rem Окно Arto откроется само, как только программа будет готова
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"

"%NODE%" server.js
if errorlevel 1 (
  echo.
  echo   Arto остановился с ошибкой. Текст ошибки — выше и в файле data\server.log
  echo.
  pause
)

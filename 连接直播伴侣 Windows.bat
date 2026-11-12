@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
set "ALIVE_NODE=%~dp0runtime\win-x64\node.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ALIVE_NODE=%~dp0runtime\win-arm64\node.exe"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ALIVE_NODE=%~dp0runtime\win-arm64\node.exe"
if not exist "%ALIVE_NODE%" (
 echo 缺少包内运行环境。请完整解压后再启动，不要在压缩包里双击。
 pause
 exit /b 1
)
"%ALIVE_NODE%" "%~dp0companion.mjs" %*
if errorlevel 1 (
 echo 启动未完成，请把上面的信息交给您的AI助手。
 pause
 exit /b 1
)
endlocal

@echo off
chcp 65001 >nul
title ATLAS 市场零件 · 后端
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "data" mkdir "data"

node "scripts\port.mjs" check 43130
if not errorlevel 1 goto running

echo.
echo   ATLAS 市场零件 · 后端
echo   抓取页会带 token 自动打开；服务就绪后浏览器自己弹出来
echo   关闭本窗口即停止后端
echo.

start "" /b node "scripts\port.mjs" open 43130 /run --token-file "data\token.txt"
node server.mjs
echo.
echo   后端已停止
echo.
pause
exit /b 0

:running
echo.
echo   后端已经在运行，直接打开抓取页
echo.
node "scripts\port.mjs" open 43130 /run --token-file "data\token.txt"
exit /b 0

:nonode
echo.
echo   [X] 没有检测到 Node.js
echo       请先安装 LTS 版本: https://nodejs.org/
echo       装完再双击本文件
echo.
pause
exit /b 1

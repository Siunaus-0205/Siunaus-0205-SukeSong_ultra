@echo off
title ATLAS ����淶��
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "data" mkdir "data"

echo.
echo   ATLAS ����淶��
echo   ��ַ: http://127.0.0.1:43125
echo   �رձ����ڼ�ֹͣ����
echo.
start "" http://127.0.0.1:43125
node server.mjs
echo.
echo   ������ֹͣ
echo.
pause
exit /b 0

:nonode
echo.
echo   [X] û�м�⵽ Node.js
echo       ���Ȱ�װ LTS �汾: https://nodejs.org/
echo       װ����˫�����ļ�
echo.
pause
exit /b 1

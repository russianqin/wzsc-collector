@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (
  echo 没找到 Node.js。请先安装 Node.js（https://nodejs.org）再运行本安装。
  pause
  exit /b 1
)
node install.js
pause

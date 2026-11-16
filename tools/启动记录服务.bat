@echo off
cd /d "%~dp0"
echo 正在启动公考记录服务…
node "%~dp0gongkao-server.js"
pause

@echo off
cd /d "%~dp0"
echo 正在启动公考记录服务…
python "%~dp0gongkao-server.py"
pause

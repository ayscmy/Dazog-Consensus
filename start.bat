@echo off
chcp 65001 >nul
set "NODE=C:\Users\ayscm\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0server.js"
pause

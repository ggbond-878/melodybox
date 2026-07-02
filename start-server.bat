@echo off
cd /d "%~dp0"
set "NODE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
"%NODE%" server.js

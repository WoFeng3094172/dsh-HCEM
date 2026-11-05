@echo off
chcp 65001 >nul
cd /d "E:\HCEM\HCEM v0.0.2\embedding-service"
echo Starting HCEM embedding service on http://127.0.0.1:8081 ...
node server.mjs
pause

@echo off
cd /d "%~dp0"
node --env-file-if-exists=.env "%~dp0server\main.js"
pause

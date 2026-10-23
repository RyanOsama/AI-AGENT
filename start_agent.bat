@echo off
chcp 65001 > nul
title تشغيل وكيل بريد Gmail الذكي
echo ========================================================
echo   جاري تشغيل وكيل بريد Gmail الذكي (AI Email Assistant)
echo ========================================================
echo.
cd /d "%~dp0"
start http://localhost:3000
node server.js
pause

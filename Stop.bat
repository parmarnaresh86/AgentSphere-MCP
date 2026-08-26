@echo off
cd /d "%~dp0"
title AgentSphere AI - Stop

:: ── Windows Service mode ──────────────────────────────────────────────────────
sc query "AgentSphere AI" >nul 2>&1
if not errorlevel 1 (
    echo  Stopping Windows Service...
    sc stop "AgentSphere AI"
    echo.
    echo  AgentSphere AI stopped.
    echo  (Service will restart automatically at next Windows boot)
    echo.
    pause & exit /b
)

:: ── pm2 fallback ──────────────────────────────────────────────────────────────
where pm2 >nul 2>&1
if errorlevel 1 (
    echo  Stopping node process on port 3000...
    powershell -NoProfile -Command ^
      "try { Get-Process -Id (Get-NetTCPConnection -LocalPort 3000 -EA Stop).OwningProcess -EA Stop | Stop-Process -Force; Write-Host '  Server stopped' } catch { Write-Host '  Server was not running' }"
    pause & exit /b
)

pm2 stop agentsphere-ai
pm2 save --force >nul 2>&1
echo.
echo  AgentSphere AI stopped.
echo.
pause

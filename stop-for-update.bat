@echo off
title AgentSphere AI - Stop Before Update
cd /d "%~dp0"

echo.
echo  ============================================================
echo    Stopping AgentSphere AI (run this BEFORE extracting an
echo    update ZIP over this folder - Windows can't overwrite
echo    files that are still open)
echo  ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Stop-Service 'AgentSphere AI' -Force -ErrorAction SilentlyContinue; ^
     Start-Sleep -Seconds 1; ^
     Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; ^
     Start-Sleep -Seconds 1; ^
     $p = Get-Process node -ErrorAction SilentlyContinue; ^
     if ($p) { Write-Host '  WARNING: node process still running - close it manually.' -ForegroundColor Red } ^
     else { Write-Host '  OK - stopped. Safe to extract the update ZIP now.' -ForegroundColor Green }"

echo.
pause

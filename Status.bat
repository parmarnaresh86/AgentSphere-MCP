@echo off
cd /d "%~dp0"
title AgentSphere AI - Status

echo.
echo  ============================================================
echo    AgentSphere AI - Service Status
echo  ============================================================
echo.

:: ── Windows Service status ────────────────────────────────────────────────────
sc query "AgentSphere AI" >nul 2>&1
if not errorlevel 1 (
    echo  Windows Service status:
    sc query "AgentSphere AI"
    echo.
    echo  Startup type:
    sc qc "AgentSphere AI" | findstr /i "START_TYPE"
    echo.
    goto :port_check
)

:: ── pm2 status ────────────────────────────────────────────────────────────────
where pm2 >nul 2>&1
if not errorlevel 1 (
    echo  pm2 process list:
    pm2 list
    echo.
)

:port_check
:: ── Port 3000 check ───────────────────────────────────────────────────────────
powershell -NoProfile -Command ^
    "$conn = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; ^
     if ($conn) { ^
       Write-Host '  HTTP STATUS:  RUNNING  (port 3000 active)' -ForegroundColor Green; ^
       Write-Host '  Local:   http://localhost:3000' -ForegroundColor Cyan; ^
       $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' }).IPAddress; ^
       foreach ($ip in $ips) { Write-Host ('  LAN:     http://' + $ip + ':3000') -ForegroundColor Green } ^
     } else { Write-Host '  HTTP STATUS:  STOPPED  (port 3000 not in use)' -ForegroundColor Red }"

echo.

:: ── Last 20 log lines ─────────────────────────────────────────────────────────
if exist "%~dp0chat.log" (
    echo  Last 20 log lines  [%~dp0chat.log]
    echo  ------------------------------------
    powershell -NoProfile -Command "Get-Content '%~dp0chat.log' -Tail 20"
    echo.
)

echo  ============================================================
echo  Tip: Open services.msc to manage the Windows Service
echo  ============================================================
echo.
pause

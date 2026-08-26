@echo off
cd /d "%~dp0"
title AgentSphere AI - Start

:: ── Windows Service mode (preferred) ─────────────────────────────────────────
sc query "AgentSphere AI" >nul 2>&1
if not errorlevel 1 (
    echo  Starting Windows Service...
    sc start "AgentSphere AI" >nul 2>&1
    if errorlevel 1 (
        echo  Service already running or failed to start.
        sc query "AgentSphere AI"
    ) else (
        echo.
        echo  AgentSphere AI is starting...
    )
    echo.
    echo  Access: http://localhost:3000
    echo  Manage: services.msc
    echo.
    timeout /t 4 /nobreak >nul
    start http://localhost:3000
    exit /b
)

:: ── pm2 fallback ──────────────────────────────────────────────────────────────
where pm2 >nul 2>&1
if errorlevel 1 goto :fallback

pm2 resurrect >nul 2>&1
pm2 describe agentsphere-ai >nul 2>&1
if errorlevel 1 (
    pm2 start "%~dp0chat-server.mjs" --name agentsphere-ai --log "%~dp0chat.log" --time --restart-delay 3000 --max-restarts 10
) else (
    pm2 restart agentsphere-ai
)
pm2 save --force >nul 2>&1
echo  AgentSphere AI started via pm2.
timeout /t 3 /nobreak >nul
start http://localhost:3000
exit /b

:: ── Direct fallback (no pm2, no service) ─────────────────────────────────────
:fallback
echo  Starting AgentSphere AI (visible window mode)...
echo  Access: http://localhost:3000
echo  Close this window to stop.
echo.
start "" cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:3000"
node chat-server.mjs

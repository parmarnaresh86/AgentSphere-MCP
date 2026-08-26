@echo off
setlocal enabledelayedexpansion
title AgentSphere AI - Build Deploy Package
cd /d "%~dp0"
color 0E

echo.
echo  ============================================================
echo    AgentSphere AI - Build Deploy Package
echo    (Includes credentials + DB for silent install)
echo  ============================================================
echo.

:: ── Check .env exists ────────────────────────────────────────────────────────
if not exist ".env" (
    echo  ERROR: No .env file found in %~dp0
    echo  Run install.bat first to configure credentials.
    pause & exit /b 1
)

:: ── Stamp ─────────────────────────────────────────────────────────────────────
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%d"
set "RELNAME=AgentSphere-Deploy-%STAMP%"
set "OUTZIP=%~dp0releases\%RELNAME%.zip"
if not exist "%~dp0releases\" mkdir "%~dp0releases"

:: ── Step 1: Build TypeScript ──────────────────────────────────────────────────
echo  [1/4] Building TypeScript...
call npm run build >nul 2>&1
echo  OK   Build complete
echo.

:: ── Step 2: Package + embed credentials ──────────────────────────────────────
echo  [2/4] Packaging with credentials...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "
    `$src  = 'd:\akhshat\MCP'
    `$out  = '%OUTZIP%'
    `$temp = Join-Path `$env:TEMP 'agentsphere-deploy'

    if (Test-Path `$temp) { Remove-Item `$temp -Recurse -Force }
    New-Item -ItemType Directory -Path `$temp | Out-Null

    # Source files to copy
    `$files = @(
        'install.bat','install.ps1','update.bat','update.ps1','stop-for-update.bat','fix-service.bat','fix-service.ps1','diagnose.bat','diagnose.ps1',
        'Start.bat','Stop.bat','Status.bat','build-release.bat','build-deploy.bat','service-install.mjs','service-uninstall.mjs',
        'chat-server.mjs','analytics-v2.mjs','company-context.mjs','reports-engine.mjs','nlp-engine.mjs','query-templates.mjs','db.mjs','db-connector.mjs','mail-po.mjs',
        'check-sml-views.mjs','package.json','package-lock.json','tsconfig.json',
        'README.md','PROJECT_GUIDE.md','USER_MANUAL.html',
        '.env'
    )
    `$dirs = @('controllers','src','dist','public','data')

    foreach (`$f in `$files) {
        `$fp = Join-Path `$src `$f
        if (Test-Path `$fp) {
            Copy-Item `$fp (Join-Path `$temp `$f)
            Write-Host ('  + ' + `$f)
        }
    }
    foreach (`$d in `$dirs) {
        `$dp = Join-Path `$src `$d
        if (Test-Path `$dp) {
            Copy-Item `$dp (Join-Path `$temp `$d) -Recurse -Force
            Write-Host ('  + ' + `$d + '/')
        }
    }

    # Include hanny.db (company connections + user accounts) if present
    `$db = Join-Path `$src 'hanny.db'
    if (Test-Path `$db) {
        Copy-Item `$db (Join-Path `$temp 'hanny.db')
        Write-Host '  + hanny.db  (company connections + user accounts)'
    }

    Write-Host ''
    Write-Host '  Compressing...'
    Compress-Archive -Path (Join-Path `$temp '*') -DestinationPath `$out -Force
    Remove-Item `$temp -Recurse -Force

    `$size = [math]::Round((Get-Item `$out).Length / 1MB, 2)
    Write-Host ('  OK   ' + `$size + ' MB')
"

if not exist "%OUTZIP%" (
    echo  ERROR: Package creation failed.
    pause & exit /b 1
)
echo.

:: ── Step 3: Write SHA256 checksum ────────────────────────────────────────────
echo  [3/4] Writing checksum...
powershell -NoProfile -Command ^
    "(Get-FileHash '%OUTZIP%' -Algorithm SHA256).Hash + '  %RELNAME%.zip'" ^
    > "%~dp0releases\%RELNAME%.sha256"
echo  OK   Checksum saved
echo.

:: ── Step 4: Summary ──────────────────────────────────────────────────────────
echo  [4/4] Done!
echo.
echo  ============================================================
echo    Deploy Package Ready
echo  ============================================================
echo.
echo  File:  %OUTZIP%
echo.
echo  DEPLOY STEPS ON TARGET SERVER:
echo  --------------------------------
echo  FRESH INSTALL:
echo    1. Install Node.js 18+  (https://nodejs.org)
echo    2. Copy  %RELNAME%.zip  to target server
echo    3. Extract to any folder  (e.g. C:\AgentSphere)
echo    4. Right-click  install.bat  → Run as Administrator
echo    5. NO credential prompts - all config is pre-loaded
echo    6. Browser opens at http://localhost:3000
echo.
echo  UPDATE EXISTING INSTALL:
echo    1. In the EXISTING install folder, right-click  stop-for-update.bat
echo       → Run as Administrator  (required — Windows can't overwrite
echo       hanny.db / chat-server.mjs while they're still in use)
echo    2. Extract this new ZIP over the existing folder  (overwrite files)
echo    3. Right-click  update.bat  → Run as Administrator
echo    3. Zero prompts - stops service, updates, restarts automatically
echo    4. Browser opens at http://localhost:3000
echo.
echo  WHAT IS INCLUDED:
echo    Source code, controllers, frontend, TypeScript dist
echo    .env  (all SAP + AI credentials)
echo    hanny.db  (company connections + user accounts)
echo.
echo  NOTE: This package contains credentials.
echo        Keep it secure - do not share publicly.
echo.

explorer "%~dp0releases"
pause

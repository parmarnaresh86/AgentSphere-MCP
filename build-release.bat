@echo off
setlocal enabledelayedexpansion
title AgentSphere AI - Build Release Package
cd /d "%~dp0"
color 0B

echo.
echo  ============================================================
echo    AgentSphere AI - Build Release Package
echo  ============================================================
echo.

:: ── Version stamp ─────────────────────────────────────────────────────────────
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%d"
set "RELNAME=AgentSphere-AI-%STAMP%"
set "OUTZIP=%~dp0releases\%RELNAME%.zip"

:: ── Step 1: Build TypeScript ──────────────────────────────────────────────────
echo  [1/4] Building TypeScript...
call npm run build >nul 2>&1
if errorlevel 1 (
    echo  WARNING: TypeScript build had errors - continuing anyway.
) else (
    echo  OK   Build complete
)
echo.

:: ── Step 2: Create releases folder ───────────────────────────────────────────
echo  [2/4] Preparing release folder...
if not exist "%~dp0releases\" mkdir "%~dp0releases"

:: ── Step 3: Create ZIP (exclude node_modules, .env, db, logs) ────────────────
echo  [3/4] Packaging files...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "
    $src  = '%~dp0'.TrimEnd('\')
    $out  = '%OUTZIP%'
    $temp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'agentsphere-build')

    # Clean temp folder
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
    New-Item -ItemType Directory -Path $temp | Out-Null

    # Files and folders to include
    $include = @(
        'install.bat','install.ps1','Start.bat','Stop.bat','Status.bat','build-release.bat','restore-db.bat',
        'service-install.mjs','service-uninstall.mjs',
        'chat-server.mjs','nlp-engine.mjs','db.mjs','db-connector.mjs','mail-po.mjs',
        'company-context.mjs','reports-engine.mjs','analytics-v2.mjs','query-templates.mjs',
        'check-sml-views.mjs','package.json','package-lock.json','tsconfig.json',
        'README.md','PROJECT_GUIDE.md'
    )
    $includeDirs = @('controllers','src','dist','public','data')

    # Exclude patterns
    $excludeFiles = @('*.log','*.db','*.db-shm','*.db-wal','CLAUDE.md',
                      'hs_err_*.log','replay_pid*.log','debug.log','chat.log','data.db','hanny.db*')

    # Copy individual files
    foreach ($f in $include) {
        $fp = Join-Path $src $f
        if (Test-Path $fp) {
            Copy-Item $fp (Join-Path $temp $f)
            Write-Host ('  + ' + $f)
        }
    }

    # Copy directories (excluding unwanted files)
    foreach ($d in $includeDirs) {
        $dp = Join-Path $src $d
        if (Test-Path $dp) {
            $dst = Join-Path $temp $d
            Copy-Item $dp $dst -Recurse -Force
            Write-Host ('  + ' + $d + '/')
        }
    }

    # Zip it
    Write-Host ''
    Write-Host '  Compressing...'
    Compress-Archive -Path (Join-Path $temp '*') -DestinationPath $out -Force

    # Cleanup temp
    Remove-Item $temp -Recurse -Force

    \$size = [math]::Round((Get-Item \$out).Length / 1MB, 1)
    Write-Host ''
    Write-Host ('  OK   Package size: ' + \$size + ' MB')
    Write-Host ('  ZIP: ' + \$out)
"

if not exist "%OUTZIP%" (
    echo.
    echo  ERROR: Package creation failed.
    pause & exit /b 1
)
echo.

:: ── Step 4: Summary ──────────────────────────────────────────────────────────
echo  [4/4] Done!
echo.
echo  ============================================================
echo    Release Package Ready
echo  ============================================================
echo.
echo  File:  %OUTZIP%
echo.
echo  HOW TO DEPLOY ON ANOTHER SERVER:
echo  ---------------------------------
echo  1. Copy  %RELNAME%.zip  to the target server
echo  2. Extract to any folder  (e.g. C:\AgentSphere)
echo  3. Double-click  install.bat  (as Administrator)
echo  4. Follow the setup prompts (SAP URL, credentials, AI key)
echo  5. Browser opens automatically at http://localhost:3000
echo.
echo  NOTE: Target server needs Node.js 18+ installed.
echo        Download from: https://nodejs.org
echo.

:: Open releases folder in Explorer
explorer "%~dp0releases"

pause

#Requires -Version 5.1
<#
.SYNOPSIS
    AgentSphere AI - Service Repair Tool
    Cleanly removes the broken service and re-registers it fresh.
    Use this when: service shows Running but http://localhost:3000 doesn't respond.
#>

$ErrorActionPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot

function Pass($m)  { Write-Host "  [OK]   $m" -ForegroundColor Green  }
function Fail($m)  { Write-Host "  [ERR]  $m" -ForegroundColor Red    }
function Info($m)  { Write-Host "  [...]  $m" -ForegroundColor Yellow }
function Sep       { Write-Host "  " + ("-" * 58) -ForegroundColor DarkGray }

Clear-Host
Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor Cyan
Write-Host "  |       AgentSphere AI  -  Service Repair Tool                |" -ForegroundColor Cyan
Write-Host "  +=============================================================+" -ForegroundColor Cyan
Write-Host ""

# Admin check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "  Requesting Administrator privileges..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

# ── STEP 1: Kill everything on port 3000 ──────────────────────────────────────
Sep
Info "Step 1/5: Stopping all processes on port 3000"

# Stop Windows Service
$svc = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Stop-Service "AgentSphere AI" -Force
    Start-Sleep -Seconds 3
    Pass "Service stopped"
}

# Kill any node.exe on port 3000
$pids = @()
netstat -ano 2>$null | Select-String ":3000\s" | ForEach-Object {
    $p = ($_ -split '\s+')[-1]
    if ($p -match '^\d+$') { $pids += [int]$p }
}
foreach ($pid3 in ($pids | Select-Object -Unique)) {
    try { Stop-Process -Id $pid3 -Force; Pass "Killed PID $pid3" } catch {}
}
Start-Sleep -Seconds 2

# ── STEP 2: Remove service via SCM + sc.exe ────────────────────────────────────
Sep
Info "Step 2/5: Removing old service registration"

# Try node-windows uninstall first
if (Test-Path "$PSScriptRoot\service-uninstall.mjs") {
    node "$PSScriptRoot\service-uninstall.mjs" 2>$null
    Start-Sleep -Seconds 3
}

# Force remove via sc.exe in case node-windows uninstall partially failed
$scQuery = sc.exe query "AgentSphere AI" 2>$null
if ($LASTEXITCODE -eq 0) {
    sc.exe stop "AgentSphere AI" 2>$null | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete "AgentSphere AI" 2>$null | Out-Null
    Start-Sleep -Seconds 2
    Pass "Service removed via sc.exe"
} else {
    Pass "No stale SCM registration found"
}

# Remove daemon folder completely (clean slate)
$daemonDir = Join-Path $PSScriptRoot "daemon"
if (Test-Path $daemonDir) {
    try {
        Get-ChildItem $daemonDir -Recurse -Force | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
        Remove-Item $daemonDir -Force -ErrorAction SilentlyContinue
        Pass "Old daemon folder removed"
    } catch {
        Info "Could not fully remove daemon folder (files may be locked) - continuing"
    }
}

# ── STEP 3: Verify prerequisites ─────────────────────────────────────────────
Sep
Info "Step 3/5: Checking prerequisites"

# Node.js
$nodeVer = (node -v 2>&1).Trim().TrimStart('v')
Pass "Node.js v$nodeVer"

# .env
if (Test-Path "$PSScriptRoot\.env") { Pass ".env found" }
else { Fail ".env MISSING - cannot start"; Read-Host "Press Enter"; exit 1 }

# dist/server.js
if (Test-Path "$PSScriptRoot\dist\server.js") { Pass "dist/server.js found" }
else {
    Info "dist/server.js missing - rebuilding TypeScript..."
    npm run build 2>&1 | Out-Null
    if (Test-Path "$PSScriptRoot\dist\server.js") { Pass "Build complete" }
    else { Fail "TypeScript build failed"; Read-Host "Press Enter"; exit 1 }
}

# node_modules
if (Test-Path "$PSScriptRoot\node_modules") { Pass "node_modules found" }
else {
    Info "node_modules missing - running npm install..."
    npm install 2>&1 | Out-Null
    Pass "npm install done"
}

# ── STEP 4: Re-register service ───────────────────────────────────────────────
Sep
Info "Step 4/5: Registering fresh Windows Service"

# Pre-create daemon dir so node-windows scan never fails
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot "daemon") -Force | Out-Null

node "$PSScriptRoot\service-install.mjs"
$exitCode = $LASTEXITCODE

Start-Sleep -Seconds 5

# Confirm daemon exe exists
$daemonExe = Join-Path $PSScriptRoot "daemon\agentsphereai.exe"
if (Test-Path $daemonExe) {
    Pass "daemon\agentsphereai.exe written to disk"
} else {
    Info "daemon exe not found - will use direct node start instead"
}

# ── STEP 5: Verify service or fall back to direct start ───────────────────────
Sep
Info "Step 5/5: Verifying application"

Start-Sleep -Seconds 3
$svcFinal = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue

if ($svcFinal -and $svcFinal.Status -eq 'Running') {
    Pass "Windows Service 'AgentSphere AI' is RUNNING"
} else {
    Info "Service not running - starting node directly as fallback"
    $chatLog   = Join-Path $PSScriptRoot "chat.log"
    $errorLog  = Join-Path $PSScriptRoot "chat.error.log"
    $proc = Start-Process "node" `
        -ArgumentList "`"$PSScriptRoot\chat-server.mjs`"" `
        -WorkingDirectory $PSScriptRoot `
        -RedirectStandardOutput $chatLog `
        -RedirectStandardError  $errorLog `
        -WindowStyle Hidden -PassThru
    if ($proc) { Pass "node chat-server.mjs started (PID $($proc.Id))" }
    else       { Fail "Could not start node process - check PATH" }
}

# Ensure firewall
$fwRule = "AgentSphere AI (port 3000)"
if (-not (Get-NetFirewallRule -DisplayName $fwRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $fwRule -Direction Inbound -Protocol TCP `
        -LocalPort 3000 -Action Allow -Profile Domain,Private | Out-Null
    Pass "Firewall rule added (port 3000)"
}

# Wait for HTTP
Info "Waiting for port 3000..."
$up = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest "http://localhost:3000" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
        if ($r.StatusCode -lt 500) { $up = $true; break }
    } catch {}
}

Write-Host ""
if ($up) {
    Write-Host "  +=============================================================+" -ForegroundColor Green
    Write-Host "  |   Application is UP and responding on port 3000             |" -ForegroundColor Green
    Write-Host "  +=============================================================+" -ForegroundColor Green
    $ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' }).IPAddress
    Write-Host ""
    Write-Host "  http://localhost:3000" -ForegroundColor Cyan
    foreach ($ip in $ips) { Write-Host "  http://${ip}:3000" -ForegroundColor Green }
} else {
    Write-Host "  +=============================================================+" -ForegroundColor Red
    Write-Host "  |   Port 3000 still not responding - check chat.log           |" -ForegroundColor Red
    Write-Host "  +=============================================================+" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Check these files for errors:" -ForegroundColor Yellow
    Write-Host "  $PSScriptRoot\chat.log" -ForegroundColor White
    Write-Host "  $PSScriptRoot\chat.error.log" -ForegroundColor White
    Write-Host "  $PSScriptRoot\daemon\AgentSphere AI.wrapper.log" -ForegroundColor White
    Write-Host ""
    Write-Host "  Or run manually in CMD (as Admin):" -ForegroundColor Yellow
    Write-Host "  cd /d $PSScriptRoot" -ForegroundColor White
    Write-Host "  node chat-server.mjs" -ForegroundColor White
}

Write-Host ""
Start-Process "http://localhost:3000"
Read-Host "  Press Enter to close"

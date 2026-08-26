#Requires -Version 5.1
<#
.SYNOPSIS
    AgentSphere AI - One-Touch Updater
    Stops the service, refreshes packages + TypeScript build, restarts.
    No prompts - all credentials come pre-loaded in the deploy package.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ── Helpers ───────────────────────────────────────────────────────────────────

function Show-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "  +=============================================================+" -ForegroundColor Cyan
    Write-Host "  |       AgentSphere AI  for  SAP Business One                 |" -ForegroundColor Cyan
    Write-Host "  |              One-Touch Updater  (Silent)                    |" -ForegroundColor Cyan
    Write-Host "  +=============================================================+" -ForegroundColor Cyan
    Write-Host ""
}

$script:step = 0
$script:totalSteps = 6

function Write-Step($label) {
    $script:step++
    Write-Host "  [$($script:step)/$($script:totalSteps)] $label..." -ForegroundColor White
}

function Write-OK($msg)   { Write-Host "        OK   $msg" -ForegroundColor Green  }
function Write-Warn($msg) { Write-Host "        WARN $msg" -ForegroundColor Yellow }

function Stop-WithError($msg) {
    Write-Host ""
    Write-Host "  ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

# ── Admin elevation ───────────────────────────────────────────────────────────

Show-Banner

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "  Requesting Administrator privileges..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Show-Banner
Write-Host "  Mode: UPDATE  (running as Administrator)" -ForegroundColor Yellow
Write-Host ""

# ── Preflight: Node.js ────────────────────────────────────────────────────────

Write-Step "Checking Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host ""
    Write-Host "  Node.js not found. Opening download page..." -ForegroundColor Yellow
    Start-Process "https://nodejs.org/en/download"
    Stop-WithError "Install Node.js 18+ then re-run update.bat"
}
$nodeVer   = (node -v 2>&1).Trim().TrimStart('v')
$nodeMajor = [int](($nodeVer -split '\.')[0])
if ($nodeMajor -lt 18) {
    Stop-WithError "Node.js 18+ required (found v$nodeVer). Download: https://nodejs.org"
}
Write-OK "Node.js v$nodeVer"
Write-Host ""

# ── STEP 1: Stop service ──────────────────────────────────────────────────────

Write-Step "Stopping AgentSphere AI service"

$svc = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Stop-Service "AgentSphere AI" -Force -ErrorAction SilentlyContinue
    $waited = 0
    while ((Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue).Status -eq 'Running' -and $waited -lt 15) {
        Start-Sleep -Seconds 1
        $waited++
    }
    Write-OK "Service stopped"
} elseif ($svc) {
    Write-OK "Service already stopped"
} else {
    # Fallback: kill any node process on port 3000
    $pid3000 = (netstat -ano 2>$null | Select-String ":3000 " | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Select-Object -First 1)
    if ($pid3000 -and $pid3000 -match '^\d+$') {
        Stop-Process -Id ([int]$pid3000) -Force -ErrorAction SilentlyContinue
        Write-OK "Killed node process on port 3000 (PID $pid3000)"
    } else {
        Write-OK "No running instance found"
    }
}
Write-Host ""

# ── STEP 2: npm install ───────────────────────────────────────────────────────

Write-Step "Installing / updating packages"

$npmOut = npm install 2>&1
if ($LASTEXITCODE -ne 0) {
    $npmOut | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Stop-WithError "npm install failed - check your internet connection."
}
Write-OK "Packages ready"
Write-Host ""

# ── STEP 3: Build TypeScript ──────────────────────────────────────────────────

Write-Step "Building TypeScript (MCP server)"

$buildOut = npm run build 2>&1
if ($LASTEXITCODE -ne 0) {
    $buildOut | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Stop-WithError "TypeScript build failed - see errors above."
}
Write-OK "Build complete  →  dist/server.js"
Write-Host ""

# ── STEP 4: Register / update Windows Service ─────────────────────────────────

Write-Step "Registering Windows Service"

$svcExisting = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
if ($svcExisting) {
    Write-OK "Service already registered - will reuse"
} else {
    Write-Host "  Service not found - registering now..." -ForegroundColor DarkGray
    node "$PSScriptRoot\service-install.mjs"
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Windows Service installation failed."
    }
    Start-Sleep -Seconds 3
    Write-OK "Service registered"
}

# Ensure firewall rule exists
$fwRuleName = "AgentSphere AI (port 3000)"
if (-not (Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
        -DisplayName  $fwRuleName `
        -Direction    Inbound `
        -Protocol     TCP `
        -LocalPort    3000 `
        -Action       Allow `
        -Profile      Domain,Private `
        -Description  "Allows LAN access to AgentSphere AI chat UI" | Out-Null
    Write-OK "Firewall rule added (port 3000)"
} else {
    Write-OK "Firewall rule already present"
}
Write-Host ""

# ── STEP 5: Start service ─────────────────────────────────────────────────────

Write-Step "Starting AgentSphere AI service"

$svcNow = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
$startedViaService = $false
if ($svcNow) {
    Start-Service "AgentSphere AI" -ErrorAction SilentlyContinue
    $waited = 0
    while ((Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue).Status -ne 'Running' -and $waited -lt 15) {
        Start-Sleep -Seconds 1
        $waited++
    }
    $final = (Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue).Status
    if ($final -eq 'Running') {
        Write-OK "Service running"
        $startedViaService = $true
    } else {
        Write-Warn "Service failed to start (status: $final) - falling back to direct start"
    }
}

# Fallback: if service is not running, launch node directly in background
if (-not $startedViaService) {
    $port3000 = netstat -ano 2>$null | Select-String ":3000\s"
    if ($port3000) {
        Write-OK "Port 3000 already listening (another process) - skipping direct start"
    } else {
        Write-Host "  Starting chat-server.mjs directly (background)..." -ForegroundColor DarkGray
        $chatLog = Join-Path $PSScriptRoot "chat.log"
        $proc = Start-Process "node" -ArgumentList "`"$PSScriptRoot\chat-server.mjs`"" `
            -WorkingDirectory $PSScriptRoot `
            -RedirectStandardOutput $chatLog `
            -RedirectStandardError "$PSScriptRoot\chat.error.log" `
            -WindowStyle Hidden -PassThru
        if ($proc) {
            Write-OK "Started  (PID $($proc.Id)) - check chat.log for errors"
        } else {
            Write-Warn "Could not start node process - run Start.bat manually"
        }
    }
}
Write-Host ""

# ── STEP 6: Verify HTTP ───────────────────────────────────────────────────────

Write-Step "Verifying HTTP on port 3000"

$tries = 0
$up = $false
while ($tries -lt 12 -and -not $up) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-WebRequest "http://localhost:3000" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
        if ($resp.StatusCode -lt 500) { $up = $true }
    } catch { }
    $tries++
}

if ($up) {
    Write-OK "http://localhost:3000 is responding"
} else {
    Write-Warn "Port 3000 not responding yet - may still be starting up"
}
Write-Host ""

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor Green
Write-Host "  |   Update Complete!                                           |" -ForegroundColor Green
Write-Host "  +=============================================================+" -ForegroundColor Green
Write-Host ""
Write-Host "  Access URLs:" -ForegroundColor White
Write-Host "    This PC:  http://localhost:3000" -ForegroundColor Cyan

$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' }).IPAddress
foreach ($ip in $ips) {
    Write-Host "    LAN:      http://${ip}:3000" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Windows Service: 'AgentSphere AI'  (auto-starts at boot)" -ForegroundColor DarkGray
Write-Host "  Logs: $PSScriptRoot\chat.log" -ForegroundColor DarkGray
Write-Host ""

Start-Sleep -Seconds 2
Start-Process "http://localhost:3000"

Read-Host "  Press Enter to close"

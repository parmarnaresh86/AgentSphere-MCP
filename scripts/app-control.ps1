#Requires -Version 5.1
<#
.SYNOPSIS
    Start / Restart / Stop AgentSphere AI.

.DESCRIPTION
    start, restart : close any running copy (Windows Service, stray node processes,
                     anything node-based holding the port), make sure the LAN firewall
                     rule exists, start a fresh copy and wait until it answers.
    stop           : close every running copy.
    Uses the "AgentSphere AI" Windows Service when installed, otherwise runs
    chat-server.mjs as a hidden background process logging to chat.log.
#>
param([ValidateSet('start', 'restart', 'stop')][string]$Action = 'restart')

$ErrorActionPreference = 'Stop'
$appDir  = Split-Path $PSScriptRoot -Parent
$svcName = 'AgentSphere AI'
Set-Location $appDir

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action $Action" -Verb RunAs
    exit
}

function Write-OK($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

# Port from .env (CHAT_PORT), default 3000
$port = 3000
$envFile = Join-Path $appDir '.env'
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*CHAT_PORT\s*=\s*(\d+)' } | Select-Object -Last 1
    if ($line -match '=\s*(\d+)') { $port = [int]$Matches[1] }
}

Write-Host ""
Write-Host "  AgentSphere AI - $($Action.ToUpper())  (port $port)" -ForegroundColor Cyan
Write-Host ""

# -- Stop everything that is running ------------------------------------------
$svc = Get-Service $svcName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') {
    Stop-Service $svcName -Force -ErrorAction SilentlyContinue
    try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20)) } catch {}
    Write-OK "Windows Service stopped"
}

$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'chat-server\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }

foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    if ($p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $killed++ }
    else { Write-Warn "Port $port is used by another program: $($p.ProcessName) (PID $($p.Id)) - not closed" }
}
if ($killed) { Write-OK "Closed $killed running app process(es)" }

for ($i = 0; $i -lt 10 -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }

if ($Action -eq 'stop') {
    Write-OK "AgentSphere AI is stopped"
    Write-Host ""
    exit 0
}

# -- LAN access: firewall rule -------------------------------------------------
$fwName = "AgentSphere AI (port $port)"
if (-not (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow `
        -Profile Domain, Private -Description 'LAN access to AgentSphere AI' | Out-Null
    Write-OK "Firewall rule added for LAN access (TCP $port)"
} else {
    Write-OK "Firewall rule for LAN access present (TCP $port)"
}

# -- Start a fresh copy --------------------------------------------------------
if (-not (Test-Path (Join-Path $appDir 'dist\server.js'))) {
    Write-Warn "dist\server.js missing - SAP tools will not load. Run One-Click-Install.bat first."
}

if ($svc) {
    Start-Service $svcName
    Write-OK "Windows Service started"
} else {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Write-Host "  ERROR: Node.js not found. Run One-Click-Install.bat first." -ForegroundColor Red; Read-Host "  Press Enter"; exit 1 }
    Start-Process $node -ArgumentList 'chat-server.mjs' -WorkingDirectory $appDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $appDir 'chat.log') -RedirectStandardError (Join-Path $appDir 'chat-error.log')
    Write-OK "Started in the background (log: chat.log)"
}

Write-Info "Waiting for the app to answer..."
$up = $false
for ($i = 0; $i -lt 45 -and -not $up; $i++) {
    Start-Sleep 2
    try { $up = (Invoke-WebRequest "http://localhost:$port/login.html" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch {}
}

Write-Host ""
if ($up) {
    Write-OK "AgentSphere AI is running"
    Write-Host ""
    Write-Host "    This server:  http://localhost:$port" -ForegroundColor Cyan
    $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' }).IPAddress
    foreach ($ip in $ips) { Write-Host "    LAN:          http://${ip}:$port" -ForegroundColor Cyan }
    Start-Process "http://localhost:$port"
} else {
    Write-Warn "The app did not answer within 90 seconds. Check chat-error.log / chat.log or run diagnose.bat"
}
Write-Host ""
Start-Sleep 5

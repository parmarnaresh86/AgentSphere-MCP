#Requires -Version 5.1
<#
.SYNOPSIS
    AgentSphere AI - Diagnostic Tool
    Checks every layer and tells you exactly what is wrong.
#>

$ErrorActionPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot

$sep = "  " + ("-" * 60)

function Show-Section($title) {
    Write-Host ""
    Write-Host "  [$title]" -ForegroundColor Cyan
    Write-Host $sep -ForegroundColor DarkGray
}

function Pass($msg)  { Write-Host "  [PASS] $msg" -ForegroundColor Green  }
function Fail($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red    }
function Warn($msg)  { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Info($msg)  { Write-Host "         $msg" -ForegroundColor Gray   }

Clear-Host
Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor Cyan
Write-Host "  |       AgentSphere AI  -  Diagnostic Report                  |" -ForegroundColor Cyan
Write-Host "  +=============================================================+" -ForegroundColor Cyan

$issues = [System.Collections.Generic.List[string]]@()

# ── 1. Node.js ────────────────────────────────────────────────────────────────
Show-Section "Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Fail "Node.js NOT INSTALLED"
    $issues.Add("Install Node.js 18+ from https://nodejs.org")
} else {
    $ver = (node -v 2>&1).Trim().TrimStart('v')
    $major = [int](($ver -split '\.')[0])
    if ($major -lt 18) {
        Fail "Node.js v$ver - need v18+"
        $issues.Add("Upgrade Node.js to v18+ from https://nodejs.org")
    } else {
        Pass "Node.js v$ver"
    }
}

# ── 2. Key files ──────────────────────────────────────────────────────────────
Show-Section "Key Files"
$required = @{
    "chat-server.mjs"     = "Main application"
    "package.json"        = "Node package config"
    ".env"                = "SAP + AI credentials"
    "dist\server.js"      = "Compiled TypeScript MCP server"
    "node_modules"        = "npm packages"
}
foreach ($f in $required.Keys) {
    if (Test-Path (Join-Path $PSScriptRoot $f)) {
        Pass "$f  ($($required[$f]))"
    } else {
        Fail "$f  MISSING  -- $($required[$f])"
        $issues.Add("Missing file: $f")
    }
}

# ── 3. .env content ───────────────────────────────────────────────────────────
Show-Section ".env Configuration"
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    $env = Get-Content $envFile | Where-Object { $_ -match '=' -and $_ -notmatch '^#' }
    $keys = @{}
    $env | ForEach-Object { $parts = $_ -split '=',2; $keys[$parts[0].Trim()] = $parts[1] }

    $sapKeys = @('SAP_B1_BASE_URL','SL_BASE_URL','SAP_B1_COMPANY','SAP_B1_USER','SAP_B1_PASSWORD')
    foreach ($k in $sapKeys) {
        if ($keys.ContainsKey($k) -and $keys[$k]) { Pass "$k = set" }
        else { Fail "$k = MISSING or empty"; $issues.Add("Add $k to .env") }
    }

    $aiSet = $false
    foreach ($k in @('ANTHROPIC_API_KEY','AZURE_OPENAI_API_KEY')) {
        if ($keys.ContainsKey($k) -and $keys[$k]) { Pass "$k = set"; $aiSet = $true }
    }
    if (-not $aiSet) { Warn "No AI API key found - NLP-only mode (no AI responses)" }
} else {
    Fail ".env not found"
    $issues.Add("Create .env from .env.example")
}

# ── 4. Windows Service ────────────────────────────────────────────────────────
Show-Section "Windows Service"
$svc = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Pass "Service 'AgentSphere AI' is RUNNING"
    } else {
        Fail "Service 'AgentSphere AI' is $($svc.Status)"
        $issues.Add("Service is not running - see fix below")

        # Try to get last error from Event Log
        $evts = Get-EventLog -LogName Application -Source "AgentSphere AI" -Newest 5 -ErrorAction SilentlyContinue
        if ($evts) {
            Warn "Last service events:"
            $evts | ForEach-Object { Info "  [$($_.TimeGenerated)] $($_.Message.Substring(0,[Math]::Min(200,$_.Message.Length)))" }
        }
    }
} else {
    Warn "Windows Service not registered (will run in direct mode)"
    $issues.Add("Service not registered - run install.bat as Administrator to register it")
}

# ── 5. Port 3000 ──────────────────────────────────────────────────────────────
Show-Section "Port 3000"
$listening = netstat -ano 2>$null | Select-String ":3000\s"
if ($listening) {
    $pid3000 = ($listening | Select-Object -First 1 | ForEach-Object { ($_ -split '\s+')[-1] })
    Pass "Port 3000 is LISTENING  (PID $pid3000)"
    try {
        $proc = Get-Process -Id ([int]$pid3000) -ErrorAction Stop
        Info "Process: $($proc.Name)  ($($proc.MainWindowTitle))"
    } catch {}
} else {
    Fail "Port 3000 NOT listening - app is not running"
    $issues.Add("Application is not running on port 3000")
}

# ── 6. HTTP check ─────────────────────────────────────────────────────────────
Show-Section "HTTP Response"
try {
    $r = Invoke-WebRequest "http://localhost:3000" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Pass "http://localhost:3000  →  HTTP $($r.StatusCode)"
} catch {
    Fail "http://localhost:3000 not responding  ($($_.Exception.Message))"
    $issues.Add("HTTP on port 3000 not responding")
}

# ── 7. chat.log ───────────────────────────────────────────────────────────────
Show-Section "chat.log (last 25 lines)"
$logFile = Join-Path $PSScriptRoot "chat.log"
if (Test-Path $logFile) {
    Pass "Log file found: $logFile"
    Write-Host ""
    Get-Content $logFile -Tail 25 | ForEach-Object { Info $_ }
} else {
    Warn "chat.log not found - app has never started or log path differs"
    $issues.Add("No chat.log - app has not started successfully yet")
}

# ── 8. node-windows daemon log ────────────────────────────────────────────────
Show-Section "Service Daemon Log"
$daemonLog = Join-Path $PSScriptRoot "AgentSphere AI.wrapper.log"
if (-not (Test-Path $daemonLog)) {
    $daemonLog = Get-ChildItem $PSScriptRoot -Filter "*.wrapper.log" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if ($daemonLog -and (Test-Path $daemonLog)) {
    Pass "Daemon log: $daemonLog"
    Write-Host ""
    Get-Content $daemonLog -Tail 20 | ForEach-Object { Info $_ }
} else {
    Warn "No wrapper.log found (service may not be registered via node-windows)"
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor $(if ($issues.Count -eq 0) { "Green" } else { "Red" })
if ($issues.Count -eq 0) {
    Write-Host "  |   All checks passed - app is healthy                        |" -ForegroundColor Green
} else {
    Write-Host "  |   $($issues.Count) issue(s) found - see action plan below             |" -ForegroundColor Red
}
Write-Host "  +=============================================================+" -ForegroundColor $(if ($issues.Count -eq 0) { "Green" } else { "Red" })

if ($issues.Count -gt 0) {
    Write-Host ""
    Write-Host "  ACTION PLAN:" -ForegroundColor Yellow
    $i = 1
    foreach ($issue in $issues) {
        Write-Host "  $i. $issue" -ForegroundColor White
        $i++
    }
}

Write-Host ""
Write-Host "  QUICK FIX OPTIONS:" -ForegroundColor Cyan
Write-Host "  A) Start directly (no service):  double-click Start.bat" -ForegroundColor White
Write-Host "  B) Re-register service:          Run install.bat as Administrator" -ForegroundColor White
Write-Host "  C) Manual start + log:           Run  node chat-server.mjs  in this folder" -ForegroundColor White
Write-Host ""

Read-Host "  Press Enter to close"

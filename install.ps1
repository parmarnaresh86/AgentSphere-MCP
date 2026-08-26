#Requires -Version 5.1
<#
.SYNOPSIS
    AgentSphere AI for SAP Business One - One-Touch Installer / Updater
    Registers the app as a Windows Service (starts at boot, no login needed).
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ── Helpers ───────────────────────────────────────────────────────────────────

function Show-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "  +=============================================================+" -ForegroundColor Cyan
    Write-Host "  |       AgentSphere AI  for  SAP Business One                 |" -ForegroundColor Cyan
    Write-Host "  |              One-Touch Installer / Updater                  |" -ForegroundColor Cyan
    Write-Host "  +=============================================================+" -ForegroundColor Cyan
    Write-Host ""
}

$script:step = 0
$script:totalSteps = 10

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

function Read-Required($label, $default = "") {
    do {
        $prompt = if ($default) { "    $label [$default]" } else { "    $label" }
        $val = Read-Host $prompt
        if (-not $val -and $default) { $val = $default }
        if (-not $val.Trim()) { Write-Host "    (required)" -ForegroundColor Yellow }
    } while (-not $val.Trim())
    return $val.Trim()
}

function Read-Secret($label) {
    do {
        $ss = Read-Host "    $label" -AsSecureString
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
        if (-not $plain) { Write-Host "    (required)" -ForegroundColor Yellow }
    } while (-not $plain)
    return $plain
}

function New-Shortcut($name, $target, $desc, $iconIdx) {
    $desk = [Environment]::GetFolderPath("Desktop")
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut("$desk\$name.lnk")
    $lnk.TargetPath       = $target
    $lnk.WorkingDirectory = $PSScriptRoot
    $lnk.Description      = $desc
    $lnk.IconLocation     = "$env:SystemRoot\System32\SHELL32.dll,$iconIdx"
    $lnk.Save()
}

# ── Start ─────────────────────────────────────────────────────────────────────

Show-Banner

# ── Admin elevation ───────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "  Requesting Administrator privileges..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Show-Banner

# Detect install vs update
$mode = if (Test-Path "node_modules") { "UPDATE" } else { "INSTALL" }
$modeLabel = if ($mode -eq "UPDATE") { "UPDATE  (existing installation found)" } else { "FRESH INSTALL" }
Write-Host "  Mode: $modeLabel" -ForegroundColor $(if ($mode -eq "UPDATE") { "Yellow" } else { "Cyan" })
Write-Host ""

# ── STEP 1: Node.js 18+ ───────────────────────────────────────────────────────
Write-Step "Checking Node.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn "Node.js not found - opening download page..."
    Start-Process "https://nodejs.org/en/download"
    Stop-WithError "Install Node.js 18+ then re-run this installer."
}

$nodeVer   = (node -v).Trim().TrimStart('v')
$nodeMajor = [int](($nodeVer -split '\.')[0])
if ($nodeMajor -lt 18) {
    Stop-WithError "Node.js 18+ required (found v$nodeVer). Download from https://nodejs.org"
}
Write-OK "Node.js v$nodeVer"
Write-Host ""

# ── STEP 2: npm install ───────────────────────────────────────────────────────
Write-Step "Installing packages (including node-windows)"

# Native command output is left un-redirected on purpose: with $ErrorActionPreference
# = 'Stop', a "2>&1" capture wraps every stderr line (npm writes routine warnings
# there constantly) as a terminating error and kills the script instantly.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
npm install
$npmExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($npmExit -ne 0) {
    Stop-WithError "npm install failed (exit $npmExit) - check your internet connection and the output above."
}
Write-OK "Packages ready"
Write-Host ""

# ── STEP 3: Build TypeScript ──────────────────────────────────────────────────
Write-Step "Building TypeScript"

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
npm run build
$buildExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($buildExit -ne 0) {
    Stop-WithError "TypeScript build failed (exit $buildExit) - see errors above."
}
Write-OK "Build complete"
Write-Host ""

# ── STEP 4: Configuration (.env) ─────────────────────────────────────────────
Write-Step "Configuration"
Write-Host ""

$writeEnv = $true

if (Test-Path ".env") {
    Write-Host "  Existing .env found." -ForegroundColor Yellow
    $keep = Read-Host "    Keep existing configuration? [Y/n]"
    if ($keep -notmatch '^[Nn]') {
        $writeEnv = $false
        Write-OK "Existing .env preserved"
    } else {
        Copy-Item ".env" ".env.bak" -Force
        Write-OK "Old .env backed up to .env.bak"
    }
}

if ($writeEnv) {
    Write-Host ""
    Write-Host "  SAP Business One Connection" -ForegroundColor White
    Write-Host "  ------------------------------------------" -ForegroundColor DarkGray

    $sapUrl = Read-Required "Service Layer URL  (e.g. https://192.168.1.10:50000/b1s/v1)"
    $sapUrl = $sapUrl.TrimEnd('/')
    $sapCo  = Read-Required "Company Database   (e.g. SBODemoUS)"
    $sapUs  = Read-Required "SAP Username       (e.g. manager)"
    $sapPw  = Read-Secret   "SAP Password"

    Write-Host ""
    Write-Host "  AI Provider" -ForegroundColor White
    Write-Host "  ------------------------------------------" -ForegroundColor DarkGray
    Write-Host "    1. Anthropic  (Claude - direct)"
    Write-Host "    2. Azure OpenAI  (GPT-4o)"
    Write-Host "    3. Azure Claude"
    Write-Host "    4. Skip / NLP only (no AI key)"
    Write-Host ""
    do { $ai = Read-Host "    Choice [1-4]" } while ($ai -notmatch '^[1-4]$')

    $envLines = [System.Collections.Generic.List[string]]@(
        "SAP_B1_BASE_URL=$sapUrl",
        "SL_BASE_URL=$sapUrl",
        "SAP_B1_COMPANY=$sapCo",
        "SL_COMPANY=$sapCo",
        "SAP_B1_USER=$sapUs",
        "SL_USER=$sapUs",
        "SAP_B1_PASSWORD=$sapPw",
        "SL_PASSWORD=$sapPw",
        "NODE_TLS_REJECT_UNAUTHORIZED=0",
        "CHAT_PORT=3000"
    )

    switch ($ai) {
        "1" {
            Write-Host ""
            $k = Read-Required "Anthropic API Key (sk-ant-...)"
            $envLines.Add("ANTHROPIC_API_KEY=$k")
        }
        "2" {
            Write-Host ""
            $ep = Read-Required "Azure GPT-4o Endpoint"
            $k  = Read-Required "Azure API Key"
            $envLines.Add("AI_PROVIDER=gpt")
            $envLines.Add("AZURE_GPT_ENDPOINT=$ep")
            $envLines.Add("AZURE_OPENAI_API_KEY=$k")
        }
        "3" {
            Write-Host ""
            $ep  = Read-Required "Azure Claude Endpoint"
            $k   = Read-Required "Azure API Key"
            $mdl = Read-Required "Model" "claude-3-5-sonnet-20241022"
            $envLines.Add("AI_PROVIDER=azure")
            $envLines.Add("AZURE_OPENAI_ENDPOINT=$ep")
            $envLines.Add("AZURE_OPENAI_API_KEY=$k")
            $envLines.Add("AZURE_CLAUDE_MODEL=$mdl")
        }
    }

    # Auto-generate DB encryption key for HANA password storage
    $encKey = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
    $envLines.Add("DB_ENCRYPT_KEY=$encKey")

    $envLines | Set-Content ".env" -Encoding utf8NoBOM
    Write-OK ".env created"
    Write-OK "DB_ENCRYPT_KEY auto-generated (HANA password encryption)"

    # Optional SAP connection test
    Write-Host ""
    $testConn = Read-Host "    Test SAP B1 connection now? [Y/n]"
    if ($testConn -notmatch '^[Nn]') {
        Write-Host "    Connecting to SAP..." -ForegroundColor DarkGray
        try {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

            $body = @{ CompanyDB = $sapCo; UserName = $sapUs; Password = $sapPw } | ConvertTo-Json
            $null = Invoke-RestMethod -Uri "$sapUrl/Login" -Method POST -Body $body `
                        -ContentType "application/json" -TimeoutSec 15 -ErrorAction Stop
            Write-OK "SAP connection successful"
        } catch {
            Write-Warn "Connection test failed: $($_.Exception.Message)"
            Write-Warn "Check credentials in .env if the app does not connect"
        }
    }
}

Write-Host ""

# ── STEP 5: Install as Windows Service ───────────────────────────────────────
Write-Step "Installing Windows Service (starts at boot, no login needed)"
Write-Host ""

# Stop and remove any existing Windows Service install
$existing = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Existing service found - removing for clean reinstall..." -ForegroundColor DarkGray
    if ($existing.Status -eq 'Running') {
        Stop-Service "AgentSphere AI" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    node "$PSScriptRoot\service-uninstall.mjs"
    Start-Sleep -Seconds 2
}

# Clean up any stale pm2 service (migration from old install)
$pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
if ($pm2Cmd) {
    & pm2 delete agentsphere-ai 2>$null | Out-Null
}

# Install as proper Windows Service via node-windows
Write-Host "  Registering service with Windows SCM..." -ForegroundColor DarkGray
node "$PSScriptRoot\service-install.mjs"

if ($LASTEXITCODE -ne 0) {
    Stop-WithError "Windows Service installation failed. See output above."
}

# Verify service is registered
Start-Sleep -Seconds 3
$svc = Get-Service "AgentSphere AI" -ErrorAction SilentlyContinue
if ($svc) {
    Write-OK "Windows Service registered: '$($svc.DisplayName)' [$($svc.Status)]"
    Write-OK "Startup type: Automatic (starts at every Windows boot)"
} else {
    Write-Warn "Service may still be registering - check services.msc"
}

Write-Host ""

# ── STEP 6: Windows Firewall rule ────────────────────────────────────────────
Write-Step "Configuring Windows Firewall (LAN access on port 3000)"

$fwRuleName = "AgentSphere AI (port 3000)"
$existingRule = Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
if ($existingRule) {
    Remove-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
}
New-NetFirewallRule `
    -DisplayName  $fwRuleName `
    -Direction    Inbound `
    -Protocol     TCP `
    -LocalPort    3000 `
    -Action       Allow `
    -Profile      Domain,Private `
    -Description  "Allows LAN access to AgentSphere AI chat UI" | Out-Null

Write-OK "Firewall rule added - port 3000 open on Domain and Private networks"
Write-Host ""

# ── STEP 7: Desktop shortcuts ─────────────────────────────────────────────────
Write-Step "Creating desktop shortcuts"

New-Shortcut "AgentSphere AI - Start"   "$PSScriptRoot\Start.bat"  "Start AgentSphere AI"          14
New-Shortcut "AgentSphere AI - Stop"    "$PSScriptRoot\Stop.bat"   "Stop AgentSphere AI"           131
New-Shortcut "AgentSphere AI - Status"  "$PSScriptRoot\Status.bat" "AgentSphere AI Service Status" 24
Write-OK "Shortcuts created on Desktop"
Write-Host ""

# ── STEP 8: SQLite database (hanny.db) ───────────────────────────────────────
Write-Step "Setting up local database (SQLite - hanny.db)"

$dbPath = Join-Path $PSScriptRoot "hanny.db"

if (Test-Path $dbPath) {
    Write-OK "Existing database found - keeping it as-is ($([math]::Round((Get-Item $dbPath).Length/1KB,1)) KB)"
} else {
    # Offer to restore from a backup copy dropped next to the installer
    $backupCandidates = @(
        (Join-Path $PSScriptRoot "backup\hanny.db"),
        (Join-Path $PSScriptRoot "hanny.db.bak")
    ) | Where-Object { Test-Path $_ }

    if ($backupCandidates.Count -gt 0) {
        Write-Host "  Found a database backup: $($backupCandidates[0])" -ForegroundColor Yellow
        $restore = Read-Host "    Restore it as the active database? [Y/n]"
        if ($restore -notmatch '^[Nn]') {
            Copy-Item $backupCandidates[0] $dbPath -Force
            Write-OK "Database restored from backup"
        }
    }

    if (-not (Test-Path $dbPath)) {
        # No existing DB and no backup - let db.mjs create + seed it (default admin/admin123)
        Write-Host "  No existing database - creating a fresh one..." -ForegroundColor DarkGray
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        node -e "import('./db.mjs').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
        $ErrorActionPreference = $prevEAP
        if (Test-Path $dbPath) {
            Write-OK "hanny.db created and seeded with default admin account (admin / admin123)"
            Write-Warn "Change the default admin password after first login"
        } else {
            Write-Warn "Database will be created automatically on first app start instead"
        }
    }
}
Write-Host ""

# ── STEP 9: Claude Desktop connector (optional) ──────────────────────────────
Write-Step "Claude Desktop MCP connector (optional)"
Write-Host ""

$doClaudeSetup = Read-Host "    Register this SAP B1 server as a Claude Desktop connector? [y/N]"
if ($doClaudeSetup -match '^[Yy]') {
    if (-not (Test-Path "dist\server.js")) {
        Write-Warn "dist\server.js missing - skipping (build step above should have produced it)"
    } else {
        $claudeConfigPath = $null
        $pkg = Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter 'Claude_*' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pkg) {
            $candidate = Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
            if (Test-Path $candidate) { $claudeConfigPath = $candidate }
        }
        if (-not $claudeConfigPath) {
            $classic = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
            if (Test-Path $classic) { $claudeConfigPath = $classic }
        }

        if (-not $claudeConfigPath) {
            Write-Warn "Claude Desktop config not found - install Claude Desktop, run it once, then re-run:"
            Write-Warn "  powershell -ExecutionPolicy Bypass -File .\install-desktop-mcp.ps1"
        } else {
            $envLinesNow = Get-Content ".env"
            function Get-EnvVal($name) {
                $l = $envLinesNow | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
                if (-not $l) { return $null }
                return ($l -replace "^\s*$name\s*=", '').Trim()
            }
            $ceUrl  = Get-EnvVal 'SL_BASE_URL'
            $ceCo   = Get-EnvVal 'SL_COMPANY'
            $ceUser = Get-EnvVal 'SL_USER'
            $cePass = Get-EnvVal 'SL_PASSWORD'

            if (-not ($ceUrl -and $ceCo -and $ceUser -and $cePass)) {
                Write-Warn "SL_* credentials missing from .env - skipping connector write"
            } else {
                $backupPath = "$claudeConfigPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                Copy-Item $claudeConfigPath $backupPath -Force
                $json = Get-Content $claudeConfigPath -Raw | ConvertFrom-Json
                if (-not $json.PSObject.Properties['mcpServers']) {
                    $json | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([PSCustomObject]@{})
                }
                $connectorName = "sap-b1-agentsphere"
                $entry = [PSCustomObject]@{
                    command = 'node'
                    args    = @((Join-Path $PSScriptRoot 'dist\server.js') -replace '\\', '/')
                    env     = [PSCustomObject]@{
                        SL_BASE_URL                  = $ceUrl
                        SL_COMPANY                   = $ceCo
                        SL_USER                      = $ceUser
                        SL_PASSWORD                  = $cePass
                        NODE_TLS_REJECT_UNAUTHORIZED = '0'
                    }
                }
                if ($json.mcpServers.PSObject.Properties[$connectorName]) {
                    $json.mcpServers.PSObject.Properties.Remove($connectorName)
                }
                $json.mcpServers | Add-Member -NotePropertyName $connectorName -NotePropertyValue $entry
                $jsonText = $json | ConvertTo-Json -Depth 10
                [System.IO.File]::WriteAllText($claudeConfigPath, $jsonText, [System.Text.UTF8Encoding]::new($false))
                Write-OK "Connector '$connectorName' written to Claude Desktop config"
                Write-OK "Backed up previous config to $backupPath"
                Write-Warn "Fully quit Claude Desktop (system tray -> Quit) and reopen it to load the connector"
            }
        }
    }
} else {
    Write-Host "  Skipped. Run later with:  install-desktop-mcp.ps1  or  Setup-SapConnector.ps1" -ForegroundColor DarkGray
}
Write-Host ""

# ── STEP 10: ChatGPT connector via SQL Gateway (optional) ───────────────────
Write-Step "ChatGPT connector - SQL Gateway local-agent (optional)"
Write-Host ""
Write-Host "  ChatGPT cannot run a local MCP server directly - it needs the" -ForegroundColor DarkGray
Write-Host "  sql-gateway-mcp relay (Render server + this PC's local-agent)." -ForegroundColor DarkGray

$gatewayDir = Join-Path $PSScriptRoot "sql-gateway-mcp\local-agent"
if (-not (Test-Path $gatewayDir)) {
    Write-Warn "sql-gateway-mcp\local-agent not found in this project - skipping"
} else {
    $doGateway = Read-Host "    Install/refresh the SQL Gateway connector for ChatGPT now? [y/N]"
    if ($doGateway -match '^[Yy]') {
        Write-Host "  Launching SQL Gateway installer..." -ForegroundColor DarkGray
        Start-Process -FilePath (Join-Path $gatewayDir "install.bat") -WorkingDirectory $gatewayDir -Wait
        Write-OK "SQL Gateway connector setup finished (see its own summary above)"
    } else {
        Write-Host "  Skipped. Run later with:  sql-gateway-mcp\local-agent\install.bat" -ForegroundColor DarkGray
    }
}
Write-Host ""

# ── Done ──────────────────────────────────────────────────────────────────────

$title = if ($mode -eq "UPDATE") { "Update Complete!" } else { "Installation Complete!" }

Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor Green
Write-Host "  |   $($title.PadRight(57))|" -ForegroundColor Green
Write-Host "  +=============================================================+" -ForegroundColor Green
Write-Host ""
Write-Host "  Windows Service: 'AgentSphere AI'" -ForegroundColor White
Write-Host "  - Starts AUTOMATICALLY at every Windows boot (no login needed)" -ForegroundColor DarkGray
Write-Host "  - Auto-restarts if it crashes" -ForegroundColor DarkGray
Write-Host "  - Manage via: services.msc" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Access (share these with LAN users):" -ForegroundColor White
Write-Host "    This PC:  http://localhost:3000" -ForegroundColor Cyan

$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' }).IPAddress
foreach ($ip in $ips) {
    Write-Host "    LAN:      http://${ip}:3000" -ForegroundColor Green
}
Write-Host ""
Write-Host "  Firewall: port 3000 open on Domain + Private networks" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Database: SQLite at $dbPath" -ForegroundColor White
Write-Host "  - Default login (first run only): admin / admin123 - change it after logging in" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Desktop shortcuts: Start  |  Stop  |  Status" -ForegroundColor DarkGray
Write-Host "  Logs: $PSScriptRoot\chat.log" -ForegroundColor DarkGray
Write-Host ""

Start-Sleep -Seconds 3
Start-Process "http://localhost:3000"

Read-Host "  Press Enter to close"

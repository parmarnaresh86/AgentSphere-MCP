#Requires -Version 5.1
<#
.SYNOPSIS
    SAP B1 MCP Connector Setup Wizard - interactive installer for Claude Desktop.
    Configures one connector against any mix of Service Layer, SQL Server, and
    HANA access, tests each connection before saving, and writes the result
    straight into Claude Desktop's config. Safe to re-run to add another
    connector or update an existing one.

.WHAT IT DOES
    1. Ensures dependencies are installed and the server is built
    2. Asks which access path(s) to configure (Service Layer / SQL Server / HANA)
    3. Prompts for credentials for each selected path and TESTS them live
    4. Locates Claude Desktop's config (Store/MSIX or classic install)
    5. Backs up the existing config, then writes/updates the named connector
    6. Tells you to restart Claude Desktop
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Show-Banner {
    Write-Host ""
    Write-Host "  +=======================================================+" -ForegroundColor Cyan
    Write-Host "  |     SAP B1 MCP Connector - Setup Wizard                |" -ForegroundColor Cyan
    Write-Host "  +=======================================================+" -ForegroundColor Cyan
    Write-Host ""
}

function Write-OK($msg)   { Write-Host "      OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "      WARN $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "      FAIL $msg" -ForegroundColor Red }

function Read-Required($label, $default = "") {
    do {
        $prompt = if ($default) { "  $label [$default]" } else { "  $label" }
        $val = Read-Host $prompt
        if (-not $val -and $default) { $val = $default }
        if (-not $val.Trim()) { Write-Host "    (required)" -ForegroundColor Yellow }
    } while (-not $val.Trim())
    return $val.Trim()
}

function Read-Optional($label, $default = "") {
    $prompt = if ($default) { "  $label [$default] (optional)" } else { "  $label (optional, Enter to skip)" }
    $val = Read-Host $prompt
    if (-not $val -and $default) { return $default }
    return $val.Trim()
}

function Read-Secret($label) {
    $ss = Read-Host "  $label" -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
}

function Read-YesNo($label, $defaultYes = $false) {
    $suffix = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
    $val = Read-Host "  $label $suffix"
    if (-not $val) { return $defaultYes }
    return $val -match '^[Yy]'
}

Show-Banner

# -- STEP 1: dependencies + build ---------------------------------------------
Write-Host "[1/5] Checking dependencies..." -ForegroundColor White
if (-not (Test-Path "node_modules")) {
    Write-Host "      Installing packages (first run)..." -ForegroundColor DarkGray
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}
npm run build | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
$serverJs = Join-Path $PSScriptRoot 'dist\server.js'
if (-not (Test-Path $serverJs)) { throw "Build did not produce dist\server.js" }
Write-OK "Server built: $serverJs"
Write-Host ""

# -- STEP 2: connector name ---------------------------------------------------
Write-Host "[2/5] Connector identity" -ForegroundColor White
$connectorName = Read-Required "Connector name (shown in Claude Desktop, e.g. sap-b1-acme)"
Write-Host ""

# -- STEP 3: choose and configure access paths --------------------------------
Write-Host "[3/5] Choose access path(s) for this connector" -ForegroundColor White
Write-Host "      You can enable more than one - Claude will use whichever works." -ForegroundColor DarkGray
Write-Host ""

$envVars = @{}

# --- Service Layer ---
if (Read-YesNo "Configure Service Layer (REST API - the full 60+ tool suite)?" $true) {
    Write-Host ""
    $slUrl  = Read-Required "  Service Layer URL (e.g. https://host:50000/b1s/v1)"
    $slUrl  = $slUrl.TrimEnd('/')
    $slCo   = Read-Required "  Company DB"
    $slUser = Read-Required "  Username" "manager"
    $slPass = Read-Secret   "  Password"

    Write-Host "      Testing login..." -ForegroundColor DarkGray
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
        $body = @{ CompanyDB = $slCo; UserName = $slUser; Password = $slPass } | ConvertTo-Json
        $null = Invoke-RestMethod -Uri "$slUrl/Login" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 15 -ErrorAction Stop
        Write-OK "Service Layer login succeeded"
    } catch {
        Write-Err "Service Layer login failed: $($_.Exception.Message)"
        Write-Warn "Saving these values anyway - fix credentials/server config later if needed."
    }

    $envVars['SL_BASE_URL'] = $slUrl
    $envVars['SL_COMPANY']  = $slCo
    $envVars['SL_USER']     = $slUser
    $envVars['SL_PASSWORD'] = $slPass
    $envVars['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    Write-Host ""
}

# --- SQL Server ---
if (Read-YesNo "Configure direct SQL Server access (bypasses Service Layer)?" $false) {
    Write-Host ""
    $sqlHost = Read-Required "  SQL Server host/IP"
    $sqlInst = Read-Optional "  Named instance (e.g. SQLEXPRESS01, leave blank if using a port)"
    $sqlPort = ""
    if (-not $sqlInst) { $sqlPort = Read-Optional "  Port" "1433" }
    $sqlDb   = Read-Required "  Database name"
    $sqlUser = Read-Required "  Username" "sa"
    $sqlPass = Read-Secret   "  Password"

    Write-Host "      Testing connection..." -ForegroundColor DarkGray
    try {
        $server = if ($sqlInst) { "$sqlHost\$sqlInst" } else { "$sqlHost,$sqlPort" }
        $testCmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
        if ($testCmd) {
            $out = & sqlcmd -S $server -U $sqlUser -P $sqlPass -Q "SELECT 1" -C 2>&1
            if ($LASTEXITCODE -eq 0) { Write-OK "SQL Server connection succeeded" }
            else { Write-Err "SQL Server test failed: $out"; Write-Warn "Saving these values anyway." }
        } else {
            Write-Warn "sqlcmd not found - skipping live test, saving values as-is."
        }
    } catch {
        Write-Err "SQL Server test failed: $($_.Exception.Message)"
        Write-Warn "Saving these values anyway."
    }

    $envVars['MSSQL_HOST']     = $sqlHost
    if ($sqlInst) { $envVars['MSSQL_INSTANCE'] = $sqlInst }
    if ($sqlPort) { $envVars['MSSQL_PORT']     = $sqlPort }
    $envVars['MSSQL_DATABASE'] = $sqlDb
    $envVars['MSSQL_USER']     = $sqlUser
    $envVars['MSSQL_PASSWORD'] = $sqlPass
    Write-Host ""
}

# --- HANA ---
if (Read-YesNo "Configure direct HANA access (bypasses Service Layer)?" $false) {
    Write-Host ""
    $hanaHost = Read-Required "  HANA host/IP"
    $hanaPort = Read-Required "  SQL port (e.g. 30113 for a tenant, 30015 for single-container)"
    $hanaTenant = Read-Optional "  Tenant/database name (e.g. HDB - leave blank for single-container HANA)"
    $hanaUser = Read-Required "  Username" "SYSTEM"
    $hanaPass = Read-Secret   "  Password"

    Write-Host "      Testing connection..." -ForegroundColor DarkGray
    $testScript = Join-Path $env:TEMP "hana-test-$(Get-Random).mjs"
    $escUser = $hanaUser -replace "'", "\'"
    $escPass = $hanaPass -replace "'", "\'"
    @"
import hdb from "hdb";
const client = hdb.createClient({ host: '$hanaHost', port: $hanaPort, user: '$escUser', password: '$escPass'$(if ($hanaTenant) { ", databaseName: '$hanaTenant'" }) });
client.connect((err) => {
  if (err) { console.log("FAIL:" + err.message); process.exit(1); }
  console.log("OK");
  client.disconnect();
});
"@ | Set-Content -Path $testScript -Encoding utf8
    try {
        $out = & node $testScript 2>&1
        Remove-Item $testScript -Force -ErrorAction SilentlyContinue
        if ($out -match "^OK") { Write-OK "HANA connection succeeded" }
        else { Write-Err "HANA test failed: $out"; Write-Warn "Saving these values anyway." }
    } catch {
        Remove-Item $testScript -Force -ErrorAction SilentlyContinue
        Write-Err "HANA test failed: $($_.Exception.Message)"
        Write-Warn "Saving these values anyway."
    }

    $envVars['HANA_HOST']     = $hanaHost
    $envVars['HANA_PORT']     = $hanaPort
    if ($hanaTenant) { $envVars['HANA_TENANT'] = $hanaTenant }
    $envVars['HANA_USER']     = $hanaUser
    $envVars['HANA_PASSWORD'] = $hanaPass
    Write-Host ""
}

if ($envVars.Count -eq 0) {
    throw "No access path configured - nothing to install. Re-run and enable at least one."
}

# -- STEP 4: locate Claude Desktop config -------------------------------------
Write-Host "[4/5] Locating Claude Desktop config..." -ForegroundColor White

$configPath = $null
$pkg = Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter 'Claude_*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg) {
    $candidate = Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
    if (Test-Path $candidate) { $configPath = $candidate }
}
if (-not $configPath) {
    $classic = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
    if (Test-Path $classic) { $configPath = $classic }
}
if (-not $configPath) {
    throw "Could not find claude_desktop_config.json. Is Claude Desktop installed and has it been run at least once?"
}
Write-OK $configPath
Write-Host ""

# -- STEP 5: write connector ---------------------------------------------------
Write-Host "[5/5] Writing connector '$connectorName'..." -ForegroundColor White

$backupPath = "$configPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $configPath $backupPath
Write-Host "      Backed up existing config to $backupPath" -ForegroundColor DarkGray

$json = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $json.PSObject.Properties['mcpServers']) {
    $json | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([PSCustomObject]@{})
}

$envObj = [PSCustomObject]@{}
foreach ($key in $envVars.Keys) {
    $envObj | Add-Member -NotePropertyName $key -NotePropertyValue $envVars[$key]
}

$entry = [PSCustomObject]@{
    command = 'node'
    args    = @($serverJs -replace '\\', '/')
    env     = $envObj
}

if ($json.mcpServers.PSObject.Properties[$connectorName]) {
    $json.mcpServers.PSObject.Properties.Remove($connectorName)
}
$json.mcpServers | Add-Member -NotePropertyName $connectorName -NotePropertyValue $entry

$jsonText = $json | ConvertTo-Json -Depth 10
# Claude Desktop's JSON parser rejects a UTF-8 BOM, which -Encoding utf8 in PS 5.1 adds.
[System.IO.File]::WriteAllText($configPath, $jsonText, [System.Text.UTF8Encoding]::new($false))

Write-OK "Connector '$connectorName' written"
Write-Host ""
Write-Host "  +=======================================================+" -ForegroundColor Green
Write-Host "  |   Setup complete                                       |" -ForegroundColor Green
Write-Host "  +=======================================================+" -ForegroundColor Green
Write-Host ""
Write-Host "  Access paths configured: $($envVars.Keys -join ', ')" -ForegroundColor White
Write-Host ""
Write-Host "  Fully quit Claude Desktop (system tray -> Quit) and reopen it" -ForegroundColor Cyan
Write-Host "  to load '$connectorName'." -ForegroundColor Cyan
Write-Host ""
Read-Host "  Press Enter to close"

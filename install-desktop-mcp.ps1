#Requires -Version 5.1
<#
.SYNOPSIS
    Installs/refreshes the SAP B1 MCP server as a connector in Claude Desktop
    on this laptop. Safe to re-run any time (e.g. after moving the repo,
    changing .env credentials, or a Claude Desktop reinstall/update).

.WHAT IT DOES
    1. Builds the MCP server (npm run build -> dist/server.js)
    2. Reads SL_BASE_URL / SL_COMPANY / SL_USER / SL_PASSWORD from .env
    3. Locates Claude Desktop's config file (Store/MSIX install or classic install)
    4. Backs up the existing config, then merges in the "sap-b1-wms-dev-uk"
       mcpServers entry (existing entries/preferences are preserved)
    5. Tells you to restart Claude Desktop
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$ServerName = 'sap-b1-wms-dev-uk'
$ServerJs   = Join-Path $PSScriptRoot 'dist\server.js'

Write-Host ""
Write-Host "== SAP B1 MCP -> Claude Desktop connector installer ==" -ForegroundColor Cyan
Write-Host ""

# ── 1. Build ──────────────────────────────────────────────────────────────
Write-Host "[1/4] Building MCP server (npm run build)..." -ForegroundColor White
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
if (-not (Test-Path $ServerJs)) { throw "Build did not produce $ServerJs" }
Write-Host "      OK - $ServerJs" -ForegroundColor Green

# ── 2. Read credentials from .env ────────────────────────────────────────
Write-Host "[2/4] Reading credentials from .env..." -ForegroundColor White
$envPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }
$envLines = Get-Content $envPath

function Get-EnvValue($name) {
    $line = $envLines | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line -replace "^\s*$name\s*=", '').Trim()
}

$slBaseUrl = Get-EnvValue 'SL_BASE_URL'
$slCompany = Get-EnvValue 'SL_COMPANY'
$slUser    = Get-EnvValue 'SL_USER'
$slPass    = Get-EnvValue 'SL_PASSWORD'

foreach ($pair in @(@('SL_BASE_URL', $slBaseUrl), @('SL_COMPANY', $slCompany), @('SL_USER', $slUser), @('SL_PASSWORD', $slPass))) {
    if (-not $pair[1]) { throw "$($pair[0]) missing from .env" }
}
Write-Host "      OK - $slCompany @ $slBaseUrl" -ForegroundColor Green

# ── 3. Locate Claude Desktop config ──────────────────────────────────────
Write-Host "[3/4] Locating Claude Desktop config..." -ForegroundColor White

$configPath = $null

# Store/MSIX install: LocalAppData\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json
$pkg = Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter 'Claude_*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg) {
    $candidate = Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
    if (Test-Path $candidate) { $configPath = $candidate }
}

# Classic (non-Store) install fallback
if (-not $configPath) {
    $classic = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
    if (Test-Path $classic) { $configPath = $classic }
}

if (-not $configPath) {
    throw "Could not find claude_desktop_config.json. Is Claude Desktop installed and has it been run at least once?"
}
Write-Host "      OK - $configPath" -ForegroundColor Green

# ── 4. Merge in the mcpServers entry ──────────────────────────────────────
Write-Host "[4/4] Updating config..." -ForegroundColor White

$backupPath = "$configPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $configPath $backupPath
Write-Host "      Backed up existing config to $backupPath" -ForegroundColor Yellow

$json = Get-Content $configPath -Raw | ConvertFrom-Json

if (-not $json.PSObject.Properties['mcpServers']) {
    $json | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([PSCustomObject]@{})
}

$entry = [PSCustomObject]@{
    command = 'node'
    args    = @($ServerJs -replace '\\', '/')
    env     = [PSCustomObject]@{
        SL_BASE_URL                  = $slBaseUrl
        SL_COMPANY                   = $slCompany
        SL_USER                      = $slUser
        SL_PASSWORD                  = $slPass
        NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }
}

if ($json.mcpServers.PSObject.Properties[$ServerName]) {
    $json.mcpServers.PSObject.Properties.Remove($ServerName)
}
$json.mcpServers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $entry

$jsonText = $json | ConvertTo-Json -Depth 10
# Claude Desktop's JSON parser rejects a UTF-8 BOM, which -Encoding utf8 in PS 5.1 adds.
[System.IO.File]::WriteAllText($configPath, $jsonText, [System.Text.UTF8Encoding]::new($false))

Write-Host "      OK - '$ServerName' connector written" -ForegroundColor Green
Write-Host ""
Write-Host "Done. Fully quit Claude Desktop (system tray -> Quit) and reopen it" -ForegroundColor Cyan
Write-Host "to load the connector." -ForegroundColor Cyan
Write-Host ""

#Requires -Version 5.1
<#
.SYNOPSIS
    AgentSphere AI for SAP Business One - One-Click Installer (no prompts).

.DESCRIPTION
    Everything is read from .env - fill it in once, then run One-Click-Install.bat.
    Installs Node.js / VC++ runtime if missing, installs packages, builds, creates the
    read-only HANA user, registers the Windows Service, opens the firewall and starts the app.
    Safe to re-run: it updates an existing installation and keeps hanny.db.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$script:step  = 0
$script:total = 12
$script:warnings = New-Object System.Collections.Generic.List[string]

function Write-Step($label) { $script:step++; Write-Host ""; Write-Host "  [$($script:step)/$($script:total)] $label" -ForegroundColor White }
function Write-OK($msg)     { Write-Host "        OK   $msg" -ForegroundColor Green }
function Write-Info($msg)   { Write-Host "        $msg" -ForegroundColor DarkGray }
function Write-Warn($msg)   { Write-Host "        WARN $msg" -ForegroundColor Yellow; $script:warnings.Add($msg) }
function Stop-Install($msg) {
    Write-Host ""
    Write-Host "  ERROR: $msg" -ForegroundColor Red
    Write-Host "  Log: $logPath" -ForegroundColor DarkGray
    try { Stop-Transcript | Out-Null } catch {}
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

# Native tools (npm, node) write warnings to stderr; with 'Stop' that would abort the script.
function Invoke-Native([scriptblock]$cmd) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $cmd; return $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
}

function Update-PathFromRegistry {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# -- .env helpers (keeps comments, order and encoding of the file) ------------
$envFile = Join-Path $PSScriptRoot '.env'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-EnvFile {
    $map = @{}
    foreach ($line in [IO.File]::ReadAllLines($envFile, $utf8)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $map[$Matches[1]] = $Matches[2].Trim() }
    }
    return $map
}

function Set-EnvValue($name, $value) {
    $lines = [Collections.Generic.List[string]]([IO.File]::ReadAllLines($envFile, $utf8))
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$name\s*=") { $lines[$i] = "$name=$value"; $found = $true }
    }
    if (-not $found) { $lines.Add("$name=$value") }
    [IO.File]::WriteAllLines($envFile, $lines, $utf8)
    $script:cfg[$name] = $value
}

function New-StrongPassword([int]$length = 20) {
    # Letters + digits only: satisfies the default HANA password policy and needs no quoting anywhere
    $sets = 'ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'
    $all = -join $sets
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] $length
    $rng.GetBytes($bytes)
    $chars = for ($i = 0; $i -lt $length; $i++) { $all[$bytes[$i] % $all.Length] }
    for ($i = 0; $i -lt 3; $i++) { $chars[$i] = $sets[$i][$bytes[$i] % $sets[$i].Length] }   # one of each class
    return -join $chars
}

# =============================================================================
Clear-Host
Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor Cyan
Write-Host "  |       AgentSphere AI  for  SAP Business One                 |" -ForegroundColor Cyan
Write-Host "  |              One-Click Installer                            |" -ForegroundColor Cyan
Write-Host "  +=============================================================+" -ForegroundColor Cyan

# -- Administrator ------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "  Requesting Administrator privileges..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

$logPath = Join-Path $PSScriptRoot ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $logPath | Out-Null

# =============================================================================
Write-Step "Checking configuration (.env)"

$required = 'SL_BASE_URL', 'SL_COMPANY', 'SL_USER', 'SL_PASSWORD'
function Get-MissingRequired {
    # Either the SL_* name or its legacy SAP_B1_* twin counts
    $required | Where-Object { $v = $cfg[$_]; if (-not $v) { $v = $cfg[$_ -replace '^SL_', 'SAP_B1_'] }; -not $v -or $v -match 'your-sap-server' }
}

if (-not (Test-Path $envFile)) {
    $example = Join-Path $PSScriptRoot '.env.example'
    if (-not (Test-Path $example)) { Stop-Install ".env and .env.example are both missing." }
    Copy-Item $example $envFile
    Write-Info "Created .env from the template"
}

$script:cfg = Read-EnvFile
for ($try = 0; ($missing = Get-MissingRequired) -and $try -lt 3; $try++) {
    Write-Host ""
    Write-Host "  Fill in your SAP, HANA and AI details in Notepad, save, and close Notepad." -ForegroundColor Yellow
    Write-Host "  Still needed: $($missing -join ', ')" -ForegroundColor Yellow
    Start-Process notepad.exe $envFile -Wait
    $script:cfg = Read-EnvFile
}
if ($missing) { Stop-Install "Fill in these values in .env first: $($missing -join ', ')" }

# Fill legacy SAP_B1_* names from SL_* (or the other way round) so both are present
foreach ($pair in @(@('SL_BASE_URL','SAP_B1_BASE_URL'), @('SL_COMPANY','SAP_B1_COMPANY'), @('SL_USER','SAP_B1_USER'), @('SL_PASSWORD','SAP_B1_PASSWORD'))) {
    $a, $b = $pair
    if (-not $cfg[$a] -and $cfg[$b]) { Set-EnvValue $a $cfg[$b] }
    if (-not $cfg[$b] -and $cfg[$a]) { Set-EnvValue $b $cfg[$a] }
}

Write-OK "SAP: $($cfg.SL_COMPANY) at $($cfg.SL_BASE_URL) as $($cfg.SL_USER)"

if ($cfg.HANA_HOST) { Write-OK "HANA: $($cfg.HANA_HOST):$($cfg.HANA_PORT), app user $($cfg.HANA_USER)" }
else                { Write-Info "HANA_HOST blank - direct DB access (DB SQL mode) will not be set up" }

$aiKey = $cfg.ANTHROPIC_API_KEY, $cfg.AZURE_OPENAI_API_KEY | Where-Object { $_ }
if ($aiKey) { Write-OK "AI provider: $(if ($cfg.AI_PROVIDER) { $cfg.AI_PROVIDER } else { 'anthropic' })" }
else        { Write-Warn "No AI key in .env - the app will run in rule-based Standard mode" }

$port = if ($cfg.CHAT_PORT) { [int]$cfg.CHAT_PORT } else { 3000 }

# =============================================================================
Write-Step "Checking Node.js and Visual C++ runtime"

Update-PathFromRegistry
$nodeMajor = 0
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0]) }

if ($nodeMajor -lt 20) {
    if ($nodeMajor) { Write-Info "Node.js v$nodeMajor is too old (20 or later needed) - installing Node.js 22 LTS" }
    else            { Write-Info "Node.js not found - installing Node.js 22 LTS" }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        $rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1
        $msi = Join-Path $env:TEMP "node-$($rel.version)-x64.msi"
        Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-x64.msi" -OutFile $msi -UseBasicParsing
        $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
        if ($p.ExitCode -notin 0, 3010) { throw "msiexec exit code $($p.ExitCode)" }
        Update-PathFromRegistry
    } catch {
        Stop-Install "Could not install Node.js automatically ($($_.Exception.Message)). Install Node.js 22 LTS from https://nodejs.org and run again."
    }
}
Write-OK "Node.js $(node -v), npm $(npm -v)"

$vc = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
if ($vc -and $vc.Installed -eq 1) {
    Write-OK "Visual C++ runtime $($vc.Version)"
} else {
    Write-Info "Installing Visual C++ 2015-2022 runtime..."
    try {
        $ProgressPreference = 'SilentlyContinue'
        $vcExe = Join-Path $env:TEMP 'vc_redist.x64.exe'
        Invoke-WebRequest 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $vcExe -UseBasicParsing
        $p = Start-Process $vcExe -ArgumentList '/install /quiet /norestart' -Wait -PassThru
        if ($p.ExitCode -notin 0, 1638, 3010) { throw "exit code $($p.ExitCode)" }
        Write-OK "Visual C++ runtime installed"
    } catch { Write-Warn "Visual C++ runtime install failed ($($_.Exception.Message)) - install it manually if the app does not start" }
}

# =============================================================================
Write-Step "Stopping any running copy of the app"

$svcName = 'AgentSphere AI'
$svc = Get-Service $svcName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Stop-Service $svcName -Force -ErrorAction SilentlyContinue
    Write-OK "Service stopped"
}
# A running node process locks the native SQLite module and blocks npm install
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'chat-server\.mjs' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($procs) { Write-OK "Stopped $(@($procs).Count) running chat-server process(es)" }
if (-not $svc -and -not $procs) { Write-OK "Nothing running" }

# =============================================================================
Write-Step "Installing packages (npm install)"

$code = Invoke-Native { npm install --no-fund --no-audit }
if ($code -ne 0) { Stop-Install "npm install failed (exit $code). Check the internet connection and the output above." }

# npm 11+ blocks native install scripts not listed in package.json "allowScripts"
$sqliteOk = (Invoke-Native { node -e "require('better-sqlite3')(':memory:')" }) -eq 0
if (-not $sqliteOk) {
    Write-Info "Building native modules (SQLite, canvas)..."
    if ([int]((npm -v).Split('.')[0]) -ge 11) { Invoke-Native { npm approve-scripts better-sqlite3 canvas } | Out-Null }
    Invoke-Native { npm rebuild better-sqlite3 canvas } | Out-Null
    $sqliteOk = (Invoke-Native { node -e "require('better-sqlite3')(':memory:')" }) -eq 0
}
if (-not $sqliteOk) { Stop-Install "The SQLite module (better-sqlite3) did not build. See the output above." }
Write-OK "Packages installed, native modules working"

# =============================================================================
Write-Step "Building the SAP tool server (TypeScript)"

$code = Invoke-Native { npm run build }
if ($code -ne 0 -or -not (Test-Path 'dist\server.js')) { Stop-Install "Build failed (exit $code). See the errors above." }
Write-OK "dist\server.js built"

# =============================================================================
Write-Step "Encryption key"

if ($cfg.DB_ENCRYPT_KEY -match '^[0-9a-fA-F]{64}$') {
    Write-OK "DB_ENCRYPT_KEY already set"
} else {
    Set-EnvValue 'DB_ENCRYPT_KEY' (node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
    Write-OK "DB_ENCRYPT_KEY generated and saved to .env"
}

# =============================================================================
Write-Step "Testing SAP Service Layer login"

$slUrl = $cfg.SL_BASE_URL.TrimEnd('/')
if ($slUrl -notmatch '/b1s/v\d$') { $slUrl += '/b1s/v1' }
try {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $body = @{ CompanyDB = $cfg.SL_COMPANY; UserName = $cfg.SL_USER; Password = $cfg.SL_PASSWORD } | ConvertTo-Json
    $login = Invoke-RestMethod -Uri "$slUrl/Login" -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 20
    Write-OK "Logged in to $($cfg.SL_COMPANY) (SAP B1 version $($login.Version))"
} catch {
    Write-Warn "SAP login failed: $($_.Exception.Message). Check SL_* values in .env - the app will install but cannot reach SAP"
} finally {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = $null
}

# =============================================================================
Write-Step "HANA read-only database user"

if (-not $cfg.HANA_HOST) {
    Write-Info "Skipped (HANA_HOST blank)"
} else {
    $hanaPort = if ($cfg.HANA_PORT) { [int]$cfg.HANA_PORT } else { 30015 }
    $tcp = New-Object Net.Sockets.TcpClient
    $reach = $false
    try { $reach = $tcp.ConnectAsync($cfg.HANA_HOST, $hanaPort).Wait(5000) } catch {} finally { $tcp.Close() }

    if (-not $reach) {
        Write-Warn "Cannot reach HANA at $($cfg.HANA_HOST):$hanaPort - open the port in the firewall and re-run. DB SQL mode is not set up"
    } else {
        if (-not $cfg.HANA_USER)     { Set-EnvValue 'HANA_USER' 'AGENTSPHERE_RO' }
        $creating = $cfg.HANA_ADMIN_PASSWORD -and $cfg.HANA_ADMIN_USER -and ($cfg.HANA_ADMIN_USER -ne $cfg.HANA_USER)
        if (-not $cfg.HANA_PASSWORD) {
            if ($creating) { Set-EnvValue 'HANA_PASSWORD' (New-StrongPassword); Write-OK "Generated a password for $($cfg.HANA_USER) (saved in .env)" }
            else { Write-Warn "HANA_PASSWORD is blank and no HANA_ADMIN_PASSWORD given - DB SQL mode is not set up" }
        }
        if ($cfg.HANA_PASSWORD) {
            $code = Invoke-Native { node scripts/setup-hana-user.mjs }
            if ($code -ne 0) {
                Write-Warn "HANA user setup failed (see above) - DB SQL mode will not work until it is fixed"
            } elseif ($creating) {
                Set-EnvValue 'HANA_ADMIN_PASSWORD' ''
                Write-OK "HANA_ADMIN_PASSWORD removed from .env (no longer needed)"
            }
        }
    }
}

# =============================================================================
Write-Step "Local app database (hanny.db)"

$dbPath = Join-Path $PSScriptRoot 'hanny.db'
if (Test-Path $dbPath) {
    Write-OK "Existing hanny.db kept ($([math]::Round((Get-Item $dbPath).Length / 1KB)) KB)"
} else {
    $code = Invoke-Native { node -e "import('./db.mjs').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" }
    if (Test-Path $dbPath) { Write-OK "hanny.db created with default logins admin / admin123 and superadmin / admin123" }
    else { Write-Warn "hanny.db will be created on first start" }
}

# =============================================================================
Write-Step "Windows Service '$svcName'"

if (Get-Service $svcName -ErrorAction SilentlyContinue) {
    Write-Info "Removing the old service registration..."
    Invoke-Native { node service-uninstall.mjs } | Out-Null
    for ($i = 0; $i -lt 15 -and (Get-Service $svcName -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
}
$code = Invoke-Native { node service-install.mjs }
Start-Sleep 3
$svc = Get-Service $svcName -ErrorAction SilentlyContinue
if (-not $svc) { Stop-Install "Windows Service registration failed (exit $code). See the output above." }
Set-Service $svcName -StartupType Automatic
if ($svc.Status -ne 'Running') { Start-Service $svcName -ErrorAction SilentlyContinue }
Write-OK "Service registered, startup Automatic"

# =============================================================================
Write-Step "Firewall and shortcuts"

$fwName = "AgentSphere AI (port $port)"
Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow `
    -Profile Domain, Private -Description 'LAN access to AgentSphere AI' | Out-Null
Write-OK "Inbound TCP $port allowed on Domain and Private networks"

$desk = [Environment]::GetFolderPath('CommonDesktopDirectory')
$ws = New-Object -ComObject WScript.Shell
foreach ($s in @(@('Start', 137), @('Restart', 238), @('Stop', 131), @('Status', 24))) {
    $lnk = $ws.CreateShortcut("$desk\AgentSphere AI - $($s[0]).lnk")
    $lnk.TargetPath = Join-Path $PSScriptRoot "$($s[0]).bat"
    $lnk.WorkingDirectory = $PSScriptRoot
    $lnk.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,$($s[1])"
    $lnk.Save()
}
Write-OK "Start / Restart / Stop / Status shortcuts on the desktop"

# =============================================================================
Write-Step "Starting AgentSphere AI"

$up = $false
for ($i = 0; $i -lt 45 -and -not $up; $i++) {
    Start-Sleep 2
    try { $up = (Invoke-WebRequest "http://localhost:$port/login.html" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch {}
}
if ($up) { Write-OK "App is answering on port $port" }
else     { Write-Warn "App did not answer within 90 seconds - run diagnose.bat or check services.msc" }

# =============================================================================
Write-Host ""
Write-Host "  +=============================================================+" -ForegroundColor Green
Write-Host "  |   Installation complete                                     |" -ForegroundColor Green
Write-Host "  +=============================================================+" -ForegroundColor Green
Write-Host ""
Write-Host "  Open in a browser:" -ForegroundColor White
Write-Host "    This server:  http://localhost:$port" -ForegroundColor Cyan
$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.)' }).IPAddress
foreach ($ip in $ips) { Write-Host "    Network:      http://${ip}:$port" -ForegroundColor Cyan }
Write-Host ""
Write-Host "  First login: admin / admin123  - change it right away." -ForegroundColor Yellow
if ($script:warnings.Count) {
    Write-Host ""
    Write-Host "  Warnings:" -ForegroundColor Yellow
    foreach ($w in $script:warnings) { Write-Host "    - $w" -ForegroundColor Yellow }
}
Write-Host ""
Write-Host "  Install log: $logPath" -ForegroundColor DarkGray
try { Stop-Transcript | Out-Null } catch {}

if ($up) { Start-Process "http://localhost:$port" }
Write-Host ""
Read-Host "  Press Enter to close"

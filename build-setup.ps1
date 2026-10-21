#Requires -Version 5.1
<#
.SYNOPSIS
    Builds releases\AgentSphere-Setup-<version>.exe - a single setup file for customer servers.

.DESCRIPTION
    Packs the application (without node_modules, dist, .env, databases, logs, certs)
    into app.zip and wraps it with scripts\setup-bootstrap.ps1 using IExpress, which
    ships with Windows. Running the EXE installs to C:\AgentSphere (or updates the
    existing install) and then runs one-click-install.ps1, which installs Node.js,
    the VC++ runtime and all npm packages, creates the HANA user and starts the service.
#>
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot

$version = (Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version
$stamp   = Get-Date -Format 'yyyyMMdd'
$outDir  = Join-Path $src 'releases'
$outExe  = Join-Path $outDir "AgentSphere-Setup-$version-$stamp.exe"
# IExpress fails silently on long paths, so build in a short folder and move the EXE afterwards
$work    = Join-Path $outDir '_build'
# and does not accept a quoted SED path, so the path must also be free of spaces
if ($work.Length -gt 50 -or $work.Contains(' ')) { $work = Join-Path $env:SystemDrive '\asbuild' }
$tmpExe  = Join-Path $work 'setup.exe'
$stage   = Join-Path $work 'app'
$pack    = Join-Path $work 'pack'

Write-Host ""
Write-Host "  Building AgentSphere setup $version" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $stage, $pack, $outDir | Out-Null

# -- 1. Stage application files ------------------------------------------------
$excludeDirs  = 'node_modules', '.git', '.claude', '.vscode', 'daemon', 'dist', 'releases', 'certs', 'exports',
                'db-backup-corrupt', 'sql-gateway-mcp', 'hana-gateway-mcp', 'apip'
$excludeFiles = '.env', '.env copy', '.env.bak', '.env.local', 'hanny.db', 'hanny.db-shm', 'hanny.db-wal',
                'data.db', '*.log', '*.log.err'
$null = robocopy $src $stage /E /NFL /NDL /NJH /NJS /NP /XD @excludeDirs /XF @excludeFiles
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
if (-not (Test-Path (Join-Path $stage 'one-click-install.ps1'))) { throw "one-click-install.ps1 missing from the package" }
$count = (Get-ChildItem $stage -Recurse -File).Count
Write-Host "  OK   $count files staged" -ForegroundColor Green

# -- 2. Zip + bootstrap ----------------------------------------------------------
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $pack 'app.zip')
Copy-Item (Join-Path $src 'scripts\setup-bootstrap.ps1') $pack
Set-Content (Join-Path $pack 'setup.cmd') -Encoding ASCII -Value '@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-bootstrap.ps1"'
Write-Host "  OK   app.zip $([math]::Round((Get-Item (Join-Path $pack 'app.zip')).Length / 1MB, 1)) MB" -ForegroundColor Green

# -- 3. IExpress self-extracting setup -------------------------------------------
$sed = Join-Path $work 'setup.sed'
@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=Install AgentSphere AI for SAP Business One?
DisplayLicense=
FinishMessage=
TargetName=$tmpExe
FriendlyName=AgentSphere AI Setup $version
AppLaunched=cmd /c setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="app.zip"
FILE1="setup-bootstrap.ps1"
FILE2="setup.cmd"
[SourceFiles]
SourceFiles0=$pack\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@ | Set-Content $sed -Encoding ASCII

$p = Start-Process "$env:SystemRoot\System32\iexpress.exe" -ArgumentList "/N /Q $sed" -Wait -PassThru
if (-not (Test-Path $tmpExe)) { throw "IExpress did not produce the setup file (exit $($p.ExitCode))" }
Move-Item $tmpExe $outExe -Force

Remove-Item $work -Recurse -Force
Write-Host "  OK   $outExe ($([math]::Round((Get-Item $outExe).Length / 1MB, 1)) MB)" -ForegroundColor Green
Write-Host ""

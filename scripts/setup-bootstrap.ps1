#Requires -Version 5.1
<#
    Runs inside AgentSphere-Setup.exe (built by Build-Setup.bat).
    Unpacks app.zip into the install folder and runs one-click-install.ps1 there.
    An existing installation is updated in place: .env, hanny.db, certs and data are kept
    because they are never part of app.zip.
#>
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    # -Wait keeps Setup.exe's temp folder (holding app.zip) alive until the elevated copy finishes
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs -Wait
    exit
}

Write-Host ""
Write-Host "  AgentSphere AI - Setup" -ForegroundColor Cyan
Write-Host ""

# Update the existing install if the service is registered, otherwise C:\AgentSphere
$target = 'C:\AgentSphere'
$svc = Get-CimInstance Win32_Service -Filter "DisplayName='AgentSphere AI'" -ErrorAction SilentlyContinue
if ($svc -and $svc.PathName -match '"?([^"]+)\\daemon\\[^\\"]+\.exe') {
    $target = $Matches[1]
    Write-Host "  Existing installation found - updating $target" -ForegroundColor Yellow
} else {
    Write-Host "  Installing to $target" -ForegroundColor White
}

if (Get-Service 'AgentSphere AI' -ErrorAction SilentlyContinue) { Stop-Service 'AgentSphere AI' -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'chat-server\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force $target | Out-Null
Write-Host "  Copying application files..." -ForegroundColor DarkGray
Expand-Archive -Path (Join-Path $PSScriptRoot 'app.zip') -DestinationPath $target -Force
Write-Host "  OK   Files copied" -ForegroundColor Green

& (Join-Path $target 'one-click-install.ps1')

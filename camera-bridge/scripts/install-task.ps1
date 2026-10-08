<#
  Registers the TRIVO Camera Bridge to start automatically when THIS Windows user logs on.

  Why a logon task and not a Windows Service: the station credential is protected with DPAPI CurrentUser, i.e. it can only
  be decrypted by the Windows account that stored it. A logon task already runs as that account, needs no extra software
  (no NSSM/WinSW wrapper) and gives a service-like restart policy. If the bridge ever must run with nobody logged on,
  register the same run-bridge.cmd as the action of an "at startup" task under a dedicated account and run
  `provision` as that account.

  Run once, as the photography-station user (no administrator rights needed):
      powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
#>
param([string]$TaskName = 'TRIVO Camera Bridge')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-bridge.cmd'
if (-not (Test-Path (Join-Path $root 'dist\index.js'))) { throw "dist\index.js not found - run 'npm ci && npm run build' first." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node.exe is not on PATH.' }
New-Item -ItemType Directory -Force (Join-Path $env:LOCALAPPDATA 'TrivoCameraBridge\logs') | Out-Null

$action   = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName' for $env:USERDOMAIN\$env:USERNAME. It starts at the next logon."
Write-Host "Start now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check:      node dist\index.js check      (and http://127.0.0.1:9102/status)"
Write-Host "Logs:       $env:LOCALAPPDATA\TrivoCameraBridge\logs\bridge.log"
Write-Host "Note: Stop-ScheduledTask ends the process immediately (no shutdown signal). That is safe - see README, 'Crash and restart'."

param([string]$TaskName = 'TRIVO Camera Bridge')
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed '$TaskName'. The stored credential and logs under %LOCALAPPDATA%\TrivoCameraBridge were left in place."
} else { Write-Host "'$TaskName' is not registered." }

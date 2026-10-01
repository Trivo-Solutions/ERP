<#
  Creates or removes a per-user Startup-folder shortcut so the print agent launches automatically
  at login instead of needing a manual double-click every day. Per-user Startup
  (shell:startup) needs no admin rights, unlike a machine-wide Scheduled Task or service.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Action install -ExePath C:\path\to\printer-agent.exe
    powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1 -Action uninstall
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall')][string]$Action,
    [string]$ExePath
)

$ErrorActionPreference = 'Stop'

$WshShell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $WshShell.SpecialFolders('Startup') 'TRIVO Print Agent.lnk'

if ($Action -eq 'install') {
    if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) {
        Write-Error "ExePath is required and must exist for -Action install."
        exit 1
    }
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $ExePath
    $shortcut.WorkingDirectory = Split-Path -Parent $ExePath
    $shortcut.WindowStyle = 7  # minimized
    $shortcut.Description = 'SEA ERP label print agent — starts automatically at login'
    $shortcut.Save()
    Write-Output "OK: installed $shortcutPath -> $ExePath"
} else {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    Write-Output "OK: removed $shortcutPath"
}

# Builds printer-agent into a standalone .exe and packages it into two downloads under
# client/public/downloads/, so `npm run build --workspace=client` ships both as same-origin
# downloads (see client/src/pages/Hardware/HardwarePage.tsx):
#   - trivo-print-agent-setup.exe — the one-click installer (primary; recommended)
#   - printer-agent.zip — the exe + .env.example + README.md, for manual/advanced install
#
# Use this on a native (non-Docker) Windows deploy, run it before building the client. The
# containerized deploy path (DEPLOY.md) builds the .zip equivalently inside client/Dockerfile,
# but CANNOT build the installer itself — Inno Setup's compiler (ISCC.exe) is Windows-only and
# doesn't run in that Linux build container. So the installer is committed to
# client/public/downloads/trivo-print-agent-setup.exe (see the root .gitignore's carve-out) and
# only gets refreshed by re-running this script (or `npm run installer` directly) on a Windows
# machine and committing the result — Docker deploys just ship whatever's already committed.

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$agentDir = Join-Path $repoRoot 'printer-agent'
$downloadsDir = Join-Path $repoRoot 'client\public\downloads'
$stageDir = Join-Path $env:TEMP 'printer-agent-download-stage'

Push-Location $agentDir
try {
    npm run package
} finally {
    Pop-Location
}

if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir | Out-Null
Copy-Item (Join-Path $agentDir 'dist-exe\printer-agent.exe') $stageDir
Copy-Item (Join-Path $agentDir '.env.example') $stageDir
Copy-Item (Join-Path $agentDir 'README.md') $stageDir

New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null
$zipPath = Join-Path $downloadsDir 'printer-agent.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath

Remove-Item $stageDir -Recurse -Force
Write-Host "Built $zipPath"

Push-Location $agentDir
try {
    npm run installer
} finally {
    Pop-Location
}
$installerSrc = Join-Path $agentDir 'dist-installer\TRIVO Print Agent Setup.exe'
$installerDest = Join-Path $downloadsDir 'trivo-print-agent-setup.exe'
Copy-Item $installerSrc $installerDest -Force
Write-Host "Built $installerDest -- remember to 'git add' and commit this file (see .gitignore's carve-out)."

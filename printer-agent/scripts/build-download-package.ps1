# Builds printer-agent into a standalone .exe and packages it (with .env.example + README.md)
# into client/public/downloads/printer-agent.zip, so `npm run build --workspace=client` ships it
# as a same-origin download (see client/src/pages/Hardware/HardwarePage.tsx).
#
# Use this on a native (non-Docker) Windows deploy, run it before building the client. The
# containerized deploy path (DEPLOY.md) does the equivalent inside client/Dockerfile instead —
# this script is not part of that path.

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

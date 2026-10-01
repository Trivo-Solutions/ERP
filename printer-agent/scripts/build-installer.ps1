# Builds the standalone printer-agent.exe (same as build-download-package.ps1) and then compiles
# it into a real Windows installer via Inno Setup: dist-installer\TRIVO Print Agent Setup.exe.
#
# Prerequisite: Inno Setup 6 (ISCC.exe). Install once with:
#   winget install --id JRSoftware.InnoSetup -e
# (or download from https://jrsoftware.org/isinfo.php)

$ErrorActionPreference = 'Stop'

$agentDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$issPath = Join-Path $agentDir 'installer\trivo-print-agent.iss'

Push-Location $agentDir
try {
    npm run package
} finally {
    Pop-Location
}

$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $found) {
        Write-Error "ISCC.exe (Inno Setup compiler) not found. Install it first: winget install --id JRSoftware.InnoSetup -e"
        exit 1
    }
    $iscc = $found
} else {
    $iscc = $iscc.Source
}

& $iscc $issPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "Inno Setup compilation failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Built $(Join-Path $agentDir 'dist-installer\TRIVO Print Agent Setup.exe')"

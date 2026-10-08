<#
  Builds and tests the native Windows webcam helper (Windows x64, MSVC Build Tools 2022 + the CMake that ships with them).
  Output: native-src\build-webcam\Release\{trivo-webcam-helper.exe, webcam_tests.exe}
  -Install copies ONLY trivo-webcam-helper.exe to <bridge>\native\webcam\ (gitignored), where the bridge looks for it.
  The helper needs no SDK: it uses the Media Foundation and WIC components that ship with Windows 10/11
  (Windows "N" editions need the Media Feature Pack).
#>
param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cm = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cm) { $cm = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
if (-not (Test-Path $cm)) { throw 'cmake not found (install Visual Studio 2022 Build Tools with the C++ workload).' }
$src = Join-Path $root 'native-src\webcam-helper'; $bld = Join-Path $root 'native-src\build-webcam'
& $cm -S $src -B $bld -G 'Visual Studio 17 2022' -A x64; if ($LASTEXITCODE) { throw 'configure failed' }
& $cm --build $bld --config Release; if ($LASTEXITCODE) { throw 'build failed' }
& (Join-Path $bld 'Release\webcam_tests.exe'); if ($LASTEXITCODE) { throw 'native webcam tests failed' }
if ($Install) {
  $dest = Join-Path $root 'native\webcam'; New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item (Join-Path $bld 'Release\trivo-webcam-helper.exe') $dest -Force
  Write-Host "Installed trivo-webcam-helper.exe -> $dest"
}

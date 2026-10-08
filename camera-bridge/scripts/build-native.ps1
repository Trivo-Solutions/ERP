<#
  Builds and tests the native Sony helper (Windows x64, MSVC Build Tools 2022 + the CMake that ships with them).
  Output: native-src\build\Release\{trivo-sony-helper.exe, trivo-sony-helper-fake.exe, native_tests.exe}
  Optional -SdkDir: path of the LOCALLY INSTALLED Sony Camera Remote SDK (requires native-src\sony-helper\SonyDriver.cpp, see README there).
  Nothing from the SDK is copied into the repository. To install the production helper where the bridge looks for it:
      -Install   copies ONLY trivo-sony-helper.exe to <bridge>\native\sony\ (gitignored).
#>
param([string]$SdkDir = '', [switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cm = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cm) { $cm = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
if (-not (Test-Path $cm)) { throw 'cmake not found (install Visual Studio 2022 Build Tools with the C++ workload).' }
$src = Join-Path $root 'native-src\sony-helper'; $bld = Join-Path $root 'native-src\build'
$cfg = @('-S', $src, '-B', $bld, '-G', 'Visual Studio 17 2022', '-A', 'x64')
if ($SdkDir) { $cfg += "-DCRSDK_DIR=$SdkDir" }
& $cm @cfg; if ($LASTEXITCODE) { throw 'configure failed' }
& $cm --build $bld --config Release; if ($LASTEXITCODE) { throw 'build failed' }
& (Join-Path $bld 'Release\native_tests.exe'); if ($LASTEXITCODE) { throw 'native tests failed' }
if ($Install) {
  $dest = Join-Path $root 'native\sony'; New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item (Join-Path $bld 'Release\trivo-sony-helper.exe') $dest -Force
  Write-Host "Installed trivo-sony-helper.exe -> $dest  (SDK runtime DLLs are a separate, operator-installed prerequisite)"
}
